import { describe, expect, it, vi } from "vitest";

import {
  type X402StellarAdapter,
  type PaymentSessionService,
} from "@lumenbazaar/stellar-payments";

import {
  buildCapabilityRegistry,
  createStaticCapabilityRegistry,
} from "./capabilityRegistry.js";

// ─── Fake adapters ────────────────────────────────────────────────────────────

function liveExactAdapter(delayMs = 0): X402StellarAdapter {
  return {
    async verifyExact() {
      if (delayMs > 0) await sleep(delayMs);
      return { valid: false, failureCode: "SETTLEMENT_FAILED", adapter: "@x402/stellar" };
    }
  };
}

function throwingExactAdapter(): X402StellarAdapter {
  return {
    async verifyExact() {
      throw new Error("secret-bearing upstream error");
    }
  };
}

function liveUptoService(delayMs = 0): Partial<PaymentSessionService> {
  return {
    async getSession() {
      if (delayMs > 0) await sleep(delayMs);
      // Simulate RESOURCE_NOT_FOUND — expected for a sentinel ID.
      throw Object.assign(new Error("not found"), { code: "RESOURCE_NOT_FOUND" });
    }
  } as unknown as Partial<PaymentSessionService>;
}

function throwingUptoService(): Partial<PaymentSessionService> {
  return {
    async getSession() {
      throw new Error("soroban rpc unavailable");
    }
  } as unknown as Partial<PaymentSessionService>;
}

const testNetworks = ["stellar:testnet"] as const;

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

// ─── Registry population ──────────────────────────────────────────────────────

describe("buildCapabilityRegistry – population", () => {
  it("registers exact when adapter passes startup check", async () => {
    const registry = await buildCapabilityRegistry({
      exactAdapter: liveExactAdapter(),
      networks: testNetworks,
    });

    expect(registry.isSupported("exact", "stellar:testnet")).toBe(true);
    expect(registry.getSupportedSchemes()).toContainEqual({
      scheme: "exact",
      network: "stellar:testnet",
    });
  });

  it("registers upto when session service passes startup check", async () => {
    const registry = await buildCapabilityRegistry({
      uptoService: liveUptoService() as PaymentSessionService,
      networks: testNetworks,
    });

    expect(registry.isSupported("upto", "stellar:testnet")).toBe(true);
  });

  it("registers both when both adapters pass", async () => {
    const registry = await buildCapabilityRegistry({
      exactAdapter: liveExactAdapter(),
      uptoService: liveUptoService() as PaymentSessionService,
      networks: testNetworks,
    });

    expect(registry.isSupported("exact", "stellar:testnet")).toBe(true);
    expect(registry.isSupported("upto", "stellar:testnet")).toBe(true);
    expect(registry.getSupportedSchemes()).toHaveLength(2);
  });

  it("registers neither when both adapters are absent", async () => {
    const registry = await buildCapabilityRegistry({ networks: testNetworks });

    expect(registry.isSupported("exact", "stellar:testnet")).toBe(false);
    expect(registry.isSupported("upto", "stellar:testnet")).toBe(false);
    expect(registry.getSupportedSchemes()).toHaveLength(0);
  });

  it("registers exact only when upto adapter is absent", async () => {
    const registry = await buildCapabilityRegistry({
      exactAdapter: liveExactAdapter(),
      networks: testNetworks,
    });

    expect(registry.isSupported("exact", "stellar:testnet")).toBe(true);
    expect(registry.isSupported("upto", "stellar:testnet")).toBe(false);
    expect(registry.getSupportedSchemes()).toHaveLength(1);
  });

  it("registers upto only when exact adapter is absent", async () => {
    const registry = await buildCapabilityRegistry({
      uptoService: liveUptoService() as PaymentSessionService,
      networks: testNetworks,
    });

    expect(registry.isSupported("exact", "stellar:testnet")).toBe(false);
    expect(registry.isSupported("upto", "stellar:testnet")).toBe(true);
    expect(registry.getSupportedSchemes()).toHaveLength(1);
  });

  it("registers entries for every configured network", async () => {
    const networks = ["stellar:testnet", "stellar:pubnet"] as const;
    const registry = await buildCapabilityRegistry({
      exactAdapter: liveExactAdapter(),
      networks,
    });

    expect(registry.isSupported("exact", "stellar:testnet")).toBe(true);
    expect(registry.isSupported("exact", "stellar:pubnet")).toBe(true);
    expect(registry.getSupportedSchemes()).toHaveLength(2);
  });
});

// ─── Failure cases ────────────────────────────────────────────────────────────

