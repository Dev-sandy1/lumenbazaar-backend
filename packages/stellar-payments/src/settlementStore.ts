import { randomUUID } from "node:crypto";

import {
  createCorrelationId,
  getCorrelationId,
  LumenError,
  type NetworkId,
  type Settlement
} from "@lumenbazaar/shared";

export type CreateSettlementInput = {
  correlationId?: string;
  paymentAttemptId: string;
  transactionHash?: string;
  ledger?: number;
  network: NetworkId;
  amount: string;
  assetCode: string;
  assetIssuer: string;
  status: Settlement["status"];
  reconciliationState?: Settlement["reconciliationState"];
  settledAt?: string;
};

export type SettlementStore = {
  createSettlement: (input: CreateSettlementInput) => Promise<Settlement>;
  getSettlementByAttempt: (paymentAttemptId: string) => Promise<Settlement | undefined>;
  getSettlementByTransactionHash: (transactionHash: string, network: string) => Promise<Settlement | undefined>;
};

export class InMemorySettlementStore implements SettlementStore {
  private readonly settlements = new Map<string, Settlement>();
  private readonly byAttempt = new Map<string, string>();
  private readonly byTransactionHash = new Map<string, string>();

  async createSettlement(input: CreateSettlementInput) {
    if (this.byAttempt.has(input.paymentAttemptId)) {
      throw new LumenError("REPLAY_DETECTED", "Payment attempt has already been settled.");
    }

    if (input.transactionHash !== undefined && this.byTransactionHash.has(`${input.network}:${input.transactionHash}`)) {
      throw new LumenError("REPLAY_DETECTED", "Settlement transaction hash already exists.");
    }

    const settlement: Settlement = {
      id: `set_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      correlationId: input.correlationId ?? getCorrelationId() ?? createCorrelationId(),
      paymentAttemptId: input.paymentAttemptId,
      transactionHash: input.transactionHash ?? null,
      ledger: input.ledger ?? null,
      network: input.network,
      amount: input.amount,
      assetCode: input.assetCode,
      assetIssuer: input.assetIssuer,
      status: input.status,
      reconciliationState: input.reconciliationState ?? "not_required",
      reconciliationReason: null,
      reconciliationAttempts: 0,
      lastReconciledAt: null,
      settledAt: input.settledAt ?? null,
      createdAt: new Date().toISOString()
    };

    this.settlements.set(settlement.id, settlement);
    this.byAttempt.set(input.paymentAttemptId, settlement.id);

    if (settlement.transactionHash !== null) {
      this.byTransactionHash.set(`${settlement.network}:${settlement.transactionHash}`, settlement.id);
    }

    return settlement;
  }

  async getSettlementByAttempt(paymentAttemptId: string) {
    const id = this.byAttempt.get(paymentAttemptId);
    return id === undefined ? undefined : this.settlements.get(id);
  }

  async getSettlementByTransactionHash(transactionHash: string, network: string) {
    const id = this.byTransactionHash.get(`${network}:${transactionHash}`);
    return id === undefined ? undefined : this.settlements.get(id);
  }
}
