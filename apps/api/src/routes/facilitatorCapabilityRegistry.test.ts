/**
 * Integration tests for the facilitator route driven by the capability registry.
 *
 * Covers all four capability combinations (exact only, upto only, both, neither)
 * and verifies that /v1/supported accurately reflects registry state, including
 * the regression case where an env flag alone does NOT make a scheme supported
 * when its adapter fails the startup check.
 */
import { describe, expect, it } from "vitest";

import { loadConfig } from "@lumenbazaar/shared";
import {
  InMemoryPaymentAttemptStore,
  PaymentVerificationService,
  SettlementService,
  type X402StellarAdapter,
} from "@lumenbazaar/stellar-payments";

import { buildApiApp } from "../app.js";
import {
  createStaticCapabilityRegistry,
} from "../services/capabilityRegistry.js";
import { createStaticReadinessService } from "../services/readiness.js";

// ─── Shared test adapter ──────────────────────────────────────────────────────

const exactAdapter: X402StellarAdapter = {
  async verifyExact() {
    return { valid: true, adapter: "@x402/stellar" };
  },
  async settleExact() {
    return {
      transactionHash: "tx_cap_registry",
      ledger: 100,
      status: "confirmed",
      adapter: "@x402/stellar",
    };
  },
};

const contractId = "CDLZUPTOSESSIONCONTRACT000000000000000000000000000000000";
const assetContractId = "CDLZUSDCTOKENCONTRACT0000000000000000000000000000000000";

function enabledUptoConfig() {
  return loadConfig({
    ENABLE_UPTO_SCHEME: "true",
    STELLAR_TESTNET_UPTO_SESSION_CONTRACT_ID: contractId,
    STELLAR_TESTNET_USDC_CONTRACT_ID: assetContractId,
  });
}

// ─── Combination 1: exact only ────────────────────────────────────────────────

