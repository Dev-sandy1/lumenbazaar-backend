import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { isIP } from "node:net";
import { pathToFileURL } from "node:url";

import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

import {
  getReleaseCommit,
  loadConfig,
  runWithTraceparent,
  serviceName,
  startTraceSpan
} from "@lumenbazaar/shared";

import { BackendClient } from "./client.js";
import { createMcpServer, mcpToolSchemaDocument } from "./server.js";
import { createMcpMetricsService, mcpMetricRoute, type McpMetricsService } from "./metrics.js";
import { type McpToolCapabilities } from "./tools.js";

// ---------------------------------------------------------------------------
// CORS configuration
// ---------------------------------------------------------------------------
//
// MCP Streamable HTTP requires browsers and hosted MCP clients to send custom
// headers (Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version).
// Without CORS headers those requests are blocked by browser preflight.
//
// Origin policy: wildcard (*) is intentionally NOT used as the default.
// Mcp-Session-Id is a bearer credential and browsers will not send it with
// credentials=include if the server replies with Access-Control-Allow-Origin: *.
// The allowed-origin set is configured via MCP_ALLOWED_ORIGINS (comma-separated)
// with a safe fallback of an empty set (no cross-origin access).
//
// Set MCP_ALLOWED_ORIGINS=* only for fully public, credential-free deployments.
// ---------------------------------------------------------------------------

const MCP_CORS_ALLOW_HEADERS =
  "Content-Type, Accept, Mcp-Session-Id, Mcp-Protocol-Version, Authorization, traceparent";
const MCP_CORS_EXPOSE_HEADERS = "Mcp-Session-Id, traceparent";
const MCP_CORS_MAX_AGE = "600"; // 10 minutes

/**
 * Parse the MCP_ALLOWED_ORIGINS environment variable into a set of allowed
 * origins.  Returns an empty set when the variable is absent or empty.
 */
export function parseCorsAllowedOrigins(envValue: string | undefined): ReadonlySet<string> {
  if (envValue === undefined || envValue.trim() === "") return new Set();
  return new Set(
    envValue
      .split(",")
      .map((o) => o.trim())
      .filter((o) => o.length > 0)
  );
}

/**
 * Resolve the CORS `Access-Control-Allow-Origin` value for a request.
 *
 * - If the allowed set contains `"*"` every origin is permitted (wildcard
 *   response).
 * - Otherwise the request `Origin` header is reflected only when it appears in
 *   the configured set; absent or unrecognised origins receive no CORS header,
 *   which causes the browser to block the request — this is the secure default.
 */
export function resolveCorsOrigin(
  requestOrigin: string | undefined,
  allowedOrigins: ReadonlySet<string>
): string | null {
  if (allowedOrigins.size === 0) return null;
  if (allowedOrigins.has("*")) return "*";
  if (requestOrigin !== undefined && allowedOrigins.has(requestOrigin)) return requestOrigin;
  return null;
}

/**
 * Write CORS response headers onto `response`.  Call this before writing the
 * status line for every request that might come from a browser or hosted MCP
 * client.
 *
 * Returns `true` when the request is an OPTIONS preflight that has been fully
 * handled so the caller should not continue processing the request.
 */
export function applyCorsHeaders(
  request: IncomingMessage,
  response: ServerResponse,
  allowedOrigins: ReadonlySet<string>
): boolean {
  const requestOrigin = Array.isArray(request.headers["origin"])
    ? request.headers["origin"][0]
    : request.headers["origin"];

  const resolvedOrigin = resolveCorsOrigin(requestOrigin, allowedOrigins);

  if (resolvedOrigin !== null) {
    response.setHeader("access-control-allow-origin", resolvedOrigin);
    response.setHeader("access-control-allow-headers", MCP_CORS_ALLOW_HEADERS);
    response.setHeader("access-control-expose-headers", MCP_CORS_EXPOSE_HEADERS);
    // Reflect credentials only when the origin is explicitly listed (not wildcard)
    if (resolvedOrigin !== "*") {
      response.setHeader("access-control-allow-credentials", "true");
    }
  }

  if (request.method === "OPTIONS") {
    if (resolvedOrigin !== null) {
      response.setHeader("access-control-allow-methods", "GET, POST, DELETE, OPTIONS");
      response.setHeader("access-control-max-age", MCP_CORS_MAX_AGE);
    }
    response.writeHead(204);
    response.end();
    return true; // preflight handled
  }

  return false;
}

export type McpHttpServerOptions = {
  host?: string;
  path?: string;
  port?: number;
  client?: BackendClient;
  capabilityProvider?: () => Promise<McpToolCapabilities>;
  requestGuard?: McpHttpRequestGuard;
  metrics?: McpMetricsService;
  /** Allowed CORS origins. Defaults to MCP_ALLOWED_ORIGINS env var. */
  allowedOrigins?: ReadonlySet<string>;
};

