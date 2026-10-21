import { randomUUID } from "node:crypto";

import cors from "@fastify/cors";
import Fastify from "fastify";

import {
  type AppConfig,
  getReleaseCommit,
  listConfiguredNetworks,
  loadConfig,
  runWithCorrelationId,
  runWithTraceparent,
  startTraceSpan
} from "@lumenbazaar/shared";
import {
  PaymentSessionService,
  type PaymentSessionStore,
  PaymentVerificationService,
  ReceiptService,
  SettlementService,
  createPaymentPersistence,
  createRuntimePaymentReconciliation,
  createX402StellarAdapter,
  type FacilitatorSignerProvider
} from "@lumenbazaar/stellar-payments";

import { registerErrorHandling } from "./http/errors.js";
import { registerRateLimitHook } from "./http/rateLimit.js";
import { registerSellerApiKeyAuth } from "./http/sellerApiKeyAuth.js";
import { registerConformanceRoutes } from "./routes/conformance.js";
import { registerDiscoveryRoutes } from "./routes/discovery.js";
import { registerFacilitatorRoutes } from "./routes/facilitator.js";
import { registerMetadataRoutes } from "./routes/metadata.js";
import { registerPaymentSessionRoutes } from "./routes/paymentSessions.js";
import { registerReceiptVerificationRoutes } from "./routes/receiptVerification.js";
import { registerResourceRoutes } from "./routes/resources.js";
import { registerSellerRoutes } from "./routes/sellers.js";
import { registerStreamRoutes } from "./routes/streams.js";
import { registerWebhookRoutes } from "./routes/webhooks.js";
import {
  ReceiptStatusStreamService,
  type EventStreamTuning
} from "./services/receiptStatusStreams.js";
import { StreamAccessService } from "./services/streamAccess.js";
import { createRuntimeAuditLog, type AuditLogService } from "./services/audit.js";
import { createCatalogPersistence } from "./services/catalogPersistence.js";
import { CatalogService } from "./services/cataloging.js";
import { CatalogValidationService } from "./services/catalogValidation.js";
import { ConformanceRunService, createServiceConformanceRunner } from "./services/conformance.js";
import { DiscoveryService } from "./services/discovery.js";
import { createMetricsService, type MetricsService } from "./services/metrics.js";
import { createOperationalMetricsRefresher } from "./services/operationalMetrics.js";
import { createRuntimeRateLimitService, type RateLimitService } from "./services/rateLimit.js";
import {
  createReadinessService,
  createRuntimeReadinessProbes,
  type PaymentCapabilities,
  type ReadinessService
} from "./services/readiness.js";
import {
  buildCapabilityRegistry,
  createStaticCapabilityRegistry,
  type CapabilityRegistry
} from "./services/capabilityRegistry.js";
import { ResourceService } from "./services/resources.js";
import { SearchService } from "./services/search.js";
import { SellerApiKeyService } from "./services/sellerApiKeys.js";
import { SellerService } from "./services/sellers.js";
import type { WebhookService } from "./services/webhooks.js";
import { WebhookEventService } from "./services/webhookEvents.js";

export type BuildApiAppOptions = {
  config?: AppConfig;
  logger?: boolean;
  paymentSessionService?: PaymentSessionService;
  paymentSessionStore?: PaymentSessionStore;
  verificationService?: PaymentVerificationService;
  settlementService?: SettlementService;
  receiptService?: ReceiptService;
  sellerService?: SellerService;
  sellerApiKeyService?: SellerApiKeyService;
  webhookService?: WebhookService;
  webhookEventService?: WebhookEventService;
  resourceService?: ResourceService;
  catalogValidationService?: CatalogValidationService;
  catalogService?: CatalogService;
  discoveryService?: DiscoveryService;
  searchService?: SearchService;
  conformanceService?: ConformanceRunService;
  auditLogService?: AuditLogService;
  rateLimitService?: RateLimitService;
  metricsService?: MetricsService;
  /**
   * Static capability overrides injected in tests.
   *
   * May only RESTRICT capabilities (set `exact: false` or `upto: false`),
   * never ADD them.  A scheme set to `false` here will not be registered even
   * if its adapter startup check passes.  This behaviour is tested in
   * `capabilityRegistry.test.ts`.
   *
   * @deprecated as the primary source of truth — use `capabilityRegistry`
   *   or `signerProvider` for live deployments.  This option is retained
   *   solely for test isolation.
   */
  paymentCapabilities?: PaymentCapabilities;
  readinessService?: ReadinessService;
  signerProvider?: FacilitatorSignerProvider;
  /**
   * Pre-built capability registry.  Injected by tests that need fine-grained
   * control over which schemes are reported as supported without running real
   * adapter startup checks.
   */
  capabilityRegistry?: CapabilityRegistry;
  streamAccessService?: StreamAccessService;
  receiptStatusStreamService?: ReceiptStatusStreamService;
  eventStreamTuning?: EventStreamTuning;
};

