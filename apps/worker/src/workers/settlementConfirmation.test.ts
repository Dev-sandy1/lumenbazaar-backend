import { describe, expect, it, vi } from "vitest";
import { type Job, type Queue } from "bullmq";
import { type PrismaClient } from "@prisma/client";
import * as StellarSdk from "@stellar/stellar-sdk";

import { loadConfig } from "@lumenbazaar/shared";

import {
  createTransactionStatusClient,
  handleSettlementConfirmation,
  isMalformedError,
  isNotFound,
  isTimeoutError,
  markReconciliationDeadLetter,
  ReconciliationPendingError,
  resumePendingSettlements,
  type ChainTransactionState,
  type SettlementConfirmationJobData,
  type TransactionStatusClient
} from "./settlementConfirmation.js";

const config = loadConfig({
  STELLAR_NETWORK: "testnet",
  STELLAR_HORIZON_URL: "https://horizon-testnet.stellar.org"
});

function createMockDb(overrides: Record<string, unknown> = {}) {
  const txPrisma = {
    paymentAttempt: {
      update: vi.fn().mockResolvedValue({ id: "attempt_1" })
    },
    settlement: {
      update: vi.fn().mockResolvedValue({ id: "settlement_1" })
    },
    receipt: {
      upsert: vi.fn().mockResolvedValue({ id: "receipt_1" })
    },
    auditLog: {
      create: vi.fn().mockResolvedValue({ id: "audit_1" })
    }
  };

  const db = {
    ...txPrisma,
    paymentAttempt: {
      ...txPrisma.paymentAttempt,
      findUnique: vi.fn(),
      findMany: vi.fn()
    },
    settlement: {
      ...txPrisma.settlement,
      findUnique: vi.fn()
    },
    $transaction: vi.fn(async (arg: unknown) => {
      if (typeof arg === "function") {
        return (arg as (tx: typeof txPrisma) => Promise<unknown>)(txPrisma);
      }
      if (Array.isArray(arg)) {
        return Promise.all(arg);
      }
      return arg;
    }),
    ...overrides
  };

  return { db: db as unknown as PrismaClient, rawDb: db, txPrisma };
}

function createMockJob(
  data: SettlementConfirmationJobData,
  options: { attempts?: number; attemptsMade?: number } = {}
) {
  return {
    id: "job_test_1",
    data,
    attemptsMade: options.attemptsMade ?? 0,
    opts: {
      attempts: options.attempts ?? 3
    },
    log: vi.fn().mockResolvedValue(1)
  } as unknown as Job<SettlementConfirmationJobData>;
}

