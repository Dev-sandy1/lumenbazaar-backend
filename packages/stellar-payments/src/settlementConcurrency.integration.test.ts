import { PrismaClient } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "@lumenbazaar/shared";
import { createTestPaymentRequest, testPaymentConfigEnv } from "@lumenbazaar/testkit";

import { PaymentVerificationService } from "./verification.js";
import {
  PrismaPaymentAttemptStore,
  PrismaPaymentStatePersistence,
  PrismaReceiptStore,
  PrismaSettlementStore
} from "./prismaPaymentPersistence.js";
import { ReceiptService } from "./receipt.js";
import { SettlementService } from "./settlement.js";
import { type X402StellarAdapter } from "./x402Adapter.js";

const databaseUrl = process.env.PAYMENT_PERSISTENCE_TEST_DATABASE_URL;
const describePostgres = databaseUrl === undefined ? describe.skip : describe;

describePostgres("multi-process settlement concurrency", () => {
  let clients: PrismaClient[] = [];

  beforeEach(async () => {
    const cleanup = createClient();
    clients.push(cleanup);
    await cleanup.receipt.deleteMany();
    await cleanup.settlement.deleteMany();
    await cleanup.paymentAttempt.deleteMany();
  });

  afterEach(async () => {
    await Promise.all(clients.splice(0).map(async (client) => client.$disconnect()));
  });

  it("converges a verification uniqueness race on the original attempt", async () => {
    const adapter: X402StellarAdapter = {
      async verifyExact() {
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { valid: true, adapter: "@x402/stellar" };
      }
    };
    const config = loadConfig(testPaymentConfigEnv);
    const firstClient = createClient();
    const secondClient = createClient();
    clients.push(firstClient, secondClient);
    const services = [
      new PaymentVerificationService(config, {
        adapter,
        attemptStore: new PrismaPaymentAttemptStore(firstClient)
      }),
      new PaymentVerificationService(config, {
        adapter,
        attemptStore: new PrismaPaymentAttemptStore(secondClient)
      })
    ];
    const request = createTestPaymentRequest("verification-race");

    const [first, concurrent] = await Promise.all(
      services.map(async (service) => service.verify(request))
    );

    expect(concurrent).toEqual(first);
    await expect(firstClient.paymentAttempt.count()).resolves.toBe(1);
  });

  it("submits once and returns one durable result across independent clients", async () => {
    const settleExact = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return {
        transactionHash: "tx_multi_process",
        ledger: 765432,
        status: "confirmed" as const,
        adapter: "@x402/stellar" as const
      };
    });
    const adapter: X402StellarAdapter = {
      async verifyExact() {
        return { valid: true, adapter: "@x402/stellar" };
      },
      settleExact
    };
    const config = loadConfig(testPaymentConfigEnv);
    const firstClient = createClient();
    const secondClient = createClient();
    clients.push(firstClient, secondClient);
    const firstAttemptStore = new PrismaPaymentAttemptStore(firstClient);
    const verification = new PaymentVerificationService(config, {
      adapter,
      attemptStore: firstAttemptStore
    });
    const services = [
      createSettlementService(config, adapter, firstClient),
      createSettlementService(config, adapter, secondClient)
    ];
    const request = createTestPaymentRequest("multi-process-concurrency");
    await verification.verify(request);

    const [first, concurrent] = await Promise.all(
      services.map(async (service) => service.settle(request))
    );
    const retry = await services[1]!.settle(request);

    expect(concurrent).toEqual(first);
    expect(retry).toEqual(first);
    expect(first!.amount).toBe("500000");
    expect(settleExact).toHaveBeenCalledTimes(1);
    await expect(firstClient.settlement.count()).resolves.toBe(1);
    await expect(firstClient.receipt.count()).resolves.toBe(1);
  });

  it("keeps an interrupted claim durable so another process cannot resubmit", async () => {
    const firstClient = createClient();
    clients.push(firstClient);
    const firstStore = new PrismaPaymentAttemptStore(firstClient);
    const attempt = await firstStore.createVerifiedAttempt({
      paymentHash: "interrupted_payment_hash",
      network: "stellar:testnet",
      assetCode: "USDC",
      assetIssuer: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF",
      amount: "500000",
      payTo: "GAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAWHF"
    });
    await expect(firstStore.claimSettlement(attempt.id)).resolves.toMatchObject({
      status: "settling"
    });
    await firstClient.$disconnect();
    clients = clients.filter((client) => client !== firstClient);

    const restartedClient = createClient();
    clients.push(restartedClient);
    const restartedStore = new PrismaPaymentAttemptStore(restartedClient);
    await expect(restartedStore.claimSettlement(attempt.id)).resolves.toBeUndefined();
    await expect(restartedStore.getPaymentAttempt(attempt.id)).resolves.toMatchObject({
      status: "settling"
    });
  });
});

function createSettlementService(
  config: ReturnType<typeof loadConfig>,
  adapter: X402StellarAdapter,
  client: PrismaClient
) {
  return new SettlementService(config, {
    adapter,
    attemptStore: new PrismaPaymentAttemptStore(client),
    settlementStore: new PrismaSettlementStore(client),
    receiptService: new ReceiptService({ receiptStore: new PrismaReceiptStore(client) }),
    statePersistence: new PrismaPaymentStatePersistence(client)
  });
}

function createClient() {
  return new PrismaClient({
    datasources: {
      db: { url: databaseUrl ?? "postgresql://integration-test-is-disabled" }
    }
  });
}
