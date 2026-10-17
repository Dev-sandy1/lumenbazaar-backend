import { createHash, randomUUID } from "node:crypto";

import { z } from "zod";

import {
  LumenError,
  listConfiguredNetworks,
  localIssuerPublicKey,
  type AppConfig,
  type JsonObject,
  type NetworkId
} from "@lumenbazaar/shared";
import {
  type PaymentSessionService,
  type PaymentVerificationService,
  type SettlementService
} from "@lumenbazaar/stellar-payments";

export type ConformanceCaseDefinition = {
  description: string;
  endpoint:
    | "/v1/supported"
    | "/v1/verify"
    | "/v1/settle"
    | "/v1/payment-sessions"
    | "/v1/payment-sessions/{sessionId}/settle";
  id: string;
  method: "GET" | "POST";
  name: string;
  network: NetworkId;
  reserved?: boolean;
  scheme: "exact" | "upto";
};

export type ConformanceCaseResult = ConformanceCaseDefinition & {
  details?: JsonObject;
  durationMs: number;
  error?: string;
  passed: boolean;
  status: "passed" | "failed" | "reserved";
};

export type ConformanceRunRecord = {
  completedAt: string;
  createdAt: string;
  exactResults: number;
  failedCount: number;
  id: string;
  network: NetworkId;
  passedCount: number;
  reservedCount: number;
  results: ConformanceCaseResult[];
  startedAt: string;
  status: "passed" | "failed";
  suite: "stellar-x402";
};

export type ConformanceCaseRunner = (
  definition: ConformanceCaseDefinition
) => Promise<JsonObject | void>;

export type ConformanceRunStore = {
  createRun: (
    input: Omit<ConformanceRunRecord, "id" | "createdAt">
  ) => Promise<ConformanceRunRecord>;
  getRun: (runId: string) => Promise<ConformanceRunRecord | undefined>;
  listRuns: (filters: ListConformanceRunsInput) => Promise<ConformanceRunRecord[]>;
};

export type ConformanceRunServiceOptions = {
  exactEnabled?: boolean;
  uptoEnabled?: boolean;
  /**
   * When provided, capabilities are read from the registry at run time rather
   * than from the static `exactEnabled` / `uptoEnabled` flags.  The registry
   * takes precedence: if it reports a scheme as unsupported, the corresponding
   * conformance cases are reserved regardless of the static flags.
   *
   * `exactEnabled` / `uptoEnabled` may still be used to further restrict
   * (never to expand) what the registry reports.
   */
  capabilityRegistry?: () => import("./capabilityRegistry.js").CapabilityRegistry;
};

export const runConformanceSchema = z.object({
  network: z.enum(["stellar:testnet", "stellar:pubnet"]).default("stellar:testnet"),
  includeReserved: z.boolean().default(true)
});

