import { describe, expect, it, vi } from "vitest";

import { loadConfig } from "@lumenbazaar/shared";
import {
  InMemoryPaymentAttemptStore,
  PaymentSessionService,
  PaymentVerificationService,
  SettlementService,
  type X402StellarAdapter
} from "@lumenbazaar/stellar-payments";

import {
  ConformanceRunService,
  conformanceDefinitions,
  createServiceConformanceRunner
} from "./conformance.js";

describe("ConformanceRunService", () => {
  it("runs exact checks and reserves upto checks separately", async () => {
    const runner = vi.fn(async () => ({
      checked: true
    }));
    const service = new ConformanceRunService(runner);

    const run = await service.run({
      network: "stellar:testnet"
    });

    expect(run).toMatchObject({
      network: "stellar:testnet",
      suite: "stellar-x402",
      status: "passed",
      passedCount: 3,
      failedCount: 0,
      reservedCount: 3,
      exactResults: 3
    });
    expect(run.results.filter((result) => result.scheme === "exact")).toHaveLength(3);
    expect(run.results.filter((result) => result.scheme === "upto")).toHaveLength(3);
    expect(runner).toHaveBeenCalledTimes(3);
    await expect(service.list({})).resolves.toEqual([run]);
    await expect(service.get(run.id)).resolves.toEqual(run);
  });

  it("records failed exact checks without treating reserved slots as failures", async () => {
    const runner = vi.fn(async (definition: { id: string }) => {
      if (definition.id === "exact-settle") {
        throw new Error("settlement failed");
      }
    });
    const service = new ConformanceRunService(runner);

    const run = await service.run({
      includeReserved: true,
      network: "stellar:testnet"
    });

    expect(run.status).toBe("failed");
    expect(run.failedCount).toBe(1);
    expect(run.reservedCount).toBe(3);
    expect(run.results.find((result) => result.id === "exact-settle")).toMatchObject({
      status: "failed",
      error: "settlement failed"
    });
  });

  it("can return only executable exact definitions", () => {
    expect(
      conformanceDefinitions("stellar:testnet", false).map((definition) => definition.id)
    ).toEqual(["exact-supported", "exact-verify", "exact-settle"]);
  });

  it("runs upto checks when capped sessions are deployed", async () => {
    const config = loadConfig({
      ENABLE_UPTO_SCHEME: "true",
      STELLAR_TESTNET_UPTO_SESSION_CONTRACT_ID:
        "CDLZUPTOSESSIONCONTRACT000000000000000000000000000000000",
      STELLAR_TESTNET_USDC_CONTRACT_ID: "CDLZUSDCTOKENCONTRACT0000000000000000000000000000000000"
    });
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
          ledger: 1,
          status: "confirmed",
          adapter: "@x402/stellar"
        };
      }
    };
    const runner = createServiceConformanceRunner(
      config,
      new PaymentVerificationService(config, { adapter, attemptStore }),
      new SettlementService(config, { adapter, attemptStore }),
      new PaymentSessionService(config)
    );
    const service = new ConformanceRunService(runner, undefined, { uptoEnabled: true });

    const run = await service.run({
      network: "stellar:testnet",
      includeReserved: false
    });

    expect(run.status).toBe("passed");
    expect(run.reservedCount).toBe(0);
    expect(run.results.map((result) => result.id)).toEqual([
      "exact-supported",
      "exact-verify",
      "exact-settle",
      "upto-supported",
      "upto-session-create",
      "upto-settle"
    ]);
    expect(run.results.filter((result) => result.scheme === "upto")).toHaveLength(3);
  });

  it("labels runs with mode, commit, and x402 package version", async () => {
    const runner = vi.fn(async () => undefined);
    const service = new ConformanceRunService(runner, undefined, {
      commit: "abc123commit",
      x402PackageVersion: "2.28.0"
    });

    const run = await service.run({ network: "stellar:testnet", mode: "local" });

    expect(run.mode).toBe("local");
    expect(run.commit).toBe("abc123commit");
    expect(run.x402Version).toBe(2);
    expect(run.x402PackageVersion).toBe("2.28.0");
  });

  it("rejects live mode claims when not running in a verified live environment", async () => {
    const runner = vi.fn(async () => undefined);
    const localService = new ConformanceRunService(runner, undefined, { isLive: false });

    await expect(localService.run({ network: "stellar:testnet", mode: "live" })).rejects.toThrow(
      "Cannot claim live conformance unless deployed tests passed in a live environment."
    );
  });

  it("accepts live mode when verified live environment is configured", async () => {
    const runner = vi.fn(async () => undefined);
    const liveService = new ConformanceRunService(runner, undefined, {
      isLive: true,
      commit: "livecommit789",
      x402PackageVersion: "2.28.0"
    });

    const run = await liveService.run({ network: "stellar:testnet", mode: "live" });

    expect(run.mode).toBe("live");
    expect(run.status).toBe("passed");
    expect(run.commit).toBe("livecommit789");
  });

  it("filters runs by mode (local vs live)", async () => {
    const runner = vi.fn(async () => undefined);
    const service = new ConformanceRunService(runner, undefined, { isLive: true });

    const localRun = await service.run({ network: "stellar:testnet", mode: "local" });
    const liveRun = await service.run({ network: "stellar:testnet", mode: "live" });

    const localList = await service.list({ mode: "local" });
    expect(localList.map((r) => r.id)).toEqual([localRun.id]);

    const liveList = await service.list({ mode: "live" });
    expect(liveList.map((r) => r.id)).toEqual([liveRun.id]);
  });

  it("builds immutable conformance specification with release and compatibility metadata", async () => {
    const { buildConformanceSpec, renderConformanceMarkdown } = await import("./conformance.js");
    const spec = buildConformanceSpec({
      commit: "testsha456",
      version: "0.1.0",
      x402PackageVersion: "2.28.0"
    });

    expect(spec.suite).toBe("stellar-x402");
    expect(spec.version).toBe("0.1.0");
    expect(spec.commit).toBe("testsha456");
    expect(spec.protocol).toEqual({
      name: "x402",
      version: 2,
      package: "@x402/core",
      packageVersion: "2.28.0",
      stellarPackage: "@x402/stellar",
      stellarPackageVersion: "2.28.0"
    });
    expect(spec.executionModes.local.verifiedOnChain).toBe(false);
    expect(spec.executionModes.live.verifiedOnChain).toBe(true);
    expect(spec.cases.testnet.length).toBeGreaterThanOrEqual(6);
    expect(spec.cases.pubnet.length).toBeGreaterThanOrEqual(6);

    const markdown = renderConformanceMarkdown(spec);
    expect(markdown).toContain("Source Commit: `testsha456`");
    expect(markdown).toContain("Core Package: `@x402/core@2.28.0`");
    expect(markdown).toContain("## Execution Modes");
    expect(markdown).toContain("## Conformance Cases (Testnet)");
  });
});
