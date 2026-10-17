import { type FastifyInstance } from "fastify";
import { z } from "zod";

import { LumenError, type AppConfig, listConfiguredNetworks } from "@lumenbazaar/shared";
import {
  PaymentVerificationService,
  SettlementService,
  toLumenSettleResponse,
  toLumenVerifyResponse,
  type ReceiptService
} from "@lumenbazaar/stellar-payments";

import { parseParams } from "../http/validation.js";
import { type MetricsService } from "../services/metrics.js";
import { type ReadinessService } from "../services/readiness.js";
import { type CapabilityRegistry } from "../services/capabilityRegistry.js";
import { type ReceiptStatusStreamService } from "../services/receiptStatusStreams.js";

export type FacilitatorRouteOptions = {
  config: AppConfig;
  readiness: ReadinessService;
  /**
   * When provided, `GET /v1/supported` reads which schemes are available from
   * the capability registry instead of (or in addition to) the readiness report.
   * The registry is the authoritative source; readiness gates further on live
   * dependency health per request.
   */
  capabilityRegistry?: () => CapabilityRegistry;
  verificationService?: PaymentVerificationService;
  settlementService?: SettlementService;
  receiptService?: ReceiptService;
  metrics?: MetricsService;
  receiptStreams?: ReceiptStatusStreamService;
};

export function registerFacilitatorRoutes(app: FastifyInstance, options: FacilitatorRouteOptions) {
  const verificationService =
    options.verificationService ?? new PaymentVerificationService(options.config);
  const settlementService =
    options.settlementService ??
    new SettlementService(options.config, {
      attemptStore: verificationService.getAttemptStore()
    });
  const receiptService = options.receiptService ?? settlementService.getReceiptService();

  app.get("/v1/supported", async () => {
    const networks = listConfiguredNetworks(options.config);

    // Determine which schemes are supported.
    // When a capability registry is wired in, it is the authoritative source:
    // its decision is derived from adapter startup checks.  The readiness report
    // is evaluated in parallel and acts as a live-dependency gate — a scheme that
    // passes its startup check can still be suppressed if a dependency is down.
    const readinessReport = await options.readiness.evaluate();
    const readinessCapabilities = readinessReport.capabilities;

    const registry = options.capabilityRegistry?.();
    const exactEnabled = registry !== undefined
      ? registry.isSupported("exact", networks[0]?.id ?? "stellar:testnet") && readinessCapabilities.exact
      : readinessCapabilities.exact;
    const uptoEnabled = registry !== undefined
      ? registry.isSupported("upto", networks[0]?.id ?? "stellar:testnet") && readinessCapabilities.upto
      : readinessCapabilities.upto;

    const exactKinds = exactEnabled
      ? networks.map((network) => ({
          x402Version: 2,
          scheme: "exact",
          network: network.id,
          extra: {
            areFeesSponsored: true,
            assets: network.assets.map((asset) => ({
              code: asset.code,
              issuer: asset.issuer,
              contractId: asset.contractId,
              decimals: asset.decimals
            }))
          }
        }))
      : [];
    const uptoKinds = networks.flatMap((network) =>
      uptoEnabled &&
      options.config.features.uptoScheme &&
      network.uptoSessionContractId !== undefined
        ? [
            {
              x402Version: 2,
              scheme: "upto",
              network: network.id,
              extra: {
                assets: network.assets
                  .filter((asset) => asset.contractId !== undefined)
                  .map((asset) => ({
                    code: asset.code,
                    issuer: asset.issuer,
                    contractId: asset.contractId,
                    decimals: asset.decimals
                  })),
                contractId: network.uptoSessionContractId,
                sessionEndpoint: "/v1/payment-sessions"
              }
            }
          ]
        : []
    );

    const kinds = [...exactKinds, ...uptoKinds];

    return {
      kinds,
      extensions: ["bazaar"],
      signers: kinds.length === 0 ? {} : { "stellar:*": [options.config.facilitatorAccount] }
    };
  });

  app.post("/v1/verify", async (request, reply) => {
    const startedAt = Date.now();
    const network = extractPaymentNetwork(request.body);

    try {
      const result = await verificationService.verify(request.body);
      reply.header("x-correlation-id", result.correlationId);
      options.metrics?.recordVerification(result.network, "accepted");
      return toLumenVerifyResponse(result);
    } catch (error) {
      if (error instanceof LumenError && error.code === "REPLAY_DETECTED") {
        options.metrics?.recordVerification(network, "replay");
        options.metrics?.recordReplayRejection(network);
      } else {
        options.metrics?.recordVerification(network, "rejected");
      }
      recordRpcErrorIfNeeded(options.metrics, network, "verify", error);
      throw error;
    } finally {
      options.metrics?.observeVerifyLatency(network, Date.now() - startedAt);
    }
  });

  app.post("/v1/settle", async (request, reply) => {
    const startedAt = Date.now();
    const network = extractPaymentNetwork(request.body);

    try {
      const result = await settlementService.settle(request.body);
      reply.header("x-correlation-id", result.correlationId);
      await options.receiptStreams?.notifyReceipt(result.receiptId);
      options.metrics?.recordSettlementResult(result.network, "settled");
      options.metrics?.observeFinality(result.network, Date.now() - startedAt, "confirmed");
      return toLumenSettleResponse(result);
    } catch (error) {
      options.metrics?.recordSettlementResult(network, "failed");
      options.metrics?.observeFinality(network, Date.now() - startedAt, "failed");
      if (
        error instanceof LumenError &&
        typeof error.details === "object" &&
        error.details !== null &&
        "status" in error.details &&
        error.details.status === "timed_out"
      ) {
        options.metrics?.recordReconciliation(network, "pending");
      }
      recordRpcErrorIfNeeded(options.metrics, network, "settle", error);
      throw error;
    } finally {
      options.metrics?.observeSettleLatency(network, Date.now() - startedAt);
    }
  });
  app.get("/v1/receipts/:receiptId", async (request, reply) => {
    const params = parseParams(request, z.object({ receiptId: z.string().min(1) }));
    const receipt = await receiptService.getReceipt(params.receiptId);
    reply.header("x-correlation-id", receipt.correlationId);
    return receipt;
  });
}

function extractPaymentNetwork(body: unknown): string {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return "unknown";
  }

  const paymentPayload = (body as Record<string, unknown>).paymentPayload;

  if (
    typeof paymentPayload === "object" &&
    paymentPayload !== null &&
    !Array.isArray(paymentPayload)
  ) {
    const accepted = (paymentPayload as Record<string, unknown>).accepted;
    const network =
      typeof accepted === "object" && accepted !== null && !Array.isArray(accepted)
        ? (accepted as Record<string, unknown>).network
        : undefined;

    if (typeof network === "string") {
      return network;
    }
  }

  return "unknown";
}

function recordRpcErrorIfNeeded(
  metrics: MetricsService | undefined,
  network: string,
  operation: string,
  error: unknown
) {
  if (metrics === undefined) {
    return;
  }

  if (error instanceof LumenError) {
    if (error.code === "SETTLEMENT_FAILED" || error.code === "TRUSTLINE_REQUIRED") {
      metrics.recordRpcError(network, operation);
    }
    return;
  }

  metrics.recordRpcError(network, operation);
}
