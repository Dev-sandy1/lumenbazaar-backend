import {
  createCorrelationId,
  getCorrelationId,
  LumenError,
  type AppConfig,
  type PaymentAttempt
} from "@lumenbazaar/shared";
import { type VerifyResponse } from "@x402/core/types";

import { computePaymentHash } from "./hash.js";
import { amountsEqual } from "./amounts.js";
import {
  type NormalizedVerifyPaymentRequest,
  parseVerifyPaymentRequest
} from "./paymentPayload.js";
import {
  type X402StellarAdapter,
  type X402VerificationResult,
  createX402StellarAdapter
} from "./x402Adapter.js";
import { InMemoryPaymentAttemptStore, type PaymentAttemptStore } from "./paymentAttemptStore.js";

export type PaymentVerificationResult = {
  correlationId: string;
  paymentAttemptId: string;
  paymentHash: string;
  network: NormalizedVerifyPaymentRequest["network"];
  status: "verified";
  adapter: "@x402/stellar";
};

export type LumenVerifyResponse = VerifyResponse & {
  isValid: true;
  extra: {
    lumenbazaar: PaymentVerificationResult;
  };
};

export function toLumenVerifyResponse(result: PaymentVerificationResult): LumenVerifyResponse {
  return {
    isValid: true,
    extra: {
      lumenbazaar: result
    }
  };
}

export type PaymentAuditLogger = {
  record: (input: {
    action: string;
    actorId?: string | null;
    actorType: "buyer" | "facilitator" | "seller" | "system";
    metadata?: Record<string, unknown>;
    targetId?: string | null;
    targetType: string;
  }) => Promise<unknown>;
};

export type PaymentVerificationServiceOptions = {
  auditLogService?: PaymentAuditLogger;
  adapter?: X402StellarAdapter;
  attemptStore?: PaymentAttemptStore;
};

export class PaymentVerificationService {
  private readonly auditLogService: PaymentAuditLogger | undefined;
  private readonly adapter: X402StellarAdapter;
  private readonly attemptStore: PaymentAttemptStore;

  constructor(
    private readonly config: AppConfig,
    options: PaymentVerificationServiceOptions = {}
  ) {
    this.adapter = options.adapter ?? createX402StellarAdapter();
    this.attemptStore = options.attemptStore ?? new InMemoryPaymentAttemptStore();
    this.auditLogService = options.auditLogService;
  }

  async verify(input: unknown): Promise<PaymentVerificationResult> {
    const normalized = parseVerifyPaymentRequest(input, this.config);
    const paymentHash = computePaymentHash(normalized.paymentPayload);

    const existing = await this.attemptStore.findPaymentAttemptByHash(paymentHash);
    if (existing !== undefined) {
      return existingVerificationResult(existing, normalized, paymentHash);
    }

    const adapterResult = await this.adapter.verifyExact({
      paymentPayload: normalized.paymentPayload,
      paymentRequirements: normalized.paymentRequirements,
      normalizedRequest: normalized
    });

    assertAdapterAccepted(adapterResult);

    let attempt: PaymentAttempt;
    try {
      attempt = await this.attemptStore.createVerifiedAttempt({
        correlationId: getCorrelationId() ?? createCorrelationId(),
        paymentHash,
        idempotencyKey: `verify:${paymentHash}`,
        network: normalized.network,
        assetCode: normalized.asset.code,
        assetIssuer: normalized.asset.issuer,
        amount: normalized.amount,
        payTo: normalized.payTo
      });
    } catch (error) {
      if (error instanceof LumenError && error.code === "REPLAY_DETECTED") {
        const concurrent = await this.attemptStore.findPaymentAttemptByHash(paymentHash);
        if (concurrent !== undefined) {
          return existingVerificationResult(concurrent, normalized, paymentHash);
        }
      }
      throw error;
    }

    await this.auditLogService?.record({
      action: "payment.verify",
      actorId: null,
      actorType: "facilitator",
      targetId: attempt.id,
      targetType: "payment_attempt",
      metadata: {
        amount: attempt.amount,
        assetCode: attempt.assetCode,
        network: attempt.network,
        resourceId: attempt.resourceId,
        sellerId: attempt.sellerId,
        status: attempt.status
      }
    });

    return {
      correlationId: attempt.correlationId,
      paymentAttemptId: attempt.id,
      paymentHash,
      network: normalized.network,
      status: "verified",
      adapter: adapterResult.adapter
    };
  }

  getAttemptStore() {
    return this.attemptStore;
  }
}

function existingVerificationResult(
  existing: PaymentAttempt,
  normalized: NormalizedVerifyPaymentRequest,
  paymentHash: string
): PaymentVerificationResult {
  if (
    existing.network !== normalized.network ||
    existing.assetCode !== normalized.asset.code ||
    existing.assetIssuer !== normalized.asset.issuer ||
    !amountsEqual(existing.amount, normalized.amount) ||
    existing.payTo !== normalized.payTo
  ) {
    throw new LumenError(
      "REPLAY_DETECTED",
      "Payment authorization was retried with conflicting requirements."
    );
  }
  if (!["verified", "settling", "confirmed"].includes(existing.status)) {
    throw new LumenError("REPLAY_DETECTED", "Payment authorization is no longer reusable.");
  }
  return {
    correlationId: existing.correlationId,
    paymentAttemptId: existing.id,
    paymentHash,
    network: normalized.network,
    status: "verified",
    adapter: "@x402/stellar"
  };
}

function assertAdapterAccepted(result: X402VerificationResult) {
  if (result.valid) {
    return;
  }

  throw new LumenError(
    result.failureCode ?? "INVALID_SIGNATURE",
    result.failureReason ?? "x402 Stellar verification rejected the payload.",
    {
      details: {
        adapter: result.adapter,
        ...(result.officialContext ?? {})
      }
    }
  );
}