export type McpHttpServerHandle = {
  close: () => Promise<void>;
  host: string;
  path: string;
  port: number;
  url: string;
};

type McpHttpTransport = Pick<StreamableHTTPServerTransport, "close" | "handleRequest">;

type McpHttpRouteOptions = {
  capabilityProvider?: () => Promise<McpToolCapabilities>;
  environment?: string;
  requestGuard?: McpHttpRequestGuard;
  metrics?: McpMetricsService;
  allowedOrigins?: ReadonlySet<string>;
};

export class McpHttpRequestGuard {
  private readonly requests = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly limit = 120,
    private readonly windowMs = 60_000,
    private readonly maxBodyBytes = 1024 * 1024,
    private readonly trustProxy = false
  ) {}

  check(request: IncomingMessage) {
    const contentLength = Number(request.headers["content-length"] ?? 0);
    if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > this.maxBodyBytes) {
      return { allowed: false as const, status: 413, error: "request_too_large" };
    }

    const now = Date.now();
    const key = this.clientKey(request);
    const current = this.requests.get(key);
    const state =
      current === undefined || current.resetAt <= now
        ? { count: 0, resetAt: now + this.windowMs }
        : current;
    state.count += 1;
    this.requests.set(key, state);
    if (state.count > this.limit) {
      return {
        allowed: false as const,
        status: 429,
        error: "rate_limited",
        retryAfter: Math.max(1, Math.ceil((state.resetAt - now) / 1000))
      };
    }
    return { allowed: true as const };
  }

  private clientKey(request: IncomingMessage) {
    if (this.trustProxy) {
      const forwarded = request.headers["x-forwarded-for"];
      const clientIp = (Array.isArray(forwarded) ? forwarded[0] : forwarded)
        ?.split(",")
        .at(-1)
        ?.trim();
      if (clientIp !== undefined && isIP(clientIp) !== 0) {
        return clientIp;
      }
    }
    return request.socket.remoteAddress ?? "unknown";
  }
}

export async function startMcpHttpServer(
  options: McpHttpServerOptions = {}
): Promise<McpHttpServerHandle> {
  const config = loadConfig();
  const host = options.host ?? process.env.MCP_HOST ?? config.api.host;
  const path = normalizePath(options.path ?? process.env.MCP_PATH ?? "/mcp");
  const port = options.port ?? Number(process.env.MCP_PORT ?? 3001);
  const client = options.client ?? new BackendClient();
  const capabilityProvider = options.capabilityProvider ?? (() => client.getToolCapabilities());
  const requestGuard =
    options.requestGuard ??
    new McpHttpRequestGuard(120, 60_000, 1024 * 1024, process.env.MCP_TRUST_PROXY === "true");
  const metrics = options.metrics ?? createMcpMetricsService();
  const allowedOrigins =
    options.allowedOrigins ?? parseCorsAllowedOrigins(process.env.MCP_ALLOWED_ORIGINS);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID()
  });
  const mcpServer = createMcpServer({ client, capabilityProvider, metrics });

  await mcpServer.connect(transport as unknown as Transport);

  const httpServer = createServer((request, response) => {
    handleMcpHttpRequest(request, response, transport, path, {
      capabilityProvider,
      requestGuard,
      metrics,
      allowedOrigins,
      environment: config.lumenEnv
    }).catch(() => {
      sendJson(response, 500, {
        ok: false,
        error: "internal_error"
      });
    });
  });

  await new Promise<void>((resolvePromise, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(port, host, () => {
      httpServer.off("error", reject);
      resolvePromise();
    });
  });

  const address = httpServer.address();
  const actualPort = typeof address === "object" && address !== null ? address.port : port;
  const publicHost = host === "0.0.0.0" ? "localhost" : host;
  const url = `http://${publicHost}:${actualPort}${path}`;

  return {
    async close() {
      await transport.close();
      await new Promise<void>((resolvePromise, reject) => {
        httpServer.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolvePromise();
        });
      });
    },
    host,
    path,
    port: actualPort,
    url
  };
}

export async function handleMcpHttpRequest(
  request: IncomingMessage,
  response: ServerResponse,
  transport: McpHttpTransport,
  mcpPath = "/mcp",
  options: McpHttpRouteOptions = {}
) {
  const rawTraceparent = request.headers.traceparent;
  const parent = typeof rawTraceparent === "string" ? rawTraceparent : undefined;
  return runWithTraceparent(parent, async () => {
    const span = startTraceSpan("mcp.http.request", {
      "http.request.method": request.method ?? "UNKNOWN"
    });
    if (span.traceparent !== undefined && !response.headersSent) {
      response.setHeader("traceparent", span.traceparent);
    }
    return span.run(async () => {
      try {
        await handleMcpHttpRequestInner(request, response, transport, mcpPath, options);
      } finally {
        span.end({ "http.response.status_code": response.statusCode });
      }
    });
  });
}

