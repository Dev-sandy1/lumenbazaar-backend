import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import {
  createCorrelationId,
  getCorrelationId,
  LumenError,
  isSupportedNetwork,
  type ErrorCode,
  type PaymentAttempt,
  type Receipt,
  type Settlement
} from "@lumenbazaar/shared";

import {
  type CreatePaymentAttemptInput,
  type PaymentAttemptStore,
  type UpdatePaymentAttemptInput
} from "./paymentAttemptStore.js";
import {
  type ConfirmedPaymentStateInput,
  type FailedPaymentStateInput,
  type PaymentStatePersistence
} from "./paymentStatePersistence.js";
import { receiptEvidenceHash } from "./receipt.js";
import { type CreateReceiptInput, type ReceiptStore } from "./receiptStore.js";
import { type CreateSettlementInput, type SettlementStore } from "./settlementStore.js";

type PaymentDatabaseClient = Pick<PrismaClient, "paymentAttempt" | "receipt" | "settlement">;

export class PrismaPaymentAttemptStore implements PaymentAttemptStore {
  constructor(private readonly db: PaymentDatabaseClient) {}

  async createVerifiedAttempt(input: CreatePaymentAttemptInput) {
    try {
      return mapPaymentAttempt(
        await this.db.paymentAttempt.create({
          data: {
            correlationId: input.correlationId ?? getCorrelationId() ?? createCorrelationId(),
            paymentHash: input.paymentHash,
            idempotencyKey: input.idempotencyKey ?? `verify:${input.paymentHash}`,
            network: input.network,
            assetCode: input.assetCode,
            assetIssuer: input.assetIssuer,
            amount: input.amount,
            payTo: input.payTo,
            status: "verified",
            ...(input.resourceId === undefined ? {} : { resourceId: input.resourceId }),
            ...(input.sellerId === undefined ? {} : { sellerId: input.sellerId }),
            ...(input.expiresAtLedger === undefined
              ? {}
              : { expiresAtLedger: input.expiresAtLedger })
          }
        })
      );
    } catch (error) {
      throwReplayOr(error);
    }
  }

  async getPaymentAttempt(paymentAttemptId: string) {
    const row = await this.db.paymentAttempt.findUnique({ where: { id: paymentAttemptId } });
    return row === null ? undefined : mapPaymentAttempt(row);
  }

  async claimSettlement(paymentAttemptId: string) {
    const claimed = await this.db.paymentAttempt.updateMany({
      where: { id: paymentAttemptId, status: "verified" },
      data: { status: "settling", failureCode: null, failureReason: null }
    });
    if (claimed.count === 0) {
      return undefined;
    }
    return this.getPaymentAttempt(paymentAttemptId);
  }

  async findPaymentAttemptByHash(paymentHash: string) {
    const row = await this.db.paymentAttempt.findUnique({ where: { paymentHash } });
    return row === null ? undefined : mapPaymentAttempt(row);
  }

  async updatePaymentAttempt(paymentAttemptId: string, input: UpdatePaymentAttemptInput) {
    try {
      return mapPaymentAttempt(
        await this.db.paymentAttempt.update({
          where: { id: paymentAttemptId },
          data: {
            ...(input.status === undefined ? {} : { status: input.status }),
            ...(input.failureCode === undefined ? {} : { failureCode: input.failureCode }),
            ...(input.failureReason === undefined ? {} : { failureReason: input.failureReason })
          }
        })
      );
    } catch (error) {
      if (isNotFound(error)) {
        throw new LumenError("INVALID_PAYMENT_PAYLOAD", "Payment attempt was not found.");
      }
      throw error;
    }
  }
}

export class PrismaSettlementStore implements SettlementStore {
  constructor(private readonly db: PaymentDatabaseClient) {}

  async createSettlement(input: CreateSettlementInput) {
    try {
      return mapSettlement(await this.db.settlement.create({ data: settlementData(input) }));
    } catch (error) {
      throwReplayOr(error);
    }
  }

  async getSettlementByAttempt(paymentAttemptId: string) {
    const row = await this.db.settlement.findUnique({ where: { paymentAttemptId } });
    return row === null ? undefined : mapSettlement(row);
  }

  async getSettlementByTransactionHash(transactionHash: string) {
    const row = await this.db.settlement.findUnique({ where: { transactionHash } });
    return row === null ? undefined : mapSettlement(row);
  }
}

export class PrismaReceiptStore implements ReceiptStore {
  constructor(private readonly db: PaymentDatabaseClient) {}

  async createReceipt(input: CreateReceiptInput) {
    try {
      return mapReceipt(await this.db.receipt.create({ data: receiptData(input) }));
    } catch (error) {
      throwReplayOr(error);
    }
  }

  async getReceipt(receiptId: string) {
    const row = await this.db.receipt.findUnique({ where: { id: receiptId } });
    return row === null ? undefined : mapReceipt(row);
  }

  async getReceiptByAttempt(paymentAttemptId: string) {
    const row = await this.db.receipt.findUnique({ where: { paymentAttemptId } });
    return row === null ? undefined : mapReceipt(row);
  }
}

export class PrismaPaymentStatePersistence implements PaymentStatePersistence {
  constructor(private readonly client: PrismaClient) {}