describe("facilitator – exact only", () => {
  it("advertises exact but not upto", async () => {
    const config = loadConfig({});
    const registry = createStaticCapabilityRegistry(
      { exact: true, upto: false },
      ["stellar:testnet"]
    );
    const app = buildApiApp({
      logger: false,
      config,
      capabilityRegistry: registry,
      readinessService: createStaticReadinessService(config, { exact: true, upto: false }),
    });

    const response = await app.inject({ method: "GET", url: "/v1/supported" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.kinds).toHaveLength(1);
    expect(body.kinds[0]).toMatchObject({ scheme: "exact", network: "stellar:testnet" });
    expect(body.signers).toMatchObject({ "stellar:*": expect.any(Array) });
    await app.close();
  });

  it("fails closed with empty kinds when readiness is degraded", async () => {
    const config = loadConfig({});
    const registry = createStaticCapabilityRegistry(
      { exact: true, upto: false },
      ["stellar:testnet"]
    );
    const app = buildApiApp({
      logger: false,
      config,
      capabilityRegistry: registry,
      // readiness says exact is NOT available (dependency down)
      readinessService: createStaticReadinessService(config, { exact: false, upto: false }),
    });

    const response = await app.inject({ method: "GET", url: "/v1/supported" });

    expect(response.statusCode).toBe(200);
    expect(response.json().kinds).toHaveLength(0);
    expect(response.json().signers).toEqual({});
    await app.close();
  });
});

// ─── Combination 2: upto only ─────────────────────────────────────────────────

describe("facilitator – upto only", () => {
  it("advertises upto but not exact", async () => {
    const config = enabledUptoConfig();
    const registry = createStaticCapabilityRegistry(
      { exact: false, upto: true },
      ["stellar:testnet"]
    );
    const app = buildApiApp({
      logger: false,
      config,
      capabilityRegistry: registry,
      readinessService: createStaticReadinessService(config, { exact: false, upto: true }),
    });

    const response = await app.inject({ method: "GET", url: "/v1/supported" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    const uptoKinds = body.kinds.filter((k: { scheme: string }) => k.scheme === "upto");
    const exactKinds = body.kinds.filter((k: { scheme: string }) => k.scheme === "exact");
    expect(uptoKinds).toHaveLength(1);
    expect(exactKinds).toHaveLength(0);
    expect(uptoKinds[0]).toMatchObject({
      scheme: "upto",
      network: "stellar:testnet",
    });
    await app.close();
  });
});

// ─── Combination 3: both ──────────────────────────────────────────────────────

describe("facilitator – both exact and upto", () => {
  it("advertises both schemes", async () => {
    const config = enabledUptoConfig();
    const registry = createStaticCapabilityRegistry(
      { exact: true, upto: true },
      ["stellar:testnet"]
    );
    const app = buildApiApp({
      logger: false,
      config,
      capabilityRegistry: registry,
      readinessService: createStaticReadinessService(config, { exact: true, upto: true }),
    });

    const response = await app.inject({ method: "GET", url: "/v1/supported" });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.kinds).toHaveLength(2);
    const schemes = body.kinds.map((k: { scheme: string }) => k.scheme).sort();
    expect(schemes).toEqual(["exact", "upto"]);
    await app.close();
  });
});

// ─── Combination 4: neither ───────────────────────────────────────────────────

describe("facilitator – neither scheme", () => {
  it("returns empty kinds list and empty signers", async () => {
    const config = loadConfig({});
    const registry = createStaticCapabilityRegistry({}, ["stellar:testnet"]);
    const app = buildApiApp({
      logger: false,
      config,
      capabilityRegistry: registry,
      readinessService: createStaticReadinessService(config, { exact: false, upto: false }),
    });

    const response = await app.inject({ method: "GET", url: "/v1/supported" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      kinds: [],
      extensions: ["bazaar"],
      signers: {},
    });
    await app.close();
  });

  it("service starts and stays healthy (200) when no scheme is supported", async () => {
    const config = loadConfig({});
    const registry = createStaticCapabilityRegistry({}, ["stellar:testnet"]);
    const app = buildApiApp({
      logger: false,
      config,
      capabilityRegistry: registry,
      readinessService: createStaticReadinessService(config, { exact: false, upto: false }),
    });

    const health = await app.inject({ method: "GET", url: "/health" });
    const supported = await app.inject({ method: "GET", url: "/v1/supported" });

    expect(health.statusCode).toBe(200);
    expect(supported.statusCode).toBe(200);
    expect(supported.json().kinds).toHaveLength(0);
    await app.close();
  });
});

// ─── Registry drives conformance reservations ─────────────────────────────────

describe("facilitator – registry drives conformance", () => {
  it("reserves exact conformance cases when registry reports exact unavailable", async () => {
    const config = loadConfig({});
    const attemptStore = new InMemoryPaymentAttemptStore();
    const verificationService = new PaymentVerificationService(config, {
      adapter: exactAdapter,
      attemptStore,
    });
    const settlementService = new SettlementService(config, {
      adapter: exactAdapter,
      attemptStore,
    });

    // Neither scheme available in registry
    const registry = createStaticCapabilityRegistry({}, ["stellar:testnet"]);
    const app = buildApiApp({
      logger: false,
      config,
      capabilityRegistry: registry,
      readinessService: createStaticReadinessService(config, { exact: false, upto: false }),
      verificationService,
      settlementService,
    });

    const run = await app.inject({
      method: "POST",
      url: "/v1/conformance/runs",
      payload: { network: "stellar:testnet" },
    });

    expect(run.statusCode).toBe(200);
    expect(run.json().reservedCount).toBe(6);
    expect(run.json().passedCount).toBe(0);
    await app.close();
  });

  it("runs exact conformance cases when registry reports exact available", async () => {
    const config = loadConfig({});
    const attemptStore = new InMemoryPaymentAttemptStore();
    const verificationService = new PaymentVerificationService(config, {
      adapter: exactAdapter,
      attemptStore,
    });
    const settlementService = new SettlementService(config, {
      adapter: exactAdapter,
      attemptStore,
    });

    // Exact available in registry
    const registry = createStaticCapabilityRegistry(
      { exact: true, upto: false },
      ["stellar:testnet"]
    );
    const app = buildApiApp({
      logger: false,
      config,
      capabilityRegistry: registry,
      readinessService: createStaticReadinessService(config, { exact: true, upto: false }),
      verificationService,
      settlementService,
    });

    const run = await app.inject({
      method: "POST",
      url: "/v1/conformance/runs",
      payload: { network: "stellar:testnet" },
    });

    expect(run.statusCode).toBe(200);
    // 3 exact cases should run (not reserved), 3 upto cases should still be reserved
    expect(run.json().reservedCount).toBe(3);
    expect(run.json().exactResults).toBe(3);
    await app.close();
  });
});

// ─── Regression: env flag alone does not register a scheme ────────────────────

describe("regression – env flag alone does not register capability", () => {
  it("exact not advertised when registry says unavailable, even with signerProvider set", async () => {
    const config = loadConfig({});
    // Registry explicitly says exact is not supported (simulates a failed startup check).
    const registry = createStaticCapabilityRegistry(
      { exact: false, upto: false },
      ["stellar:testnet"]
    );
    const app = buildApiApp({
      logger: false,
      config,
      capabilityRegistry: registry,
      // Provide a live adapter — but registry override wins.
      verificationService: new PaymentVerificationService(config, { adapter: exactAdapter }),
      readinessService: createStaticReadinessService(config, { exact: true, upto: false }),
    });

    const response = await app.inject({ method: "GET", url: "/v1/supported" });

    expect(response.statusCode).toBe(200);
    // Registry says no → must not appear even though readiness says yes.
    expect(response.json().kinds).toHaveLength(0);
    await app.close();
  });

  it("paymentCapabilities:true alone does not make a scheme supported when registry is empty", async () => {
    const config = loadConfig({});
    const registry = createStaticCapabilityRegistry({}, ["stellar:testnet"]);
    const app = buildApiApp({
      logger: false,
      config,
      // paymentCapabilities requests exact, but registry has nothing
      paymentCapabilities: { exact: true, upto: false },
      capabilityRegistry: registry,
      readinessService: createStaticReadinessService(config, { exact: true, upto: false }),
    });

    const response = await app.inject({ method: "GET", url: "/v1/supported" });

    expect(response.json().kinds).toHaveLength(0);
    await app.close();
  });
});
