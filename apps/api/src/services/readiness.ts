import { Redis } from "ioredis";

import {
  type AppConfig,
  createPrismaClient,
  listConfiguredNetworks,
  localIssuerPublicKey
} from "@lumenbazaar/shared";
import { type FacilitatorSignerProvider } from "@lumenbazaar/stellar-payments";

export type PaymentCapabilities = {
  exact: boolean;
  upto: boolean;
};

/**
 * Status values for each dependency probe.
 *
 * - "ready"         — dependency responded successfully
 * - "unavailable"   — dependency is reachable but unhealthy, or the probe threw
 * - "timeout"       — probe did not complete within the configured deadline
 * - "not_configured" — the dependency URL / credential is absent from config;
 *                       the service will NOT serve this capability
 * - "not_required"  — dependency is optional and not enabled for this deployment
 */
export type ReadinessCheckStatus =
  | "ready"
  | "unavailable"
  | "timeout"
  | "not_configured"
  | "not_required";

export type ReadinessCheck = {
  status: ReadinessCheckStatus;
  /** Elapsed probe time in milliseconds. Omitted when status is not_required or not_configured. */
  latencyMs?: number;
  /**
   * Stable, generic reason code — never includes raw error messages, hostnames,
   * credentials, URLs, or stack traces.
   */
  reason?: string;
};

export type ReadinessReport = {
  ok: boolean;
  environment: AppConfig["lumenEnv"];
  checks: {
    database: ReadinessCheck;
    redis: ReadinessCheck;
    stellarRpc: ReadinessCheck;
    horizon: ReadinessCheck;
    signer: ReadinessCheck;
    migrations: ReadinessCheck;
    assets: ReadinessCheck;
  };
  capabilities: PaymentCapabilities;
};

export type ReadinessService = {
  evaluate(): Promise<ReadinessReport>;
};

export type ReadinessProbes = {
  database: () => Promise<void>;
  redis: () => Promise<void>;
  stellarRpc: () => Promise<void>;
  horizon: () => Promise<void>;
  signer?: () => Promise<void>;
  migrations: () => Promise<void>;
  assets: () => Promise<void>;
};

/** Default probe deadline. Override with READINESS_PROBE_TIMEOUT_MS env var or per-call. */
const defaultProbeTimeoutMs = Number(process.env.READINESS_PROBE_TIMEOUT_MS ?? 2_000);

const requiredMigrations = [
  "0001_core_catalog",
  "0002_payment_records",
  "0003_discovery_operations",
  "0004_upto_sessions",
  "0005_durable_payment_persistence",
  "0006_settlement_reconciliation",
  "0007_observability_correlation"
] as const;

export function createReadinessService(
  config: AppConfig,
  requestedCapabilities: PaymentCapabilities,
  probes: ReadinessProbes = createRuntimeReadinessProbes(config),
  probeTimeoutMs: number = defaultProbeTimeoutMs
): ReadinessService {
  return {
    async evaluate() {
      const signerRequired = requestedCapabilities.exact || requestedCapabilities.upto;
      const [database, redis, stellarRpc, horizon, signer, migrations, assets] = await Promise.all([
        runProbe(probes.database, probeTimeoutMs),
        runProbe(probes.redis, probeTimeoutMs),
        runProbe(probes.stellarRpc, probeTimeoutMs),
        runProbe(probes.horizon, probeTimeoutMs),
        signerRequired
          ? probes.signer === undefined
            ? Promise.resolve(notConfigured())
            : runProbe(probes.signer, probeTimeoutMs)
          : Promise.resolve<ReadinessCheck>({ status: "not_required" }),
        runProbe(probes.migrations, probeTimeoutMs),
        runProbe(probes.assets, probeTimeoutMs)
      ]);
      const requiredChecks = [database, redis, stellarRpc, horizon, migrations, assets];
      const sharedDependenciesReady = requiredChecks.every((check) => check.status === "ready");
      const signerReady = !signerRequired || signer.status === "ready";
      const exact = requestedCapabilities.exact && sharedDependenciesReady && signerReady;
      const upto =
        requestedCapabilities.upto &&
        config.features.uptoScheme &&
        sharedDependenciesReady &&
        signerReady &&
        listConfiguredNetworks(config).every(
          (network) =>
            network.uptoSessionContractId !== undefined &&
            network.assets.some((asset) => asset.contractId !== undefined)
        );

      return {
        ok: sharedDependenciesReady && signerReady,
        environment: config.lumenEnv,
        checks: {
          database,
          redis,
          stellarRpc,
          horizon,
          signer,
          migrations,
          assets
        },
        capabilities: { exact, upto }
      };
    }
  };
}

export function createStaticReadinessService(
  config: AppConfig,
  capabilities: PaymentCapabilities,
  overrides: Partial<ReadinessReport["checks"]> = {}
): ReadinessService {
  const ready: ReadinessCheck = { status: "ready" };
  const checks: ReadinessReport["checks"] = {
    database: ready,
    redis: ready,
    stellarRpc: ready,
    horizon: ready,
    signer: capabilities.exact || capabilities.upto ? ready : { status: "not_required" },
    migrations: ready,
    assets: ready,
    ...overrides
  };

  return {
    async evaluate() {
      const ok = Object.values(checks).every(
        (check) => check.status !== "unavailable" && check.status !== "timeout" && check.status !== "not_configured"
      );
      return {
        ok,
        environment: config.lumenEnv,
        checks,
        capabilities: ok ? capabilities : { exact: false, upto: false }
      };
    }
  };
}