  async recordConfirmed(input: ConfirmedPaymentStateInput) {
    try {
      return await this.client.$transaction(async (tx) => {
        const settlement = mapSettlement(
          await tx.settlement.create({
            data: settlementData({
              ...input.settlement,
              correlationId: input.attempt.correlationId
            })
          })
        );
        const transition = await tx.paymentAttempt.updateMany({
          where: { id: input.attempt.id, status: "settling" },
          data: { status: "confirmed", failureCode: null, failureReason: null }
        });
        if (transition.count !== 1) {
          throw new LumenError("REPLAY_DETECTED", "Payment state transition was already claimed.");
        }
        const attempt = mapPaymentAttempt(
          await tx.paymentAttempt.findUniqueOrThrow({ where: { id: input.attempt.id } })
        );
        const receipt = mapReceipt(
          await tx.receipt.create({
            data: receiptData({
              correlationId: attempt.correlationId,
              paymentAttemptId: attempt.id,
              resourceId: attempt.resourceId,
              sellerId: attempt.sellerId,
              transactionHash: settlement.transactionHash,
              ledger: settlement.ledger,
              network: attempt.network,
              amount: attempt.amount,
              assetCode: attempt.assetCode,
              assetIssuer: attempt.assetIssuer,
              status: "finalized",
              settledAt: settlement.settledAt,
              failureCode: null,
              failureReason: null,
              evidenceHash: receiptEvidenceHash(attempt, settlement)
            })
          })
        );
        return { attempt, settlement, receipt };
      });
    } catch (error) {
      throwReplayOr(error);
    }
  }

  async recordFailed(input: FailedPaymentStateInput) {
    try {
      return await this.client.$transaction(async (tx) => {
        const settlement = mapSettlement(
          await tx.settlement.create({
            data: settlementData({
              ...input.settlement,
              correlationId: input.attempt.correlationId
            })
          })
        );
        const transition = await tx.paymentAttempt.updateMany({
          where: { id: input.attempt.id, status: "settling" },
          data: {
            status: input.settlement.status,
            failureCode: input.failureCode,
            failureReason: input.failureReason
          }
        });
        if (transition.count !== 1) {
          throw new LumenError("REPLAY_DETECTED", "Payment state transition was already claimed.");
        }
        const attempt = mapPaymentAttempt(
          await tx.paymentAttempt.findUniqueOrThrow({ where: { id: input.attempt.id } })
        );
        return { attempt, settlement };
      });
    } catch (error) {
      throwReplayOr(error);
    }
  }
}

function settlementData(input: CreateSettlementInput): Prisma.SettlementUncheckedCreateInput {
  return {
    correlationId: input.correlationId ?? getCorrelationId() ?? createCorrelationId(),
    paymentAttemptId: input.paymentAttemptId,
    network: input.network,
    amount: input.amount,
    assetCode: input.assetCode,
    assetIssuer: input.assetIssuer,
    status: input.status,
    reconciliationState: input.reconciliationState ?? "not_required",
    ...(input.transactionHash === undefined ? {} : { transactionHash: input.transactionHash }),
    ...(input.ledger === undefined ? {} : { ledger: input.ledger }),
    ...(input.settledAt === undefined ? {} : { settledAt: new Date(input.settledAt) })
  };
}

function receiptData(input: CreateReceiptInput): Prisma.ReceiptUncheckedCreateInput {
  return {
    id: `receipt_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
    correlationId: input.correlationId ?? getCorrelationId() ?? createCorrelationId(),
    paymentAttemptId: input.paymentAttemptId,
    resourceId: input.resourceId,
    sellerId: input.sellerId,
    transactionHash: input.transactionHash,
    ledger: input.ledger,
    network: input.network,
    amount: input.amount,
    assetCode: input.assetCode,
    assetIssuer: input.assetIssuer,
    status: input.status,
    settledAt: input.settledAt === null ? null : new Date(input.settledAt),
    failureCode: input.failureCode,
    failureReason: input.failureReason,
    evidenceHash: input.evidenceHash
  };
}

function mapAmount(value: Prisma.Decimal): string {
  const [whole = "0", fraction = ""] = value.toFixed().split(".");
  const trimmedFraction = fraction.replace(/0+$/u, "");

  return trimmedFraction.length === 0 ? whole : `${whole}.${trimmedFraction}`;
}

function mapPaymentAttempt(row: Prisma.PaymentAttemptGetPayload<object>): PaymentAttempt {
  return {
    ...row,
    network: requireNetwork(row.network),
    amount: mapAmount(row.amount),
    status: row.status as PaymentAttempt["status"],
    failureCode: row.failureCode as ErrorCode | null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function mapSettlement(row: Prisma.SettlementGetPayload<object>): Settlement {
  return {
    ...row,
    network: requireNetwork(row.network),
    amount: mapAmount(row.amount),
    status: row.status as Settlement["status"],
    reconciliationState: row.reconciliationState as Settlement["reconciliationState"],
    reconciliationReason: row.reconciliationReason,
    reconciliationAttempts: row.reconciliationAttempts,
    lastReconciledAt: row.lastReconciledAt?.toISOString() ?? null,
    settledAt: row.settledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString()
  };
}

function mapReceipt(row: Prisma.ReceiptGetPayload<object>): Receipt {
  return {
    ...row,
    network: requireNetwork(row.network),
    amount: mapAmount(row.amount),
    status: row.status as Receipt["status"],
    failureCode: row.failureCode as ErrorCode | null,
    settledAt: row.settledAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function requireNetwork(network: string) {
  if (!isSupportedNetwork(network)) {
    throw new Error("Stored payment network is not supported.");
  }
  return network;
}

function throwReplayOr(error: unknown): never {
  if (isUniqueViolation(error)) {
    throw new LumenError("REPLAY_DETECTED", "Payment evidence already exists.");
  }
  throw error;
}

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function isNotFound(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2025";
}
