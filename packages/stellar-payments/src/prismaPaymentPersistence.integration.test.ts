import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { type LumenError } from "@lumenbazaar/shared";

import {
  PrismaPaymentAttemptStore,
  PrismaPaymentSessionStore,
  PrismaPaymentStatePersistence,
  PrismaReceiptStore
} from "./prismaPaymentPersistence.js";

const databaseUrl = process.env.PAYMENT_PERSISTENCE_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;
const network = "stellar:testnet" as const;
const issuer = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

describePostgres("Prisma payment persistence", () => {
  let client: PrismaClient;

  beforeEach(async () => {
    client = createClient();
    await client.uptoSessionSettlement.deleteMany();
    await client.paymentSession.deleteMany();
    await client.receipt.deleteMany();
    await client.settlement.deleteMany();
    await client.paymentAttempt.deleteMany();
  });

  afterEach(async () => {
    await client.$disconnect();
  });

  it("survives a client restart and returns the immutable receipt evidence", async () => {
    const attemptStore = new PrismaPaymentAttemptStore(client);
    const persistence = new PrismaPaymentStatePersistence(client);
    const attempt = await attemptStore.createVerifiedAttempt({
      paymentHash: "payment_hash_restart",
      idempotencyKey: "verify:payment_hash_restart",
      network,
      assetCode: "USDC",
      assetIssuer: issuer,
      amount: "0.0500000",
      payTo: issuer
    });
    await attemptStore.claimSettlement(attempt.id);
    const result = await persistence.recordConfirmed({
      attempt,
      settlement: confirmedSettlement(attempt.id, "transaction_hash_restart")
    });

    await client.$disconnect();
    client = createClient();

    const restartedAttempts = new PrismaPaymentAttemptStore(client);
    const restartedReceipts = new PrismaReceiptStore(client);
    await expect(restartedAttempts.getPaymentAttempt(attempt.id)).resolves.toMatchObject({
      correlationId: attempt.correlationId,
      status: "confirmed"
    });
    await expect(restartedReceipts.getReceipt(result.receipt.id)).resolves.toMatchObject({
      id: result.receipt.id,
      correlationId: attempt.correlationId,
      transactionHash: "transaction_hash_restart",
      evidenceHash: expect.stringMatching(/^[a-f0-9]{64}$/u)
    });
    expect(result.settlement.correlationId).toBe(attempt.correlationId);
  });

  it("rolls back a partial confirmation and rejects duplicate evidence", async () => {
    const attemptStore = new PrismaPaymentAttemptStore(client);
    const persistence = new PrismaPaymentStatePersistence(client);
    const first = await attemptStore.createVerifiedAttempt({
      paymentHash: "payment_hash_first",
      network,
      assetCode: "USDC",
      assetIssuer: issuer,
      amount: "0.0500000",
      payTo: issuer
    });
    await attemptStore.claimSettlement(first.id);
    await persistence.recordConfirmed({
      attempt: first,
      settlement: confirmedSettlement(first.id, "transaction_hash_shared")
    });
    const second = await attemptStore.createVerifiedAttempt({
      paymentHash: "payment_hash_second",
      network,
      assetCode: "USDC",
      assetIssuer: issuer,
      amount: "0.0500000",
      payTo: issuer
    });
    await attemptStore.claimSettlement(second.id);

    await expect(
      persistence.recordConfirmed({
        attempt: second,
        settlement: confirmedSettlement(second.id, "transaction_hash_shared")
      })
    ).rejects.toMatchObject({ code: "REPLAY_DETECTED" } satisfies Partial<LumenError>);
    await expect(attemptStore.getPaymentAttempt(second.id)).resolves.toMatchObject({
      status: "settling"
    });
    await expect(
      client.settlement.findUnique({ where: { paymentAttemptId: second.id } })
    ).resolves.toBeNull();
    await expect(
      client.receipt.findUnique({ where: { paymentAttemptId: second.id } })
    ).resolves.toBeNull();
    await expect(
      attemptStore.createVerifiedAttempt({
        paymentHash: "payment_hash_second",
        network,
        assetCode: "USDC",
        assetIssuer: issuer,
        amount: "0.0500000",
        payTo: issuer
      })
    ).rejects.toMatchObject({ code: "REPLAY_DETECTED" } satisfies Partial<LumenError>);
  });

  it("persists payment sessions and settlements across restarts", async () => {
    const sessionStore = new PrismaPaymentSessionStore(client);
    const session = await sessionStore.createSession({
      assetCode: "USDC",
      assetContractId: "CDLZUSDCTOKENCONTRACT0000000000000000000000000000000000",
      assetIssuer: issuer,
      buyer: issuer,
      capAmount: "10.0000000",
      contractId: "CDLZUPTOSESSIONCONTRACT000000000000000000000000000000000",
      contractSessionId: "contract_session_persist_integration_1",
      expiresAtLedger: 100,
      ledger: 50,
      network,
      payTo: issuer,
      remainingAmount: "10.0000000",
      resourceHash: "a".repeat(64),
      resourceId: null,
      sellerId: null,
      spentAmount: "0.0000000",
      status: "open",
      transactionHash: "tx_session_create_integration_1",
      usageHash: null
    });

    const settlement = await sessionStore.createSettlement({
      amount: "2.5000000",
      ledger: 55,
      network,
      sessionId: session.id,
      settledAt: "2026-10-20T12:00:00.000Z",
      status: "settled",
      transactionHash: "tx_session_settle_integration_1",
      usageHash: "b".repeat(64)
    });

    await client.$disconnect();
    client = createClient();

    const restartedStore = new PrismaPaymentSessionStore(client);
    const loadedSession = await restartedStore.getSession(session.id);
    expect(loadedSession).toMatchObject({
      id: session.id,
      contractSessionId: "contract_session_persist_integration_1",
      capAmount: "10",
      spentAmount: "0",
      remainingAmount: "10",
      status: "open"
    });

    const loadedByContract = await restartedStore.getSessionByContractSessionId(
      "contract_session_persist_integration_1"
    );
    expect(loadedByContract?.id).toBe(session.id);

    const loadedSettlement = await restartedStore.getSettlement(session.id);
    expect(loadedSettlement).toMatchObject({
      id: settlement.id,
      sessionId: session.id,
      amount: "2.5",
      transactionHash: "tx_session_settle_integration_1",
      ledger: 55
    });

    const loadedByTxHash = await restartedStore.getSettlementByTransactionHash(
      "tx_session_settle_integration_1"
    );
    expect(loadedByTxHash?.id).toBe(settlement.id);
  });
});

function createClient() {
  return new PrismaClient({
    datasources: {
      db: { url: databaseUrl ?? "postgresql://integration-test-is-disabled" }
    }
  });
}

function confirmedSettlement(paymentAttemptId: string, transactionHash: string) {
  return {
    paymentAttemptId,
    transactionHash,
    ledger: 123456,
    network,
    amount: "0.0500000",
    assetCode: "USDC",
    assetIssuer: issuer,
    status: "confirmed" as const,
    reconciliationState: "not_required" as const,
    settledAt: "2026-10-07T12:00:00.000Z"
  };
}
