import { randomUUID } from "node:crypto";

import { createCorrelationId, getCorrelationId, LumenError, type Receipt } from "@lumenbazaar/shared";

export type CreateReceiptInput = Omit<
  Receipt,
  "id" | "correlationId" | "createdAt" | "updatedAt"
> & { correlationId?: string };

export type ReceiptStore = {
  createReceipt: (input: CreateReceiptInput) => Promise<Receipt>;
  getReceipt: (receiptId: string) => Promise<Receipt | undefined>;
  getReceiptByAttempt: (paymentAttemptId: string) => Promise<Receipt | undefined>;
  listReceiptsBySeller: (sellerId: string, limit?: number) => Promise<Receipt[]>;
};

export class InMemoryReceiptStore implements ReceiptStore {
  private readonly receipts = new Map<string, Receipt>();
  private readonly byAttempt = new Map<string, string>();

  async createReceipt(input: CreateReceiptInput) {
    const existingId = this.byAttempt.get(input.paymentAttemptId);
    if (existingId !== undefined) {
      const existing = this.receipts.get(existingId);
      if (existing?.status === "finalized") {
        throw new LumenError("REPLAY_DETECTED", "Finalized receipt evidence cannot be overwritten.");
      }
      throw new LumenError("REPLAY_DETECTED", "Payment evidence already exists.");
    }

    const now = new Date().toISOString();
    const receipt: Receipt = {
      id: `receipt_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      correlationId: input.correlationId ?? getCorrelationId() ?? createCorrelationId(),
      ...input,
      createdAt: now,
      updatedAt: now
    };

    this.receipts.set(receipt.id, receipt);
    this.byAttempt.set(receipt.paymentAttemptId, receipt.id);

    return receipt;
  }

  async getReceipt(receiptId: string) {
    return this.receipts.get(receiptId);
  }

  async getReceiptByAttempt(paymentAttemptId: string) {
    const receiptId = this.byAttempt.get(paymentAttemptId);
    return receiptId === undefined ? undefined : this.receipts.get(receiptId);
  }

  async listReceiptsBySeller(sellerId: string, limit = 100) {
    const matches = [...this.receipts.values()]
      .filter((receipt) => receipt.sellerId === sellerId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return matches.slice(0, limit);
  }
}
