import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import {
  LumenError,
  type AppConfig,
  type JsonObject,
  type NetworkId,
  isSupportedNetwork,
  normalizeAssetCode
} from "@lumenbazaar/shared";

import { assertStellarPublicKey } from "./addresses.js";
import {
  amountToStroops,
  compareExactAmounts,
  normalizeExactAmount,
  stroopsToAmount
} from "./amounts.js";
import { requireSupportedAsset } from "./clients.js";
import {
  createLocalUptoSessionContractBindings,
  type UptoSessionContractBindings
} from "./uptoContractBindings.js";
import { type PaymentAuditLogger } from "./verification.js";

const assetSchema = z.object({
  code: z.string().min(1).max(12),
  issuer: z.string().min(1)
});

const usageHashPattern = /^[a-f0-9]{64}$/i;

export const createPaymentSessionSchema = z.object({
  scheme: z.literal("upto"),
  network: z.string(),
  buyer: z.string().min(1),
  asset: assetSchema,
  capAmount: z.string(),
  payTo: z.string(),
  resourceId: z.string().optional(),
  sellerId: z.string().optional(),
  expiresAtLedger: z.number().int().positive(),
  currentLedger: z.number().int().nonnegative().optional()
});

export const settlePaymentSessionSchema = z.object({
  sessionId: z.string().min(1),
  amount: z.string(),
  usageHash: z.string().min(1),
  currentLedger: z.number().int().nonnegative().optional()
});

export type CreatePaymentSessionInput = z.output<typeof createPaymentSessionSchema>;
export type SettlePaymentSessionInput = z.output<typeof settlePaymentSessionSchema>;
export type UptoPaymentSessionStatus = "open" | "settling" | "settled";

export type UptoPaymentSession = {
  assetCode: string;
  assetContractId: string;
  assetIssuer: string;
  buyer: string;
  capAmount: string;
  contractId: string;
  contractSessionId: string;
  createdAt: string;
  expiresAtLedger: number;
  id: string;
  ledger: number | null;
  network: NetworkId;
  payTo: string;
  remainingAmount: string;
  resourceHash: string;
  resourceId: string | null;
  sellerId: string | null;
  spentAmount: string;
  status: UptoPaymentSessionStatus;
  transactionHash: string | null;
  updatedAt: string;
  usageHash: string | null;
};

export type UptoSessionSettlement = {
  amount: string;
  createdAt: string;
  id: string;
  ledger: number;
  network: NetworkId;
  sessionId: string;
  settledAt: string;
  status: "settled";
  transactionHash: string;
  usageHash: string;
};

export type PaymentSessionStore = {
  claimSessionForSettlement: (sessionId: string) => Promise<UptoPaymentSession | undefined>;
  createSession: (
    input: Omit<UptoPaymentSession, "id" | "createdAt" | "updatedAt">
  ) => Promise<UptoPaymentSession>;
  createSettlement: (
    input: Omit<UptoSessionSettlement, "id" | "createdAt">
  ) => Promise<UptoSessionSettlement>;
  getSession: (sessionId: string) => Promise<UptoPaymentSession | undefined>;
  getSessionByContractSessionId: (
    contractSessionId: string
  ) => Promise<UptoPaymentSession | undefined>;
  getSettlement: (sessionId: string) => Promise<UptoSessionSettlement | undefined>;
  getSettlementByTransactionHash: (
    transactionHash: string
  ) => Promise<UptoSessionSettlement | undefined>;
  updateSession: (
    sessionId: string,
    input: Partial<Omit<UptoPaymentSession, "id" | "createdAt">>
  ) => Promise<UptoPaymentSession>;
};

export type PaymentSessionServiceOptions = {
  auditLogService?: PaymentAuditLogger;
  bindings?: UptoSessionContractBindings;
  store?: PaymentSessionStore;
};

export class InMemoryPaymentSessionStore implements PaymentSessionStore {
  private readonly sessions = new Map<string, UptoPaymentSession>();
  private readonly settlements = new Map<string, UptoSessionSettlement>();