describe("buildCapabilityRegistry – failure cases", () => {
  it("does NOT register exact when adapter throws", async () => {
    const registry = await buildCapabilityRegistry({
      exactAdapter: throwingExactAdapter(),
      networks: testNetworks,
    });

    expect(registry.isSupported("exact", "stellar:testnet")).toBe(false);
  });

  it("does NOT register upto when service throws", async () => {
    const registry = await buildCapabilityRegistry({
      uptoService: throwingUptoService() as PaymentSessionService,
      networks: testNetworks,
    });

    expect(registry.isSupported("upto", "stellar:testnet")).toBe(false);
  });

  it("records adapter_not_configured when exact adapter is absent", async () => {
    const registry = await buildCapabilityRegistry({ networks: testNetworks });
    const reasons = registry.getUnavailableReasons();
    const exactReason = reasons.find((r) => r.scheme === "exact");

    expect(exactReason?.reason).toBe("adapter_not_configured");
  });

  it("records adapter_not_configured when upto service is absent", async () => {
    const registry = await buildCapabilityRegistry({ networks: testNetworks });
    const reasons = registry.getUnavailableReasons();
    const uptoReason = reasons.find((r) => r.scheme === "upto");

    expect(uptoReason?.reason).toBe("adapter_not_configured");
  });

  it("records startup_check_failed when adapter throws", async () => {
    const registry = await buildCapabilityRegistry({
      exactAdapter: throwingExactAdapter(),
      networks: testNetworks,
    });
    const reasons = registry.getUnavailableReasons();
    const exactReason = reasons.find((r) => r.scheme === "exact");

    expect(exactReason?.reason).toBe("startup_check_failed");
  });

  it("records startup_check_timeout when adapter exceeds deadline", async () => {
    const registry = await buildCapabilityRegistry({
      exactAdapter: liveExactAdapter(500), // 500 ms
      networks: testNetworks,
      checkOptions: { timeoutMs: 1 }, // 1 ms deadline
    });
    const reasons = registry.getUnavailableReasons();
    const exactReason = reasons.find((r) => r.scheme === "exact");

    expect(exactReason?.reason).toBe("startup_check_timeout");
    expect(registry.isSupported("exact", "stellar:testnet")).toBe(false);
  });

  it("never includes raw error text in reason codes", async () => {
    const registry = await buildCapabilityRegistry({
      exactAdapter: throwingExactAdapter(),
      networks: testNetworks,
    });
    const serialized = JSON.stringify(registry.getUnavailableReasons());

    expect(serialized).not.toContain("secret-bearing");
    expect(serialized).not.toContain("upstream error");
  });

  it("always resolves even when both adapters fail", async () => {
    await expect(
      buildCapabilityRegistry({
        exactAdapter: throwingExactAdapter(),
        uptoService: throwingUptoService() as PaymentSessionService,
        networks: testNetworks,
      })
    ).resolves.toBeDefined();
  });
});

// ─── Immutability ─────────────────────────────────────────────────────────────

describe("buildCapabilityRegistry – immutability", () => {
  it("getSupportedSchemes returns a frozen array", async () => {
    const registry = await buildCapabilityRegistry({
      exactAdapter: liveExactAdapter(),
      networks: testNetworks,
    });
    const schemes = registry.getSupportedSchemes();

    expect(Object.isFrozen(schemes)).toBe(true);
    expect(() => {
      (schemes as RegisteredCapability[]).push({ scheme: "exact", network: "stellar:pubnet" });
    }).toThrow();
  });

  it("getUnavailableReasons returns a frozen array", async () => {
    const registry = await buildCapabilityRegistry({ networks: testNetworks });
    const reasons = registry.getUnavailableReasons();

    expect(Object.isFrozen(reasons)).toBe(true);
  });

  it("each RegisteredCapability entry is frozen", async () => {
    const registry = await buildCapabilityRegistry({
      exactAdapter: liveExactAdapter(),
      networks: testNetworks,
    });
    const [first] = registry.getSupportedSchemes();

    expect(Object.isFrozen(first)).toBe(true);
  });
});

// ─── allowedCapabilities restriction ─────────────────────────────────────────

