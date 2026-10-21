import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type LumenError } from "@lumenbazaar/shared";

import { receiptEvidenceHash } from "./receipt.js";
import { PrismaPaymentAttemptStore, PrismaReceiptStore, PrismaSettlementStore } from "./prismaPaymentPersistence.js";

const databaseUrl = process.env.PAYMENT_PERSISTENCE_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

const testnet = "stellar:testnet" as const;
const mainnet = "stellar:mainnet" as const;
const issuer = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

function createClient() {
  return new PrismaClient({
    datasources: { db: { url: databaseUrl ?? "postgresql://integration-test-is-disabled" } }
  });
}

describePostgres("PrismaSettlementStore", () => {
  let client: PrismaClient;
  let attemptStore: PrismaPaymentAttemptStore;
  let store: PrismaSettlementStore;

  beforeEach(async () => {
    client = createClient();
    await client.receipt.deleteMany();
    await client.settlement.deleteMany();
    await client.paymentAttempt.deleteMany();
    attemptStore = new PrismaPaymentAttemptStore(client);
    store = new PrismaSettlementStore(client);
  });

  afterEach(async () => {
    await client.$disconnect();
  });

  it("persists a settlement and retrieves it by attempt id", async () => {
    const attempt = await attemptStore.createVerifiedAttempt(attemptInput("hash_lookup_1"));

    const created = await store.createSettlement({
      paymentAttemptId: attempt.id,
      transactionHash: "tx_lookup_1",
      ledger: 100,
      network: testnet,
      amount: "1.0000000",
      assetCode: "USDC",
      assetIssuer: issuer,
      status: "confirmed",
      settledAt: new Date().toISOString()
    });

    const byAttempt = await store.getSettlementByAttempt(attempt.id);
    expect(byAttempt).toMatchObject({ id: created.id, transactionHash: "tx_lookup_1" });

    const byHash = await store.getSettlementByTransactionHash("tx_lookup_1", testnet);
    expect(byHash).toMatchObject({ id: created.id, paymentAttemptId: attempt.id });
  });

  it("returns undefined for unknown attempt or hash", async () => {
    await expect(store.getSettlementByAttempt("nonexistent")).resolves.toBeUndefined();
    await expect(store.getSettlementByTransactionHash("no_such_hash", testnet)).resolves.toBeUndefined();
  });

  it("rejects a duplicate settlement for the same payment attempt", async () => {
    const attempt = await attemptStore.createVerifiedAttempt(attemptInput("hash_dup_attempt"));
    await store.createSettlement(settlementInput(attempt.id, "tx_dup_1", testnet));

    await expect(
      store.createSettlement(settlementInput(attempt.id, "tx_dup_2", testnet))
    ).rejects.toMatchObject({ code: "REPLAY_DETECTED" } satisfies Partial<LumenError>);
  });

  it("rejects the same transaction hash on the same network", async () => {
    const a = await attemptStore.createVerifiedAttempt(attemptInput("hash_same_net_1"));
    const b = await attemptStore.createVerifiedAttempt(attemptInput("hash_same_net_2"));
    await store.createSettlement(settlementInput(a.id, "tx_shared", testnet));

    await expect(
      store.createSettlement(settlementInput(b.id, "tx_shared", testnet))
    ).rejects.toMatchObject({ code: "REPLAY_DETECTED" } satisfies Partial<LumenError>);
  });

  it("allows the same transaction hash on different networks", async () => {
    const a = await attemptStore.createVerifiedAttempt(attemptInput("hash_cross_net_1"));
    const b = await attemptStore.createVerifiedAttempt(attemptInput("hash_cross_net_2"));
    await store.createSettlement(settlementInput(a.id, "tx_cross_net", testnet));

    // Same hash, different network — must succeed
    await expect(
      store.createSettlement(settlementInput(b.id, "tx_cross_net", mainnet))
    ).resolves.toMatchObject({ transactionHash: "tx_cross_net", network: mainnet });
  });
});

