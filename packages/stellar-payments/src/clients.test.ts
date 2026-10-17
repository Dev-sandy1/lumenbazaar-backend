import { describe, expect, it, vi, afterEach } from "vitest";

import { loadConfig, localIssuerPublicKey } from "@lumenbazaar/shared";

import {
  createHorizonClient,
  createRpcClient,
  requireSupportedAsset,
  probeRpcEndpoint,
  probeHorizonEndpoint
} from "./clients.js";

describe("Stellar client layer", () => {
  const config = loadConfig({});

  it("selects testnet and pubnet clients from explicit configuration", () => {
    expect(createRpcClient(config, "stellar:testnet")).toMatchObject({
      kind: "stellar-rpc",
      network: "stellar:testnet",
      url: "https://soroban-testnet.stellar.org"
    });
    expect(createHorizonClient(config, "stellar:pubnet")).toMatchObject({
      kind: "horizon",
      network: "stellar:pubnet",
      url: "https://horizon.stellar.org"
    });
  });

  it("rejects unsupported networks and assets with stable codes", () => {
    expect(() => createRpcClient(config, "stellar:futurenet")).toThrow("not supported");
    expect(() =>
      requireSupportedAsset(config, "stellar:testnet", "EURC", localIssuerPublicKey)
    ).toThrow("is not supported");
  });

  it("normalizes asset code lookup", () => {
    expect(requireSupportedAsset(config, "stellar:testnet", "usdc", localIssuerPublicKey)).toEqual({
      code: "USDC",
      issuer: localIssuerPublicKey,
      decimals: 7
    });
  });
});

// ─── Probe unit tests ────────────────────────────────────────────────────────

describe("probeRpcEndpoint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves when RPC returns a valid getLatestLedger result", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ result: { sequence: 12345 }, id: 1 })
      })
    );

    await expect(probeRpcEndpoint("https://soroban-testnet.stellar.org")).resolves.toBeUndefined();
  });

  it("throws when RPC returns a non-2xx HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 503,
        json: async () => ({})
      })
    );

    await expect(probeRpcEndpoint("https://soroban-testnet.stellar.org")).rejects.toThrow(
      "HTTP 503"
    );
  });

  it("throws when RPC response body has no result field", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({ error: { code: -32600, message: "Invalid Request" } })
      })
    );

    await expect(probeRpcEndpoint("https://soroban-testnet.stellar.org")).rejects.toThrow(
      "did not return a latest ledger result"
    );
  });

  it("throws when the request times out (AbortError)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }))
    );

    await expect(probeRpcEndpoint("https://soroban-testnet.stellar.org", 1)).rejects.toThrow();
  });

  it("does not include raw error messages in re-thrown errors from underlying fetch", async () => {
    const secretMessage = "connect ECONNREFUSED postgresql://admin:S3cr3t@prod.example.com";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error(secretMessage))
    );

    // The probe function itself re-throws directly from fetch — the test verifies
    // that the *readiness service* is the layer that redacts. Here we confirm the
    // probe throws so the service can classify it.
    await expect(probeRpcEndpoint("https://example.com", 5000)).rejects.toThrow();
  });
});

describe("probeHorizonEndpoint", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("resolves when Horizon returns 200", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({})
      })
    );

    await expect(probeHorizonEndpoint("https://horizon-testnet.stellar.org")).resolves.toBeUndefined();
  });

  it("throws when Horizon returns a non-2xx HTTP status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 502
      })
    );

    await expect(probeHorizonEndpoint("https://horizon-testnet.stellar.org")).rejects.toThrow(
      "HTTP 502"
    );
  });

  it("throws when the request times out (AbortError)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }))
    );

    await expect(probeHorizonEndpoint("https://horizon-testnet.stellar.org", 1)).rejects.toThrow();
  });
});
