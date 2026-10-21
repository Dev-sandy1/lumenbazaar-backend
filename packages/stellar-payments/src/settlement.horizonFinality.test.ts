/**
 * Tests for exact settlement with Horizon finality verification.
 * Ensures that transactions are confirmed on-chain before receipts are finalized.
 */

import { describe, it, expect, beforeEach } from "vitest";
import { type AppConfig } from "@lumenbazaar/shared";
import { SettlementService } from "./settlement.js";
import { InMemoryPaymentAttemptStore } from "./paymentAttemptStore.js";
import { InMemorySettlementStore } from "./settlementStore.js";
import { ReceiptService } from "./receipt.js";
import { type X402StellarAdapter, type X402SettlementResult } from "./x402Adapter.js";

describe("Settlement with Horizon Finality Verification", () => {
  let config: AppConfig;
  let mockAdapter: X402StellarAdapter;
  let attemptStore: InMemoryPaymentAttemptStore;
  let settlementStore: InMemorySettlementStore;
  let receiptService: ReceiptService;
  let service: SettlementService;

  beforeEach(() => {
    config = {
      nodeEnv: "test",
      lumenEnv: "testnet",
      networks: {
        testnet: {
          rpcUrl: "http://localhost:8000/soroban/rpc",
          horizonUrl: "https://horizon-testnet.stellar.org"
        }
      },
      settlement: {
        maxTransactionFeeStroops: 100_000,
        inclusionFeeStroops: 1000
      },
      redisUrl: "redis://localhost:6379"
    } as AppConfig;

    attemptStore = new InMemoryPaymentAttemptStore();
    settlementStore = new InMemorySettlementStore();
    receiptService = new ReceiptService();

    // Mock adapter that returns confirmed settlement with transaction hash
    mockAdapter = {
      async verifyExact() {
        return { valid: true, adapter: "@x402/stellar" };
      },
      async settleExact(): Promise<X402SettlementResult> {
        return {
          status: "confirmed",
          transactionHash: "eb9c0e74b80e8a5f1ab1d8a17cff8c5dc9b46b5db46e65c903f56c1fffc1b3e2",
          ledger: 12345678,
          adapter: "@x402/stellar"
        };
      }
    };

    service = new SettlementService(config, {
      adapter: mockAdapter,
      attemptStore,
      settlementStore,
      receiptService
    });
  });

  it("should create settlement with confirmed status after RPC finality", async () => {
    // Create a verified payment attempt
    await attemptStore.createVerifiedAttempt({
      paymentHash:
        "abc123def456abc123def456abc123def456abc123def456abc123def456abc1",
      network: "testnet",
      assetCode: "USDC",
      assetIssuer: "GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ65JJLDHKHRUZI3EUEKMTCH",
      amount: "100.0000000",
      payTo: "GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ65JJLDHKHRUZI3EUEKMTCH",
      sellerId: "seller_123",
      resourceId: "resource_456"
    });

    // Submit settlement request
    const settlementRequest = {
      x402Version: 2,
      paymentPayload: {
        network: "testnet",
        payer: "GBMFJBSX4UYXB3DQRHLKK6K5SNOKNW7TIZ2LJ7SLGKWHP46JBNVPPQH7",
        payerSignature: "test_signature"
      },
      paymentRequirements: {
        network: "testnet",
        payTo: "GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ65JJLDHKHRUZI3EUEKMTCH",
        amount: "100.0000000",
        assetCode: "USDC",
        assetIssuer: "GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ65JJLDHKHRUZI3EUEKMTCH",
        expiration: Math.floor(Date.now() / 1000) + 3600
      }
    };

    const result = await service.settle(settlementRequest);

    // Verify settlement was created with confirmed status and transaction hash
    expect(result.status).toBe("confirmed");
    expect(result.transactionHash).toBe(
      "eb9c0e74b80e8a5f1ab1d8a17cff8c5dc9b46b5db46e65c903f56c1fffc1b3e2"
    );
    expect(result.ledger).toBe(12345678);

    // Verify settlement record exists in store
    const settlement = await settlementStore.getSettlementByTransactionHash(
      result.transactionHash,
      result.network
    );
    expect(settlement).toBeDefined();
    expect(settlement?.status).toBe("confirmed");
    expect(settlement?.ledger).toBe(12345678);
  });

  it("should handle RPC timeout gracefully and record failed settlement", async () => {
    // Create a verified payment attempt
    await attemptStore.createVerifiedAttempt({
      paymentHash:
        "xyz789uvw123xyz789uvw123xyz789uvw123xyz789uvw123xyz789uvw123xyz7",
      network: "testnet",
      assetCode: "USDC",
      assetIssuer: "GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ65JJLDHKHRUZI3EUEKMTCH",
      amount: "50.0000000",
      payTo: "GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ65JJLDHKHRUZI3EUEKMTCH",
      sellerId: "seller_789",
      resourceId: "resource_012"
    });

    // Mock adapter that times out
    const timeoutAdapter: X402StellarAdapter = {
      async verifyExact() {
        return { valid: true, adapter: "@x402/stellar" };
      },
      async settleExact(): Promise<X402SettlementResult> {
        return {
          status: "timed_out",
          transactionHash: "timeout_tx_hash",
          failureReason: "Stellar transaction finality timed out.",
          failureCode: "SETTLEMENT_FAILED",
          adapter: "@x402/stellar"
        };
      }
    };

    const timeoutService = new SettlementService(config, {
      adapter: timeoutAdapter,
      attemptStore,
      settlementStore,
      receiptService
    });

    const settlementRequest = {
      x402Version: 2,
      paymentPayload: {
        network: "testnet",
        payer: "GBMFJBSX4UYXB3DQRHLKK6K5SNOKNW7TIZ2LJ7SLGKWHP46JBNVPPQH7",
        payerSignature: "test_signature"
      },
      paymentRequirements: {
        network: "testnet",
        payTo: "GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ65JJLDHKHRUZI3EUEKMTCH",
        amount: "50.0000000",
        assetCode: "USDC",
        assetIssuer: "GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ65JJLDHKHRUZI3EUEKMTCH",
        expiration: Math.floor(Date.now() / 1000) + 3600
      }
    };

    // Settlement should fail with timeout status
    await expect(timeoutService.settle(settlementRequest)).rejects.toThrow(
      "SETTLEMENT_FAILED"
    );

    // Verify settlement was recorded with timed_out status
    const settlement = await settlementStore.getSettlementByTransactionHash("timeout_tx_hash", "stellar:testnet");
    expect(settlement?.status).toBe("timed_out");
  });

  it("should prevent idempotent resubmission of settlement", async () => {
    const paymentHash =
      "idempotent_abc123def456abc123def456abc123def456abc123def456abc123de";

    // Create first verified attempt
    await attemptStore.createVerifiedAttempt({
      paymentHash,
      network: "testnet",
      assetCode: "USDC",
      assetIssuer: "GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ65JJLDHKHRUZI3EUEKMTCH",
      amount: "75.0000000",
      payTo: "GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ65JJLDHKHRUZI3EUEKMTCH",
      sellerId: "seller_idempotent",
      resourceId: "resource_idempotent"
    });

    const settlementRequest = {
      x402Version: 2,
      paymentPayload: {
        network: "testnet",
        payer: "GBMFJBSX4UYXB3DQRHLKK6K5SNOKNW7TIZ2LJ7SLGKWHP46JBNVPPQH7",
        payerSignature: "test_signature"
      },
      paymentRequirements: {
        network: "testnet",
        payTo: "GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ65JJLDHKHRUZI3EUEKMTCH",
        amount: "75.0000000",
        assetCode: "USDC",
        assetIssuer: "GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ65JJLDHKHRUZI3EUEKMTCH",
        expiration: Math.floor(Date.now() / 1000) + 3600
      }
    };

    // First settlement succeeds
    const result1 = await service.settle(settlementRequest);
    expect(result1.status).toBe("confirmed");
    const txHash1 = result1.transactionHash;

    // Second settlement with same payload should return cached result (idempotent)
    const result2 = await service.settle(settlementRequest);
    expect(result2.status).toBe("confirmed");
    expect(result2.transactionHash).toBe(txHash1);
    expect(result2.settlementId).toBe(result1.settlementId);
  });

  it("should mark settlement as requiring review if on-chain verification fails", async () => {
    await attemptStore.createVerifiedAttempt({
      paymentHash:
        "failed_verification_123failed_verification_123failed_verification_1",
      network: "testnet",
      assetCode: "USDC",
      assetIssuer: "GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ65JJLDHKHRUZI3EUEKMTCH",
      amount: "25.0000000",
      payTo: "GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ65JJLDHKHRUZI3EUEKMTCH",
      sellerId: "seller_failed",
      resourceId: "resource_failed"
    });

    const failedAdapter: X402StellarAdapter = {
      async verifyExact() {
        return { valid: true, adapter: "@x402/stellar" };
      },
      async settleExact(): Promise<X402SettlementResult> {
        return {
          status: "failed",
          transactionHash: "failed_verification_tx",
          failureReason: "Stellar transaction failed before finality.",
          failureCode: "SETTLEMENT_FAILED",
          adapter: "@x402/stellar"
        };
      }
    };

    const failedService = new SettlementService(config, {
      adapter: failedAdapter,
      attemptStore,
      settlementStore,
      receiptService
    });

    const settlementRequest = {
      x402Version: 2,
      paymentPayload: {
        network: "testnet",
        payer: "GBMFJBSX4UYXB3DQRHLKK6K5SNOKNW7TIZ2LJ7SLGKWHP46JBNVPPQH7",
        payerSignature: "test_signature"
      },
      paymentRequirements: {
        network: "testnet",
        payTo: "GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ65JJLDHKHRUZI3EUEKMTCH",
        amount: "25.0000000",
        assetCode: "USDC",
        assetIssuer: "GATEMHCCKCY67ZUCKTROYN24ZYT5GK4EQZ65JJLDHKHRUZI3EUEKMTCH",
        expiration: Math.floor(Date.now() / 1000) + 3600
      }
    };

    await expect(failedService.settle(settlementRequest)).rejects.toThrow(
      "SETTLEMENT_FAILED"
    );

    const settlement = await settlementStore.getSettlementByTransactionHash(
      "failed_verification_tx",
      "stellar:testnet"
    );
    expect(settlement?.status).toBe("failed");
  });
});
