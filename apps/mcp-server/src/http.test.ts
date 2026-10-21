import { createServer, type IncomingMessage, type ServerResponse } from "node:http";

import { describe, expect, it } from "vitest";

import {
  applyCorsHeaders,
  handleMcpHttpRequest,
  McpHttpRequestGuard,
  parseCorsAllowedOrigins,
  parseMcpRequestPath,
  resolveCorsOrigin,
  startMcpHttpServer
} from "./http.js";

describe("MCP HTTP server", () => {
  it("exposes a deployment health endpoint", async () => {
    const server = await startMcpHttpServer({ host: "127.0.0.1", port: 0 });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`, {
        headers: {
          traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"
        }
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("traceparent")).toMatch(
        /^00-0123456789abcdef0123456789abcdef-[0-9a-f]{16}-01$/
      );
      await expect(response.json()).resolves.toMatchObject({
        ok: true,
        app: "mcp-server",
        transport: "streamable-http"
      });
      const metrics = await fetch(`http://127.0.0.1:${server.port}/metrics`);
      expect(metrics.status).toBe(200);
      expect(await metrics.text()).toContain(
        'lumenbazaar_mcp_http_requests_total{route="health",result="accepted"} 1'
      );
    } finally {
      await server.close();
    }
  });

  it("routes only the configured MCP path to the transport", async () => {
    let handled = 0;
    const transport = {
      async close() {},
      async handleRequest(_request: IncomingMessage, response: ServerResponse) {
        handled += 1;
        response.writeHead(202, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: true }));
      }
    };
    const server = createServer((request, response) => {
      handleMcpHttpRequest(request, response, transport, "/agent").catch((error) => {
        response.writeHead(500, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: String(error) }));
      });
    });

    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    const port = typeof address === "object" && address !== null ? address.port : 0;

    try {
      const missing = await fetch(`http://127.0.0.1:${port}/mcp`);
      const routed = await fetch(`http://127.0.0.1:${port}/agent`);

      expect(missing.status).toBe(404);
      expect(routed.status).toBe(202);
      expect(handled).toBe(1);
    } finally {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }

          resolve();
        });
      });
    }
  });

  it("rejects absolute, protocol-relative, and malformed request targets", () => {
    expect(parseMcpRequestPath("/mcp?session=one")).toBe("/mcp");
    expect(parseMcpRequestPath("https://attacker.example/mcp")).toBeNull();
    expect(parseMcpRequestPath("//attacker.example/mcp")).toBeNull();
    expect(parseMcpRequestPath("/\\attacker.example/mcp")).toBeNull();
    expect(parseMcpRequestPath("/mcp\u0000suffix")).toBeNull();
  });

  it("does not expose OAuth metadata or redirect unmatched paths", async () => {
    const server = await startMcpHttpServer({ host: "127.0.0.1", port: 0 });

    try {
      const response = await fetch(
        `http://127.0.0.1:${server.port}/.well-known/oauth-authorization-server`,
        { redirect: "manual" }
      );

      expect(response.status).toBe(404);
      expect(response.headers.get("location")).toBeNull();
      await expect(response.json()).resolves.toEqual({ ok: false, error: "not_found" });
    } finally {
      await server.close();
    }
  });

  it("reports backend readiness, version, and capability-filtered schemas", async () => {
    const server = await startMcpHttpServer({
      host: "127.0.0.1",
      port: 0,
      capabilityProvider: async () => ({ backend: true, exact: false })
    });

    try {
      const ready = await fetch(`http://127.0.0.1:${server.port}/ready`);
      const version = await fetch(`http://127.0.0.1:${server.port}/version`);
      const schema = await fetch(`http://127.0.0.1:${server.port}/schema`);

      expect(ready.status).toBe(200);
      await expect(ready.json()).resolves.toMatchObject({
        ok: true,
        capabilities: { backend: true, exact: false }
      });
      await expect(version.json()).resolves.toMatchObject({
        app: "mcp-server",
        version: "0.1.0",
        commit: expect.any(String)
      });
      const schemaBody = (await schema.json()) as { tools: Array<{ name: string }> };
      expect(schemaBody.tools.map((tool) => tool.name)).toContain("search_paid_resources");
      expect(schemaBody.tools.map((tool) => tool.name)).not.toContain("call_paid_resource");
    } finally {
      await server.close();
    }
  });

  it("fails readiness closed when the backend is unavailable", async () => {
    const server = await startMcpHttpServer({
      host: "127.0.0.1",
      port: 0,
      capabilityProvider: async () => ({ backend: false, exact: false })
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/ready`);
      expect(response.status).toBe(503);
      await expect(response.json()).resolves.toMatchObject({ ok: false });
    } finally {
      await server.close();
    }
  });

  it("limits abusive request rates and oversized bodies", async () => {
    const rateLimited = await startMcpHttpServer({
      host: "127.0.0.1",
      port: 0,
      requestGuard: new McpHttpRequestGuard(1, 60_000, 1024)
    });
    try {
      expect((await fetch(`http://127.0.0.1:${rateLimited.port}/health`)).status).toBe(200);
      const second = await fetch(`http://127.0.0.1:${rateLimited.port}/health`);
      expect(second.status).toBe(429);
      expect(second.headers.get("retry-after")).toBeTruthy();
    } finally {
      await rateLimited.close();
    }

    const sizeLimited = await startMcpHttpServer({
      host: "127.0.0.1",
      port: 0,
      requestGuard: new McpHttpRequestGuard(10, 60_000, 8)
    });
    try {
      const response = await fetch(`http://127.0.0.1:${sizeLimited.port}/mcp`, {
        method: "POST",
        body: "payload too large"
      });
      expect(response.status).toBe(413);
    } finally {
      await sizeLimited.close();
    }
  });

  it("uses forwarding headers only when trusted proxy mode is explicit", async () => {
    const server = await startMcpHttpServer({
      host: "127.0.0.1",
      port: 0,
      requestGuard: new McpHttpRequestGuard(1, 60_000, 1024, true)
    });
    try {
      const first = await fetch(`http://127.0.0.1:${server.port}/health`, {
        headers: { "x-forwarded-for": "203.0.113.10" }
      });
      const secondClient = await fetch(`http://127.0.0.1:${server.port}/health`, {
        headers: { "x-forwarded-for": "203.0.113.11" }
      });
      const repeated = await fetch(`http://127.0.0.1:${server.port}/health`, {
        headers: { "x-forwarded-for": "203.0.113.10" }
      });

      expect(first.status).toBe(200);
      expect(secondClient.status).toBe(200);
      expect(repeated.status).toBe(429);
    } finally {
      await server.close();
    }
  });
});

