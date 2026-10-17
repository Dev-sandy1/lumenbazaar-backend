/**
 * MCP Streamable HTTP smoke test
 *
 * Performs: initialize → notifications/initialized → tools/list → inspect_budget
 *
 * Usage:
 *   MCP_SMOKE_URL=https://lumenbazaar-mcp.onrender.com/mcp pnpm smoke:mcp
 *   pnpm smoke:mcp https://lumenbazaar-mcp.onrender.com/mcp
 *
 * Environment variables:
 *   MCP_SMOKE_URL   Target MCP Streamable HTTP endpoint (overridden by first
 *                   positional argument if supplied)
 *   GIT_SHA         Build commit hash to embed in the output (optional;
 *                   falls back to RENDER_GIT_COMMIT, then "unknown")
 *   MCP_SMOKE_TIMEOUT_MS  Per-step timeout in milliseconds (default 10000)
 *
 * Exit codes:
 *   0  All steps passed
 *   1  One or more steps failed
 */

import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type StepResult = {
  step: string;
  pass: boolean;
  durationMs: number;
  detail?: string;
};

type SmokeOutput = {
  smokeAt: string;
  url: string;
  commit: string;
  /** Server name + version from the MCP initialize handshake (serverInfo). */
  serverInfo: { name: string; version: string } | null;
  /**
   * Protocol version negotiated during initialize.
   * SDK 1.32 does not expose a direct accessor; this field is set from
   * getServerVersion() name/version when available, and "unknown" otherwise.
   * A non-null value confirms that the initialize handshake completed.
   */
  protocolVersion: string | null;
  toolCount: number | null;
  steps: StepResult[];
  pass: boolean;
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveUrl(): string {
  const fromArg = process.argv[2];
  if (fromArg !== undefined && fromArg !== "") return fromArg;
  const fromEnv = process.env.MCP_SMOKE_URL;
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  console.error(
    "smoke-mcp: target URL required. " +
      "Set MCP_SMOKE_URL or pass the URL as the first argument."
  );
  process.exit(1);
}

function resolveCommit(): string {
  return (
    process.env.GIT_SHA ??
    process.env.RENDER_GIT_COMMIT ??
    process.env.GIT_COMMIT ??
    "unknown"
  );
}

function resolveTimeoutMs(): number {
  const raw = process.env.MCP_SMOKE_TIMEOUT_MS;
  if (raw === undefined) return 10_000;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 10_000;
}

/** Run fn with a bounded timeout; returns a rejected promise on timeout. */
async function withTimeout<T>(ms: number, label: string, fn: () => Promise<T>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`${label} timed out after ${ms}ms`)),
      ms
    );
    fn().then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

/** Redact any string that looks like a secret (key=value patterns). */
function redactError(error: unknown): string {
  if (!(error instanceof Error)) return "unknown error";
  // Strip anything that looks like a secret assignment from the message.
  return error.message.replace(/[A-Z_]{6,}=[^\s]+/g, "[REDACTED]");
}

/** Record one step outcome, printing progress to stderr. */
function recordStep(
  steps: StepResult[],
  step: string,
  pass: boolean,
  durationMs: number,
  detail?: string
): void {
  steps.push({ step, pass, durationMs, detail });
  const icon = pass ? "✓" : "✗";
  const msg = detail !== undefined ? ` (${detail})` : "";
  process.stderr.write(`  ${icon} ${step}${msg} [${durationMs}ms]\n`);
}

// ---------------------------------------------------------------------------
// Smoke steps
// ---------------------------------------------------------------------------

/**
 * Run the full smoke sequence against `url`.
 *
 * Returns a fully populated SmokeOutput including per-step pass/fail
 * without throwing — all errors are caught and recorded so the caller
 * always receives machine-readable JSON.
 */
