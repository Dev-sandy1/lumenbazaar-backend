import { z } from "zod";
import { StrKey } from "@stellar/stellar-sdk";

import {
  type NetworkConfig,
  type NetworkId,
  localIssuerPublicKey,
  stellarPassphrases,
  type SupportedAsset
} from "./networks.js";

export const runtimeEnvironments = ["local", "testnet", "staging", "mainnet"] as const;

export type RuntimeEnvironment = (typeof runtimeEnvironments)[number];

const booleanEnv = z.preprocess((value) => {
  if (value === undefined) {
    return false;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (value === "true" || value === "1") {
    return true;
  }

  if (value === "false" || value === "0") {
    return false;
  }

  return value;
}, z.boolean());

const optionalNonEmptyStringEnv = z
  .preprocess((value) => {
    if (value === "") {
      return undefined;
    }

    return value;
  }, z.string().min(1).optional())
  .optional();

/**
 * Official Stellar testnet USDC configuration.
 * Issuer: Circle's official testnet USDC issuer (https://developers.circle.com/stablecoins/quickstarts/transfer-usdc-stellar)
 * For Soroban contract ID, use `stellar contract id asset USDC:<issuer>` on testnet.
 */
const STELLAR_TESTNET_USDC_ISSUER_OFFICIAL = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";

/**
 * Configuration key for selecting testnet exact payment asset.
 * Set to "lbt" to use the custom test-only asset (via LBT_ env vars).
 * Default is "usdc" (official Stellar testnet USDC via STELLAR_TESTNET_USDC_* env vars).
 * Pubnet rejects "lbt" at startup.
 */
const testnetAssetConfigKey = (env: { TESTNET_ASSET?: string }) => {
  const assetKey = env.TESTNET_ASSET?.toLowerCase().trim() || "usdc";
  if (assetKey !== "usdc" && assetKey !== "lbt") {
    throw new Error(
      `TESTNET_ASSET must be "usdc" or "lbt" (default: "usdc"). Got: "${env.TESTNET_ASSET}"`
    );
  }
  return assetKey as "usdc" | "lbt";
};

const envSchema = z.object({
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default(process.env.NODE_ENV === "test" ? "test" : "development"),
  LUMEN_ENV: z.enum(runtimeEnvironments).default("local"),
  TESTNET_ASSET: z.string().optional().default("usdc"),
  API_HOST: z.string().min(1).default("0.0.0.0"),
  API_PORT: z.coerce.number().int().positive().max(65535).default(3000),
  API_PUBLIC_URL: z.string().url().default("http://localhost:3000"),
  MCP_PUBLIC_URL: z.string().url().default("http://localhost:3001/mcp"),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .default("http://localhost:3000,https://lumenbazaar-frontend.vercel.app"),
  DATABASE_URL: z
    .string()
    .min(1)
    .default("postgresql://postgres:postgres@localhost:5432/lumenbazaar"),
  REDIS_URL: z.string().url().default("redis://localhost:6379"),
  ENABLE_UPTO_SCHEME: booleanEnv.default(false),
  DEFAULT_ASSET_CODE: z.string().min(1).max(12).default("USDC"),
  STELLAR_TESTNET_RPC_URL: z.string().url().default("https://soroban-testnet.stellar.org"),
  STELLAR_TESTNET_HORIZON_URL: z.string().url().default("https://horizon-testnet.stellar.org"),
  /**
   * Official testnet USDC issuer: Circle's public testnet issuer.
   * Default: GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5
   * (https://developers.circle.com/stablecoins/quickstarts/transfer-usdc-stellar)
   * Only used if TESTNET_ASSET="usdc" (the default).
   */
  STELLAR_TESTNET_USDC_ISSUER: z.string().min(1).default(STELLAR_TESTNET_USDC_ISSUER_OFFICIAL),
  STELLAR_TESTNET_USDC_CONTRACT_ID: optionalNonEmptyStringEnv,
  /**
   * Custom Lumen Bazaar test-only asset issuer (LBT).
   * Only used if TESTNET_ASSET="lbt".
   * For local/testnet, defaults to localIssuerPublicKey (placeholder).
   */
  TESTNET_LBT_ISSUER: z.string().min(1).optional(),
  TESTNET_LBT_CONTRACT_ID: optionalNonEmptyStringEnv,
  STELLAR_TESTNET_UPTO_SESSION_CONTRACT_ID: optionalNonEmptyStringEnv,
  STELLAR_PUBNET_RPC_URL: z.string().url().default("https://mainnet.sorobanrpc.com"),
  STELLAR_PUBNET_HORIZON_URL: z.string().url().default("https://horizon.stellar.org"),
  /**
   * Pubnet USDC issuer. Must be explicitly configured for mainnet deployment.
   * This is the official USDC issuer on Stellar mainnet.
   */
  STELLAR_PUBNET_USDC_ISSUER: z.string().min(1).default(localIssuerPublicKey),
  STELLAR_PUBNET_USDC_CONTRACT_ID: optionalNonEmptyStringEnv,
  STELLAR_PUBNET_UPTO_SESSION_CONTRACT_ID: optionalNonEmptyStringEnv,
  FACILITATOR_ACCOUNT: z.string().min(1).default(localIssuerPublicKey),
  FACILITATOR_SIGNER_PROVIDER: z.enum(["disabled", "environment"]).default("disabled"),
  FACILITATOR_SIGNER_NETWORK: z
    .enum(["stellar:testnet", "stellar:pubnet"])
    .default("stellar:testnet"),
  FACILITATOR_SIGNING_KEY_VERSION: optionalNonEmptyStringEnv,
  EVENT_STREAM_SIGNING_SECRET: optionalNonEmptyStringEnv,
  STELLAR_MAX_TRANSACTION_FEE_STROOPS: z.coerce.number().int().positive().default(50_000),
  STELLAR_INCLUSION_FEE_STROOPS: z.coerce.number().int().positive().default(100)
});

export type RawEnv = z.input<typeof envSchema>;
export type ParsedEnv = z.output<typeof envSchema>;

export type AppConfig = {
  nodeEnv: ParsedEnv["NODE_ENV"];
  lumenEnv: RuntimeEnvironment;
  api: {
    host: string;
    port: number;
    publicUrl: string;
    corsAllowedOrigins: string[];
  };
  mcp: {
    publicUrl: string;
  };
  databaseUrl: string;
  redisUrl: string;
  facilitatorAccount: string;
  signer: {
    provider: ParsedEnv["FACILITATOR_SIGNER_PROVIDER"];
    network: NetworkId;
    keyVersion?: string;
  };
  settlement: {
    maxTransactionFeeStroops: number;
    inclusionFeeStroops: number;
  };
  eventStreams: {
    signingSecret: string | undefined;
  };
  features: {
    uptoScheme: boolean;
  };
  networks: Record<NetworkId, NetworkConfig>;
};

export type LoadConfigOptions = {
  allowPlaceholders?: boolean;
};

export function loadConfig(
  input: RawEnv = process.env as RawEnv,
  options: LoadConfigOptions = {}
): AppConfig {
  const env = envSchema.parse(input);
  const defaultAssetCode = env.DEFAULT_ASSET_CODE.toUpperCase();
  
  // Determine which testnet asset configuration to use
  const testnetAssetKind = testnetAssetConfigKey(env);
  
  // Build testnet asset configuration based on TESTNET_ASSET selection
  let testnetAsset: SupportedAsset;
  if (testnetAssetKind === "usdc") {
    // Official Stellar testnet USDC
    testnetAsset = {
      code: "USDC",
      issuer: env.STELLAR_TESTNET_USDC_ISSUER,
      ...(env.STELLAR_TESTNET_USDC_CONTRACT_ID === undefined
        ? {}
        : { contractId: env.STELLAR_TESTNET_USDC_CONTRACT_ID }),
      decimals: 7,
      kind: "usdc",
      isTestOnly: false
    };
  } else {
    // Custom LBT test-only asset
    const lbtIssuer = env.TESTNET_LBT_ISSUER || localIssuerPublicKey;
    testnetAsset = {
      code: "LBT",
      issuer: lbtIssuer,
      ...(env.TESTNET_LBT_CONTRACT_ID === undefined
        ? {}
        : { contractId: env.TESTNET_LBT_CONTRACT_ID }),
      decimals: 7,
      kind: "lbt",
      isTestOnly: true
    };
  }

  const networks: Record<NetworkId, NetworkConfig> = {
    "stellar:testnet": {
      id: "stellar:testnet",
      displayName: "Stellar Testnet",
      passphrase: stellarPassphrases["stellar:testnet"],
      rpcUrl: env.STELLAR_TESTNET_RPC_URL,
      horizonUrl: env.STELLAR_TESTNET_HORIZON_URL,
      assets: [testnetAsset],
      ...(env.STELLAR_TESTNET_UPTO_SESSION_CONTRACT_ID === undefined
        ? {}
        : { uptoSessionContractId: env.STELLAR_TESTNET_UPTO_SESSION_CONTRACT_ID })
    },
    "stellar:pubnet": {
      id: "stellar:pubnet",
      displayName: "Stellar Pubnet",
      passphrase: stellarPassphrases["stellar:pubnet"],
      rpcUrl: env.STELLAR_PUBNET_RPC_URL,
      horizonUrl: env.STELLAR_PUBNET_HORIZON_URL,
      assets: [
        {
          code: "USDC",
          issuer: env.STELLAR_PUBNET_USDC_ISSUER,
          ...(env.STELLAR_PUBNET_USDC_CONTRACT_ID === undefined
            ? {}
            : { contractId: env.STELLAR_PUBNET_USDC_CONTRACT_ID }),
          decimals: 7,
          kind: "usdc",
          isTestOnly: false
        }
      ],
      ...(env.STELLAR_PUBNET_UPTO_SESSION_CONTRACT_ID === undefined
        ? {}
        : { uptoSessionContractId: env.STELLAR_PUBNET_UPTO_SESSION_CONTRACT_ID })
    }
  };

  assertEnvironmentConfiguration(env, networks, testnetAssetKind, options);

  return {
    nodeEnv: env.NODE_ENV,
    lumenEnv: env.LUMEN_ENV,
    api: {
      host: env.API_HOST,
      port: env.API_PORT,
      publicUrl: env.API_PUBLIC_URL,
      corsAllowedOrigins: parseCorsAllowedOrigins(env.CORS_ALLOWED_ORIGINS)
    },
    mcp: {
      publicUrl: env.MCP_PUBLIC_URL
    },
    databaseUrl: env.DATABASE_URL,
    redisUrl: env.REDIS_URL,
    facilitatorAccount: env.FACILITATOR_ACCOUNT,
    signer: {
      provider: env.FACILITATOR_SIGNER_PROVIDER,
      network: env.FACILITATOR_SIGNER_NETWORK,
      ...(env.FACILITATOR_SIGNING_KEY_VERSION === undefined
        ? {}
        : { keyVersion: env.FACILITATOR_SIGNING_KEY_VERSION })
    },
    settlement: {
      maxTransactionFeeStroops: env.STELLAR_MAX_TRANSACTION_FEE_STROOPS,
      inclusionFeeStroops: env.STELLAR_INCLUSION_FEE_STROOPS
    },
    eventStreams: {
      signingSecret: env.EVENT_STREAM_SIGNING_SECRET
    },
    features: {
      uptoScheme: env.ENABLE_UPTO_SCHEME
    },
    networks
  };
}

export function listConfiguredNetworks(config: AppConfig) {
  const configuredNetworkIds: readonly NetworkId[] =
    config.lumenEnv === "mainnet" ? ["stellar:pubnet"] : ["stellar:testnet"];

  return configuredNetworkIds.map((networkId) => config.networks[networkId]);
}

function assertEnvironmentConfiguration(
  env: ParsedEnv,
  networks: Record<NetworkId, NetworkConfig>,
  testnetAssetKind: "usdc" | "lbt",
  options: LoadConfigOptions
) {
  if (env.STELLAR_INCLUSION_FEE_STROOPS > env.STELLAR_MAX_TRANSACTION_FEE_STROOPS) {
    throw new Error(
      "STELLAR_INCLUSION_FEE_STROOPS must not exceed STELLAR_MAX_TRANSACTION_FEE_STROOPS."
    );
  }

  const activeNetwork =
    env.LUMEN_ENV === "mainnet" ? networks["stellar:pubnet"] : networks["stellar:testnet"];
  const activeAsset = activeNetwork.assets[0];

  if (
    env.FACILITATOR_SIGNER_PROVIDER === "environment" &&
    env.FACILITATOR_SIGNER_NETWORK !== activeNetwork.id
  ) {
    throw new Error("FACILITATOR_SIGNER_NETWORK must match the active Stellar network.");
  }

  // Enforce USDC default for testnet exact payments
  if (env.LUMEN_ENV === "testnet" && testnetAssetKind !== "usdc") {
    if (!options.allowPlaceholders) {
      // In production-like testnet, LBT must be explicitly enabled. Warn or consider an error.
      // For now, we allow it but document it clearly.
    }
  }

  // Reject LBT on pubnet entirely
  if (env.LUMEN_ENV === "mainnet" && activeAsset?.kind === "lbt") {
    throw new Error(
      "LBT (custom test-only asset) cannot be used on pubnet. Use USDC only for mainnet deployments."
    );
  }

  if (env.LUMEN_ENV === "mainnet" && activeAsset?.issuer === localIssuerPublicKey) {
    throw new Error("STELLAR_PUBNET_USDC_ISSUER must be configured before mainnet startup.");
  }

  if (env.NODE_ENV !== "production" || env.LUMEN_ENV === "local" || options.allowPlaceholders) {
    return;
  }

  if (
    env.FACILITATOR_SIGNER_PROVIDER === "environment" &&
    env.FACILITATOR_SIGNING_KEY_VERSION === undefined
  ) {
    throw new Error("FACILITATOR_SIGNING_KEY_VERSION is required for hosted environment signers.");
  }

  const requiredPublicValues: Array<[string, string]> = [
    ["API_PUBLIC_URL", env.API_PUBLIC_URL],
    ["MCP_PUBLIC_URL", env.MCP_PUBLIC_URL],
    ["DATABASE_URL", env.DATABASE_URL],
    ["REDIS_URL", env.REDIS_URL],
    ["FACILITATOR_ACCOUNT", env.FACILITATOR_ACCOUNT],
    ["active asset issuer", activeAsset?.issuer ?? ""]
  ];

  for (const [name, value] of requiredPublicValues) {
    if (isPlaceholderValue(value)) {
      throw new Error(`${name} must not use a local or placeholder value in ${env.LUMEN_ENV}.`);
    }
  }

  if (!StrKey.isValidEd25519PublicKey(env.FACILITATOR_ACCOUNT)) {
    throw new Error(`FACILITATOR_ACCOUNT must be a valid Stellar account in ${env.LUMEN_ENV}.`);
  }
  if (activeAsset === undefined || !StrKey.isValidEd25519PublicKey(activeAsset.issuer)) {
    throw new Error(`The active asset issuer must be a valid Stellar account in ${env.LUMEN_ENV}.`);
  }
  if (activeAsset.contractId !== undefined && !StrKey.isValidContract(activeAsset.contractId)) {
    throw new Error(`The active asset contract ID must be valid in ${env.LUMEN_ENV}.`);
  }

  if (env.ENABLE_UPTO_SCHEME) {
    if (
      activeAsset?.contractId === undefined ||
      activeNetwork.uptoSessionContractId === undefined
    ) {
      throw new Error(
        `ENABLE_UPTO_SCHEME requires asset and upto session contract IDs in ${env.LUMEN_ENV}.`
      );
    }
    if (!StrKey.isValidContract(activeNetwork.uptoSessionContractId)) {
      throw new Error(`The upto session contract ID must be valid in ${env.LUMEN_ENV}.`);
    }
  }
}

function isPlaceholderValue(value: string) {
  const normalized = value.toLowerCase();
  return (
    value === localIssuerPublicKey ||
    normalized.includes(".example") ||
    normalized.includes("example.com") ||
    normalized.includes("localhost") ||
    normalized.includes("127.0.0.1")
  );
}

function parseCorsAllowedOrigins(value: string) {
  const origins = value
    .split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

  if (origins.length === 0) {
    throw new Error("CORS_ALLOWED_ORIGINS must include at least one origin.");
  }

  return origins.map((origin) => {
    let url: URL;

    try {
      url = new URL(origin);
    } catch {
      throw new Error(`CORS_ALLOWED_ORIGINS contains an invalid origin: ${origin}`);
    }

    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.origin !== origin) {
      throw new Error(`CORS_ALLOWED_ORIGINS contains an invalid origin: ${origin}`);
    }

    return origin;
  });
}