export function createRuntimeReadinessProbes(
  config: AppConfig,
  signerProvider?: FacilitatorSignerProvider,
  probeTimeoutMs: number = defaultProbeTimeoutMs
): ReadinessProbes {
  const network = listConfiguredNetworks(config)[0];

  if (network === undefined) {
    throw new Error(`No Stellar network is configured for ${config.lumenEnv}.`);
  }

  return {
    ...(signerProvider === undefined
      ? {}
      : {
          signer: async () => {
            await signerProvider.assertReady();
            const status = await signerProvider.getStatus();
            if (status.state !== "active") {
              throw new Error("Facilitator signer is not in the active state.");
            }
            if (status.retiring !== undefined && status.retiring.length > 0) {
              const now = Date.now();
              for (const retiring of status.retiring) {
                if (retiring.retireAt <= now) {
                  throw new Error(
                    `Facilitator signer ${retiring.keyId} is past its retirement window.`
                  );
                }
              }
            }
          }
        }),
    async database() {
      const client = createPrismaClient(config.databaseUrl);
      try {
        await client.$queryRawUnsafe("SELECT 1");
      } finally {
        await client.$disconnect();
      }
    },
    async redis() {
      const client = new Redis(config.redisUrl, {
        connectTimeout: probeTimeoutMs,
        enableOfflineQueue: false,
        lazyConnect: true,
        maxRetriesPerRequest: 0
      });
      try {
        await client.connect();
        await client.ping();
      } finally {
        client.disconnect();
      }
    },
    async stellarRpc() {
      const response = await fetchWithTimeout(network.rpcUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getLatestLedger" })
      }, probeTimeoutMs);
      if (!response.ok) {
        throw new Error(`Stellar RPC returned HTTP ${response.status}.`);
      }
      const payload = (await response.json()) as { result?: unknown; error?: unknown };
      if (payload.result === undefined || payload.error !== undefined) {
        throw new Error("Stellar RPC did not return a latest ledger result.");
      }
    },
    async horizon() {
      const response = await fetchWithTimeout(network.horizonUrl, undefined, probeTimeoutMs);
      if (!response.ok) {
        throw new Error(`Horizon returned HTTP ${response.status}.`);
      }
    },
    async migrations() {
      const client = createPrismaClient(config.databaseUrl);
      try {
        const rows = await client.$queryRawUnsafe<
          Array<{
            migration_name: string;
            finished_at: Date | null;
            rolled_back_at: Date | null;
          }>
        >('SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations"');
        if (rows.some((row) => row.finished_at === null && row.rolled_back_at === null)) {
          throw new Error("One or more database migrations are incomplete.");
        }
        const applied = new Set(
          rows.filter((row) => row.finished_at !== null).map((row) => row.migration_name)
        );
        const missing = requiredMigrations.filter((migration) => !applied.has(migration));
        if (missing.length > 0) {
          throw new Error(`Database migrations are missing: ${missing.join(", ")}.`);
        }
      } finally {
        await client.$disconnect();
      }
    },
    async assets() {
      for (const configuredNetwork of listConfiguredNetworks(config)) {
        if (configuredNetwork.assets.length === 0) {
          throw new Error(`${configuredNetwork.id} has no configured assets.`);
        }
        for (const asset of configuredNetwork.assets) {
          if (asset.issuer.length === 0 || asset.issuer === localIssuerPublicKey) {
            throw new Error(`${configuredNetwork.id} has a placeholder asset issuer.`);
          }
        }
      }
    }
  };
}

/**
 * Run a probe with a bounded timeout. Maps results to stable status codes:
 * - success          → "ready"  with latencyMs
 * - AbortError       → "timeout" with latencyMs
 * - any other error  → "unavailable" with a generic reason (raw error is dropped)
 */
async function runProbe(probe: () => Promise<void>, timeoutMs: number): Promise<ReadinessCheck> {
  const start = Date.now();

  // Race the probe against a timeout promise so even probes that don't use
  // AbortSignal internally are still bounded by the global deadline.
  const timeoutPromise = new Promise<never>((_, reject) => {
    const id = setTimeout(() => {
      reject(new ProbeTimeoutError());
    }, timeoutMs);
    // Allow the Node process to exit if only this timer remains.
    if (typeof id === "object" && "unref" in id) (id as NodeJS.Timeout).unref();
  });

  try {
    await Promise.race([probe(), timeoutPromise]);
    return { status: "ready", latencyMs: Date.now() - start };
  } catch (err) {
    const latencyMs = Date.now() - start;
    if (err instanceof ProbeTimeoutError || isAbortError(err)) {
      return { status: "timeout", latencyMs, reason: "probe_timeout" };
    }
    // Drop raw error messages — never surface hostnames, credentials, or stack traces.
    return { status: "unavailable", latencyMs, reason: "dependency_check_failed" };
  }
}

class ProbeTimeoutError extends Error {
  constructor() {
    super("Probe timeout");
    this.name = "ProbeTimeoutError";
  }
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError" || err.message === "The operation was aborted.")
  );
}

function notConfigured(): ReadinessCheck {
  return { status: "not_configured", reason: "probe_not_registered" };
}

async function fetchWithTimeout(url: string, init?: RequestInit, timeoutMs: number = defaultProbeTimeoutMs) {
  const signal = AbortSignal.timeout(timeoutMs);
  return fetch(url, { ...init, signal });
}
