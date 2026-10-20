import { describe, expect, it } from "vitest";

import { loadConfig } from "@lumenbazaar/shared";
import {
  InMemoryPaymentAttemptStore,
  PaymentVerificationService,
  SettlementService,
  type X402StellarAdapter
} from "@lumenbazaar/stellar-payments";

import { buildApiApp } from "../app.js";

describe("conformance routes", () => {
  it("creates, stores, and fetches exact conformance runs with reserved upto slots", async () => {
    const config = loadConfig({});
    const attemptStore = new InMemoryPaymentAttemptStore();
    const adapter: X402StellarAdapter = {
      async verifyExact() {
        return {
          valid: true,
          adapter: "@x402/stellar"
        };
      },
      async settleExact() {
        return {
          transactionHash: "tx_conformance",
          ledger: 789,
          status: "confirmed",
          adapter: "@x402/stellar"
        };
      }
    };
    const app = buildApiApp({
      logger: false,
      verificationService: new PaymentVerificationService(config, { adapter, attemptStore }),
      settlementService: new SettlementService(config, { adapter, attemptStore })
    });

    const created = await app.inject({
      method: "POST",
      url: "/v1/conformance/runs",
      payload: {
        network: "stellar:testnet"
      }
    });
    const runId = created.json().id as string;
    const listed = await app.inject({
      method: "GET",
      url: "/v1/conformance/runs?network=stellar:testnet"
    });
    const fetched = await app.inject({
      method: "GET",
      url: `/v1/conformance/runs/${runId}`
    });

    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({
      network: "stellar:testnet",
      suite: "stellar-x402",
      status: "passed",
      mode: "local",
      x402Version: 2,
      x402PackageVersion: "2.28.0",
      passedCount: 0,
      failedCount: 0,
      reservedCount: 6
    });
    expect(created.json().commit).toBeDefined();
    expect(
      created.json().results.map((result: { id: string; status: string }) => ({
        id: result.id,
        status: result.status
      }))
    ).toEqual([
      { id: "exact-supported", status: "reserved" },
      { id: "exact-verify", status: "reserved" },
      { id: "exact-settle", status: "reserved" },
      { id: "upto-supported", status: "reserved" },
      { id: "upto-session-create", status: "reserved" },
      { id: "upto-settle", status: "reserved" }
    ]);
    expect(listed.json()).toEqual([created.json()]);
    expect(fetched.json()).toEqual(created.json());

    // Filtering by mode
    const filteredLocal = await app.inject({
      method: "GET",
      url: "/v1/conformance/runs?mode=local"
    });
    expect(filteredLocal.json()).toHaveLength(1);

    const filteredLive = await app.inject({
      method: "GET",
      url: "/v1/conformance/runs?mode=live"
    });
    expect(filteredLive.json()).toHaveLength(0);

    // Rejection of claiming live mode without live deployment
    const rejectedLive = await app.inject({
      method: "POST",
      url: "/v1/conformance/runs",
      payload: {
        network: "stellar:testnet",
        mode: "live"
      }
    });
    expect(rejectedLive.statusCode).toBe(400);
    expect(rejectedLive.json()).toMatchObject({
      ok: false,
      error: {
        code: "VALIDATION_FAILED",
        message: expect.stringContaining("Cannot claim live conformance")
      }
    });

    await app.close();
  });
});
