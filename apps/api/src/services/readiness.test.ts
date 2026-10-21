import { describe, expect, it } from "vitest";

import { loadConfig } from "@lumenbazaar/shared";

import {
  createReadinessService,
  createRuntimeReadinessProbes,
  type ReadinessProbes
} from "./readiness.js";

const succeeds = async () => undefined;

function probes(overrides: Partial<ReadinessProbes> = {}): ReadinessProbes {
  return {
    database: succeeds,
    redis: succeeds,
    stellarRpc: succeeds,
    horizon: succeeds,
    signer: succeeds,
    migrations: succeeds,
    assets: succeeds,
    ...overrides
  };
}

describe("readiness service", () => {
  it("reports each required dependency independently", async () => {
    const service = createReadinessService(
      loadConfig({ LUMEN_ENV: "testnet" }),
      { exact: true, upto: false },
      probes({
        redis: async () => {
          throw new Error("redis unavailable");
        }
      })
    );

    await expect(service.evaluate()).resolves.toMatchObject({
      ok: false,
      environment: "testnet",
      checks: {
        database: { status: "ready" },
        redis: { status: "unavailable", detail: "Dependency check failed." },
        signer: { status: "ready" }
      },
      capabilities: { exact: false, upto: false }
    });
  });

  it.each(["database", "stellarRpc", "horizon", "signer", "migrations", "assets"] as const)(
    "does not advertise exact when %s is unavailable",
    async (dependency) => {
      const service = createReadinessService(
        loadConfig({}),
        { exact: true, upto: false },
        probes({
          [dependency]: async () => {
            throw new Error(`${dependency} unavailable`);
          }
        })
      );

      const report = await service.evaluate();
      expect(report.capabilities.exact).toBe(false);
      expect(report.checks[dependency].status).toBe("unavailable");
    }
  );

  it("does not require signer access when no payment adapter is enabled", async () => {
    const readinessProbes = probes();
    delete readinessProbes.signer;
    const report = await createReadinessService(
      loadConfig({}),
      { exact: false, upto: false },
      readinessProbes
    ).evaluate();

    expect(report.ok).toBe(true);
    expect(report.checks.signer.status).toBe("not_required");
    expect(report.capabilities).toEqual({ exact: false, upto: false });
  });

  it("keeps live dependency probes out of the test suite", async () => {
    const runtimeProbes = createRuntimeReadinessProbes(loadConfig({}));

    await expect(runtimeProbes.stellarRpc()).rejects.toThrow(/test suite/i);

    const report = await createReadinessService(
      loadConfig({}),
      { exact: true, upto: false },
      runtimeProbes
    ).evaluate();

    expect(report.ok).toBe(false);
    expect(report.checks.stellarRpc.status).toBe("unavailable");
    expect(report.capabilities).toEqual({ exact: false, upto: false });
  });
});
