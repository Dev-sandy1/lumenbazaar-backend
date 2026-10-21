import { createHash } from "node:crypto";

import { type NetworkId } from "@lumenbazaar/shared";

export type UptoContractCreateSessionInput = {
  assetContractId: string;
  buyer: string;
  contractId: string;
  expiresAtLedger: number;
  maxAmountStroops: bigint;
  network: NetworkId;
  resourceHash: string;
  seller: string;
};

export type UptoContractCreateSessionResult = {
  contractSessionId: string;
  ledger: number | null;
  transactionHash: string | null;
};

export type UptoContractSettleSessionInput = {
  actualAmountStroops: bigint;
  contractId: string;
  contractSessionId: string;
  network: NetworkId;
  usageHash: string;
};

export type UptoContractSettleSessionResult = {
  ledger: number;
  transactionHash: string;
};

export type UptoSessionContractBindings = {
  createSession: (
    input: UptoContractCreateSessionInput
  ) => Promise<UptoContractCreateSessionResult>;
  settleSession: (
    input: UptoContractSettleSessionInput
  ) => Promise<UptoContractSettleSessionResult>;
  getSessionState?: (
    contractId: string,
    contractSessionId: string
  ) => Promise<
    | {
        status: "open" | "settled" | "expired";
        ledger?: number;
        transactionHash?: string;
      }
    | undefined
  >;
};

export type GeneratedUptoSessionClient = {
  create_session: (
    buyer: string,
    seller: string,
    asset: string,
    maxAmount: bigint,
    expiresAtLedger: number,
    resourceHash: string
  ) => Promise<string> | string;
  settle: (
    sessionId: string,
    actualAmount: bigint,
    usageHash: string
  ) =>
    | Promise<{ ledger?: number; transactionHash?: string } | void>
    | { ledger?: number; transactionHash?: string }
    | void;
};

export type GeneratedUptoSessionClientFactory = (
  network: NetworkId,
  contractId: string
) => GeneratedUptoSessionClient;

export function createGeneratedUptoSessionBindings(
  clientFactory: GeneratedUptoSessionClientFactory
): UptoSessionContractBindings {
  return {
    async createSession(input) {
      const client = clientFactory(input.network, input.contractId);
      const contractSessionId = await client.create_session(
        input.buyer,
        input.seller,
        input.assetContractId,
        input.maxAmountStroops,
        input.expiresAtLedger,
        input.resourceHash
      );

      return {
        contractSessionId,
        ledger: null,
        transactionHash: null
      };
    },
    async settleSession(input) {
      const client = clientFactory(input.network, input.contractId);
      const result = await client.settle(
        input.contractSessionId,
        input.actualAmountStroops,
        input.usageHash
      );

      if (
        result === undefined ||
        result.ledger === undefined ||
        result.transactionHash === undefined
      ) {
        throw new Error(
          "Generated upto-session client did not return transaction hash and ledger evidence."
        );
      }

      return {
        ledger: result.ledger,
        transactionHash: result.transactionHash
      };
    }
  };
}

export function createLocalUptoSessionContractBindings(): UptoSessionContractBindings {
  const settledSessions = new Map<string, { ledger: number; transactionHash: string }>();

  return {
    async createSession(input) {
      return {
        contractSessionId: digest([
          input.network,
          input.contractId,
          input.buyer,
          input.seller,
          input.assetContractId,
          input.maxAmountStroops.toString(),
          input.expiresAtLedger.toString(),
          input.resourceHash
        ]),
        ledger: null,
        transactionHash: null
      };
    },
    async settleSession(input) {
      const txHash = contractTransactionHash(input.contractSessionId, input.usageHash);
      settledSessions.set(input.contractSessionId, { ledger: 1, transactionHash: txHash });
      return {
        ledger: 1,
        transactionHash: txHash
      };
    },
    async getSessionState(_contractId, contractSessionId) {
      const settled = settledSessions.get(contractSessionId);
      if (settled) {
        return {
          status: "settled",
          ledger: settled.ledger,
          transactionHash: settled.transactionHash
        };
      }
      return { status: "open" };
    }
  };
}

function contractTransactionHash(contractSessionId: string, usageHash: string) {
  return `upto_${digest([contractSessionId, usageHash]).slice(0, 56)}`;
}

function digest(parts: string[]) {
  const hash = createHash("sha256");

  for (const part of parts) {
    hash.update(part);
    hash.update("\0");
  }

  return hash.digest("hex");
}