async function handleMcpHttpRequestInner(
  request: IncomingMessage,
  response: ServerResponse,
  transport: McpHttpTransport,
  mcpPath = "/mcp",
  options: McpHttpRouteOptions = {}
) {
  const requestPath = parseMcpRequestPath(request.url);
  const expectedPath = normalizePath(mcpPath);
  const metricRoute = mcpMetricRoute(requestPath, expectedPath);

  // Apply CORS headers and fully handle OPTIONS preflight before any other
  // processing, including the rate limiter (preflight is not a real request).
  const allowedOrigins = options.allowedOrigins ?? new Set<string>();
  if (applyCorsHeaders(request, response, allowedOrigins)) {
    // OPTIONS preflight was fully handled; nothing more to do.
    return;
  }

  response.once("finish", () => {
    const result =
      response.statusCode === 429
        ? "rate_limited"
        : response.statusCode >= 400
          ? "rejected"
          : "accepted";
    options.metrics?.recordHttp(metricRoute, result);
  });

  if (requestPath === null) {
    sendJson(response, 400, {
      ok: false,
      error: "invalid_request_url"
    });
    return;
  }

  const guardResult = options.requestGuard?.check(request);
  if (guardResult?.allowed === false) {
    if (guardResult.retryAfter !== undefined) {
      response.setHeader("retry-after", String(guardResult.retryAfter));
    }
    sendJson(response, guardResult.status, { ok: false, error: guardResult.error });
    return;
  }

  if (requestPath === "/health") {
    if (request.method !== "GET") return methodNotAllowed(response);
    sendJson(response, 200, {
      ok: true,
      service: serviceName,
      app: "mcp-server",
      transport: "streamable-http"
    });
    return;
  }

  if (requestPath === "/ready") {
    if (request.method !== "GET") return methodNotAllowed(response);
    const capabilities = await probeCapabilities(options.capabilityProvider);
    sendJson(response, capabilities.backend ? 200 : 503, {
      ok: capabilities.backend,
      service: serviceName,
      app: "mcp-server",
      capabilities
    });
    return;
  }

  if (requestPath === "/version") {
    if (request.method !== "GET") return methodNotAllowed(response);
    sendJson(response, 200, {
      service: serviceName,
      app: "mcp-server",
      version: "0.1.0",
      commit: getReleaseCommit(),
      environment: options.environment ?? "unknown"
    });
    return;
  }

  if (requestPath === "/schema") {
    if (request.method !== "GET") return methodNotAllowed(response);
    const capabilities = await probeCapabilities(options.capabilityProvider);
    sendJson(response, 200, mcpToolSchemaDocument(capabilities));
    return;
  }

  if (requestPath === "/metrics") {
    if (request.method !== "GET") return methodNotAllowed(response);
    response.writeHead(200, {
      "cache-control": "no-store",
      "content-type": "text/plain; version=0.0.4",
      "x-content-type-options": "nosniff"
    });
    response.end((await options.metrics?.collect()) ?? "");
    return;
  }

  if (requestPath !== expectedPath) {
    sendJson(response, 404, {
      ok: false,
      error: "not_found"
    });
    return;
  }

  await transport.handleRequest(request, response);
}

async function probeCapabilities(provider: McpHttpRouteOptions["capabilityProvider"]) {
  try {
    return provider === undefined ? { backend: false, exact: false } : await provider();
  } catch {
    return { backend: false, exact: false };
  }
}

function methodNotAllowed(response: ServerResponse, allow = "GET") {
  response.setHeader("allow", allow);
  sendJson(response, 405, { ok: false, error: "method_not_allowed" });
}

export function parseMcpRequestPath(rawUrl: string | undefined) {
  const value = rawUrl ?? "/";

  if (
    !value.startsWith("/") ||
    value.startsWith("//") ||
    value.includes("\\") ||
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    return null;
  }

  try {
    return new URL(value, "http://localhost").pathname;
  } catch {
    return null;
  }
}

function sendJson(response: ServerResponse, statusCode: number, body: Record<string, unknown>) {
  if (response.headersSent) {
    return;
  }

  response.writeHead(statusCode, {
    "cache-control": "no-store",
    "content-type": "application/json",
    "x-content-type-options": "nosniff"
  });
  response.end(JSON.stringify(body));
}

function normalizePath(path: string) {
  return path.startsWith("/") ? path : `/${path}`;
}

async function main() {
  const server = await startMcpHttpServer();
  console.log(`${serviceName} MCP HTTP server listening at ${server.url}`);
}

const entrypoint = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;

if (entrypoint === import.meta.url) {
  await main();
}