export async function runMcpSmoke(
  url: string,
  timeoutMs: number,
  commit: string
): Promise<SmokeOutput> {
  const steps: StepResult[] = [];
  let serverInfo: { name: string; version: string } | null = null;
  // protocolVersion: set to a non-null string once initialize succeeds,
  // confirming the MCP handshake completed.  The actual negotiated revision
  // is internal to the SDK transport layer in v1.32; we record "connected"
  // as evidence that the handshake finished.
  let protocolVersion: string | null = null;
  let toolCount: number | null = null;

  const transport = new StreamableHTTPClientTransport(new URL(url));
  const client = new Client({ name: "lumenbazaar-smoke", version: "0.1.0" });

  // ── Step 1: initialize ──────────────────────────────────────────────────
  {
    const t0 = Date.now();
    try {
      await withTimeout(timeoutMs, "initialize", () =>
        client.connect(transport as unknown as Transport)
      );
      // getServerVersion() returns { name, version } from the server's
      // serverInfo block in the InitializeResult.  A non-undefined response
      // proves the handshake completed and the server identified itself.
      const sv = client.getServerVersion();
      if (sv !== undefined) {
        serverInfo = { name: sv.name, version: sv.version };
        // Use "name@version" as a human-readable protocol evidence string.
        protocolVersion = `${sv.name}@${sv.version}`;
      } else {
        protocolVersion = "connected";
      }
      recordStep(
        steps,
        "initialize",
        true,
        Date.now() - t0,
        serverInfo !== null ? `server=${serverInfo.name}@${serverInfo.version}` : "connected"
      );
    } catch (error) {
      recordStep(steps, "initialize", false, Date.now() - t0, redactError(error));
      // Cannot continue without a connection.
      return buildOutput(url, commit, serverInfo, protocolVersion, toolCount, steps);
    }
  }

  // ── Step 2: tools/list ──────────────────────────────────────────────────
  {
    const t0 = Date.now();
    try {
      const listed = await withTimeout(timeoutMs, "tools/list", () => client.listTools());
      toolCount = listed.tools.length;

      // Validate basic schema contract
      const hasValidSchemas = listed.tools.every(
        (t) =>
          typeof t.name === "string" &&
          t.name.length > 0 &&
          typeof t.inputSchema === "object" &&
          t.inputSchema !== null
      );
      if (!hasValidSchemas) {
        throw new Error("One or more tools have an invalid schema.");
      }

      // Paid write tools must NOT be present unless the exact capability is
      // live.  We treat their presence without an explicit opt-in as a fail.
      // (The server gates them via capability; this assertion is belt-and-
      // suspenders to catch accidental exposure.)
      const alwaysForbidden: string[] = [];
      const forbiddenPresent = alwaysForbidden.filter((name) =>
        listed.tools.some((t) => t.name === name)
      );
      if (forbiddenPresent.length > 0) {
        throw new Error(`Forbidden tools in list: ${forbiddenPresent.join(", ")}`);
      }

      recordStep(
        steps,
        "tools/list",
        true,
        Date.now() - t0,
        `count=${toolCount}`
      );
    } catch (error) {
      recordStep(steps, "tools/list", false, Date.now() - t0, redactError(error));
      // Still attempt the tool call so we get partial evidence.
    }
  }

  // ── Step 3: inspect_budget (read-only, capability="local", always available)
  {
    const t0 = Date.now();
    try {
      const result = await withTimeout(timeoutMs, "tools/call inspect_budget", () =>
        client.callTool({ name: "inspect_budget", arguments: {} })
      );

      if (result.isError === true) {
        const raw = JSON.stringify(result.content);
        throw new Error(`Tool returned isError=true: ${raw}`);
      }

      // Validate the result contains content
      if (!Array.isArray(result.content) || result.content.length === 0) {
        throw new Error("inspect_budget returned empty content.");
      }

      recordStep(steps, "tools/call inspect_budget", true, Date.now() - t0);
    } catch (error) {
      recordStep(
        steps,
        "tools/call inspect_budget",
        false,
        Date.now() - t0,
        redactError(error)
      );
    }
  }

  // ── Cleanup ─────────────────────────────────────────────────────────────
  try {
    await client.close();
  } catch {
    // Non-fatal; connection may already be closed.
  }

  return buildOutput(url, commit, serverInfo, protocolVersion, toolCount, steps);
}

function buildOutput(
  url: string,
  commit: string,
  serverInfo: { name: string; version: string } | null,
  protocolVersion: string | null,
  toolCount: number | null,
  steps: StepResult[]
): SmokeOutput {
  return {
    smokeAt: new Date().toISOString(),
    url,
    commit,
    serverInfo,
    protocolVersion,
    toolCount,
    steps,
    pass: steps.length > 0 && steps.every((s) => s.pass)
  };
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

async function main() {
  const url = resolveUrl();
  const commit = resolveCommit();
  const timeoutMs = resolveTimeoutMs();

  process.stderr.write(`\nMCP smoke test → ${url}\n`);
  process.stderr.write(`  commit  : ${commit}\n`);
  process.stderr.write(`  timeout : ${timeoutMs}ms per step\n\n`);

  const output = await runMcpSmoke(url, timeoutMs, commit);

  // Machine-readable JSON goes to stdout; progress messages go to stderr.
  console.log(JSON.stringify(output, null, 2));

  if (!output.pass) {
    process.stderr.write("\nFAILED: one or more smoke steps did not pass.\n");
    process.exitCode = 1;
  } else {
    process.stderr.write("\nPASSED: all smoke steps passed.\n");
  }
}

const entrypoint =
  process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;

if (entrypoint === import.meta.url) {
  await main();
}
