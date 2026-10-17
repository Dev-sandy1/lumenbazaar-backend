/**
 * Tests for the MCP smoke-test script.
 *
 * Validates:
 * - smoke passes against an in-process server with a working MCP stack
 * - smoke fails (non-zero-equivalent) against a broken server
 * - paid write tools are not callable/exposed when capabilities are absent
 */

import { describe, expect, it, vi } from "vitest";

import { BackendClient } from "../apps/mcp-server/src/client.js";
import { startMcpHttpServer } from "../apps/mcp-server/src/http.js";
import { runMcpSmoke } from "./smoke-mcp.js";

const TIMEOUT_MS = 15_000;

describe("MCP smoke script", () => {
  it(
    "passes all steps against a healthy in-process MCP server",
    async () => {
      const backend = new BackendClient("https://api.example.test");

      // Only stub the methods that inspect_budget would indirectly touch; the
      // tool itself uses McpPaymentToolService.inspectBudget() which is purely
      // local — no network calls required.
      vi.spyOn(backend, "getToolCapabilities").mockResolvedValue({
        backend: true,
        exact: false
      });

      const server = await startMcpHttpServer({
        host: "127.0.0.1",
        port: 0,
        client: backend,
        capabilityProvider: async () => ({ backend: true, exact: false })
      });

      try {
        const output = await runMcpSmoke(server.url, TIMEOUT_MS, "test-sha-abc123");

        expect(output.pass).toBe(true);
        expect(output.commit).toBe("test-sha-abc123");
        expect(output.url).toBe(server.url);
        // protocolVersion is set to a non-null string once initialize completes
        expect(output.protocolVersion).toBeTruthy();
        // serverInfo reflects the server's self-declared name + version
        expect(output.serverInfo).not.toBeNull();
        expect(output.serverInfo?.name).toBe("lumenbazaar");
        expect(typeof output.toolCount).toBe("number");
        expect(output.toolCount).toBeGreaterThan(0);

        // Every step must pass
        for (const step of output.steps) {
          expect(step.pass, `step "${step.step}" failed: ${step.detail ?? ""}`).toBe(true);
        }

        // All three required steps must be present
        const stepNames = output.steps.map((s) => s.step);
        expect(stepNames).toContain("initialize");
        expect(stepNames).toContain("tools/list");
        expect(stepNames).toContain("tools/call inspect_budget");
      } finally {
        await server.close();
        vi.restoreAllMocks();
      }
    },
    TIMEOUT_MS + 5_000
  );

  it(
    "fails (pass=false) when the server refuses the connection",
    async () => {
      // Use a port that is definitely not listening.
      const output = await runMcpSmoke(
        "http://127.0.0.1:1", // port 1 is privileged and always refused
        2_000,
        "dead-sha"
      );

      expect(output.pass).toBe(false);
      // The initialize step must be recorded as failed
      const initStep = output.steps.find((s) => s.step === "initialize");
      expect(initStep).toBeDefined();
      expect(initStep?.pass).toBe(false);
    },
    10_000
  );

  it(
    "fails when the server returns an MCP error for inspect_budget",
    async () => {
      const backend = new BackendClient("https://api.example.test");
      vi.spyOn(backend, "getToolCapabilities").mockResolvedValue({
        backend: false,
        exact: false
      });

      const server = await startMcpHttpServer({
        host: "127.0.0.1",
        port: 0,
        client: backend,
        capabilityProvider: async () => ({ backend: false, exact: false })
      });

      // Spy on McpPaymentToolService.prototype.inspectBudget so it throws,
      // which causes the MCP server to return isError=true to the client.
      const { McpPaymentToolService } = await import(
        "../apps/mcp-server/src/paymentTools.js"
      );
      const inspectSpy = vi
        .spyOn(McpPaymentToolService.prototype, "inspectBudget")
        .mockImplementation(() => {
          throw new Error("Simulated budget inspect failure");
        });

      try {
        const output = await runMcpSmoke(server.url, TIMEOUT_MS, "broken-sha");

        // inspect_budget failure → isError=true from server → smoke step fails
        const budgetStep = output.steps.find((s) => s.step === "tools/call inspect_budget");
        expect(budgetStep).toBeDefined();
        expect(budgetStep?.pass).toBe(false);
        expect(output.pass).toBe(false);
      } finally {
        inspectSpy.mockRestore();
        await server.close();
        vi.restoreAllMocks();
      }
    },
    TIMEOUT_MS + 5_000
  );

  it(
    "paid write tools (call_paid_resource, prepare_payment) are not callable when exact capability is absent",
    async () => {
      const backend = new BackendClient("https://api.example.test");
      vi.spyOn(backend, "getToolCapabilities").mockResolvedValue({
        backend: false,
        exact: false
      });

      const server = await startMcpHttpServer({
        host: "127.0.0.1",
        port: 0,
        client: backend,
        // Exact capability absent → these tools must not appear in tools/list
        capabilityProvider: async () => ({ backend: false, exact: false })
      });

      const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
      const { StreamableHTTPClientTransport } = await import(
        "@modelcontextprotocol/sdk/client/streamableHttp.js"
      );

      const transport = new StreamableHTTPClientTransport(new URL(server.url));
      const client = new Client({ name: "paid-gate-test", version: "0.1.0" });

      try {
        await client.connect(transport as never);
        const listed = await client.listTools();
        const toolNames = listed.tools.map((t) => t.name);

        expect(toolNames).not.toContain("call_paid_resource");
        expect(toolNames).not.toContain("prepare_payment");

        // Attempting to call a hidden paid tool must return isError=true
        const callResult = await client.callTool({
          name: "call_paid_resource",
          arguments: {}
        });
        expect(callResult.isError).toBe(true);
        expect(JSON.stringify(callResult.content)).toContain("CAPABILITY_UNAVAILABLE");
      } finally {
        await client.close();
        await server.close();
        vi.restoreAllMocks();
      }
    },
    TIMEOUT_MS + 5_000
  );
});
