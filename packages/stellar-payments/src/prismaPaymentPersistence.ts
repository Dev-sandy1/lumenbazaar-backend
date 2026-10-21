import { randomUUID } from "node:crypto";

import { Prisma, type PrismaClient } from "@prisma/client";

import {
  createCorrelationId,
  getCorrelationId,
  LumenError,
  isSupportedNetwork,
  writeOutboxEvent,
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
  type PaymentStatePersistence,
  receiptStatusChange,
  type ReceiptStatusChangeListener
} from "./paymentStatePersistence.js";
import { receiptEvidenceHash } from "./receipt.js";
import {
  type PaymentSessionStore,
  type UptoPaymentSession,
  type UptoPaymentSessionStatus,
  type UptoSessionSettlement
} from "./paymentSession.js";
import { type CreateReceiptInput, type ReceiptStore } from "./receiptStore.js";
import { type CreateSettlementInput, type SettlementStore } from "./settlementStore.js";

type PaymentDatabaseClient = Pick<PrismaClient, "paymentAttempt" | "receipt" | "settlement">;
export type PaymentSessionDatabaseClient = Pick<
  PrismaClient,
  "paymentSession" | "uptoSessionSettlement"
>;

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

  async getSettlementByTransactionHash(transactionHash: string, network: string) {
    const row = await this.db.settlement.findUnique({
      where: { transactionHash_network: { transactionHash, network } }
    });
    return row === null ? undefined : mapSettlement(row);
  }
}

export class PrismaReceiptStore implements ReceiptStore {
  constructor(private readonly db: PaymentDatabaseClient) {}

  async createReceipt(input: CreateReceiptInput) {
    const existing = await this.db.receipt.findUnique({
      where: { paymentAttemptId: input.paymentAttemptId },
      select: { status: true }
    });
    if (existing !== null) {
      if (existing.status === "finalized") {
        throw new LumenError("REPLAY_DETECTED", "Finalized receipt evidence cannot be overwritten.");
      }
      throw new LumenError("REPLAY_DETECTED", "Payment evidence already exists.");
    }
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

  async listReceiptsBySeller(sellerId: string, limit = 100) {
    const rows = await this.db.receipt.findMany({
      where: { sellerId },
      orderBy: { createdAt: "desc" },
      take: limit
    });
    return rows.map(mapReceipt);
  }
}

export class PrismaPaymentStatePersistence implements PaymentStatePersistence {
  private readonly receiptStatusListeners = new Set<ReceiptStatusChangeListener>();

  constructor(private readonly client: PrismaClient) {}

  subscribeToReceiptStatusChanges(listener: ReceiptStatusChangeListener) {
    this.receiptStatusListeners.add(listener);
    return () => {
      this.receiptStatusListeners.delete(listener);
    };
  }

  private notifyReceiptStatusChange(receipt: Receipt) {
    const change = receiptStatusChange(receipt);
    for (const listener of this.receiptStatusListeners) {
      try {
        listener(change);
      } catch {
        // Receipt status listeners must never fail settlement persistence.
      }
    }
  }

