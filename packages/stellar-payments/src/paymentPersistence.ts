import { createPrismaClient, type AppConfig } from "@lumenbazaar/shared";

import { InMemoryPaymentAttemptStore, type PaymentAttemptStore } from "./paymentAttemptStore.js";
import { InMemoryPaymentSessionStore, type PaymentSessionStore } from "./paymentSession.js";
import { type PaymentStatePersistence } from "./paymentStatePersistence.js";
import {
  PrismaPaymentAttemptStore,
  PrismaPaymentSessionStore,
  PrismaPaymentStatePersistence,
  PrismaReceiptStore,
  PrismaSettlementStore
} from "./prismaPaymentPersistence.js";
import { InMemoryReceiptStore, type ReceiptStore } from "./receiptStore.js";
import { InMemorySettlementStore, type SettlementStore } from "./settlementStore.js";

export type PaymentPersistenceBundle = {
  attemptStore: PaymentAttemptStore;
  settlementStore: SettlementStore;
  receiptStore: ReceiptStore;
  paymentSessionStore: PaymentSessionStore;
  statePersistence?: PaymentStatePersistence;
  close: () => Promise<void>;
};

export function createPaymentPersistence(config: AppConfig): PaymentPersistenceBundle {
  if (config.nodeEnv !== "production" || config.lumenEnv === "local") {
    return {
      attemptStore: new InMemoryPaymentAttemptStore(),
      settlementStore: new InMemorySettlementStore(),
      receiptStore: new InMemoryReceiptStore(),
      paymentSessionStore: new InMemoryPaymentSessionStore(),
      close: async () => undefined
    };
  }

  const client = createPrismaClient(config.databaseUrl);
  return {
    attemptStore: new PrismaPaymentAttemptStore(client),
    settlementStore: new PrismaSettlementStore(client),
    receiptStore: new PrismaReceiptStore(client),
    paymentSessionStore: new PrismaPaymentSessionStore(client),
    statePersistence: new PrismaPaymentStatePersistence(client),
    close: async () => client.$disconnect()
  };
}