  async createSession(input: Omit<UptoPaymentSession, "id" | "createdAt" | "updatedAt">) {
    const existing = Array.from(this.sessions.values()).find(
      (s) => s.contractSessionId === input.contractSessionId
    );
    if (existing !== undefined) {
      throw new LumenError("REPLAY_DETECTED", "Payment session already exists.");
    }

    const now = new Date().toISOString();
    const session: UptoPaymentSession = {
      id: `payment_session_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      ...input,
      createdAt: now,
      updatedAt: now
    };

    this.sessions.set(session.id, session);
    return session;
  }

  async createSettlement(input: Omit<UptoSessionSettlement, "id" | "createdAt">) {
    const existing = Array.from(this.settlements.values()).find(
      (s) => s.transactionHash === input.transactionHash
    );
    if (existing !== undefined) {
      throw new LumenError("REPLAY_DETECTED", "Payment evidence already exists.");
    }

    const settlement: UptoSessionSettlement = {
      id: `upto_settlement_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      ...input,
      createdAt: new Date().toISOString()
    };

    this.settlements.set(settlement.id, settlement);
    return settlement;
  }

  async getSession(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  async getSessionByContractSessionId(contractSessionId: string) {
    return Array.from(this.sessions.values()).find(
      (s) => s.contractSessionId === contractSessionId
    );
  }

  async getSettlement(sessionId: string) {
    return Array.from(this.settlements.values()).find((s) => s.sessionId === sessionId);
  }

  async getSettlementByTransactionHash(transactionHash: string) {
    return Array.from(this.settlements.values()).find((s) => s.transactionHash === transactionHash);
  }

  async claimSessionForSettlement(sessionId: string) {
    const existing = this.sessions.get(sessionId);
    if (existing === undefined || existing.status !== "open") {
      return undefined;
    }
    const claimed: UptoPaymentSession = {
      ...existing,
      status: "settling",
      updatedAt: new Date().toISOString()
    };
    this.sessions.set(sessionId, claimed);
    return claimed;
  }

  async updateSession(
    sessionId: string,
    input: Partial<Omit<UptoPaymentSession, "id" | "createdAt">>
  ) {
    const existing = this.sessions.get(sessionId);

    if (existing === undefined) {
      throw new LumenError("RESOURCE_NOT_FOUND", "Payment session was not found.");
    }

    const updated: UptoPaymentSession = {
      ...existing,
      ...input,
      updatedAt: new Date().toISOString()
    };

    this.sessions.set(sessionId, updated);
    return updated;
  }
}

export class PaymentSessionService {
  private readonly auditLogService: PaymentAuditLogger | undefined;
  private readonly bindings: UptoSessionContractBindings;
  private readonly store: PaymentSessionStore;

  constructor(
    private readonly config: AppConfig,
    options: PaymentSessionServiceOptions = {}
  ) {
    this.auditLogService = options.auditLogService;

    if (
      this.config.features.uptoScheme &&
      this.config.lumenEnv !== "local" &&
      options.bindings === undefined
    ) {
      throw new Error(
        "ENABLE_UPTO_SCHEME requires live Soroban bindings outside the local environment."
      );
    }

    this.bindings = options.bindings ?? createLocalUptoSessionContractBindings();
    this.store = options.store ?? new InMemoryPaymentSessionStore();
  }

  async createSession(input: unknown) {
    this.assertFeatureEnabled();
    const normalized = normalizeCreateSessionInput(
      createPaymentSessionSchema.parse(input),
      this.config
    );
    const contractResult = await this.bindings.createSession({
      assetContractId: normalized.assetContractId,
      buyer: normalized.buyer,
      contractId: normalized.contractId,
      expiresAtLedger: normalized.expiresAtLedger,
      maxAmountStroops: amountToStroops(normalized.capAmount),
      network: normalized.network,
      resourceHash: normalized.resourceHash,
      seller: normalized.payTo
    });
    const session = await this.store.createSession({
      assetCode: normalized.assetCode,
      assetContractId: normalized.assetContractId,
      assetIssuer: normalized.assetIssuer,
      buyer: normalized.buyer,
      capAmount: normalized.capAmount,
      contractId: normalized.contractId,
      contractSessionId: contractResult.contractSessionId,
      expiresAtLedger: normalized.expiresAtLedger,
      ledger: contractResult.ledger,
      network: normalized.network,
      payTo: normalized.payTo,
      remainingAmount: normalized.capAmount,
      resourceHash: normalized.resourceHash,
      resourceId: normalized.resourceId ?? null,
      sellerId: normalized.sellerId ?? null,
      spentAmount: "0",
      status: "open",
      transactionHash: contractResult.transactionHash,
      usageHash: null
    });

    await this.auditLogService?.record({
      action: "payment_session.create",
      actorId: session.sellerId,
      actorType: "facilitator",
      targetId: session.id,
      targetType: "payment_session",
      metadata: sessionAuditMetadata(session)
    });

    return session;
  }

