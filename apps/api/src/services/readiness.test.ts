import { describe, expect, it, vi, afterEach } from "vitest";

import { loadConfig } from "@lumenbazaar/shared";

import {
  createReadinessService,
  createStaticReadinessService,
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

afterEach(() => {
  vi.useRealTimers();
});

// ─── Unit: individual probe outcomes ────────────────────────────────────────

describe("readiness service – probe outcomes", () => {
  it("returns ready with latency when all probes succeed", async () => {
    const service = createReadinessService(
      loadConfig({ LUMEN_ENV: "testnet" }),
      { exact: true, upto: false },
      probes()
    );

    const report = await service.evaluate();

    expect(report.ok).toBe(true);
    expect(report.environment).toBe("testnet");
    expect(report.checks.database.status).toBe("ready");
    expect(typeof report.checks.database.latencyMs).toBe("number");
    expect(report.checks.database.latencyMs).toBeGreaterThanOrEqual(0);
  });

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
        redis: { status: "unavailable", reason: "dependency_check_failed" },
        signer: { status: "ready" }
      },
      capabilities: { exact: false, upto: false }
    });
  });

  it("redacts raw error messages — reason is always a stable code, never the original exception text", async () => {
    const secretUrl = "postgresql://admin:S3cr3tPassw0rd@prod-db.example.com:5432/lumenbazaar";
    const service = createReadinessService(
      loadConfig({}),
      { exact: false, upto: false },
      probes({
        database: async () => {
          throw new Error(`connect ECONNREFUSED ${secretUrl}`);
        }
      })
    );

    const report = await service.evaluate();
    const dbCheck = report.checks.database;

    expect(dbCheck.status).toBe("unavailable");
    // The raw error text must never appear in any check field.
    expect(JSON.stringify(dbCheck)).not.toContain("S3cr3tPassw0rd");
    expect(JSON.stringify(dbCheck)).not.toContain("prod-db.example.com");
    expect(JSON.stringify(dbCheck)).not.toContain("postgresql://");
    expect(dbCheck.reason).toBe("dependency_check_failed");
  });

  it("maps a probe that raises an AbortError to timeout status", async () => {
    const service = createReadinessService(
      loadConfig({}),
      { exact: false, upto: false },
      probes({
        horizon: async () => {
          const err = new Error("The operation was aborted.");
          err.name = "AbortError";
          throw err;
        }
      })
    );

    const report = await service.evaluate();

    expect(report.checks.horizon.status).toBe("timeout");
    expect(report.checks.horizon.reason).toBe("probe_timeout");
    expect(typeof report.checks.horizon.latencyMs).toBe("number");
  });

  it("maps a probe that exceeds the deadline to timeout status via external timer", async () => {
    // Use a very short timeout (1 ms) so the slow probe is guaranteed to exceed it.
    const slowProbe = () => new Promise<void>((resolve) => setTimeout(resolve, 500));
    const service = createReadinessService(
      loadConfig({}),
      { exact: false, upto: false },
      probes({ stellarRpc: slowProbe }),
      1 // 1 ms timeout — will always fire before 500 ms probe completes
    );

    const report = await service.evaluate();

    expect(report.checks.stellarRpc.status).toBe("timeout");
    expect(report.checks.stellarRpc.reason).toBe("probe_timeout");
  });

  it("includes latencyMs for ready probes", async () => {
    const service = createReadinessService(loadConfig({}), { exact: false, upto: false }, probes());

    const report = await service.evaluate();

    for (const [, check] of Object.entries(report.checks)) {
      if (check.status === "ready") {
        expect(typeof check.latencyMs).toBe("number");
        expect(check.latencyMs).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("includes latencyMs for unavailable probes", async () => {
    const service = createReadinessService(
      loadConfig({}),
      { exact: false, upto: false },
      probes({
        redis: async () => {
          throw new Error("unreachable");
        }
      })
    );

    const report = await service.evaluate();

    expect(typeof report.checks.redis.latencyMs).toBe("number");
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

  it("reports not_configured when signer probe is absent but signer is required", async () => {
    const readinessProbes = probes();
    delete readinessProbes.signer;
    const report = await createReadinessService(
      loadConfig({}),
      { exact: true, upto: false }, // signer required
      readinessProbes
    ).evaluate();

    expect(report.checks.signer.status).toBe("not_configured");
    expect(report.ok).toBe(false);
    expect(report.capabilities.exact).toBe(false);
  });

  it("does not_configured count as ready — reports 503 equivalent (ok: false)", async () => {
    // not_configured means the dependency is required but has no probe registered.
    // The service must treat this as a failure.
    const readinessProbes = probes();
    delete readinessProbes.signer;
    const report = await createReadinessService(
      loadConfig({}),
      { exact: true, upto: false },
      readinessProbes
    ).evaluate();

    expect(report.ok).toBe(false);
  });
});

// ─── Integration: degraded combinations ─────────────────────────────────────

describe("readiness service – degraded combinations", () => {
  it("all healthy → ok: true, all ready", async () => {
    const service = createReadinessService(
      loadConfig({ LUMEN_ENV: "testnet" }),
      { exact: false, upto: false },
      probes()
    );

    const report = await service.evaluate();

    expect(report.ok).toBe(true);
    for (const [name, check] of Object.entries(report.checks)) {
      expect([name, check.status]).toEqual([name, "ready"]);
    }
  });

  it("all dependencies unavailable → ok: false, each check is unavailable", async () => {
    const fail = async () => {
      throw new Error("down");
    };
    const service = createReadinessService(
      loadConfig({}),
      { exact: false, upto: false },
      probes({
        database: fail,
        redis: fail,
        stellarRpc: fail,
        horizon: fail,
        migrations: fail,
        assets: fail
      })
    );

    const report = await service.evaluate();

    expect(report.ok).toBe(false);
    expect(report.checks.database.status).toBe("unavailable");
    expect(report.checks.redis.status).toBe("unavailable");
    expect(report.checks.stellarRpc.status).toBe("unavailable");
    expect(report.checks.horizon.status).toBe("unavailable");
    expect(report.checks.migrations.status).toBe("unavailable");
    expect(report.checks.assets.status).toBe("unavailable");
  });

  it("only database down → ok: false", async () => {
    const service = createReadinessService(
      loadConfig({}),
      { exact: false, upto: false },
      probes({
        database: async () => {
          throw new Error("connection refused");
        }
      })
    );

    const report = await service.evaluate();

    expect(report.ok).toBe(false);
    expect(report.checks.database.status).toBe("unavailable");
    expect(report.checks.redis.status).toBe("ready");
  });

  it("only redis down → ok: false", async () => {
    const service = createReadinessService(
      loadConfig({}),
      { exact: false, upto: false },
      probes({
        redis: async () => {
          throw new Error("ECONNREFUSED");
        }
      })
    );

    const report = await service.evaluate();

    expect(report.ok).toBe(false);
    expect(report.checks.redis.status).toBe("unavailable");
    expect(report.checks.database.status).toBe("ready");
  });

  it("only horizon down → ok: false", async () => {
    const service = createReadinessService(
      loadConfig({}),
      { exact: false, upto: false },
      probes({
        horizon: async () => {
          throw new Error("timeout");
        }
      })
    );

    const report = await service.evaluate();

    expect(report.ok).toBe(false);
    expect(report.checks.horizon.status).toBe("unavailable");
  });

  it("only stellarRpc down → ok: false", async () => {
    const service = createReadinessService(
      loadConfig({}),
      { exact: false, upto: false },
      probes({
        stellarRpc: async () => {
          throw new Error("network error");
        }
      })
    );

    const report = await service.evaluate();

    expect(report.ok).toBe(false);
    expect(report.checks.stellarRpc.status).toBe("unavailable");
  });

  it("only migrations down → ok: false", async () => {
    const service = createReadinessService(
      loadConfig({}),
      { exact: false, upto: false },
      probes({
        migrations: async () => {
          throw new Error("missing migrations");
        }
      })
    );

    const report = await service.evaluate();

    expect(report.ok).toBe(false);
    expect(report.checks.migrations.status).toBe("unavailable");
  });

  it("database + redis down simultaneously → ok: false, both marked unavailable", async () => {
    const fail = async () => {
      throw new Error("down");
    };
    const service = createReadinessService(
      loadConfig({}),
      { exact: false, upto: false },
      probes({ database: fail, redis: fail })
    );

    const report = await service.evaluate();

    expect(report.ok).toBe(false);
    expect(report.checks.database.status).toBe("unavailable");
    expect(report.checks.redis.status).toBe("unavailable");
    expect(report.checks.stellarRpc.status).toBe("ready");
  });

  it("database timeout + redis down → ok: false, timeout and unavailable reported correctly", async () => {
    const slowDb = () => new Promise<void>((resolve) => setTimeout(resolve, 500));
    const failRedis = async () => {
      throw new Error("ECONNREFUSED");
    };
    const service = createReadinessService(
      loadConfig({}),
      { exact: false, upto: false },
      probes({ database: slowDb, redis: failRedis }),
      1 // 1 ms timeout ensures db times out
    );

    const report = await service.evaluate();

    expect(report.ok).toBe(false);
    expect(report.checks.database.status).toBe("timeout");
    expect(report.checks.redis.status).toBe("unavailable");
  });
});

// ─── Integration: liveness never affected by readiness state ─────────────────

describe("readiness service – liveness isolation", () => {
  it("liveness stays 200 when readiness reports all dependencies unavailable", async () => {
    // This is tested at the route level via app.test.ts; here we verify the service contract:
    // evaluate() always resolves (never throws) regardless of probe failures.
    const fail = async () => {
      throw new Error("catastrophic failure");
    };
    const service = createReadinessService(
      loadConfig({}),
      { exact: true, upto: false },
      probes({
        database: fail,
        redis: fail,
        stellarRpc: fail,
        horizon: fail,
        migrations: fail,
        assets: fail,
        signer: fail
      })
    );

    // Must resolve (not throw) so the route can always return a response.
    await expect(service.evaluate()).resolves.toMatchObject({ ok: false });
  });

  it("evaluate() resolves even when every probe times out", async () => {
    const neverResolves = () => new Promise<void>(() => {}); // hangs forever
    const service = createReadinessService(
      loadConfig({}),
      { exact: true, upto: false },
      probes({
        database: neverResolves,
        redis: neverResolves,
        stellarRpc: neverResolves,
        horizon: neverResolves,
        migrations: neverResolves,
        assets: neverResolves,
        signer: neverResolves
      }),
      1 // 1 ms deadline — all probes time out immediately
    );

    const report = await service.evaluate();

    expect(report.ok).toBe(false);
    for (const [name, check] of Object.entries(report.checks)) {
      if (check.status !== "not_required") {
        expect([name, check.status]).toEqual([name, "timeout"]);
      }
    }
  });
});

// ─── Static readiness service ────────────────────────────────────────────────

describe("createStaticReadinessService", () => {
  it("all ready by default", async () => {
    const service = createStaticReadinessService(loadConfig({}), { exact: true, upto: false });
    const report = await service.evaluate();
    expect(report.ok).toBe(true);
  });

  it("respects overrides — unavailable status makes ok: false", async () => {
    const service = createStaticReadinessService(
      loadConfig({ LUMEN_ENV: "testnet" }),
      { exact: true, upto: false },
      { database: { status: "unavailable", reason: "dependency_check_failed" } }
    );
    const report = await service.evaluate();
    expect(report.ok).toBe(false);
    expect(report.checks.database.status).toBe("unavailable");
  });

  it("respects timeout override — timeout status makes ok: false", async () => {
    const service = createStaticReadinessService(
      loadConfig({}),
      { exact: false, upto: false },
      { redis: { status: "timeout", latencyMs: 2001, reason: "probe_timeout" } }
    );
    const report = await service.evaluate();
    expect(report.ok).toBe(false);
    expect(report.checks.redis.status).toBe("timeout");
  });

  it("respects not_configured override — not_configured makes ok: false", async () => {
    const service = createStaticReadinessService(
      loadConfig({}),
      { exact: false, upto: false },
      { signer: { status: "not_configured" } }
    );
    const report = await service.evaluate();
    expect(report.ok).toBe(false);
  });
});
