import { describe, expect, it } from "vitest";

import {
  checkExactAdapter,
  checkUptoAdapter,
} from "./adapterStartupCheck.js";
import { type X402StellarAdapter } from "./x402Adapter.js";
import { type PaymentSessionService } from "./paymentSession.js";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function aliveExactAdapter(): X402StellarAdapter {
  return {
    async verifyExact() {
      return { valid: false, failureCode: "SETTLEMENT_FAILED", adapter: "@x402/stellar" };
    }
  };
}

function throwingExactAdapter(message = "upstream failure"): X402StellarAdapter {
  return {
    async verifyExact() {
      throw new Error(message);
    }
  };
}

function slowExactAdapter(delayMs: number): X402StellarAdapter {
  return {
    async verifyExact() {
      await sleep(delayMs);
      return { valid: false, adapter: "@x402/stellar" };
    }
  };
}

function aliveUptoService(): Partial<PaymentSessionService> {
  return {
    async getSession() {
      throw Object.assign(new Error("not found"), { code: "RESOURCE_NOT_FOUND" });
    }
  } as unknown as Partial<PaymentSessionService>;
}

function throwingUptoService(message = "rpc down"): Partial<PaymentSessionService> {
  return {
    async getSession() {
      throw new Error(message);
    }
  } as unknown as Partial<PaymentSessionService>;
}

function slowUptoService(delayMs: number): Partial<PaymentSessionService> {
  return {
    async getSession() {
      await sleep(delayMs);
      throw new Error("not found");
    }
  } as unknown as Partial<PaymentSessionService>;
}

// ─── checkExactAdapter ────────────────────────────────────────────────────────

describe("checkExactAdapter – pass", () => {
  it("returns ok:true when adapter responds (even with valid:false)", async () => {
    const result = await checkExactAdapter(aliveExactAdapter());
    expect(result).toEqual({ ok: true });
  });
});

describe("checkExactAdapter – adapter_not_configured", () => {
  it("returns adapter_not_configured when adapter is undefined", async () => {
    const result = await checkExactAdapter(undefined);
    expect(result).toEqual({ ok: false, reason: "adapter_not_configured" });
  });
});

describe("checkExactAdapter – startup_check_failed", () => {
  it("returns startup_check_failed when adapter throws", async () => {
    const result = await checkExactAdapter(throwingExactAdapter("secret password 123"));
    expect(result).toEqual({ ok: false, reason: "startup_check_failed" });
  });

  it("never surfaces raw error text in the result", async () => {
    const result = await checkExactAdapter(throwingExactAdapter("top-secret-key-material"));
    expect(JSON.stringify(result)).not.toContain("top-secret-key-material");
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("checkExactAdapter – startup_check_timeout", () => {
  it("returns startup_check_timeout when adapter exceeds deadline", async () => {
    const result = await checkExactAdapter(
      slowExactAdapter(500),
      { timeoutMs: 5 }
    );
    expect(result).toEqual({ ok: false, reason: "startup_check_timeout" });
  });

  it("does not include raw error or latency details in timeout result", async () => {
    const result = await checkExactAdapter(
      slowExactAdapter(500),
      { timeoutMs: 5 }
    );
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("latencyMs");
  });
});

// ─── checkUptoAdapter ─────────────────────────────────────────────────────────

describe("checkUptoAdapter – pass", () => {
  it("returns ok:true when session service responds (expected RESOURCE_NOT_FOUND)", async () => {
    const result = await checkUptoAdapter(aliveUptoService() as PaymentSessionService);
    expect(result).toEqual({ ok: true });
  });
});

describe("checkUptoAdapter – adapter_not_configured", () => {
  it("returns adapter_not_configured when service is undefined", async () => {
    const result = await checkUptoAdapter(undefined);
    expect(result).toEqual({ ok: false, reason: "adapter_not_configured" });
  });
});

describe("checkUptoAdapter – startup_check_failed", () => {
  it("returns startup_check_failed when service throws synchronously", async () => {
    const synchronousThrower = {
      getSession(): never {
        throw new Error("sync failure");
      }
    } as unknown as PaymentSessionService;

    const result = await checkUptoAdapter(synchronousThrower);
    expect(result).toEqual({ ok: false, reason: "startup_check_failed" });
  });

  it("never surfaces raw error text in the result", async () => {
    const result = await checkUptoAdapter(
      throwingUptoService("soroban-api-key-xyz") as PaymentSessionService
    );
    expect(JSON.stringify(result)).not.toContain("soroban-api-key-xyz");
  });
});

describe("checkUptoAdapter – startup_check_timeout", () => {
  it("returns startup_check_timeout when service exceeds deadline", async () => {
    const result = await checkUptoAdapter(
      slowUptoService(500) as PaymentSessionService,
      { timeoutMs: 5 }
    );
    expect(result).toEqual({ ok: false, reason: "startup_check_timeout" });
  });
});

// ─── Both checks run independently ───────────────────────────────────────────

describe("checkExactAdapter + checkUptoAdapter independence", () => {
  it("exact failure does not affect upto result", async () => {
    const [exactResult, uptoResult] = await Promise.all([
      checkExactAdapter(throwingExactAdapter()),
      checkUptoAdapter(aliveUptoService() as PaymentSessionService),
    ]);

    expect(exactResult).toEqual({ ok: false, reason: "startup_check_failed" });
    expect(uptoResult).toEqual({ ok: true });
  });

  it("upto failure does not affect exact result", async () => {
    const [exactResult, uptoResult] = await Promise.all([
      checkExactAdapter(aliveExactAdapter()),
      checkUptoAdapter(throwingUptoService() as PaymentSessionService),
    ]);

    expect(exactResult).toEqual({ ok: true });
    expect(uptoResult).toEqual({ ok: false, reason: "startup_check_failed" });
  });
});