describe("buildCapabilityRegistry – allowedCapabilities restriction", () => {
  it("restricts exact when allowedCapabilities.exact is false", async () => {
    const registry = await buildCapabilityRegistry({
      exactAdapter: liveExactAdapter(),
      networks: testNetworks,
      allowedCapabilities: { exact: false },
    });

    expect(registry.isSupported("exact", "stellar:testnet")).toBe(false);
    const reasons = registry.getUnavailableReasons();
    const exactReason = reasons.find((r) => r.scheme === "exact");
    // When restricted via allowedCapabilities the reason falls back to adapter_not_configured.
    expect(exactReason?.reason).toBe("adapter_not_configured");
  });

  it("restricts upto when allowedCapabilities.upto is false", async () => {
    const registry = await buildCapabilityRegistry({
      uptoService: liveUptoService() as PaymentSessionService,
      networks: testNetworks,
      allowedCapabilities: { upto: false },
    });

    expect(registry.isSupported("upto", "stellar:testnet")).toBe(false);
  });

  it("does not add exact when adapter absent but allowedCapabilities.exact is true", async () => {
    // allowedCapabilities can only restrict, never add beyond what the check produces.
    const registry = await buildCapabilityRegistry({
      networks: testNetworks,
      allowedCapabilities: { exact: true }, // no adapter provided
    });

    expect(registry.isSupported("exact", "stellar:testnet")).toBe(false);
    const reason = registry.getUnavailableReasons().find((r) => r.scheme === "exact");
    expect(reason?.reason).toBe("adapter_not_configured");
  });

  it("regression: env flag alone does NOT make a scheme supported when adapter fails check", async () => {
    // Simulates SCOPE-OUT constraint: config/env may supply adapter inputs,
    // but registration requires a passing startup check.
    const registry = await buildCapabilityRegistry({
      exactAdapter: throwingExactAdapter(), // adapter is wired but throws
      networks: testNetworks,
      allowedCapabilities: { exact: true }, // explicit "allow" cannot override a failed check
    });

    expect(registry.isSupported("exact", "stellar:testnet")).toBe(false);
    const reason = registry.getUnavailableReasons().find((r) => r.scheme === "exact");
    expect(reason?.reason).toBe("startup_check_failed");
  });
});

// ─── Diagnostics logging ──────────────────────────────────────────────────────

describe("buildCapabilityRegistry – startup diagnostics", () => {
  it("logs capability_registered for each registered scheme", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    await buildCapabilityRegistry({
      exactAdapter: liveExactAdapter(),
      networks: testNetworks,
      logger: { info, warn },
    });

    expect(info).toHaveBeenCalledWith("capability_registered", {
      scheme: "exact",
      network: "stellar:testnet",
    });
    expect(warn).not.toHaveBeenCalledWith(
      "capability_unavailable",
      expect.objectContaining({ scheme: "exact" })
    );
  });

  it("logs capability_unavailable for each unregistered scheme", async () => {
    const info = vi.fn();
    const warn = vi.fn();

    await buildCapabilityRegistry({
      networks: testNetworks,
      logger: { info, warn },
    });

    expect(warn).toHaveBeenCalledWith(
      "capability_unavailable",
      expect.objectContaining({ scheme: "exact", reason: "adapter_not_configured" })
    );
    expect(warn).toHaveBeenCalledWith(
      "capability_unavailable",
      expect.objectContaining({ scheme: "upto", reason: "adapter_not_configured" })
    );
    expect(info).not.toHaveBeenCalled();
  });

  it("never includes secrets in log data", async () => {
    const loggedData: unknown[] = [];
    const warn = vi.fn((_: string, data: unknown) => loggedData.push(data));

    await buildCapabilityRegistry({
      exactAdapter: throwingExactAdapter(),
      networks: testNetworks,
      logger: { info: vi.fn(), warn },
    });

    const serialized = JSON.stringify(loggedData);
    expect(serialized).not.toContain("secret-bearing");
    expect(serialized).not.toContain("upstream error");
  });
});

// ─── isSupported lookup ───────────────────────────────────────────────────────

describe("buildCapabilityRegistry – isSupported lookup", () => {
  it("returns false for unknown scheme", async () => {
    const registry = await buildCapabilityRegistry({
      exactAdapter: liveExactAdapter(),
      networks: testNetworks,
    });

    expect(registry.isSupported("upto" as never, "stellar:testnet")).toBe(false);
  });

  it("returns false for unknown network even when scheme is supported", async () => {
    const registry = await buildCapabilityRegistry({
      exactAdapter: liveExactAdapter(),
      networks: testNetworks,
    });

    expect(registry.isSupported("exact", "stellar:pubnet")).toBe(false);
  });
});

// ─── createStaticCapabilityRegistry ──────────────────────────────────────────

describe("createStaticCapabilityRegistry", () => {
  it("registers schemes marked true", () => {
    const registry = createStaticCapabilityRegistry({ exact: true, upto: false });

    expect(registry.isSupported("exact", "stellar:testnet")).toBe(true);
    expect(registry.isSupported("upto", "stellar:testnet")).toBe(false);
  });

  it("returns frozen arrays", () => {
    const registry = createStaticCapabilityRegistry({ exact: true });

    expect(Object.isFrozen(registry.getSupportedSchemes())).toBe(true);
    expect(Object.isFrozen(registry.getUnavailableReasons())).toBe(true);
  });

  it("records adapter_not_configured for omitted schemes", () => {
    const registry = createStaticCapabilityRegistry({});
    const reasons = registry.getUnavailableReasons();

    expect(reasons.every((r) => r.reason === "adapter_not_configured")).toBe(true);
    expect(reasons).toHaveLength(2);
  });
});

// Local type import for test assertion
type RegisteredCapability = { scheme: string; network: string };
