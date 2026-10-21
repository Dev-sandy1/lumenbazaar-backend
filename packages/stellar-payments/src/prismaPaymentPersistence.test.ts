import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { type CreatePaymentAttemptInput } from "./paymentAttemptStore.js";
import { PrismaPaymentAttemptStore } from "./prismaPaymentPersistence.js";

const network = "stellar:testnet" as const;
const issuer = "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF";

type AttemptRow = {
  id: string;
  correlationId: string;
  resourceId: string | null;
  sellerId: string | null;
  paymentHash: string;
  idempotencyKey: string;
  network: string;
  assetCode: string;
  assetIssuer: string;
  amount: Prisma.Decimal;
  payTo: string;
  status: string;
  failureCode: string | null;
  failureReason: string | null;
  expiresAtLedger: number | null;
  createdAt: Date;
  updatedAt: Date;
};

type CreateArgs = { data: Record<string, unknown> };
type FindUniqueArgs = { where: { id?: string; paymentHash?: string } };
type UpdateManyArgs = { where: { id?: string; status?: string }; data: Record<string, unknown> };
type UpdateArgs = { where: { id: string }; data: Record<string, unknown> };

class FakePaymentDatabase {
  readonly attempts = new Map<string, AttemptRow>();
  private sequence = 0;

  readonly paymentAttempt = {
    create: async ({ data }: CreateArgs) => {
      const paymentHash = String(data.paymentHash);
      const idempotencyKey = String(data.idempotencyKey);
      for (const row of this.attempts.values()) {
        if (row.paymentHash === paymentHash) {
          throw uniqueViolation("PaymentAttempt_paymentHash_key");
        }
        if (row.idempotencyKey === idempotencyKey) {
          throw uniqueViolation("PaymentAttempt_idempotencyKey_key");
        }
      }

      const now = new Date();
      const row = {
        id: `attempt_${++this.sequence}`,
        correlationId: "correlation_test",
        resourceId: null,
        sellerId: null,
        status: "verified",
        failureCode: null,
        failureReason: null,
        expiresAtLedger: null,
        createdAt: now,
        updatedAt: now,
        ...data,
        amount: numericColumn(data.amount)
      } as unknown as AttemptRow;
      this.attempts.set(row.id, row);
      return row;
    },
    findUnique: async ({ where }: FindUniqueArgs) => {
      if (where.id !== undefined) {
        return this.attempts.get(where.id) ?? null;
      }
      if (where.paymentHash !== undefined) {
        for (const row of this.attempts.values()) {
          if (row.paymentHash === where.paymentHash) {
            return row;
          }
        }
      }
      return null;
    },
    updateMany: async ({ where, data }: UpdateManyArgs) => {
      let count = 0;
      for (const row of this.attempts.values()) {
        if (where.id !== undefined && row.id !== where.id) {
          continue;
        }
        if (where.status !== undefined && row.status !== where.status) {
          continue;
        }
        Object.assign(row, data, { updatedAt: new Date() });
        count += 1;
      }
      return { count };
    },
    update: async ({ where, data }: UpdateArgs) => {
      const row = this.attempts.get(where.id);
      if (row === undefined) {
        throw notFound();
      }
      Object.assign(row, data, { updatedAt: new Date() });
      return row;
    }
  };

  readonly receipt = {};
  readonly settlement = {};

  rowCount() {
    return this.attempts.size;
  }
}

function numericColumn(value: unknown) {
  const [whole = "0", fraction = ""] = String(value).split(".");
  return new Prisma.Decimal(`${whole}.${fraction.padEnd(7, "0")}`);
}

function uniqueViolation(constraint: string) {
  return new Prisma.PrismaClientKnownRequestError(
    `Unique constraint failed on the constraint: \`${constraint}\``,
    { code: "P2002", clientVersion: "prisma-test" }
  );
}

function notFound() {
  return new Prisma.PrismaClientKnownRequestError(
    "An operation failed because it depends on one or more records that were required but not found.",
    { code: "P2025", clientVersion: "prisma-test" }
  );
}

function createStore(database = new FakePaymentDatabase()) {
  const store = new PrismaPaymentAttemptStore(
    database as unknown as ConstructorParameters<typeof PrismaPaymentAttemptStore>[0]
  );
  return { database, store };
}

function attemptInput(overrides: Partial<CreatePaymentAttemptInput> = {}) {
  return {
    paymentHash: "payment_hash_a",
    network,
    assetCode: "USDC",
    assetIssuer: issuer,
    amount: "500000",
    payTo: issuer,
    ...overrides
  };
}

