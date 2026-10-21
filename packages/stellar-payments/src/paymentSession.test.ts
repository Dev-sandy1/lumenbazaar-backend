import { Prisma } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { loadConfig, localIssuerPublicKey } from "@lumenbazaar/shared";

import {
  InMemoryPaymentSessionStore,
  PaymentSessionService,
  PrismaPaymentSessionStore,
  createGeneratedUptoSessionBindings,
  type GeneratedUptoSessionClient,
  type PaymentSessionDatabaseClient
} from "./index.js";

const contractId = "CDLZUPTOSESSIONCONTRACT000000000000000000000000000000000";
const assetContractId = "CDLZUSDCTOKENCONTRACT0000000000000000000000000000000000";
const usageHash = "a".repeat(64);

describe("PaymentSessionService", () => {
  it("fails closed when capped sessions are disabled", async () => {
    const service = new PaymentSessionService(loadConfig({}));

    await expect(service.createSession(sessionRequest())).rejects.toMatchObject({
      code: "VALIDATION_FAILED"
    });
  });

  it("creates contract-backed capped sessions and stores generated IDs", async () => {
    const client: GeneratedUptoSessionClient = {
      create_session: vi.fn(async () => "contract_session_1"),
      settle: vi.fn()
    };
    const service = new PaymentSessionService(enabledConfig(), {
      bindings: createGeneratedUptoSessionBindings(() => client),
      store: new InMemoryPaymentSessionStore()
    });

    const session = await service.createSession(sessionRequest());

    expect(session).toMatchObject({
      network: "stellar:testnet",
      buyer: localIssuerPublicKey,
      capAmount: "1",
      spentAmount: "0",
      remainingAmount: "1",
      contractId,
      contractSessionId: "contract_session_1",
      assetContractId,
      status: "open"
    });
    expect(client.create_session).toHaveBeenCalledWith(
      localIssuerPublicKey,
      localIssuerPublicKey,
      assetContractId,
      10_000_000n,
      50,
      expect.stringMatching(/^[a-f0-9]{64}$/)
    );
  });

  it("refuses synthetic bindings when upto is enabled outside local development", () => {
    expect(
      () =>
        new PaymentSessionService(
          loadConfig({
            ENABLE_UPTO_SCHEME: "true",
            LUMEN_ENV: "testnet"
          })
        )
    ).toThrow("ENABLE_UPTO_SCHEME requires live Soroban bindings");
  });

  it("settles once up to the capped amount without using exact payment payloads", async () => {
    const client: GeneratedUptoSessionClient = {
      create_session: vi.fn(async () => "contract_session_2"),
      settle: vi.fn(async () => ({ transactionHash: "tx_upto_1", ledger: 321 }))
    };
    const service = new PaymentSessionService(enabledConfig(), {
      bindings: createGeneratedUptoSessionBindings(() => client)
    });
    const session = await service.createSession(sessionRequest());

    const settled = await service.settleSession({
      sessionId: session.id,
      amount: "0.25",
      usageHash,
      currentLedger: 25
    });

    expect(settled).toMatchObject({
      scheme: "upto",
      id: session.id,
      status: "settled",
      spentAmount: "0.25",
      remainingAmount: "0.75",
      transactionHash: "tx_upto_1",
      ledger: 321
    });
    expect(client.settle).toHaveBeenCalledWith("contract_session_2", 2_500_000n, usageHash);
    await expect(
      service.settleSession({
        sessionId: session.id,
        amount: "0.01",
        usageHash: "b".repeat(64)
      })
    ).rejects.toMatchObject({
      code: "REPLAY_DETECTED"
    });
  });

  it("rejects generated clients that omit on-chain settlement evidence", async () => {
    const client: GeneratedUptoSessionClient = {
      create_session: vi.fn(async () => "contract_session_missing_evidence"),
      settle: vi.fn(async () => undefined)
    };
    const service = new PaymentSessionService(enabledConfig(), {
      bindings: createGeneratedUptoSessionBindings(() => client)
    });
    const session = await service.createSession(sessionRequest());

    await expect(
      service.settleSession({
        sessionId: session.id,
        amount: "0.25",
        usageHash
      })
    ).rejects.toThrow("did not return transaction hash and ledger evidence");
  });

  it("rejects over-cap, expired, and invalid usage-hash settlements", async () => {
    const service = new PaymentSessionService(enabledConfig());
    const session = await service.createSession(sessionRequest());

    await expect(
      service.settleSession({
        sessionId: session.id,
        amount: "1.01",
        usageHash
      })
    ).rejects.toMatchObject({
      code: "AMOUNT_MISMATCH"
    });
    await expect(
      service.settleSession({
        sessionId: session.id,
        amount: "0.01",
        usageHash: "0".repeat(64)
      })
    ).rejects.toMatchObject({
      code: "INVALID_PAYMENT_PAYLOAD"
    });
    await expect(
      service.settleSession({
        sessionId: session.id,
        amount: "0.01",
        usageHash,
        currentLedger: 50
      })
    ).rejects.toMatchObject({
      code: "AUTH_EXPIRED"
    });
  });

  it("preserves sessions and settlements across service restarts", async () => {
    const store = new InMemoryPaymentSessionStore();
    const client: GeneratedUptoSessionClient = {
      create_session: vi.fn(async () => "contract_session_restart_1"),
      settle: vi.fn(async () => ({ transactionHash: "tx_restart_1", ledger: 101 }))
    };
    const bindings = createGeneratedUptoSessionBindings(() => client);

    const service1 = new PaymentSessionService(enabledConfig(), { store, bindings });
    const session = await service1.createSession(sessionRequest());
    const settled = await service1.settleSession({
      sessionId: session.id,
      amount: "0.40",
      usageHash
    });

    // Simulate restart with a new service instance backed by the same store
    const service2 = new PaymentSessionService(enabledConfig(), { store, bindings });
    const loadedSession = await service2.getSession(session.id);

    expect(loadedSession).toMatchObject({
      id: session.id,
      status: "settled",
      spentAmount: "0.4",
      remainingAmount: "0.6",
      contractSessionId: "contract_session_restart_1",
      transactionHash: "tx_restart_1",
      ledger: 101
    });

    const loadedSettlement = await service2.getSettlement(session.id);
    expect(loadedSettlement).toMatchObject({
      sessionId: session.id,
      amount: "0.4",
      transactionHash: "tx_restart_1",
      ledger: 101,
      status: "settled"
    });
    expect(loadedSettlement.id).toBe(settled.settlementId);
  });

  it("correlates on-chain contractSessionId and transactionHash with local records", async () => {
    const store = new InMemoryPaymentSessionStore();
    const client: GeneratedUptoSessionClient = {
      create_session: vi.fn(async () => "contract_session_correlate_1"),
      settle: vi.fn(async () => ({ transactionHash: "tx_correlate_evidence_1", ledger: 202 }))
    };
    const service = new PaymentSessionService(enabledConfig(), {
      bindings: createGeneratedUptoSessionBindings(() => client),
      store
    });

    const session = await service.createSession(sessionRequest());
    const settled = await service.settleSession({
      sessionId: session.id,
      amount: "0.50",
      usageHash
    });

    // Lookup session by on-chain contractSessionId
    const byContract = await service.getSession(session.contractSessionId);
    expect(byContract.id).toBe(session.id);
    expect(byContract.contractSessionId).toBe("contract_session_correlate_1");

    // Lookup settlement by on-chain transactionHash
    const byTxHash = await service.getSettlementByTransactionHash(settled.transactionHash);
    expect(byTxHash.sessionId).toBe(session.id);
    expect(byTxHash.amount).toBe("0.5");
    expect(byTxHash.ledger).toBe(202);
  });

  it("handles concurrent settle attempts idempotently", async () => {
    const store = new InMemoryPaymentSessionStore();
    let settleInvocationCount = 0;
    const client: GeneratedUptoSessionClient = {
      create_session: vi.fn(async () => "contract_session_concurrent_1"),
      settle: vi.fn(async () => {
        settleInvocationCount += 1;
        await new Promise((resolve) => setTimeout(resolve, 30));
        return { transactionHash: "tx_concurrent_1", ledger: 303 };
      })
    };
    const service = new PaymentSessionService(enabledConfig(), {
      bindings: createGeneratedUptoSessionBindings(() => client),
      store
    });

    const session = await service.createSession(sessionRequest());

    // Execute 3 concurrent settle requests with identical amount and usageHash
    const [result1, result2, result3] = await Promise.all([
      service.settleSession({ sessionId: session.id, amount: "0.50", usageHash }),
      service.settleSession({ sessionId: session.id, amount: "0.50", usageHash }),
      service.settleSession({ sessionId: session.id, amount: "0.50", usageHash })
    ]);

    expect(settleInvocationCount).toBe(1);
    expect(result1.settlementId).toBe(result2.settlementId);
    expect(result2.settlementId).toBe(result3.settlementId);
    expect(result1.transactionHash).toBe("tx_concurrent_1");
    expect(result1.status).toBe("settled");

    // Sequential idempotent retry
    const retry = await service.settleSession({
      sessionId: session.id,
      amount: "0.50",
      usageHash
    });
    expect(retry.settlementId).toBe(result1.settlementId);

    // Replay with differing usageHash throws REPLAY_DETECTED
    await expect(
      service.settleSession({
        sessionId: session.id,
        amount: "0.50",
        usageHash: "f".repeat(64)
      })
    ).rejects.toMatchObject({
      code: "REPLAY_DETECTED"
    });

    // Replay with differing amount throws REPLAY_DETECTED
    await expect(
      service.settleSession({
        sessionId: session.id,
        amount: "0.25",
        usageHash
      })
    ).rejects.toMatchObject({
      code: "REPLAY_DETECTED"
    });
  });

  it("reconciles session when on-chain contract is settled but local store is open", async () => {
    const store = new InMemoryPaymentSessionStore();
    const service = new PaymentSessionService(enabledConfig(), {
      bindings: {
        createSession: async () => ({
          contractSessionId: "contract_session_disagree_1",
          ledger: null,
          transactionHash: null
        }),
        settleSession: async () => ({
          ledger: 10,
          transactionHash: "tx_disagree_1"
        }),
        getSessionState: async () => ({
          status: "settled",
          ledger: 500,
          transactionHash: "tx_onchain_settled_500"
        })
      },
      store
    });

    const session = await service.createSession(sessionRequest());
    expect(session.status).toBe("open");

    const reconciled = await service.reconcileSession(session.id);
    expect(reconciled.status).toBe("settled");
    expect(reconciled.transactionHash).toBe("tx_onchain_settled_500");
    expect(reconciled.ledger).toBe(500);

    const settlement = await service.getSettlement(session.id);
    expect(settlement.transactionHash).toBe("tx_onchain_settled_500");
    expect(settlement.ledger).toBe(500);
  });

  it("reconciles session when local store is left settling but on-chain contract is open", async () => {
    const store = new InMemoryPaymentSessionStore();
    let contractSessionState: "open" | "settled" = "open";
    const service = new PaymentSessionService(enabledConfig(), {
      bindings: {
        createSession: async () => ({
          contractSessionId: "contract_session_revert_1",
          ledger: null,
          transactionHash: null
        }),
        settleSession: async () => {
          contractSessionState = "settled";
          return { ledger: 601, transactionHash: "tx_revert_settle_1" };
        },
        getSessionState: async () => ({
          status: contractSessionState
        })
      },
      store
    });

    const session = await service.createSession(sessionRequest());
    // Simulate crashed intermediate state where session was claimed into "settling"
    await store.claimSessionForSettlement(session.id);
    const claimedSession = await service.getSession(session.id);
    expect(claimedSession.status).toBe("settling");

    // Reconcile sees on-chain is still "open" and recovers local store back to "open"
    const reconciled = await service.reconcileSession(session.id);
    expect(reconciled.status).toBe("open");

    // Now settling succeeds normally
    const settled = await service.settleSession({
      sessionId: session.id,
      amount: "0.20",
      usageHash
    });
    expect(settled.status).toBe("settled");
    expect(settled.transactionHash).toBe("tx_revert_settle_1");
  });

  describe("PrismaPaymentSessionStore", () => {
    it("maps database rows with Decimal amounts and Date timestamps correctly", async () => {
      const now = new Date("2026-10-20T12:00:00.000Z");
      const mockSessionRow = {
        id: "session_mock_1",
        resourceId: "resource_mock_1",
        sellerId: "seller_mock_1",
        network: "stellar:testnet",
        buyer: localIssuerPublicKey,
        payTo: localIssuerPublicKey,
        assetCode: "USDC",
        assetIssuer: localIssuerPublicKey,
        assetContractId,
        capAmount: { toString: () => "5.0000000" },
        spentAmount: { toString: () => "1.0000000" },
        remainingAmount: { toString: () => "4.0000000" },
        contractId,
        contractSessionId: "contract_session_mock_1",
        resourceHash: "c".repeat(64),
        expiresAtLedger: 100,
        status: "open",
        transactionHash: "tx_mock_create",
        ledger: 42,
        usageHash: null,
        createdAt: now,
        updatedAt: now
      };

      const mockSettlementRow = {
        id: "settlement_mock_1",
        sessionId: "session_mock_1",
        network: "stellar:testnet",
        amount: { toString: () => "1.0000000" },
        transactionHash: "tx_mock_settle",
        ledger: 45,
        usageHash: usageHash,
        status: "settled",
        settledAt: now,
        createdAt: now
      };

      const mockDb: PaymentSessionDatabaseClient = {
        paymentSession: {
          create: vi.fn(async () => mockSessionRow),
          findUnique: vi.fn(
            async ({ where }: { where: { id?: string; contractSessionId?: string } }) => {
              if (
                where.id === "session_mock_1" ||
                where.contractSessionId === "contract_session_mock_1"
              ) {
                return mockSessionRow;
              }
              return null;
            }
          ),
          updateMany: vi.fn(async () => ({ count: 1 })),
          update: vi.fn(async () => mockSessionRow)
        } as unknown as PaymentSessionDatabaseClient["paymentSession"],
        uptoSessionSettlement: {
          create: vi.fn(async () => mockSettlementRow),
          findFirst: vi.fn(async () => mockSettlementRow),
          findUnique: vi.fn(async () => mockSettlementRow)
        } as unknown as PaymentSessionDatabaseClient["uptoSessionSettlement"]
      };

      const store = new PrismaPaymentSessionStore(mockDb);

      const session = await store.createSession({
        assetCode: "USDC",
        assetContractId,
        assetIssuer: localIssuerPublicKey,
        buyer: localIssuerPublicKey,
        capAmount: "5.0000000",
        contractId,
        contractSessionId: "contract_session_mock_1",
        expiresAtLedger: 100,
        ledger: 42,
        network: "stellar:testnet",
        payTo: localIssuerPublicKey,
        remainingAmount: "4.0000000",
        resourceHash: "c".repeat(64),
        resourceId: "resource_mock_1",
        sellerId: "seller_mock_1",
        spentAmount: "1.0000000",
        status: "open",
        transactionHash: "tx_mock_create",
        usageHash: null
      });

      expect(session.id).toBe("session_mock_1");
      expect(session.capAmount).toBe("5.0000000");
      expect(session.createdAt).toBe("2026-10-20T12:00:00.000Z");

      const sessionByContract =
        await store.getSessionByContractSessionId("contract_session_mock_1");
      expect(sessionByContract?.id).toBe("session_mock_1");

      const settlement = await store.createSettlement({
        amount: "1.0000000",
        ledger: 45,
        network: "stellar:testnet",
        sessionId: "session_mock_1",
        settledAt: "2026-10-20T12:00:00.000Z",
        status: "settled",
        transactionHash: "tx_mock_settle",
        usageHash: usageHash
      });

      expect(settlement.amount).toBe("1.0000000");
      expect(settlement.settledAt).toBe("2026-10-20T12:00:00.000Z");

      const byTxHash = await store.getSettlementByTransactionHash("tx_mock_settle");
      expect(byTxHash?.id).toBe("settlement_mock_1");

      const claimed = await store.claimSessionForSettlement("session_mock_1");
      expect(claimed?.id).toBe("session_mock_1");
    });

    it("translates Prisma unique constraint violation (P2002) to REPLAY_DETECTED", async () => {
      const mockDb: PaymentSessionDatabaseClient = {
        paymentSession: {
          create: vi.fn(async () => {
            throw new Prisma.PrismaClientKnownRequestError("Unique constraint failed", {
              code: "P2002",
              clientVersion: "6.0.0"
            });
          })
        } as unknown as PaymentSessionDatabaseClient["paymentSession"],
        uptoSessionSettlement:
          {} as unknown as PaymentSessionDatabaseClient["uptoSessionSettlement"]
      };

      const store = new PrismaPaymentSessionStore(mockDb);

      await expect(
        store.createSession({
          assetCode: "USDC",
          assetContractId,
          assetIssuer: localIssuerPublicKey,
          buyer: localIssuerPublicKey,
          capAmount: "5.0000000",
          contractId,
          contractSessionId: "duplicate_contract_session",
          expiresAtLedger: 100,
          ledger: 42,
          network: "stellar:testnet",
          payTo: localIssuerPublicKey,
          remainingAmount: "4.0000000",
          resourceHash: "c".repeat(64),
          resourceId: null,
          sellerId: null,
          spentAmount: "1.0000000",
          status: "open",
          transactionHash: null,
          usageHash: null
        })
      ).rejects.toMatchObject({
        code: "REPLAY_DETECTED"
      });
    });
  });
});

function enabledConfig() {
  return loadConfig({
    ENABLE_UPTO_SCHEME: "true",
    STELLAR_TESTNET_UPTO_SESSION_CONTRACT_ID: contractId,
    STELLAR_TESTNET_USDC_CONTRACT_ID: assetContractId,
    STELLAR_TESTNET_USDC_ISSUER: localIssuerPublicKey
  });
}

function sessionRequest() {
  return {
    scheme: "upto",
    network: "stellar:testnet",
    buyer: localIssuerPublicKey,
    asset: {
      code: "USDC",
      issuer: localIssuerPublicKey
    },
    capAmount: "1.00",
    payTo: localIssuerPublicKey,
    resourceId: "resource_upto_1",
    sellerId: "seller_upto_1",
    expiresAtLedger: 50,
    currentLedger: 25
  };
}