describe("settlementConfirmation worker", () => {
  describe("duplicate jobs are harmless", () => {
    it("returns immediately without DB writes if settlement is already confirmed and receipt is finalized", async () => {
      const { db, rawDb } = createMockDb();
      rawDb.paymentAttempt.findUnique.mockResolvedValue({
        id: "attempt_1",
        status: "confirmed",
        correlationId: "corr_1",
        settlement: {
          id: "settlement_1",
          status: "confirmed",
          reconciliationState: "reconciled",
          transactionHash: "tx_hash_1"
        },
        receipt: {
          id: "receipt_1",
          status: "finalized"
        }
      });

      const job = createMockJob({
        paymentAttemptId: "attempt_1",
        settlementId: "settlement_1",
        network: "stellar:testnet"
      });

      const statusClient: TransactionStatusClient = {
        getTransactionState: vi.fn()
      };

      await handleSettlementConfirmation(job, config, { db, statusClient });

      expect(statusClient.getTransactionState).not.toHaveBeenCalled();
      expect(rawDb.settlement.update).not.toHaveBeenCalled();
      expect(rawDb.paymentAttempt.update).not.toHaveBeenCalled();
      expect(job.log).toHaveBeenCalledWith(expect.stringContaining("already final"));
    });

    it("returns immediately without DB writes if settlement is already marked for manual review", async () => {
      const { db, rawDb } = createMockDb();
      rawDb.paymentAttempt.findUnique.mockResolvedValue({
        id: "attempt_1",
        status: "failed",
        correlationId: "corr_1",
        settlement: {
          id: "settlement_1",
          status: "failed",
          reconciliationState: "needs_review",
          transactionHash: "tx_hash_1"
        },
        receipt: null
      });

      const job = createMockJob({
        paymentAttemptId: "attempt_1",
        settlementId: "settlement_1",
        network: "stellar:testnet"
      });

      const statusClient: TransactionStatusClient = {
        getTransactionState: vi.fn()
      };

      await handleSettlementConfirmation(job, config, { db, statusClient });

      expect(statusClient.getTransactionState).not.toHaveBeenCalled();
      expect(rawDb.settlement.update).not.toHaveBeenCalled();
      expect(job.log).toHaveBeenCalledWith(
        expect.stringContaining("already marked for manual review")
      );
    });
  });

  describe("success confirmation", () => {
    it("confirms settlement, finalizes receipt, and writes audit log when ledger is verified", async () => {
      const { db, rawDb, txPrisma } = createMockDb();
      rawDb.paymentAttempt.findUnique.mockResolvedValue({
        id: "attempt_1",
        status: "settling",
        correlationId: "corr_1",
        paymentHash: "ph_1",
        resourceId: "res_1",
        sellerId: "seller_1",
        amount: "10.00",
        assetCode: "USDC",
        assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5",
        network: "stellar:testnet",
        settlement: {
          id: "settlement_1",
          status: "submitted",
          transactionHash: "tx_hash_valid",
          network: "stellar:testnet",
          amount: "10.00",
          assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
        },
        receipt: null
      });

      const statusClient: TransactionStatusClient = {
        getTransactionState: vi.fn().mockResolvedValue({
          status: "confirmed",
          ledger: 123456
        } satisfies ChainTransactionState)
      };

      const job = createMockJob({
        paymentAttemptId: "attempt_1",
        settlementId: "settlement_1",
        network: "stellar:testnet"
      });

      await handleSettlementConfirmation(job, config, { db, statusClient });

      expect(statusClient.getTransactionState).toHaveBeenCalledWith(
        "tx_hash_valid",
        "stellar:testnet"
      );
      expect(txPrisma.settlement.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "settlement_1" },
          data: expect.objectContaining({
            status: "confirmed",
            ledger: 123456,
            reconciliationState: "reconciled"
          })
        })
      );
      expect(txPrisma.paymentAttempt.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "attempt_1" },
          data: expect.objectContaining({ status: "confirmed" })
        })
      );
      expect(txPrisma.receipt.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { paymentAttemptId: "attempt_1" },
          create: expect.objectContaining({
            status: "finalized",
            ledger: 123456,
            transactionHash: "tx_hash_valid"
          }),
          update: expect.objectContaining({
            status: "finalized",
            ledger: 123456
          })
        })
      );
      expect(txPrisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "settlement.reconciliation.confirmed",
            targetId: "settlement_1"
          })
        })
      );
    });
  });

  describe("delayed ledgers and not-found handling", () => {
    it("increments reconciliationAttempts and throws ReconciliationPendingError on not-found", async () => {
      const { db, rawDb } = createMockDb();
      rawDb.paymentAttempt.findUnique.mockResolvedValue({
        id: "attempt_1",
        status: "settling",
        correlationId: "corr_1",
        settlement: {
          id: "settlement_1",
          status: "submitted",
          transactionHash: "tx_delayed",
          network: "stellar:testnet",
          amount: "5.0",
          assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
        },
        receipt: null
      });

      const notFoundError = Object.assign(new Error("Not Found"), { status: 404 });
      const statusClient: TransactionStatusClient = {
        getTransactionState: vi.fn().mockRejectedValue(notFoundError)
      };

      const job = createMockJob(
        {
          paymentAttemptId: "attempt_1",
          settlementId: "settlement_1",
          network: "stellar:testnet"
        },
        { attempts: 3, attemptsMade: 0 }
      );

      await expect(handleSettlementConfirmation(job, config, { db, statusClient })).rejects.toThrow(
        ReconciliationPendingError
      );

      expect(rawDb.settlement.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "settlement_1" },
          data: expect.objectContaining({
            reconciliationState: "pending",
            reconciliationAttempts: { increment: 1 }
          })
        })
      );
    });
  });

  describe("provider timeout handling", () => {
    it("handles timeout error from provider and schedules bounded retry via ReconciliationPendingError", async () => {
      const { db, rawDb } = createMockDb();
      rawDb.paymentAttempt.findUnique.mockResolvedValue({
        id: "attempt_1",
        status: "settling",
        correlationId: "corr_1",
        settlement: {
          id: "settlement_1",
          status: "submitted",
          transactionHash: "tx_timeout",
          network: "stellar:testnet",
          amount: "5.0",
          assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
        },
        receipt: null
      });

      const timeoutError = Object.assign(new Error("Connection timed out"), { code: "ETIMEDOUT" });
      const statusClient: TransactionStatusClient = {
        getTransactionState: vi.fn().mockRejectedValue(timeoutError)
      };

      const job = createMockJob(
        {
          paymentAttemptId: "attempt_1",
          settlementId: "settlement_1",
          network: "stellar:testnet"
        },
        { attempts: 3, attemptsMade: 1 }
      );

      await expect(handleSettlementConfirmation(job, config, { db, statusClient })).rejects.toThrow(
        ReconciliationPendingError
      );

      expect(rawDb.settlement.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "settlement_1" },
          data: expect.objectContaining({
            reconciliationState: "pending",
            reconciliationAttempts: { increment: 1 }
          })
        })
      );
    });
  });

  describe("terminal failure handling", () => {
    it("records reviewable state immediately on transaction failure without retrying", async () => {
      const { db, rawDb } = createMockDb();
      rawDb.paymentAttempt.findUnique.mockResolvedValue({
        id: "attempt_1",
        status: "settling",
        correlationId: "corr_1",
        settlement: {
          id: "settlement_1",
          status: "submitted",
          transactionHash: "tx_failed",
          network: "stellar:testnet",
          amount: "5.0",
          assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
        },
        receipt: null
      });

      const statusClient: TransactionStatusClient = {
        getTransactionState: vi.fn().mockResolvedValue({
          status: "failed",
          reason: "op_underfunded"
        })
      };

      const job = createMockJob({
        paymentAttemptId: "attempt_1",
        settlementId: "settlement_1",
        network: "stellar:testnet"
      });

      await handleSettlementConfirmation(job, config, { db, statusClient });

      expect(rawDb.settlement.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "settlement_1" },
          data: expect.objectContaining({
            status: "failed",
            reconciliationState: "needs_review",
            reconciliationReason: "op_underfunded"
          })
        })
      );
      expect(rawDb.paymentAttempt.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "attempt_1" },
          data: expect.objectContaining({
            status: "failed",
            failureCode: "SETTLEMENT_FAILED"
          })
        })
      );
      expect(rawDb.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "settlement.reconciliation.needs_review",
            targetId: "settlement_1"
          })
        })
      );
    });
  });

  describe("malformed provider response handling", () => {
    it("records reviewable state when statusClient throws a malformed response error", async () => {
      const { db, rawDb } = createMockDb();
      rawDb.paymentAttempt.findUnique.mockResolvedValue({
        id: "attempt_1",
        status: "settling",
        correlationId: "corr_1",
        settlement: {
          id: "settlement_1",
          status: "submitted",
          transactionHash: "tx_malformed",
          network: "stellar:testnet",
          amount: "5.0",
          assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
        },
        receipt: null
      });

      const malformedError = new SyntaxError("Unexpected token < in JSON at position 0");
      const statusClient: TransactionStatusClient = {
        getTransactionState: vi.fn().mockRejectedValue(malformedError)
      };

      const job = createMockJob({
        paymentAttemptId: "attempt_1",
        settlementId: "settlement_1",
        network: "stellar:testnet"
      });

      await handleSettlementConfirmation(job, config, { db, statusClient });

      expect(rawDb.settlement.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "settlement_1" },
          data: expect.objectContaining({
            reconciliationState: "needs_review"
          })
        })
      );
    });

    it("records reviewable state when provider returns invalid ledger number", async () => {
      const { db, rawDb } = createMockDb();
      rawDb.paymentAttempt.findUnique.mockResolvedValue({
        id: "attempt_1",
        status: "settling",
        correlationId: "corr_1",
        settlement: {
          id: "settlement_1",
          status: "submitted",
          transactionHash: "tx_bad_ledger",
          network: "stellar:testnet",
          amount: "5.0",
          assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
        },
        receipt: null
      });

      const statusClient: TransactionStatusClient = {
        getTransactionState: vi.fn().mockResolvedValue({
          status: "confirmed",
          ledger: -5 as unknown as number
        })
      };

      const job = createMockJob({
        paymentAttemptId: "attempt_1",
        settlementId: "settlement_1",
        network: "stellar:testnet"
      });

      await handleSettlementConfirmation(job, config, { db, statusClient });

      expect(rawDb.settlement.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "settlement_1" },
          data: expect.objectContaining({
            reconciliationState: "needs_review"
          })
        })
      );
    });
  });

  describe("bounded retries and retry exhaustion", () => {
    it("transitions to needs_review when job attempts are exhausted", async () => {
      const { db, rawDb } = createMockDb();
      rawDb.paymentAttempt.findUnique.mockResolvedValue({
        id: "attempt_1",
        status: "settling",
        correlationId: "corr_1",
        settlement: {
          id: "settlement_1",
          status: "submitted",
          transactionHash: "tx_exhausted",
          network: "stellar:testnet",
          amount: "5.0",
          assetIssuer: "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"
        },
        receipt: null
      });

      const statusClient: TransactionStatusClient = {
        getTransactionState: vi.fn().mockResolvedValue({
          status: "pending",
          reason: "Transaction is not yet visible on Horizon."
        })
      };

      const job = createMockJob(
        {
          paymentAttemptId: "attempt_1",
          settlementId: "settlement_1",
          network: "stellar:testnet"
        },
        { attempts: 3, attemptsMade: 3 }
      );

      await expect(handleSettlementConfirmation(job, config, { db, statusClient })).rejects.toThrow(
        ReconciliationPendingError
      );

      expect(rawDb.settlement.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "settlement_1" },
          data: expect.objectContaining({
            status: "failed",
            reconciliationState: "needs_review",
            reconciliationReason: expect.stringContaining("Reconciliation retries exhausted")
          })
        })
      );
    });
  });

  describe("dead-letter evidence recording", () => {
    it("markReconciliationDeadLetter persists failure state and audit log", async () => {
      const { db, rawDb } = createMockDb();
      rawDb.paymentAttempt.findUnique.mockResolvedValue({
        id: "attempt_dead_letter",
        correlationId: "corr_dl_1"
      });

      await markReconciliationDeadLetter(
        db,
        {
          paymentAttemptId: "attempt_dead_letter",
          settlementId: "settlement_dead_letter",
          network: "stellar:testnet"
        },
        "Retries exhausted by dead-letter handler"
      );

      expect(rawDb.settlement.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: "settlement_dead_letter" },
          data: expect.objectContaining({
            status: "failed",
            reconciliationState: "needs_review",
            reconciliationReason: "Retries exhausted by dead-letter handler"
          })
        })
      );
      expect(rawDb.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: "settlement.reconciliation.needs_review",
            targetId: "settlement_dead_letter"
          })
        })
      );
    });
  });

  describe("restart resumption", () => {
    it("resumes pending settlements and excludes reconciled and needs_review records", async () => {
      const { db, rawDb } = createMockDb();
      const mockQueue = {
        add: vi.fn().mockResolvedValue({ id: "job_restarted" })
      } as unknown as Queue;

      rawDb.paymentAttempt.findMany.mockResolvedValue([
        {
          id: "attempt_pending_1",
          correlationId: "corr_pending_1",
          network: "stellar:testnet",
          settlement: {
            id: "settlement_pending_1",
            transactionHash: "tx_pending_1"
          }
        },
        {
          id: "attempt_settling_no_settlement",
          correlationId: "corr_settling_2",
          network: "stellar:testnet",
          settlement: null
        }
      ]);

      const count = await resumePendingSettlements(db, mockQueue);

      expect(count).toBe(2);
      expect(rawDb.paymentAttempt.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            OR: [
              { status: "settling", settlement: null },
              {
                settlement: {
                  is: {
                    transactionHash: { not: null },
                    reconciliationState: { notIn: ["reconciled", "needs_review"] },
                    OR: [
                      { reconciliationState: "pending" },
                      { status: { in: ["pending", "submitted", "timed_out"] } }
                    ]
                  }
                }
              }
            ]
          }
        })
      );
      expect(mockQueue.add).toHaveBeenCalledTimes(2);
    });
  });

  describe("error classification helpers", () => {
    it("isNotFound identifies 404 status correctly", () => {
      expect(isNotFound({ status: 404 })).toBe(true);
      expect(isNotFound({ response: { status: 404 } })).toBe(true);
      expect(isNotFound({ status: 500 })).toBe(false);
      expect(isNotFound(null)).toBe(false);
      expect(isNotFound("error")).toBe(false);
    });

    it("isTimeoutError identifies timeouts, aborts, and 504/408 statuses", () => {
      expect(isTimeoutError({ status: 504 })).toBe(true);
      expect(isTimeoutError({ status: 408 })).toBe(true);
      expect(isTimeoutError({ response: { status: 504 } })).toBe(true);
      expect(isTimeoutError({ code: "ETIMEDOUT" })).toBe(true);
      expect(isTimeoutError({ code: "ECONNABORTED" })).toBe(true);
      expect(isTimeoutError({ name: "TimeoutError" })).toBe(true);
      expect(isTimeoutError({ name: "AbortError" })).toBe(true);
      expect(isTimeoutError({ message: "request timed out" })).toBe(true);
      expect(isTimeoutError({ status: 400 })).toBe(false);
      expect(isTimeoutError(null)).toBe(false);
    });

    it("isMalformedError identifies syntax errors and bad JSON messages", () => {
      expect(isMalformedError(new SyntaxError("invalid json"))).toBe(true);
      expect(isMalformedError({ message: "malformed response from server" })).toBe(true);
      expect(isMalformedError({ message: "unexpected token < in JSON" })).toBe(true);
      expect(isMalformedError({ message: "generic error" })).toBe(false);
      expect(isMalformedError(null)).toBe(false);
    });
  });

  describe("createTransactionStatusClient", () => {
    it("returns confirmed when transaction is successful with valid ledger", async () => {
      const client = createTransactionStatusClient(config);
      const mockCall = vi.fn().mockResolvedValue({
        successful: true,
        ledger_attr: 54321
      });
      const spy = vi.spyOn(StellarSdk.Horizon.Server.prototype, "transactions").mockReturnValue({
        transaction: vi.fn().mockReturnValue({ call: mockCall })
      } as unknown as ReturnType<InstanceType<typeof StellarSdk.Horizon.Server>["transactions"]>);

      try {
        const result = await client.getTransactionState("tx_1", "stellar:testnet");
        expect(result).toEqual({ status: "confirmed", ledger: 54321 });
      } finally {
        spy.mockRestore();
      }
    });

    it("returns failed when transaction.successful is false", async () => {
      const client = createTransactionStatusClient(config);
      const mockCall = vi.fn().mockResolvedValue({
        successful: false,
        ledger_attr: 54321
      });
      const spy = vi.spyOn(StellarSdk.Horizon.Server.prototype, "transactions").mockReturnValue({
        transaction: vi.fn().mockReturnValue({ call: mockCall })
      } as unknown as ReturnType<InstanceType<typeof StellarSdk.Horizon.Server>["transactions"]>);

      try {
        const result = await client.getTransactionState("tx_failed", "stellar:testnet");
        expect(result).toEqual({
          status: "failed",
          reason: "Stellar recorded the transaction as failed."
        });
      } finally {
        spy.mockRestore();
      }
    });

    it("returns failed for malformed missing ledger attribute", async () => {
      const client = createTransactionStatusClient(config);
      const mockCall = vi.fn().mockResolvedValue({
        successful: true,
        ledger_attr: undefined
      });
      const spy = vi.spyOn(StellarSdk.Horizon.Server.prototype, "transactions").mockReturnValue({
        transaction: vi.fn().mockReturnValue({ call: mockCall })
      } as unknown as ReturnType<InstanceType<typeof StellarSdk.Horizon.Server>["transactions"]>);

      try {
        const result = await client.getTransactionState("tx_bad_ledger", "stellar:testnet");
        expect(result).toEqual({
          status: "failed",
          reason: expect.stringContaining("missing or invalid ledger attribute")
        });
      } finally {
        spy.mockRestore();
      }
    });

    it("returns pending on 404 not found", async () => {
      const client = createTransactionStatusClient(config);
      const mockCall = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("Not found"), { status: 404 }));
      const spy = vi.spyOn(StellarSdk.Horizon.Server.prototype, "transactions").mockReturnValue({
        transaction: vi.fn().mockReturnValue({ call: mockCall })
      } as unknown as ReturnType<InstanceType<typeof StellarSdk.Horizon.Server>["transactions"]>);

      try {
        const result = await client.getTransactionState("tx_not_found", "stellar:testnet");
        expect(result).toEqual({
          status: "pending",
          reason: "Transaction is not yet visible on Horizon."
        });
      } finally {
        spy.mockRestore();
      }
    });

    it("returns pending on timeout error", async () => {
      const client = createTransactionStatusClient(config);
      const mockCall = vi
        .fn()
        .mockRejectedValue(Object.assign(new Error("Timeout"), { code: "ETIMEDOUT" }));
      const spy = vi.spyOn(StellarSdk.Horizon.Server.prototype, "transactions").mockReturnValue({
        transaction: vi.fn().mockReturnValue({ call: mockCall })
      } as unknown as ReturnType<InstanceType<typeof StellarSdk.Horizon.Server>["transactions"]>);

      try {
        const result = await client.getTransactionState("tx_timeout", "stellar:testnet");
        expect(result).toEqual({
          status: "pending",
          reason: "Horizon provider request timed out."
        });
      } finally {
        spy.mockRestore();
      }
    });

    it("returns failed on syntax/malformed error", async () => {
      const client = createTransactionStatusClient(config);
      const mockCall = vi.fn().mockRejectedValue(new SyntaxError("Unexpected token in JSON"));
      const spy = vi.spyOn(StellarSdk.Horizon.Server.prototype, "transactions").mockReturnValue({
        transaction: vi.fn().mockReturnValue({ call: mockCall })
      } as unknown as ReturnType<InstanceType<typeof StellarSdk.Horizon.Server>["transactions"]>);

      try {
        const result = await client.getTransactionState("tx_syntax", "stellar:testnet");
        expect(result).toEqual({
          status: "failed",
          reason: "Provider returned a malformed response."
        });
      } finally {
        spy.mockRestore();
      }
    });
  });
});