  async getSession(sessionIdOrContractSessionId: string) {
    this.assertFeatureEnabled();
    const session =
      (await this.store.getSession(sessionIdOrContractSessionId)) ??
      (await this.store.getSessionByContractSessionId(sessionIdOrContractSessionId));

    if (session === undefined) {
      throw new LumenError("RESOURCE_NOT_FOUND", "Payment session was not found.");
    }

    return session;
  }

  async getSettlement(sessionId: string) {
    this.assertFeatureEnabled();
    const settlement = await this.store.getSettlement(sessionId);
    if (settlement === undefined) {
      throw new LumenError("RESOURCE_NOT_FOUND", "Settlement record was not found.");
    }
    return settlement;
  }

  async getSettlementByTransactionHash(transactionHash: string) {
    this.assertFeatureEnabled();
    const settlement = await this.store.getSettlementByTransactionHash(transactionHash);
    if (settlement === undefined) {
      throw new LumenError("RESOURCE_NOT_FOUND", "Settlement record was not found.");
    }
    return settlement;
  }

  async settleSession(input: unknown) {
    this.assertFeatureEnabled();
    const request = normalizeSettleSessionInput(settlePaymentSessionSchema.parse(input));
    const session = await this.getSession(request.sessionId);

    if (session.status === "settled") {
      if (
        session.usageHash === request.usageHash &&
        compareExactAmounts(session.spentAmount, request.amount) === 0
      ) {
        const settlement = await this.store.getSettlement(session.id);
        return {
          ...session,
          settlementId: settlement?.id ?? `settlement_${session.id}`,
          settledAt: settlement?.settledAt ?? session.updatedAt,
          scheme: "upto" as const
        };
      }
      throw new LumenError("REPLAY_DETECTED", "Payment session has already been settled.");
    }

    if (request.currentLedger !== undefined && session.expiresAtLedger <= request.currentLedger) {
      throw new LumenError("AUTH_EXPIRED", "Payment session has expired.");
    }

    if (compareExactAmounts(request.amount, session.capAmount) > 0) {
      throw new LumenError("AMOUNT_MISMATCH", "Settlement amount exceeds the session cap.");
    }

    const claimed = await this.store.claimSessionForSettlement(session.id);
    if (claimed === undefined) {
      return this.waitForDurableSettlement(session.id, request);
    }

    return this.executeSettlement(session, request);
  }

  private async executeSettlement(
    session: UptoPaymentSession,
    request: NormalizedSettlePaymentSessionInput
  ) {
    try {
      const contractResult = await this.bindings.settleSession({
        actualAmountStroops: amountToStroops(request.amount),
        contractId: session.contractId,
        contractSessionId: session.contractSessionId,
        network: session.network,
        usageHash: request.usageHash
      });
      const remainingAmount = subtractAmounts(session.capAmount, request.amount);
      const settledAt = new Date().toISOString();
      const settlement = await this.store.createSettlement({
        amount: request.amount,
        ledger: contractResult.ledger,
        network: session.network,
        sessionId: session.id,
        settledAt,
        status: "settled",
        transactionHash: contractResult.transactionHash,
        usageHash: request.usageHash
      });
      const updatedSession = await this.store.updateSession(session.id, {
        ledger: contractResult.ledger,
        remainingAmount,
        spentAmount: request.amount,
        status: "settled",
        transactionHash: contractResult.transactionHash,
        usageHash: request.usageHash
      });

      await this.auditLogService?.record({
        action: "payment_session.settle",
        actorId: updatedSession.sellerId,
        actorType: "facilitator",
        targetId: updatedSession.id,
        targetType: "payment_session",
        metadata: {
          ...sessionAuditMetadata(updatedSession),
          settlementId: settlement.id,
          usageHash: request.usageHash
        }
      });

      return {
        ...updatedSession,
        settlementId: settlement.id,
        settledAt,
        scheme: "upto" as const
      };
    } catch (error) {
      await this.store.updateSession(session.id, { status: "open" }).catch(() => undefined);
      throw error;
    }
  }

