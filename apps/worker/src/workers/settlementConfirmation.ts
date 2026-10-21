import { createHash, randomUUID } from "node:crypto";

import { type PrismaClient } from "@prisma/client";
import * as StellarSdk from "@stellar/stellar-sdk";
import { type Job, type Queue } from "bullmq";

import { type AppConfig, getPrismaClient, redactSensitiveText } from "@lumenbazaar/shared";
import { createHorizonClient } from "@lumenbazaar/stellar-payments";

import { enqueueSettlementConfirmation } from "../jobQueue.js";

export type SettlementConfirmationJobData = {
  correlationId?: string;
  paymentAttemptId: string;
  settlementId?: string;
  transactionHash?: string;
  network: string;
};

export type ChainTransactionState =
  | { status: "confirmed"; ledger: number }
  | { status: "failed"; reason: string }
  | { status: "pending"; reason: string };

export type TransactionStatusClient = {
  getTransactionState: (transactionHash: string, network: string) => Promise<ChainTransactionState>;
};

export class ReconciliationPendingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReconciliationPendingError";
  }
}

export async function handleSettlementConfirmation(
  job: Job<SettlementConfirmationJobData>,
  config: AppConfig,
  dependencies: {
    db?: PrismaClient;
    statusClient?: TransactionStatusClient;
  } = {}
) {
  const db = dependencies.db ?? getPrismaClient();
  const statusClient = dependencies.statusClient ?? createTransactionStatusClient(config);
  const attempt = await db.paymentAttempt.findUnique({
    where: { id: job.data.paymentAttemptId },
    include: { settlement: true, receipt: true }
  });
  if (attempt === null) {
    throw new Error(`Payment attempt not found: ${job.data.paymentAttemptId}`);
  }
  const settlement = attempt.settlement;

  // Duplicate / already final jobs are harmless
  if (
    (settlement?.status === "confirmed" && attempt.receipt?.status === "finalized") ||
    settlement?.reconciliationState === "reconciled" ||
    attempt.status === "confirmed"
  ) {
    await job.log(`Settlement ${settlement?.id ?? attempt.id} is already final.`);
    return;
  }

  // Already marked for manual review / failed jobs are harmless
  if (
    settlement?.reconciliationState === "needs_review" ||
    (settlement?.status === "failed" && attempt.status === "failed")
  ) {
    await job.log(
      `Settlement ${settlement?.id ?? attempt.id} is already marked for manual review.`
    );
    return;
  }

  const transactionHash = settlement?.transactionHash ?? job.data.transactionHash;
  if (settlement === null || transactionHash === null || transactionHash === undefined) {
    const reason = "No submitted transaction evidence is available; manual review is required.";
    await db.$transaction([
      db.paymentAttempt.update({
        where: { id: attempt.id },
        data: {
          status: "failed",
          failureCode: "SETTLEMENT_FAILED",
          failureReason: reason
        }
      }),
      db.auditLog.create({
        data: {
          correlationId: attempt.correlationId,
          actorType: "system",
          action: "settlement.reconciliation.needs_review",
          targetType: "payment_attempt",
          targetId: attempt.id,
          metadata: { reason: "missing_transaction_evidence" }
        }
      })
    ]);
    await job.log(reason);
    return;
  }

  let state: ChainTransactionState;
  try {
    state = await statusClient.getTransactionState(transactionHash, settlement.network);
  } catch (error) {
    if (isTimeoutError(error)) {
      state = {
        status: "pending",
        reason: `Transaction status check timed out: ${redactSensitiveText((error as Error).message ?? "timeout")}`
      };
    } else if (isNotFound(error)) {
      state = {
        status: "pending",
        reason: "Transaction is not yet visible on Horizon."
      };
    } else if (isMalformedError(error)) {
      state = {
        status: "failed",
        reason: `Provider returned a malformed response: ${redactSensitiveText((error as Error).message ?? "malformed")}`
      };
    } else {
      throw error;
    }
  }

  // Guard against malformed state objects returned from status client
  if (
    state === null ||
    typeof state !== "object" ||
    !("status" in state) ||
    (state.status === "confirmed" &&
      (typeof state.ledger !== "number" || !Number.isInteger(state.ledger) || state.ledger <= 0))
  ) {
    const reason =
      "Provider returned a malformed transaction state: missing valid ledger or status.";
    await recordNeedsReview(db, attempt.id, settlement.id, reason);
    await job.log(`Settlement ${settlement.id} requires manual review: ${reason}`);
    return;
  }

  if (state.status === "pending") {
    const stateReason = redactSensitiveText(state.reason);
    const isExhausted = job.opts?.attempts !== undefined && job.attemptsMade >= job.opts.attempts;

    if (isExhausted) {
      const exhaustedReason = `Reconciliation retries exhausted: ${stateReason}`;
      await recordNeedsReview(db, attempt.id, settlement.id, exhaustedReason);
      await job.log(
        `Settlement ${settlement.id} retries exhausted, recorded for manual review: ${exhaustedReason}`
      );
      throw new ReconciliationPendingError(exhaustedReason);
    }

    await db.settlement.update({
      where: { id: settlement.id },
      data: {
        reconciliationState: "pending",
        reconciliationReason: stateReason,
        reconciliationAttempts: { increment: 1 },
        lastReconciledAt: new Date()
      }
    });
    throw new ReconciliationPendingError(stateReason);
  }

  if (state.status === "failed") {
    const reason = redactSensitiveText(state.reason);
    await recordNeedsReview(db, attempt.id, settlement.id, reason);
    await job.log(`Settlement ${settlement.id} requires manual review: ${reason}`);
    return;
  }

  const settledAt = new Date();
  const evidenceHash = createHash("sha256")
    .update(
      [
        attempt.id,
        attempt.paymentHash,
        transactionHash,
        String(state.ledger),
        settlement.network,
        settlement.amount.toString(),
        settlement.assetIssuer
      ].join(":"),
      "utf8"
    )
    .digest("hex");
  await db.$transaction(async (tx) => {
    await tx.settlement.update({
      where: { id: settlement.id },
      data: {
        status: "confirmed",
        ledger: state.ledger,
        settledAt,
        reconciliationState: "reconciled",
        reconciliationReason: null,
        reconciliationAttempts: { increment: 1 },
        lastReconciledAt: settledAt
      }
    });
    await tx.paymentAttempt.update({
      where: { id: attempt.id },
      data: { status: "confirmed", failureCode: null, failureReason: null }
    });
    await tx.receipt.upsert({
      where: { paymentAttemptId: attempt.id },
      create: {
        id: `receipt_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
        correlationId: attempt.correlationId,
        paymentAttemptId: attempt.id,
        resourceId: attempt.resourceId,
        sellerId: attempt.sellerId,
        transactionHash,
        ledger: state.ledger,
        network: attempt.network,
        amount: attempt.amount,
        assetCode: attempt.assetCode,
        assetIssuer: attempt.assetIssuer,
        status: "finalized",
        settledAt,
        failureCode: null,
        failureReason: null,
        evidenceHash
      },
      update: {
        transactionHash,
        ledger: state.ledger,
        status: "finalized",
        settledAt,
        failureCode: null,
        failureReason: null,
        evidenceHash
      }
    });
    await tx.auditLog.create({
      data: {
        correlationId: attempt.correlationId,
        actorType: "system",
        action: "settlement.reconciliation.confirmed",
        targetType: "settlement",
        targetId: settlement.id,
        metadata: {
          ledger: state.ledger,
          network: settlement.network,
          paymentAttemptId: attempt.id,
          transactionHash
        }
      }
    });
  });
  await job.log(`Settlement ${settlement.id} reconciled in ledger ${state.ledger}.`);
}

export async function markReconciliationDeadLetter(
  db: PrismaClient,
  data: SettlementConfirmationJobData,
  reason: string
) {
  const settlementId =
    data.settlementId ??
    (
      await db.settlement.findUnique({
        where: { paymentAttemptId: data.paymentAttemptId },
        select: { id: true }
      })
    )?.id;

  if (settlementId !== undefined) {
    await recordNeedsReview(db, data.paymentAttemptId, settlementId, reason);
    return;
  }

  const attempt = await db.paymentAttempt.findUnique({
    where: { id: data.paymentAttemptId },
    select: { id: true, correlationId: true }
  });

  if (attempt !== null) {
    await db.$transaction([
      db.paymentAttempt.update({
        where: { id: data.paymentAttemptId },
        data: { status: "failed", failureCode: "SETTLEMENT_FAILED", failureReason: reason }
      }),
      db.auditLog.create({
        data: {
          correlationId: attempt.correlationId,
          actorType: "system",
          action: "settlement.reconciliation.needs_review",
          targetType: "payment_attempt",
          targetId: attempt.id,
          metadata: { reason }
        }
      })
    ]);
  }
}

export async function resumePendingSettlements(
  db: PrismaClient,
  queue: Queue,
  options: { take?: number } = {}
): Promise<number> {
  const attempts = await db.paymentAttempt.findMany({
    where: {
      OR: [
        { status: "settling", settlement: null },
        {
          settlement: {
            is: {
              transactionHash: { not: null },
              reconciliationState: { notIn: ["reconciled", "needs_review"] },
              OR: [
                { reconciliationState: "pending" },
                { status: { in: ["pending", "submitted", "timed_out"] } }
              ]
            }
          }
        }
      ]
    },
    include: { settlement: true },
    take: options.take ?? 1000
  });

  for (const attempt of attempts) {
    await enqueueSettlementConfirmation(queue, {
      correlationId: attempt.correlationId,
      paymentAttemptId: attempt.id,
      network: attempt.network,
      ...(attempt.settlement === null
        ? {}
        : {
            settlementId: attempt.settlement.id,
            ...(attempt.settlement.transactionHash === null
              ? {}
              : { transactionHash: attempt.settlement.transactionHash })
          })
    });
  }

  return attempts.length;
}

export function createTransactionStatusClient(config: AppConfig): TransactionStatusClient {
  return {
    async getTransactionState(transactionHash, network) {
      const horizonRef = createHorizonClient(config, network);
      const server = new StellarSdk.Horizon.Server(horizonRef.url, {
        allowHttp: horizonRef.url.startsWith("http://")
      });
      try {
        const transaction = await server.transactions().transaction(transactionHash).call();
        if (
          transaction === null ||
          typeof transaction !== "object" ||
          typeof transaction.successful !== "boolean"
        ) {
          return {
            status: "failed",
            reason: "Provider returned a malformed transaction response: invalid structure."
          };
        }
        if (transaction.successful === false) {
          return { status: "failed", reason: "Stellar recorded the transaction as failed." };
        }
        const ledger = transaction.ledger_attr;
        if (typeof ledger !== "number" || !Number.isInteger(ledger) || ledger <= 0) {
          return {
            status: "failed",
            reason:
              "Provider returned a malformed transaction response: missing or invalid ledger attribute."
          };
        }
        return { status: "confirmed", ledger };
      } catch (error) {
        if (isNotFound(error)) {
          return { status: "pending", reason: "Transaction is not yet visible on Horizon." };
        }
        if (isTimeoutError(error)) {
          return { status: "pending", reason: "Horizon provider request timed out." };
        }
        if (isMalformedError(error)) {
          return { status: "failed", reason: "Provider returned a malformed response." };
        }
        throw error;
      }
    }
  };
}

async function recordNeedsReview(
  db: PrismaClient,
  paymentAttemptId: string,
  settlementId: string,
  reason: string
) {
  const attempt = await db.paymentAttempt.findUnique({
    where: { id: paymentAttemptId },
    select: { correlationId: true }
  });
  if (attempt === null) {
    return;
  }
  await db.$transaction([
    db.settlement.update({
      where: { id: settlementId },
      data: {
        status: "failed",
        reconciliationState: "needs_review",
        reconciliationReason: reason,
        reconciliationAttempts: { increment: 1 },
        lastReconciledAt: new Date()
      }
    }),
    db.paymentAttempt.update({
      where: { id: paymentAttemptId },
      data: { status: "failed", failureCode: "SETTLEMENT_FAILED", failureReason: reason }
    }),
    db.auditLog.create({
      data: {
        correlationId: attempt.correlationId,
        actorType: "system",
        action: "settlement.reconciliation.needs_review",
        targetType: "settlement",
        targetId: settlementId,
        metadata: { paymentAttemptId, reason }
      }
    })
  ]);
}

export function isNotFound(error: unknown) {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { response?: { status?: number }; status?: number };
  return candidate.status === 404 || candidate.response?.status === 404;
}

export function isTimeoutError(error: unknown) {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as {
    response?: { status?: number };
    status?: number;
    code?: string;
    name?: string;
    message?: string;
  };
  if (candidate.status === 408 || candidate.status === 504) return true;
  if (candidate.response?.status === 408 || candidate.response?.status === 504) return true;
  if (
    candidate.code === "ETIMEDOUT" ||
    candidate.code === "ECONNABORTED" ||
    candidate.code === "ESOCKETTIMEDOUT"
  ) {
    return true;
  }
  if (candidate.name === "TimeoutError" || candidate.name === "AbortError") return true;
  if (typeof candidate.message === "string" && /timeout|timed out|abort/i.test(candidate.message)) {
    return true;
  }
  return false;
}

export function isMalformedError(error: unknown) {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const candidate = error as { name?: string; message?: string };
  if (candidate.name === "SyntaxError") return true;
  if (
    typeof candidate.message === "string" &&
    /malformed|unexpected token|invalid json|bad response/i.test(candidate.message)
  ) {
    return true;
  }
  return false;
}