describe("CORS helpers", () => {
  describe("parseCorsAllowedOrigins", () => {
    it("returns an empty set for undefined", () => {
      expect(parseCorsAllowedOrigins(undefined).size).toBe(0);
    });

    it("returns an empty set for an empty string", () => {
      expect(parseCorsAllowedOrigins("").size).toBe(0);
    });

    it("parses a single origin", () => {
      const s = parseCorsAllowedOrigins("https://app.example.com");
      expect(s.has("https://app.example.com")).toBe(true);
    });

    it("parses multiple comma-separated origins and trims whitespace", () => {
      const s = parseCorsAllowedOrigins(
        "https://a.example.com , https://b.example.com"
      );
      expect(s.has("https://a.example.com")).toBe(true);
      expect(s.has("https://b.example.com")).toBe(true);
      expect(s.size).toBe(2);
    });

    it("passes through wildcard", () => {
      const s = parseCorsAllowedOrigins("*");
      expect(s.has("*")).toBe(true);
    });
  });

  describe("resolveCorsOrigin", () => {
    it("returns null when allowed set is empty", () => {
      expect(resolveCorsOrigin("https://app.example.com", new Set())).toBeNull();
    });

    it("returns * when the allowed set contains *", () => {
      expect(resolveCorsOrigin("https://app.example.com", new Set(["*"]))).toBe("*");
    });

    it("returns the origin when it is in the allowed set", () => {
      const allowed = new Set(["https://app.example.com"]);
      expect(resolveCorsOrigin("https://app.example.com", allowed)).toBe(
        "https://app.example.com"
      );
    });

    it("returns null when the origin is not in the allowed set", () => {
      const allowed = new Set(["https://app.example.com"]);
      expect(resolveCorsOrigin("https://attacker.example.com", allowed)).toBeNull();
    });

    it("returns null when the request has no origin header", () => {
      const allowed = new Set(["https://app.example.com"]);
      expect(resolveCorsOrigin(undefined, allowed)).toBeNull();
    });
  });
});