export function buildApiApp(options: BuildApiAppOptions = {}) {
  const config = options.config ?? loadConfig();
  const app = Fastify({
    genReqId: () => randomUUID(),
    logger: options.logger ?? config.nodeEnv !== "test",
    trustProxy: false
  });
  const paymentPersistence = createPaymentPersistence(config);
  app.addHook("onClose", async () => paymentPersistence.close());
  const paymentReconciliation = createRuntimePaymentReconciliation(config);
  app.addHook("onClose", async () => paymentReconciliation.close());
  const catalogPersistence = createCatalogPersistence(config);
  app.addHook("onClose", async () => catalogPersistence.close());
  const runtimeAdapter =
    options.signerProvider === undefined
      ? undefined
      : createX402StellarAdapter({ config, signerProvider: options.signerProvider });
  const paymentCapabilities = options.paymentCapabilities ?? {
    exact:
      runtimeAdapter !== undefined &&
      listConfiguredNetworks(config).every((network) =>
        network.assets.some((asset) => asset.contractId !== undefined)
      ),
    upto: false
  };
  const readinessService =
    options.readinessService ??
    createReadinessService(
      config,
      paymentCapabilities,
      createRuntimeReadinessProbes(config, options.signerProvider)
    );

  void app.register(cors, {
    origin: config.api.corsAllowedOrigins
  });

  registerErrorHandling(app);

  const requestSpans = new WeakMap<object, ReturnType<typeof startTraceSpan>>();
  app.addHook("onRequest", (request, reply, done) => {
    const incomingTraceparent =
      typeof request.headers.traceparent === "string" ? request.headers.traceparent : undefined;
    runWithTraceparent(incomingTraceparent, () => {
      const span = startTraceSpan("http.server.request", {
        "http.request.method": request.method
      });
      requestSpans.set(request, span);
      runWithCorrelationId(request.id, () => {
        span.run(() => {
          if (span.traceparent !== undefined) reply.header("traceparent", span.traceparent);
          reply.header("x-request-id", request.id);
          reply.header("x-correlation-id", request.id);
          done();
        });
      });
    });
  });
  app.addHook("onResponse", (request, reply, done) => {
    requestSpans.get(request)?.end({
      "http.response.status_code": reply.statusCode,
      "http.route": request.routeOptions.url ?? "unmatched"
    });
    done();
  });

  const runtimeAuditLog =
    options.auditLogService === undefined ? createRuntimeAuditLog(config) : undefined;
  const auditLogService = options.auditLogService ?? runtimeAuditLog!.service;
  if (runtimeAuditLog !== undefined) {
    app.addHook("onClose", async () => runtimeAuditLog.close());
  }
  const runtimeRateLimit =
    options.rateLimitService === undefined ? createRuntimeRateLimitService(config) : undefined;
  const rateLimitService = options.rateLimitService ?? runtimeRateLimit!.service;
  if (runtimeRateLimit !== undefined) {
    app.addHook("onClose", async () => runtimeRateLimit.close());
  }
  const sellerService =
    options.sellerService ?? new SellerService(catalogPersistence.sellerStore, auditLogService);
  const resourceService =
    options.resourceService ??
    new ResourceService(
      config,
      sellerService,
      catalogPersistence.resourceStore,
      catalogPersistence.indexingQueue,
      auditLogService
    );
  const sellerApiKeyService =
    options.sellerApiKeyService ??
    new SellerApiKeyService(catalogPersistence.sellerApiKeyStore, auditLogService);
  registerSellerApiKeyAuth(app, {
    sellerApiKeyService,
    resolveResourceSeller: async (resourceId) => {
      const resource = await resourceService.getResource(resourceId).catch(() => undefined);
      return resource?.sellerId;
    }
  });
  registerRateLimitHook(app, { rateLimitService });
  const metricsService = options.metricsService ?? createMetricsService();
  const operationalMetrics = createOperationalMetricsRefresher(config, metricsService);
  app.addHook("onClose", async () => operationalMetrics.close());
  const receiptService =
    options.receiptService ?? new ReceiptService({ receiptStore: paymentPersistence.receiptStore });

  registerMetadataRoutes(app, {
    config,
    metrics: metricsService,
    readiness: readinessService,
    operationalMetrics
  });
  const verificationService =
    options.verificationService ??
    new PaymentVerificationService(config, {
      auditLogService,
      attemptStore: paymentPersistence.attemptStore,
      ...(runtimeAdapter === undefined ? {} : { adapter: runtimeAdapter })
    });
  const settlementService =
    options.settlementService ??
    new SettlementService(config, {
      auditLogService,
      attemptStore: verificationService.getAttemptStore(),
      settlementStore: paymentPersistence.settlementStore,
      receiptService,
      ...(paymentReconciliation.scheduler === undefined
        ? {}
        : { reconciliationScheduler: paymentReconciliation.scheduler }),
      ...(options.verificationService === undefined &&
      paymentPersistence.statePersistence !== undefined
        ? { statePersistence: paymentPersistence.statePersistence }
        : {}),
      ...(runtimeAdapter === undefined ? {} : { adapter: runtimeAdapter })
    });
  const routeReceiptService = options.receiptService ?? settlementService.getReceiptService();
  const paymentSessionService =
    options.paymentSessionService ??
    new PaymentSessionService(config, {
      auditLogService,
      store: options.paymentSessionStore ?? paymentPersistence.paymentSessionStore
    });
  const catalogValidationService =
    options.catalogValidationService ?? new CatalogValidationService(config, sellerService);
  const catalogService =
    options.catalogService ??
    new CatalogService(catalogValidationService, resourceService, {
      auditLogService,
      eventStore: catalogPersistence.eventStore,
      indexingQueue: catalogPersistence.indexingQueue,
      metrics: metricsService
    });
  const discoveryService = options.discoveryService ?? new DiscoveryService(resourceService);
  const searchService =
    options.searchService ??
    new SearchService(resourceService, metricsService, catalogPersistence.searchDocumentStore);
  // ── Capability registry ──────────────────────────────────────────────────────
  // Built asynchronously in onReady so adapter startup checks complete before
  // traffic is accepted. Tests may inject a pre-built registry via options.
  let capRegistry: CapabilityRegistry | undefined = options.capabilityRegistry;

  // When no pre-built registry is provided, construct one in onReady.
  if (capRegistry === undefined) {
    app.addHook("onReady", async () => {
      capRegistry = await buildCapabilityRegistry({
        exactAdapter: runtimeAdapter,
        uptoService:
          options.paymentSessionService === undefined ? paymentSessionService : undefined,
        networks: listConfiguredNetworks(config).map((n) => n.id),
        allowedCapabilities: options.paymentCapabilities,
        checkOptions: { timeoutMs: 5_000 },
        logger: {
          info: (msg, data) => app.log.info({ ...data, event: msg }),
          warn: (msg, data) => app.log.warn({ ...data, event: msg })
        }
      });
    });
  }

  // Accessor used by routes: always resolves after onReady has run.
  function getCapabilityRegistry(): CapabilityRegistry {
    if (capRegistry === undefined) {
      // This can only happen if a route fires before onReady, which Fastify
      // prevents. Return an empty registry as a safe fallback.
      return createStaticCapabilityRegistry({});
    }
    return capRegistry;
  }

  const conformanceService =
    options.conformanceService ??
    new ConformanceRunService(
      createServiceConformanceRunner(
        config,
        verificationService,
        settlementService,
        paymentSessionService
      ),
      undefined,
      {
        // Capability options are forwarded from the registry once initialized.
        // These are overridden at runtime via getCapabilityRegistry() in the
        // conformance service when a registry is wired in.
        exactEnabled: options.paymentCapabilities?.exact,
        uptoEnabled:
          options.paymentCapabilities?.upto !== undefined
            ? config.features.uptoScheme && options.paymentCapabilities.upto
            : undefined,
        capabilityRegistry: () => getCapabilityRegistry(),
        isLive: config.lumenEnv !== "local" && config.lumenEnv !== "test",
        commit: getReleaseCommit(),
        x402PackageVersion: "2.28.0"
      }
    );

  const streamAccessService =
    options.streamAccessService ??
    new StreamAccessService({ signingSecret: config.eventStreams.signingSecret });
  const receiptStatusStreams =
    options.receiptStatusStreamService ??
    new ReceiptStatusStreamService({
      receiptService: routeReceiptService,
      streamAccess: streamAccessService,
      ...(options.eventStreamTuning ?? {})
    });
  app.addHook("onClose", async () => receiptStatusStreams.close());
  const unsubscribeReceiptStatusChanges =
    paymentPersistence.statePersistence?.subscribeToReceiptStatusChanges((change) =>
      receiptStatusStreams.publish(change)
    );
  if (unsubscribeReceiptStatusChanges !== undefined) {
    app.addHook("onClose", async () => unsubscribeReceiptStatusChanges());
  }

  const webhookEventService = options.webhookEventService ?? new WebhookEventService();
  void webhookEventService;

  registerFacilitatorRoutes(app, {
    config,
    verificationService,
    settlementService,
    receiptService: routeReceiptService,
    metrics: metricsService,
    readiness: readinessService,
    receiptStreams: receiptStatusStreams,
    capabilityRegistry: () => getCapabilityRegistry()
  });
  registerPaymentSessionRoutes(app, { paymentSessionService });
  registerSellerRoutes(app, { sellerService, sellerApiKeyService });
  registerWebhookRoutes(app, { webhookService: options.webhookService });
  registerResourceRoutes(app, { resourceService });
  registerDiscoveryRoutes(app, {
    catalogValidationService,
    catalogService,
    discoveryService,
    searchService
  });
  registerConformanceRoutes(app, {
    conformanceService
  });
  registerStreamRoutes(app, {
    receiptService: routeReceiptService,
    sellerService,
    streamAccess: receiptStatusStreams.streamAccess,
    streams: receiptStatusStreams
  });
  registerReceiptVerificationRoutes(app, {
    receiptService: routeReceiptService,
    attemptStore: verificationService.getAttemptStore(),
    settlementStore: paymentPersistence.settlementStore
  });

  return app;
}
