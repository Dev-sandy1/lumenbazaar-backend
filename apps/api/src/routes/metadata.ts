import { type FastifyInstance } from "fastify";

import {
  getReleaseCommit,
  type AppConfig,
  listConfiguredNetworks,
  serviceName
} from "@lumenbazaar/shared";

import { apiOpenApiSpec } from "../openapi.js";
import { type MetricsService } from "../services/metrics.js";
import { type OperationalMetricsRefresher } from "../services/operationalMetrics.js";
import { type ReadinessService } from "../services/readiness.js";

export type MetadataRouteOptions = {
  config: AppConfig;
  metrics: MetricsService;
  readiness: ReadinessService;
  operationalMetrics?: OperationalMetricsRefresher;
};

export function registerMetadataRoutes(app: FastifyInstance, options: MetadataRouteOptions) {
  /**
   * LIVENESS probe — answers "is the process alive?"
   *
   * Performs NO I/O and makes NO dependency calls. Always returns 200 while the
   * process is running, even if every downstream dependency is completely down.
   *
   * Orchestrators (Kubernetes, ECS, etc.) should use this for liveness checks
   * so that a flapping database does not cause the process to be restarted.
   */
  app.get("/health", async () => ({
    ok: true,
    service: serviceName,
    app: "api"
  }));

  /**
   * READINESS probe — answers "is the process ready to serve traffic?"
   *
   * Runs all dependency probes concurrently, each with a bounded timeout
   * (default 2 s, override with READINESS_PROBE_TIMEOUT_MS). Returns 200 only
   * when every required dependency is healthy; returns 503 otherwise.
   *
   * Response body always includes per-dependency status and latency. Errors are
   * redacted to stable reason codes — raw messages, hostnames, and credentials
   * are never surfaced.
   *
   * Orchestrators should use this for readiness / traffic checks so that pods
   * are removed from the load-balancer when dependencies are degraded.
   */
  app.get("/ready", async (_request, reply) => {
    const report = await options.readiness.evaluate();
    options.metrics.setDependencyStatus("postgres", report.checks.database.status === "ready");
    options.metrics.setDependencyStatus("redis", report.checks.redis.status === "ready");
    options.metrics.setDependencyStatus("rpc", report.checks.stellarRpc.status === "ready");
    options.metrics.setDependencyStatus("horizon", report.checks.horizon.status === "ready");
    options.metrics.setDependencyStatus("signer", report.checks.signer.status !== "unavailable" && report.checks.signer.status !== "timeout" && report.checks.signer.status !== "not_configured");
    reply.code(report.ok ? 200 : 503);
    return report;
  });

  app.get("/version", async () => ({
    service: serviceName,
    version: "0.1.0",
    commit: getReleaseCommit(),
    environment: options.config.lumenEnv
  }));

  app.get("/openapi.json", async () => apiOpenApiSpec);
  app.get("/v1/openapi.json", async () => apiOpenApiSpec);

  app.get("/metrics", async (_request, reply) => {
    await options.operationalMetrics?.refresh();
    reply.type("text/plain; version=0.0.4");
    return options.metrics.collect();
  });

  app.get("/v1/networks", async () => ({
    networks: listConfiguredNetworks(options.config).map((network) => ({
      id: network.id,
      displayName: network.displayName,
      passphrase: network.passphrase,
      rpcUrl: network.rpcUrl,
      horizonUrl: network.horizonUrl,
      assets: network.assets
    }))
  }));
}