describePostgres("PrismaReceiptStore", () => {
  let client: PrismaClient;
  let attemptStore: PrismaPaymentAttemptStore;
  let store: PrismaReceiptStore;

  beforeEach(async () => {
    client = createClient();
    await client.receipt.deleteMany();
    await client.settlement.deleteMany();
    await client.paymentAttempt.deleteMany();
    attemptStore = new PrismaPaymentAttemptStore(client);
    store = new PrismaReceiptStore(client);
  });

  afterEach(async () => {
    await client.$disconnect();
  });

  it("persists a receipt and retrieves it by id and by attempt", async () => {
    const attempt = await attemptStore.createVerifiedAttempt(attemptInput("hash_rcpt_lookup"));
    const input = receiptInput(attempt);
    const created = await store.createReceipt(input);

    await expect(store.getReceipt(created.id)).resolves.toMatchObject({
      id: created.id,
      paymentAttemptId: attempt.id,
      evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    await expect(store.getReceiptByAttempt(attempt.id)).resolves.toMatchObject({ id: created.id });
  });

  it("returns undefined for unknown receipt id or attempt", async () => {
    await expect(store.getReceipt("receipt_unknown")).resolves.toBeUndefined();
    await expect(store.getReceiptByAttempt("nonexistent")).resolves.toBeUndefined();
  });

  it("rejects overwriting a finalized receipt", async () => {
    const attempt = await attemptStore.createVerifiedAttempt(attemptInput("hash_rcpt_finalized"));
    await store.createReceipt(receiptInput(attempt, "finalized"));

    await expect(
      store.createReceipt(receiptInput(attempt, "finalized"))
    ).rejects.toMatchObject({ code: "REPLAY_DETECTED" } satisfies Partial<LumenError>);
  });

  it("rejects any duplicate receipt regardless of status", async () => {
    const attempt = await attemptStore.createVerifiedAttempt(attemptInput("hash_rcpt_dup"));
    await store.createReceipt(receiptInput(attempt, "pending"));

    await expect(
      store.createReceipt(receiptInput(attempt, "pending"))
    ).rejects.toMatchObject({ code: "REPLAY_DETECTED" } satisfies Partial<LumenError>);
  });

  it("lists receipts for a seller ordered by most recent", async () => {
    const sellerId = "seller_list_test";
    const a = await attemptStore.createVerifiedAttempt(attemptInput("hash_list_1", sellerId));
    const b = await attemptStore.createVerifiedAttempt(attemptInput("hash_list_2", sellerId));
    await store.createReceipt(receiptInput(a, "finalized", sellerId));
    await store.createReceipt(receiptInput(b, "finalized", sellerId));

    const results = await store.listReceiptsBySeller(sellerId);
    expect(results).toHaveLength(2);
    expect(results[0]!.createdAt >= results[1]!.createdAt).toBe(true);
  });
});

// --- helpers ---

function attemptInput(paymentHash: string, sellerId?: string) {
  return {
    paymentHash,
    network: testnet,
    assetCode: "USDC",
    assetIssuer: issuer,
    amount: "1.0000000",
    payTo: issuer,
    ...(sellerId ? { sellerId } : {})
  };
}

function settlementInput(
  paymentAttemptId: string,
  transactionHash: string,
  network: typeof testnet | typeof mainnet
) {
  return {
    paymentAttemptId,
    transactionHash,
    ledger: 200,
    network,
    amount: "1.0000000",
    assetCode: "USDC",
    assetIssuer: issuer,
    status: "confirmed" as const,
    settledAt: new Date().toISOString()
  };
}

function receiptInput(
  attempt: { id: string; network: typeof testnet; amount: string; assetCode: string; assetIssuer: string },
  status: "pending" | "finalized" = "finalized",
  sellerId?: string
) {
  const now = new Date().toISOString();
  const transactionHash = `tx_rcpt_${attempt.id}`;
  const ledger = 300;

  // Minimal PaymentAttempt and Settlement shapes needed for hashing
  const fakeAttempt = {
    id: attempt.id,
    correlationId: "corr_fake",
    paymentHash: `ph_${attempt.id}`,
    idempotencyKey: `ik_${attempt.id}`,
    network: attempt.network,
    amount: attempt.amount,
    assetCode: attempt.assetCode,
    assetIssuer: attempt.assetIssuer,
    payTo: issuer,
    status: "confirmed" as const,
    failureCode: null,
    failureReason: null,
    resourceId: null,
    sellerId: sellerId ?? null,
    expiresAtLedger: null,
    createdAt: now,
    updatedAt: now
  };
  const fakeSettlement = {
    id: "set_fake",
    correlationId: "corr_fake",
    paymentAttemptId: attempt.id,
    transactionHash,
    ledger,
    network: attempt.network,
    amount: attempt.amount,
    assetCode: attempt.assetCode,
    assetIssuer: attempt.assetIssuer,
    status: "confirmed" as const,
    reconciliationState: "not_required" as const,
    reconciliationReason: null,
    reconciliationAttempts: 0,
    lastReconciledAt: null,
    settledAt: now,
    createdAt: now
  };

  return {
    paymentAttemptId: attempt.id,
    transactionHash,
    ledger,
    network: attempt.network,
    amount: attempt.amount,
    assetCode: attempt.assetCode,
    assetIssuer: attempt.assetIssuer,
    status,
    settledAt: now,
    failureCode: null,
    failureReason: null,
    resourceId: null,
    sellerId: sellerId ?? null,
    evidenceHash: receiptEvidenceHash(fakeAttempt, fakeSettlement)
  };
}