  async recordConfirmed(input: ConfirmedPaymentStateInput) {
    try {
      const result = await this.client.$transaction(async (tx) => {
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

        // Write outbox event for receipt finalization (transactional)
        // This replaces the notifyReceiptStatusChange call that was outside the transaction
        await writeOutboxEvent(tx, {
          aggregateType: "receipt",
          aggregateId: receipt.id,
          eventType: "receipt.status_changed",
          payload: {
            receiptId: receipt.id,
            paymentAttemptId: receipt.paymentAttemptId,
            sellerId: receipt.sellerId,
            status: receipt.status,
            transactionHash: receipt.transactionHash,
            ledger: receipt.ledger,
            amount: receipt.amount,
            assetCode: receipt.assetCode,
            assetIssuer: receipt.assetIssuer,
            settledAt: receipt.settledAt
          }
        });

        return { attempt, settlement, receipt };
      });
      // Note: notifyReceiptStatusChange has been moved to outbox relay
      // The event is now delivered asynchronously by the outbox relay worker
      return result;
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

        // Write outbox event for settlement reconciliation if needed
        if (settlement.reconciliationState === "pending") {
          await writeOutboxEvent(tx, {
            aggregateType: "settlement",
            aggregateId: settlement.id,
            eventType: "settlement.reconciliation_enqueued",
            payload: {
              settlementId: settlement.id,
              paymentAttemptId: settlement.paymentAttemptId,
              transactionHash: settlement.transactionHash,
              network: settlement.network,
              correlationId: settlement.correlationId
            }
          });
        }

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

function mapPaymentAttempt(row: Prisma.PaymentAttemptGetPayload<object>): PaymentAttempt {
  return {
    ...row,
    network: requireNetwork(row.network),
    amount: row.amount.toString(),
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
    amount: row.amount.toString(),
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
    amount: row.amount.toString(),
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

export class PrismaPaymentSessionStore implements PaymentSessionStore {
  constructor(private readonly db: PaymentSessionDatabaseClient) {}

  async createSession(
    input: Omit<UptoPaymentSession, "id" | "createdAt" | "updatedAt">
  ): Promise<UptoPaymentSession> {
    try {
      const row = await this.db.paymentSession.create({
        data: {
          resourceId: input.resourceId,
          sellerId: input.sellerId,
          network: input.network,
          buyer: input.buyer,
          payTo: input.payTo,
          assetCode: input.assetCode,
          assetIssuer: input.assetIssuer,
          assetContractId: input.assetContractId,
          capAmount: input.capAmount,
          spentAmount: input.spentAmount,
          remainingAmount: input.remainingAmount,
          contractId: input.contractId,
          contractSessionId: input.contractSessionId,
          resourceHash: input.resourceHash,
          expiresAtLedger: input.expiresAtLedger,
          status: input.status,
          transactionHash: input.transactionHash,
          ledger: input.ledger,
          usageHash: input.usageHash
        }
      });
      return mapPaymentSession(row);
    } catch (error) {
      throwReplayOr(error);
    }
  }

  async createSettlement(
    input: Omit<UptoSessionSettlement, "id" | "createdAt">
  ): Promise<UptoSessionSettlement> {
    try {
      const row = await this.db.uptoSessionSettlement.create({
        data: {
          sessionId: input.sessionId,
          network: input.network,
          amount: input.amount,
          transactionHash: input.transactionHash,
          ledger: input.ledger,
          usageHash: input.usageHash,
          status: input.status,
          settledAt: new Date(input.settledAt)
        }
      });
      return mapUptoSessionSettlement(row);
    } catch (error) {
      throwReplayOr(error);
    }
  }

  async getSession(sessionId: string): Promise<UptoPaymentSession | undefined> {
    const row = await this.db.paymentSession.findUnique({
      where: { id: sessionId }
    });
    return row === null ? undefined : mapPaymentSession(row);
  }

  async getSessionByContractSessionId(
    contractSessionId: string
  ): Promise<UptoPaymentSession | undefined> {
    const row = await this.db.paymentSession.findUnique({
      where: { contractSessionId }
    });
    return row === null ? undefined : mapPaymentSession(row);
  }

  async getSettlement(sessionId: string): Promise<UptoSessionSettlement | undefined> {
    const row = await this.db.uptoSessionSettlement.findFirst({
      where: { sessionId },
      orderBy: { createdAt: "desc" }
    });
    return row === null ? undefined : mapUptoSessionSettlement(row);
  }

  async getSettlementByTransactionHash(
    transactionHash: string
  ): Promise<UptoSessionSettlement | undefined> {
    const row = await this.db.uptoSessionSettlement.findUnique({
      where: { transactionHash }
    });
    return row === null ? undefined : mapUptoSessionSettlement(row);
  }

  async claimSessionForSettlement(sessionId: string): Promise<UptoPaymentSession | undefined> {
    const claimed = await this.db.paymentSession.updateMany({
      where: { id: sessionId, status: "open" },
      data: { status: "settling" }
    });
    if (claimed.count === 0) {
      return undefined;
    }
    return this.getSession(sessionId);
  }

  async updateSession(
    sessionId: string,
    input: Partial<Omit<UptoPaymentSession, "id" | "createdAt">>
  ): Promise<UptoPaymentSession> {
    try {
      const row = await this.db.paymentSession.update({
        where: { id: sessionId },
        data: {
          ...(input.resourceId !== undefined ? { resourceId: input.resourceId } : {}),
          ...(input.sellerId !== undefined ? { sellerId: input.sellerId } : {}),
          ...(input.network !== undefined ? { network: input.network } : {}),
          ...(input.buyer !== undefined ? { buyer: input.buyer } : {}),
          ...(input.payTo !== undefined ? { payTo: input.payTo } : {}),
          ...(input.assetCode !== undefined ? { assetCode: input.assetCode } : {}),
          ...(input.assetIssuer !== undefined ? { assetIssuer: input.assetIssuer } : {}),
          ...(input.assetContractId !== undefined
            ? { assetContractId: input.assetContractId }
            : {}),
          ...(input.capAmount !== undefined ? { capAmount: input.capAmount } : {}),
          ...(input.spentAmount !== undefined ? { spentAmount: input.spentAmount } : {}),
          ...(input.remainingAmount !== undefined
            ? { remainingAmount: input.remainingAmount }
            : {}),
          ...(input.contractId !== undefined ? { contractId: input.contractId } : {}),
          ...(input.contractSessionId !== undefined
            ? { contractSessionId: input.contractSessionId }
            : {}),
          ...(input.resourceHash !== undefined ? { resourceHash: input.resourceHash } : {}),
          ...(input.expiresAtLedger !== undefined
            ? { expiresAtLedger: input.expiresAtLedger }
            : {}),
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.transactionHash !== undefined
            ? { transactionHash: input.transactionHash }
            : {}),
          ...(input.ledger !== undefined ? { ledger: input.ledger } : {}),
          ...(input.usageHash !== undefined ? { usageHash: input.usageHash } : {})
        }
      });
      return mapPaymentSession(row);
    } catch (error) {
      if (isNotFound(error)) {
        throw new LumenError("RESOURCE_NOT_FOUND", "Payment session was not found.");
      }
      throwReplayOr(error);
    }
  }
}

function mapPaymentSession(row: Prisma.PaymentSessionGetPayload<object>): UptoPaymentSession {
  return {
    id: row.id,
    resourceId: row.resourceId,
    sellerId: row.sellerId,
    network: requireNetwork(row.network),
    buyer: row.buyer,
    payTo: row.payTo,
    assetCode: row.assetCode,
    assetIssuer: row.assetIssuer,
    assetContractId: row.assetContractId,
    capAmount: row.capAmount.toString(),
    spentAmount: row.spentAmount.toString(),
    remainingAmount: row.remainingAmount.toString(),
    contractId: row.contractId,
    contractSessionId: row.contractSessionId,
    resourceHash: row.resourceHash,
    expiresAtLedger: row.expiresAtLedger,
    status: row.status as UptoPaymentSessionStatus,
    transactionHash: row.transactionHash,
    ledger: row.ledger,
    usageHash: row.usageHash,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function mapUptoSessionSettlement(
  row: Prisma.UptoSessionSettlementGetPayload<object>
): UptoSessionSettlement {
  return {
    id: row.id,
    sessionId: row.sessionId,
    network: requireNetwork(row.network),
    amount: row.amount.toString(),
    transactionHash: row.transactionHash,
    ledger: row.ledger,
    usageHash: row.usageHash,
    status: "settled",
    settledAt: row.settledAt.toISOString(),
    createdAt: row.createdAt.toISOString()
  };
}
