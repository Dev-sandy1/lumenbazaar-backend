import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  probeHorizonEndpointsWithFailover,
  probeRpcEndpointsWithFailover
} from "./clients.js";
import {
  getCircuitSnapshot,
  recordFailure,
  recordSuccess,
  resetCircuitState
} from "./circuitBreaker.js";

function okResponse(): Response {
  return {
    ok: true,
    json: async () => ({ result: { sequence: 1 } })
  } as unknown as Response;
}

function failResponse(): Response {
  return { ok: false, status: 503 } as unknown as Response;
}

describe("circuit breaker + RPC failover", () => {
  const urlA = "https://rpc-a.testnet.example.com";
  const urlB = "https://rpc-b.testnet.example.com";

  beforeEach(() => {
    resetCircuitState();
    vi.restoreAllMocks();
  });

  afterEach(() => {
    resetCircuitState();
  });

  it("partial outage: fails over to second endpoint when first errors", async () => {
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValueOnce(failResponse() as unknown as Response)
      .mockResolvedValueOnce(okResponse() as unknown as Response);

    const result = await probeRpcEndpointsWithFailover([urlA, urlB]);

    expect(result.succeeded).toBe(true);
    expect(result.endpoint).toBe("https://rpc-b.testnet.example.com");
    expect(result.errors.length).toBe(1);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("stale RPC: opens circuit after threshold failures and skips endpoint", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(failResponse() as unknown as Response);

    // Three consecutive failures against A open its circuit.
    for (let i = 0; i < 3; i += 1) {
      await probeRpcEndpointsWithFailover([urlA], { cooldownMs: 60_000 });
    }

    const snapshot = getCircuitSnapshot();
    const a = snapshot.find((s) => s.endpoint === "https://rpc-a.testnet.example.com");
    expect(a?.state).toBe("open");
    expect(a?.consecutiveFailures).toBeGreaterThanOrEqual(3);

    // Reset the spy so we can prove the next call does NOT probe.
    vi.restoreAllMocks();
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(okResponse() as unknown as Response);

    const result = await probeRpcEndpointsWithFailover([urlA], { cooldownMs: 60_000 });

    expect(result.succeeded).toBe(false);
    expect(result.errors.some((e) => e.message === "circuit open")).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("recovery: half-open trial succeeds and closes circuit", async () => {
    // Force circuit A open.
    recordFailure(urlA);
    recordFailure(urlA);
    recordFailure(urlA);
    expect(getCircuitSnapshot().find((s) => s.endpoint === "https://rpc-a.testnet.example.com")?.state).toBe(
      "open"
    );

    // Fast-forward past cooldown by passing an explicit cooldown of 0.
    const fetchSpy = vi
      .spyOn(global, "fetch")
      .mockResolvedValue(okResponse() as unknown as Response);

    const result = await probeRpcEndpointsWithFailover([urlA], { cooldownMs: 0 });

    expect(result.succeeded).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(1);

    const snap = getCircuitSnapshot().find((s) => s.endpoint === "https://rpc-a.testnet.example.com");
    expect(snap?.state).toBe("closed");
    expect(snap?.consecutiveFailures).toBe(0);
  });

  it("all-endpoint failure returns succeeded=false with every error captured", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(failResponse() as unknown as Response);

    const result = await probeRpcEndpointsWithFailover([urlA, urlB]);

    expect(result.succeeded).toBe(false);
    expect(result.errors.length).toBe(2);
    expect(result.errors[0]?.endpoint).toBe("https://rpc-a.testnet.example.com");
    expect(result.errors[1]?.endpoint).toBe("https://rpc-b.testnet.example.com");

    // Both circuits should now be open (default threshold is 3, but
    // recordFailure was called once per endpoint in this single attempt;
    // force a second and third attempt to confirm both open).
    await probeRpcEndpointsWithFailover([urlA, urlB]);
    await probeRpcEndpointsWithFailover([urlA, urlB]);
    const snapshot = getCircuitSnapshot();
    expect(snapshot.every((s) => s.state === "open")).toBe(true);
  });

  it("Horizon failover uses the same path", async () => {
    const horizonA = "https://horizon-a.testnet.example.com";
    const horizonB = "https://horizon-b.testnet.example.com";

    vi.spyOn(global, "fetch")
      .mockResolvedValueOnce(failResponse() as unknown as Response)
      .mockResolvedValueOnce(okResponse() as unknown as Response);

    const result = await probeHorizonEndpointsWithFailover([horizonA, horizonB]);

    expect(result.succeeded).toBe(true);
    expect(result.endpoint).toBe("https://horizon-b.testnet.example.com");
  });

  it("credentials never appear in the circuit snapshot", async () => {
    // Prime a failure against a URL that embeds a secret token.
    const withSecret = "https://rpc-a.testnet.example.com/very-secret-token";
    recordFailure(withSecret);
    const snap = getCircuitSnapshot();
    const entry = snap.find((s) => s.endpoint === "https://rpc-a.testnet.example.com");
    expect(entry).toBeDefined();
    expect(JSON.stringify(snap)).not.toContain("very-secret-token");
  });
});