describe("PrismaPaymentAttemptStore", () => {
  it("rejects a duplicate payment hash without persisting a second attempt", async () => {
    const { database, store } = createStore();
    const first = await store.createVerifiedAttempt(attemptInput());

    await expect(store.createVerifiedAttempt(attemptInput())).rejects.toMatchObject({
      code: "REPLAY_DETECTED"
    });

    expect(database.rowCount()).toBe(1);
    await expect(store.findPaymentAttemptByHash("payment_hash_a")).resolves.toMatchObject({
      id: first.id,
      status: "verified"
    });
    await expect(store.findPaymentAttemptByHash("payment_hash_unknown")).resolves.toBeUndefined();
  });

  it("lets concurrent verification of the same payload create exactly one attempt", async () => {
    const { database, store } = createStore();
    const [first, second] = await Promise.allSettled([
      store.createVerifiedAttempt(attemptInput()),
      store.createVerifiedAttempt(attemptInput())
    ]);

    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    if (second.status === "rejected") {
      expect(second.reason).toMatchObject({ code: "REPLAY_DETECTED" });
    }
    expect(database.rowCount()).toBe(1);
  });

  it("rejects a replayed idempotency key that uses a different payment hash", async () => {
    const { database, store } = createStore();
    await store.createVerifiedAttempt(attemptInput({ idempotencyKey: "verify:shared" }));

    await expect(
      store.createVerifiedAttempt(
        attemptInput({ paymentHash: "payment_hash_b", idempotencyKey: "verify:shared" })
      )
    ).rejects.toMatchObject({ code: "REPLAY_DETECTED" });
    expect(database.rowCount()).toBe(1);
  });

  it("returns verified attempts after a process restart backed by the same database", async () => {
    const { database, store } = createStore();
    const created = await store.createVerifiedAttempt(attemptInput());

    const restarted = createStore(database).store;
    await expect(restarted.getPaymentAttempt(created.id)).resolves.toMatchObject({
      id: created.id,
      paymentHash: "payment_hash_a",
      status: "verified"
    });
    await expect(restarted.findPaymentAttemptByHash("payment_hash_a")).resolves.toMatchObject({
      id: created.id
    });
  });

  it("claims settlement with a single conditional state change", async () => {
    const { store } = createStore();
    const attempt = await store.createVerifiedAttempt(attemptInput());

    const claimed = await store.claimSettlement(attempt.id);
    expect(claimed).toMatchObject({ status: "settling" });
    await expect(store.claimSettlement(attempt.id)).resolves.toBeUndefined();
    await expect(store.getPaymentAttempt(attempt.id)).resolves.toMatchObject({
      status: "settling"
    });
  });

  it("clears stale failure evidence when the settlement claim succeeds", async () => {
    const { store } = createStore();
    const attempt = await store.createVerifiedAttempt(attemptInput());
    await store.updatePaymentAttempt(attempt.id, {
      failureCode: "SETTLEMENT_FAILED",
      failureReason: "stellar horizon rejected the transaction"
    });

    const claimed = await store.claimSettlement(attempt.id);
    expect(claimed).toMatchObject({
      status: "settling",
      failureCode: null,
      failureReason: null
    });
  });

  it("reports a missing attempt as an invalid payment payload", async () => {
    const { store } = createStore();
    await expect(
      store.updatePaymentAttempt("attempt_missing", { status: "settling" })
    ).rejects.toMatchObject({ code: "INVALID_PAYMENT_PAYLOAD" });
    await expect(store.claimSettlement("attempt_missing")).resolves.toBeUndefined();
  });

  it("round-trips atomic amounts through the numeric column scale", async () => {
    const { store } = createStore();
    const attempt = await store.createVerifiedAttempt(attemptInput());

    expect(attempt.amount).toBe("500000");
    await expect(store.getPaymentAttempt(attempt.id)).resolves.toMatchObject({
      amount: "500000"
    });
    await expect(store.findPaymentAttemptByHash("payment_hash_a")).resolves.toMatchObject({
      amount: "500000"
    });
  });

  it("canonicalizes stored amounts that carry the numeric column scale", async () => {
    const { store } = createStore();
    const attempt = await store.createVerifiedAttempt(attemptInput({ amount: "0.0500000" }));

    expect(attempt.amount).toBe("0.05");
  });
});