export const listConformanceRunsSchema = z.object({
  network: z.enum(["stellar:testnet", "stellar:pubnet"]).optional(),
  status: z.enum(["passed", "failed"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20)
});

export type RunConformanceInput = z.output<typeof runConformanceSchema>;
export type ListConformanceRunsInput = z.output<typeof listConformanceRunsSchema>;

export class InMemoryConformanceRunStore implements ConformanceRunStore {
  private readonly runs = new Map<string, ConformanceRunRecord>();

  async createRun(input: Omit<ConformanceRunRecord, "id" | "createdAt">) {
    const run: ConformanceRunRecord = {
      id: `conformance_run_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      ...input,
      createdAt: new Date().toISOString()
    };

    this.runs.set(run.id, run);
    return run;
  }

  async getRun(runId: string) {
    return this.runs.get(runId);
  }

  async listRuns(filters: ListConformanceRunsInput) {
    return [...this.runs.values()]
      .filter((run) => filters.network === undefined || run.network === filters.network)
      .filter((run) => filters.status === undefined || run.status === filters.status)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, filters.limit);
  }
}

export class ConformanceRunService {
  constructor(
    private readonly runner: ConformanceCaseRunner,
    private readonly store: ConformanceRunStore = new InMemoryConformanceRunStore(),
    private readonly options: ConformanceRunServiceOptions = {}
  ) {}

  async run(input: unknown) {
    const request = runConformanceSchema.parse(input ?? {});
    const startedAt = new Date().toISOString();

    // Determine enabled flags: prefer registry over static options when both
    // are available. The registry can only restrict, never expand, what the
    // static options say.
    let exactEnabled = this.options.exactEnabled !== false;
    let uptoEnabled = this.options.uptoEnabled === true;

    if (this.options.capabilityRegistry !== undefined) {
      const registry = this.options.capabilityRegistry();
      const registryExact = registry.isSupported("exact", request.network);
      const registryUpto = registry.isSupported("upto", request.network);
      // Registry takes precedence: if it says unavailable, override static.
      exactEnabled = exactEnabled && registryExact;
      uptoEnabled = uptoEnabled || registryUpto;
      // But registry can never *add* exact if static opts explicitly disable it.
      if (this.options.exactEnabled === false) exactEnabled = false;
    }

    const definitions = conformanceDefinitions(
      request.network,
      request.includeReserved,
      uptoEnabled,
      exactEnabled
    );
    const results: ConformanceCaseResult[] = [];

    for (const definition of definitions) {
      results.push(await this.runCase(definition));
    }

    const completedAt = new Date().toISOString();
    const failedCount = results.filter((result) => result.status === "failed").length;
    const passedCount = results.filter((result) => result.status === "passed").length;
    const reservedCount = results.filter((result) => result.status === "reserved").length;

    return this.store.createRun({
      completedAt,
      exactResults: results.filter((result) => result.scheme === "exact").length,
      failedCount,
      network: request.network,
      passedCount,
      reservedCount,
      results,
      startedAt,
      status: failedCount === 0 ? "passed" : "failed",
      suite: "stellar-x402"
    });
  }

  async list(input: unknown) {
    return this.store.listRuns(listConformanceRunsSchema.parse(input ?? {}));
  }

  async get(runId: string) {
    const run = await this.store.getRun(runId);

    if (run === undefined) {
      throw new LumenError("RESOURCE_NOT_FOUND", "Conformance run was not found.");
    }

    return run;
  }

  getDefinitions(network: NetworkId = "stellar:testnet") {
    let exactEnabled = this.options.exactEnabled !== false;
    let uptoEnabled = this.options.uptoEnabled === true;

    if (this.options.capabilityRegistry !== undefined) {
      const registry = this.options.capabilityRegistry();
      const registryExact = registry.isSupported("exact", network);
      const registryUpto = registry.isSupported("upto", network);
      exactEnabled = exactEnabled && registryExact;
      uptoEnabled = uptoEnabled || registryUpto;
      if (this.options.exactEnabled === false) exactEnabled = false;
    }

    return conformanceDefinitions(
      network,
      true,
      uptoEnabled,
      exactEnabled
    );
  }

  private async runCase(definition: ConformanceCaseDefinition): Promise<ConformanceCaseResult> {
    const startedAt = Date.now();

    if (definition.reserved === true) {
      return {
        ...definition,
        durationMs: 0,
        passed: false,
        status: "reserved"
      };
    }

    try {
      const details = await this.runner(definition);
      return {
        ...definition,
        ...(details === undefined ? {} : { details }),
        durationMs: Date.now() - startedAt,
        passed: true,
        status: "passed"
      };
    } catch (error) {
      return {
        ...definition,
        durationMs: Date.now() - startedAt,
        error: error instanceof Error ? error.message : String(error),
        passed: false,
        status: "failed"
      };
    }
  }
}

export function conformanceDefinitions(
  network: NetworkId,
  includeReserved: boolean,
  uptoEnabled = false,
  exactEnabled = true
): ConformanceCaseDefinition[] {
  const exact: ConformanceCaseDefinition[] = [
    {
      id: "exact-supported",
      name: "GET /v1/supported returns exact scheme",
      description: "Checks that the facilitator advertises exact Stellar x402 support.",
      endpoint: "/v1/supported",
      method: "GET",
      network,
      scheme: "exact",
      ...(exactEnabled ? {} : { reserved: true })
    },
    {
      id: "exact-verify",
      name: "POST /v1/verify accepts exact payment",
      description: "Checks that exact payment payloads are accepted by verification.",
      endpoint: "/v1/verify",
      method: "POST",
      network,
      scheme: "exact",
      ...(exactEnabled ? {} : { reserved: true })
    },
    {
      id: "exact-settle",
      name: "POST /v1/settle processes exact payment",
      description: "Checks that a verified exact payment can be settled.",
      endpoint: "/v1/settle",
      method: "POST",
      network,
      scheme: "exact",
      ...(exactEnabled ? {} : { reserved: true })
    }
  ];
  const upto: ConformanceCaseDefinition[] = [
    {
      id: "upto-supported",
      name: "GET /v1/supported advertises upto readiness",
      description: uptoEnabled
        ? "Checks that the facilitator advertises deployed capped session support."
        : "Reserved until capped session contracts are deployed.",
      endpoint: "/v1/supported",
      method: "GET",
      network,
      ...(uptoEnabled ? {} : { reserved: true }),
      scheme: "upto"
    },
    {
      id: "upto-session-create",
      name: "POST /v1/payment-sessions creates upto session",
      description: uptoEnabled
        ? "Checks that capped session creation returns a contract-backed session."
        : "Reserved until backend session APIs are enabled.",
      endpoint: "/v1/payment-sessions",
      method: "POST",
      network,
      ...(uptoEnabled ? {} : { reserved: true }),
      scheme: "upto"
    },
    {
      id: "upto-settle",
      name: "POST /v1/payment-sessions/{sessionId}/settle processes upto draw",
      description: uptoEnabled
        ? "Checks that capped session settlement succeeds without the exact route."
        : "Reserved until capped settlement validation is enabled.",
      endpoint: "/v1/payment-sessions/{sessionId}/settle",
      method: "POST",
      network,
      ...(uptoEnabled ? {} : { reserved: true }),
      scheme: "upto"
    }
  ];

  const definitions = [...exact, ...upto];
  return includeReserved
    ? definitions
    : definitions.filter((definition) => definition.reserved !== true);
}

export function createServiceConformanceRunner(
  config: AppConfig,
  verificationService: PaymentVerificationService,
  settlementService: SettlementService,
  paymentSessionService?: PaymentSessionService
): ConformanceCaseRunner {
  return async (definition) => {
    switch (definition.id) {
      case "exact-supported":
        return assertSupported(config, definition.network);
      case "exact-verify":
        return assertVerify(config, verificationService, definition);
      case "exact-settle":
        return assertSettle(config, verificationService, settlementService, definition);
      case "upto-supported":
        return assertUptoSupported(config, definition.network);
      case "upto-session-create":
        return assertUptoSessionCreate(
          config,
          requirePaymentSessionService(paymentSessionService),
          definition
        );
      case "upto-settle":
        return assertUptoSettle(
          config,
          requirePaymentSessionService(paymentSessionService),
          definition
        );
      default:
        throw new Error(`No runner registered for ${definition.id}`);
    }
  };
}

async function assertSupported(config: AppConfig, network: NetworkId): Promise<JsonObject> {
  const match = listConfiguredNetworks(config).find((candidate) => candidate.id === network);

  if (match === undefined) {
    throw new Error(`Exact scheme was not advertised for ${network}`);
  }

  return {
    advertised: true,
    network,
    assetCount: match.assets.length,
    x402Version: "2"
  };
}

async function assertVerify(
  config: AppConfig,
  verificationService: PaymentVerificationService,
  definition: ConformanceCaseDefinition
): Promise<JsonObject> {
  const payload = exactPaymentRequest(config, definition.network, definition.id);
  const verified = await verificationService.verify(payload);

  if (verified.status !== "verified") {
    throw new Error("/v1/verify did not return a verified payment attempt");
  }

  return {
    paymentAttemptId: verified.paymentAttemptId,
    status: verified.status
  };
}

async function assertSettle(
  config: AppConfig,
  verificationService: PaymentVerificationService,
  settlementService: SettlementService,
  definition: ConformanceCaseDefinition
): Promise<JsonObject> {
  const payload = exactPaymentRequest(config, definition.network, definition.id);
  await verificationService.verify(payload);
  const settled = await settlementService.settle(payload);

  if (settled.status !== "confirmed") {
    throw new Error("/v1/settle did not return a confirmed receipt");
  }

  return {
    receiptId: settled.receiptId,
    settlementId: settled.settlementId,
    status: settled.status
  };
}

async function assertUptoSupported(config: AppConfig, network: NetworkId): Promise<JsonObject> {
  const networkConfig = config.networks[network];
  const asset = networkConfig.assets.find((candidate) => candidate.contractId !== undefined);

  if (!config.features.uptoScheme || networkConfig.uptoSessionContractId === undefined) {
    throw new Error(`Upto scheme was not advertised for ${network}`);
  }

  if (asset?.contractId === undefined) {
    throw new Error(`No capped-session asset contract was configured for ${network}`);
  }

  return {
    advertised: true,
    network,
    assetContractId: asset.contractId,
    contractId: networkConfig.uptoSessionContractId
  };
}

async function assertUptoSessionCreate(
  config: AppConfig,
  paymentSessionService: PaymentSessionService,
  definition: ConformanceCaseDefinition
): Promise<JsonObject> {
  const session = await paymentSessionService.createSession(
    uptoPaymentSessionRequest(config, definition.network, definition.id)
  );

  if (session.status !== "open") {
    throw new Error("/v1/payment-sessions did not return an open capped session");
  }

  return {
    contractSessionId: session.contractSessionId,
    sessionId: session.id,
    status: session.status
  };
}

async function assertUptoSettle(
  config: AppConfig,
  paymentSessionService: PaymentSessionService,
  definition: ConformanceCaseDefinition
): Promise<JsonObject> {
  const session = await paymentSessionService.createSession(
    uptoPaymentSessionRequest(config, definition.network, definition.id)
  );
  const settled = await paymentSessionService.settleSession({
    sessionId: session.id,
    amount: "0.005",
    usageHash: digest(`upto-settle:${session.id}`),
    currentLedger: 10
  });

  if (settled.status !== "settled") {
    throw new Error("/v1/payment-sessions/{sessionId}/settle did not settle the session");
  }

  return {
    remainingAmount: settled.remainingAmount,
    sessionId: settled.id,
    settlementId: settled.settlementId,
    status: settled.status
  };
}

function requirePaymentSessionService(
  paymentSessionService: PaymentSessionService | undefined
): PaymentSessionService {
  if (paymentSessionService === undefined) {
    throw new Error("Payment session service is not configured");
  }

  return paymentSessionService;
}

function exactPaymentRequest(config: AppConfig, network: NetworkId, seed: string) {
  const asset = config.networks[network].assets[0];

  if (asset?.contractId === undefined) {
    throw new Error(`No configured SEP-41 asset contract for ${network}`);
  }

  const paymentRequirements = {
    scheme: "exact" as const,
    network,
    asset: asset.contractId,
    amount: "100000",
    payTo: config.facilitatorAccount || localIssuerPublicKey,
    maxTimeoutSeconds: 60,
    extra: {
      assetCode: asset.code,
      assetIssuer: asset.issuer
    }
  };

  return {
    x402Version: 2 as const,
    paymentPayload: {
      x402Version: 2 as const,
      accepted: paymentRequirements,
      payload: {
        transaction: Buffer.from(
          `conformance:${seed}:${Date.now()}:${Math.random().toString(36).slice(2)}`
        ).toString("base64")
      }
    },
    paymentRequirements
  };
}

function uptoPaymentSessionRequest(config: AppConfig, network: NetworkId, seed: string) {
  const asset = config.networks[network].assets[0];

  if (asset === undefined) {
    throw new Error(`No configured asset for ${network}`);
  }

  return {
    scheme: "upto" as const,
    network,
    buyer: localIssuerPublicKey,
    asset: {
      code: asset.code,
      issuer: asset.issuer
    },
    capAmount: "0.01",
    payTo: config.facilitatorAccount || localIssuerPublicKey,
    expiresAtLedger: 20,
    currentLedger: 10,
    resourceId: `conformance_${seed}_${Date.now()}_${Math.random().toString(36).slice(2)}`
  };
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