  private async waitForDurableSettlement(
    sessionId: string,
    request: NormalizedSettlePaymentSessionInput
  ) {
    for (let check = 0; check < 250; check += 1) {
      const current = await this.store.getSession(sessionId);
      if (current === undefined) {
        break;
      }
      if (current.status === "settled") {
        if (
          current.usageHash === request.usageHash &&
          compareExactAmounts(current.spentAmount, request.amount) === 0
        ) {
          const settlement = await this.store.getSettlement(current.id);
          return {
            ...current,
            settlementId: settlement?.id ?? `settlement_${current.id}`,
            settledAt: settlement?.settledAt ?? current.updatedAt,
            scheme: "upto" as const
          };
        }
        throw new LumenError("REPLAY_DETECTED", "Payment session has already been settled.");
      }
      if (current.status === "open") {
        const retryClaim = await this.store.claimSessionForSettlement(sessionId);
        if (retryClaim !== undefined) {
          return this.executeSettlement(retryClaim, request);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    throw new LumenError("SETTLEMENT_FAILED", "Settlement is already in progress.", {
      statusCode: 409,
      details: { status: "settling" }
    });
  }

  async reconcileSession(sessionIdOrContractSessionId: string): Promise<UptoPaymentSession> {
    this.assertFeatureEnabled();
    const session = await this.getSession(sessionIdOrContractSessionId);

    if (this.bindings.getSessionState === undefined) {
      return session;
    }

    const onChainState = await this.bindings.getSessionState(
      session.contractId,
      session.contractSessionId
    );

    if (onChainState === undefined) {
      return session;
    }

    if (session.status !== "settled" && onChainState.status === "settled") {
      const settledAt = new Date().toISOString();
      const txHash =
        onChainState.transactionHash ??
        session.transactionHash ??
        `reconciled_${session.contractSessionId}`;
      const ledger = onChainState.ledger ?? session.ledger ?? 1;

      let settlement = await this.store.getSettlement(session.id);
      if (settlement === undefined) {
        settlement = await this.store.createSettlement({
          amount: session.spentAmount !== "0" ? session.spentAmount : session.capAmount,
          ledger,
          network: session.network,
          sessionId: session.id,
          settledAt,
          status: "settled",
          transactionHash: txHash,
          usageHash: session.usageHash ?? "reconciled"
        });
      }

      const updated = await this.store.updateSession(session.id, {
        ledger,
        status: "settled",
        transactionHash: txHash,
        remainingAmount:
          session.remainingAmount === session.capAmount ? "0" : session.remainingAmount,
        spentAmount: session.spentAmount === "0" ? session.capAmount : session.spentAmount
      });

      await this.auditLogService?.record({
        action: "payment_session.reconcile",
        actorId: updated.sellerId,
        actorType: "facilitator",
        targetId: updated.id,
        targetType: "payment_session",
        metadata: {
          ...sessionAuditMetadata(updated),
          reconciledState: "settled",
          transactionHash: txHash
        }
      });

      return updated;
    }

    if (session.status === "settling" && onChainState.status === "open") {
      const updated = await this.store.updateSession(session.id, {
        status: "open"
      });

      await this.auditLogService?.record({
        action: "payment_session.reconcile",
        actorId: updated.sellerId,
        actorType: "facilitator",
        targetId: updated.id,
        targetType: "payment_session",
        metadata: {
          ...sessionAuditMetadata(updated),
          reconciledState: "open",
          previousStatus: "settling"
        }
      });

      return updated;
    }

    return session;
  }

  private assertFeatureEnabled() {
    if (!this.config.features.uptoScheme) {
      throw new LumenError("VALIDATION_FAILED", "Upto payment sessions are disabled.");
    }
  }
}

type NormalizedCreatePaymentSessionInput = CreatePaymentSessionInput & {
  assetCode: string;
  assetContractId: string;
  assetIssuer: string;
  contractId: string;
  network: NetworkId;
  resourceHash: string;
};

type NormalizedSettlePaymentSessionInput = SettlePaymentSessionInput & {
  amount: string;
  usageHash: string;
};

function normalizeCreateSessionInput(
  input: CreatePaymentSessionInput,
  config: AppConfig
): NormalizedCreatePaymentSessionInput {
  if (!isSupportedNetwork(input.network)) {
    throw new LumenError("UNSUPPORTED_NETWORK", "Payment network is not supported.");
  }

  assertStellarPublicKey(input.buyer, "buyer");
  assertStellarPublicKey(input.payTo, "payTo");

  const capAmount = normalizeExactAmount(input.capAmount);
  const assetCode = normalizeAssetCode(input.asset.code);
  const supportedAsset = requireSupportedAsset(
    config,
    input.network,
    assetCode,
    input.asset.issuer
  );
  const network = config.networks[input.network];

  if (network.uptoSessionContractId === undefined) {
    throw new LumenError(
      "SETTLEMENT_FAILED",
      `Upto session contract is not configured for ${input.network}.`
    );
  }

  if (supportedAsset.contractId === undefined) {
    throw new LumenError(
      "SETTLEMENT_FAILED",
      `Asset contract is not configured for ${assetCode} on ${input.network}.`
    );
  }

  if (input.currentLedger !== undefined && input.expiresAtLedger <= input.currentLedger) {
    throw new LumenError("AUTH_EXPIRED", "Payment session authorization has expired.");
  }

  return {
    ...input,
    capAmount,
    assetCode,
    assetContractId: supportedAsset.contractId,
    assetIssuer: input.asset.issuer,
    contractId: network.uptoSessionContractId,
    network: input.network,
    resourceHash: resourceHash(input)
  };
}

function normalizeSettleSessionInput(
  input: SettlePaymentSessionInput
): NormalizedSettlePaymentSessionInput {
  const amount = normalizeExactAmount(input.amount);
  const usageHash = input.usageHash.toLowerCase();

  if (!usageHashPattern.test(usageHash) || isZeroHash(usageHash)) {
    throw new LumenError(
      "INVALID_PAYMENT_PAYLOAD",
      "Usage hash must be a non-zero 32-byte digest."
    );
  }

  return {
    ...input,
    amount,
    usageHash
  };
}

function subtractAmounts(left: string, right: string) {
  const difference = amountToStroops(left) - amountToStroops(right);

  if (difference === 0n) {
    return "0";
  }

  if (difference < 0n) {
    throw new LumenError("AMOUNT_MISMATCH", "Settlement amount exceeds the session cap.");
  }

  return stroopsToAmount(difference);
}

function resourceHash(input: CreatePaymentSessionInput) {
  return digest({
    asset: {
      code: normalizeAssetCode(input.asset.code),
      issuer: input.asset.issuer
    },
    buyer: input.buyer,
    capAmount: normalizeExactAmount(input.capAmount),
    network: input.network,
    payTo: input.payTo,
    resourceId: input.resourceId ?? null,
    sellerId: input.sellerId ?? null
  });
}

function digest(value: JsonObject) {
  return createHash("sha256")
    .update(JSON.stringify(sortKeys(value)))
    .digest("hex");
}

function sortKeys(value: JsonObject): JsonObject {
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, isJsonObject(entry) ? sortKeys(entry) : entry])
  ) as JsonObject;
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isZeroHash(value: string) {
  return /^0+$/.test(value);
}

function sessionAuditMetadata(session: UptoPaymentSession) {
  return {
    amount: session.spentAmount,
    assetCode: session.assetCode,
    capAmount: session.capAmount,
    contractId: session.contractId,
    network: session.network,
    resourceId: session.resourceId,
    sellerId: session.sellerId,
    status: session.status
  };
}