describe("CORS HTTP integration", () => {
  it("responds to OPTIONS preflight with 204 and correct CORS headers", async () => {
    const server = await startMcpHttpServer({
      host: "127.0.0.1",
      port: 0,
      allowedOrigins: new Set(["https://app.example.com"])
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "OPTIONS",
        headers: {
          origin: "https://app.example.com",
          "access-control-request-method": "POST",
          "access-control-request-headers": "Content-Type, Mcp-Session-Id"
        }
      });

      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe(
        "https://app.example.com"
      );
      expect(response.headers.get("access-control-allow-headers")).toMatch(
        /Mcp-Session-Id/i
      );
      expect(response.headers.get("access-control-allow-headers")).toMatch(
        /Mcp-Protocol-Version/i
      );
      expect(response.headers.get("access-control-allow-headers")).toMatch(/traceparent/i);
      expect(response.headers.get("access-control-expose-headers")).toMatch(
        /Mcp-Session-Id/i
      );
      expect(response.headers.get("access-control-expose-headers")).toMatch(/traceparent/i);
      expect(response.headers.get("access-control-allow-credentials")).toBe("true");
      expect(response.headers.get("access-control-max-age")).toBeTruthy();
    } finally {
      await server.close();
    }
  });

  it("does not emit CORS headers for unknown origins", async () => {
    const server = await startMcpHttpServer({
      host: "127.0.0.1",
      port: 0,
      allowedOrigins: new Set(["https://app.example.com"])
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`, {
        headers: { origin: "https://attacker.example.com" }
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("emits wildcard CORS header when configured with *", async () => {
    const server = await startMcpHttpServer({
      host: "127.0.0.1",
      port: 0,
      allowedOrigins: new Set(["*"])
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`, {
        headers: { origin: "https://any.example.com" }
      });

      expect(response.status).toBe(200);
      expect(response.headers.get("access-control-allow-origin")).toBe("*");
      // No Allow-Credentials when using wildcard (browser restriction)
      expect(response.headers.get("access-control-allow-credentials")).toBeNull();
    } finally {
      await server.close();
    }
  });

  it("exposes Mcp-Session-Id in the Access-Control-Expose-Headers for non-OPTIONS requests", async () => {
    const server = await startMcpHttpServer({
      host: "127.0.0.1",
      port: 0,
      allowedOrigins: new Set(["https://app.example.com"])
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`, {
        headers: { origin: "https://app.example.com" }
      });

      expect(response.headers.get("access-control-expose-headers")).toMatch(
        /Mcp-Session-Id/i
      );
    } finally {
      await server.close();
    }
  });

  it("returns 405 for non-GET on utility routes even with a known origin", async () => {
    const server = await startMcpHttpServer({
      host: "127.0.0.1",
      port: 0,
      allowedOrigins: new Set(["https://app.example.com"])
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/health`, {
        method: "POST",
        headers: { origin: "https://app.example.com" }
      });

      expect(response.status).toBe(405);
    } finally {
      await server.close();
    }
  });

  it("OPTIONS preflight with no matching origin returns 204 but no CORS headers", async () => {
    const server = await startMcpHttpServer({
      host: "127.0.0.1",
      port: 0,
      allowedOrigins: new Set(["https://app.example.com"])
    });

    try {
      const response = await fetch(`http://127.0.0.1:${server.port}/mcp`, {
        method: "OPTIONS",
        headers: { origin: "https://evil.example.com" }
      });

      // Still 204 (handler ran), but no CORS origin header
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBeNull();
    } finally {
      await server.close();
    }
  });
});

describe("applyCorsHeaders unit", () => {
  /**
   * Small helper: run applyCorsHeaders against synthetic IncomingMessage /
   * ServerResponse stand-ins without starting a real server.
   */
  function mockPair(method: string, origin?: string) {
    const capturedHeaders: Record<string, string | string[]> = {};
    let statusCode = 0;
    let ended = false;

    const request = {
      method,
      headers: origin !== undefined ? { origin } : {}
    } as unknown as IncomingMessage;

    const response = {
      setHeader(name: string, value: string) {
        capturedHeaders[name.toLowerCase()] = value;
      },
      writeHead(code: number) {
        statusCode = code;
      },
      end() {
        ended = true;
      },
      headersSent: false
    } as unknown as ServerResponse;

    return { request, response, capturedHeaders, getStatus: () => statusCode, isEnded: () => ended };
  }

  it("returns true and ends the response for OPTIONS preflight with a known origin", () => {
    const { request, response, capturedHeaders, getStatus, isEnded } = mockPair(
      "OPTIONS",
      "https://app.example.com"
    );
    const handled = applyCorsHeaders(request, response, new Set(["https://app.example.com"]));
    expect(handled).toBe(true);
    expect(isEnded()).toBe(true);
    expect(getStatus()).toBe(204);
    expect(capturedHeaders["access-control-allow-origin"]).toBe("https://app.example.com");
  });

  it("returns false for non-OPTIONS requests", () => {
    const { request, response } = mockPair("POST", "https://app.example.com");
    const handled = applyCorsHeaders(request, response, new Set(["https://app.example.com"]));
    expect(handled).toBe(false);
  });

  it("returns true for OPTIONS even when origin is not in the set", () => {
    const { request, response, getStatus, isEnded } = mockPair(
      "OPTIONS",
      "https://evil.example.com"
    );
    const handled = applyCorsHeaders(request, response, new Set(["https://app.example.com"]));
    expect(handled).toBe(true);
    expect(isEnded()).toBe(true);
    expect(getStatus()).toBe(204);
  });
});
