import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { loadConfig, localIssuerPublicKey } from "../packages/shared/src/index.js";

export type DeploymentCheckOptions = {
  allowPlaceholders: boolean;
  envFile?: string;
};

export type DeploymentCheckStep = {
  command: string;
  description: string;
  evidence: string;
  name: string;
  rollbackPoint: string;
};

export type DeploymentRunbook = {
  capabilityAdvertisingGate: string;
  migrationOrdering: string[];
  rollback: {
    idempotency: string;
    paymentEvidence: string;
    steps: string[];
  };
  steps: DeploymentCheckStep[];
};

export type DeploymentCheckResult = {
  runbook: DeploymentRunbook;
  endpoints: {
    api: {
      health: string;
      readiness: string;
      metrics: string;
      openapi: string;
      supported: string;
      version: string;
    };
    mcp: {
      health: string;
      metrics: string;
      readiness: string;
      schema: string;
      streamableHttp: string;
      version: string;
    };
  };
  errors: string[];
  ok: boolean;
  warnings: string[];
};

type EnvMap = Record<string, string | undefined>;

const requiredKeys = [
  "NODE_ENV",
  "LUMEN_ENV",
  "API_PUBLIC_URL",
  "MCP_PUBLIC_URL",
  "MCP_TRUST_PROXY",
  "DATABASE_URL",
  "REDIS_URL",
  "STELLAR_TESTNET_RPC_URL",
  "STELLAR_TESTNET_HORIZON_URL",
  "STELLAR_TESTNET_USDC_ISSUER",
  "STELLAR_TESTNET_USDC_CONTRACT_ID",
  "FACILITATOR_ACCOUNT",
  "FACILITATOR_SIGNER_PROVIDER",
  "FACILITATOR_SIGNER_NETWORK",
  "FACILITATOR_SIGNING_KEY_VERSION",
  "STELLAR_MAX_TRANSACTION_FEE_STROOPS",
  "STELLAR_INCLUSION_FEE_STROOPS"
];

export async function runDeploymentCheck(
  options: DeploymentCheckOptions
): Promise<DeploymentCheckResult> {
  const env = await loadDeploymentEnv(options.envFile);
  return validateTestnetDeploymentEnv(env, options);
}

export function validateTestnetDeploymentEnv(
  env: EnvMap,
  options: DeploymentCheckOptions
): DeploymentCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  for (const key of requiredKeys) {
    if (env[key] === undefined || env[key] === "") {
      errors.push(`${key} is required for testnet deployment.`);
    }
  }

  if (env.NODE_ENV !== "production") {
    errors.push("NODE_ENV must be production for testnet deployment.");
  }

  if (env.LUMEN_ENV !== "testnet") {
    errors.push("LUMEN_ENV must be testnet for testnet deployment.");
  }

  if (env.MCP_TRUST_PROXY !== "true" && env.MCP_TRUST_PROXY !== "false") {
    errors.push("MCP_TRUST_PROXY must be true or false for testnet deployment.");
  }

  if (env.FACILITATOR_SIGNER_PROVIDER !== "environment") {
    errors.push("FACILITATOR_SIGNER_PROVIDER must be environment for testnet deployment.");
  }

  if (env.FACILITATOR_SIGNER_NETWORK !== "stellar:testnet") {
    errors.push("FACILITATOR_SIGNER_NETWORK must be stellar:testnet for testnet deployment.");
  }

  collectPositiveIntegerError(
    env.STELLAR_MAX_TRANSACTION_FEE_STROOPS,
    "STELLAR_MAX_TRANSACTION_FEE_STROOPS",
    errors
  );
  collectPositiveIntegerError(
    env.STELLAR_INCLUSION_FEE_STROOPS,
    "STELLAR_INCLUSION_FEE_STROOPS",
    errors
  );
  if (
    /^\d+$/.test(env.STELLAR_INCLUSION_FEE_STROOPS ?? "") &&
    /^\d+$/.test(env.STELLAR_MAX_TRANSACTION_FEE_STROOPS ?? "") &&
    Number(env.STELLAR_INCLUSION_FEE_STROOPS) > Number(env.STELLAR_MAX_TRANSACTION_FEE_STROOPS)
  ) {
    errors.push(
      "STELLAR_INCLUSION_FEE_STROOPS must not exceed STELLAR_MAX_TRANSACTION_FEE_STROOPS."
    );
  }

  collectUrlError(env.API_PUBLIC_URL, "API_PUBLIC_URL", errors);
  collectUrlError(env.MCP_PUBLIC_URL, "MCP_PUBLIC_URL", errors);
  collectUrlError(env.DATABASE_URL, "DATABASE_URL", errors);
  collectUrlError(env.REDIS_URL, "REDIS_URL", errors);
  collectUrlError(env.STELLAR_TESTNET_RPC_URL, "STELLAR_TESTNET_RPC_URL", errors);
  collectUrlError(env.STELLAR_TESTNET_HORIZON_URL, "STELLAR_TESTNET_HORIZON_URL", errors);

  if (!options.allowPlaceholders) {
    collectPlaceholderError(env.API_PUBLIC_URL, "API_PUBLIC_URL", errors);
    collectPlaceholderError(env.MCP_PUBLIC_URL, "MCP_PUBLIC_URL", errors);
    collectPlaceholderError(env.STELLAR_TESTNET_USDC_ISSUER, "STELLAR_TESTNET_USDC_ISSUER", errors);
    collectPlaceholderError(
      env.STELLAR_TESTNET_USDC_CONTRACT_ID,
      "STELLAR_TESTNET_USDC_CONTRACT_ID",
      errors
    );
    collectPlaceholderError(env.FACILITATOR_ACCOUNT, "FACILITATOR_ACCOUNT", errors);
  } else {
    collectPlaceholderWarning(env.API_PUBLIC_URL, "API_PUBLIC_URL", warnings);
    collectPlaceholderWarning(env.MCP_PUBLIC_URL, "MCP_PUBLIC_URL", warnings);
    collectPlaceholderWarning(
      env.STELLAR_TESTNET_USDC_ISSUER,
      "STELLAR_TESTNET_USDC_ISSUER",
      warnings
    );
    collectPlaceholderWarning(
      env.STELLAR_TESTNET_USDC_CONTRACT_ID,
      "STELLAR_TESTNET_USDC_CONTRACT_ID",
      warnings
    );
    collectPlaceholderWarning(env.FACILITATOR_ACCOUNT, "FACILITATOR_ACCOUNT", warnings);
  }

  try {
    loadConfig(env, { allowPlaceholders: options.allowPlaceholders });
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }

  const apiBaseUrl = stripTrailingSlash(
    env.API_PUBLIC_URL ?? "https://api.testnet.lumenbazaar.example"
  );
  const mcpUrl = env.MCP_PUBLIC_URL ?? "https://mcp.testnet.lumenbazaar.example/mcp";
  const mcpEndpoint = (pathname: string) => {
    const url = new URL(mcpUrl);
    url.pathname = pathname;
    url.search = "";
    url.hash = "";
    return url.toString();
  };

  return {
    runbook: buildDeploymentRunbook(),
    endpoints: {
      api: {
        health: `${apiBaseUrl}/health`,
        readiness: `${apiBaseUrl}/ready`,
        metrics: `${apiBaseUrl}/metrics`,
        openapi: `${apiBaseUrl}/openapi.json`,
        supported: `${apiBaseUrl}/v1/supported`,
        version: `${apiBaseUrl}/version`
      },
      mcp: {
        health: mcpEndpoint("/health"),
        metrics: mcpEndpoint("/metrics"),
        readiness: mcpEndpoint("/ready"),
        schema: mcpEndpoint("/schema"),
        streamableHttp: mcpUrl,
        version: mcpEndpoint("/version")
      }
    },
    errors,
    ok: errors.length === 0,
    warnings
  };
}

export function buildDeploymentRunbook(): DeploymentRunbook {
  return {
    capabilityAdvertisingGate:
      "Only advertise payment and network capabilities after readiness and smoke gates pass; keep unsupported capabilities fail closed and labeled.",
    migrationOrdering: [
      "1. Take a database snapshot and record its identifier as rollback evidence.",
      "2. Run migrations in ascending order with pnpm db:migrate (never out of order).",
      "3. Verify migration status matches the expected head before starting API, worker, or MCP.",
      "4. If a migration fails, stop and restore the snapshot before retrying."
    ],
    rollback: {
      idempotency:
        "Preserve idempotency keys and dedupe records across rollback; never delete or reuse idempotency state.",
      paymentEvidence:
        "Retain payment intents, settlement records, and facilitator receipts as immutable evidence during rollback.",
      steps: [
        "1. Stop capability advertising by disabling payment and network features.",
        "2. Drain worker queues and stop API and MCP processes.",
        "3. Restore the recorded database snapshot if migrations are implicated.",
        "4. Redeploy the previous known-good API, worker, and MCP versions.",
        "5. Re-run readiness and smoke gates before re-enabling capabilities.",
        "6. Capture logs, snapshot identifiers, and payment evidence references."
      ]
    },
    steps: [
      {
        command: "pnpm db:migrate",
        description: "Apply database migrations in ascending order.",
        evidence: "Migration output and resulting schema version.",
        name: "database-migration",
        rollbackPoint: "Pre-migration database snapshot identifier."
      },
      {
        command: "pnpm --filter @lumen/api start",
        description: "Start the API service.",
        evidence: "API startup logs and process identifier.",
        name: "api",
        rollbackPoint: "Previous API image tag."
      },
      {
        command: "pnpm --filter @lumen/worker start",
        description: "Start the worker service.",
        evidence: "Worker startup logs and queue drain status.",
        name: "worker",
        rollbackPoint: "Previous worker image tag."
      },
      {
        command: "pnpm --filter @lumen/mcp start",
        description: "Start the MCP service.",
        evidence: "MCP startup logs and process identifier.",
        name: "mcp",
        rollbackPoint: "Previous MCP image tag."
      },
      {
        command: "pnpm deploy:testnet:check --env-file .env.testnet",
        description: "Run readiness and smoke gates before advertising capabilities.",
        evidence: "Deployment check JSON output with ok=true.",
        name: "readiness-smoke-gate",
        rollbackPoint: "Last passing deployment check output."
      }
    ]
  };
}

function collectPositiveIntegerError(value: string | undefined, key: string, errors: string[]) {
  if (value === undefined || !/^\d+$/.test(value) || Number(value) <= 0) {
    errors.push(`${key} must be a positive integer.`);
  }
}

export function parseEnvFile(content: string): EnvMap {
  const env: EnvMap = {};

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();

    if (line.length === 0 || line.startsWith("#")) {
      continue;
    }

    const separatorIndex = line.indexOf("=");

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = line.slice(separatorIndex + 1).trim();
    env[key] = stripQuotes(value);
  }

  return env;
}

export function parseDeploymentCheckArgs(argv: string[]): DeploymentCheckOptions {
  const options: DeploymentCheckOptions = {
    allowPlaceholders: false
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === undefined) {
      continue;
    }

    if (arg === "--allow-placeholders") {
      options.allowPlaceholders = true;
      continue;
    }

    if (arg === "--env-file") {
      const value = argv[index + 1];

      if (value === undefined) {
        throw new Error("--env-file requires a value.");
      }

      options.envFile = value;
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }

    throw new Error(`Unknown deployment check option: ${arg}`);
  }

  return options;
}

async function loadDeploymentEnv(envFile: string | undefined): Promise<EnvMap> {
  if (envFile === undefined) {
    return process.env;
  }

  return {
    ...process.env,
    ...parseEnvFile(await readFile(resolve(envFile), "utf8"))
  };
}

function collectUrlError(value: string | undefined, key: string, errors: string[]) {
  if (value === undefined || value === "") {
    return;
  }

  try {
    new URL(value);
  } catch {
    errors.push(`${key} must be a valid URL.`);
  }
}

function collectPlaceholderError(value: string | undefined, key: string, errors: string[]) {
  if (isPlaceholder(value)) {
    errors.push(`${key} still contains a placeholder value.`);
  }
}

function collectPlaceholderWarning(value: string | undefined, key: string, warnings: string[]) {
  if (isPlaceholder(value)) {
    warnings.push(`${key} uses a placeholder value.`);
  }
}

function isPlaceholder(value: string | undefined) {
  return (
    value !== undefined &&
    (value.includes(".example") ||
      value.includes("example.com") ||
      value.toLowerCase().includes("replace_me") ||
      value === localIssuerPublicKey)
  );
}

function stripQuotes(value: string) {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }

  return value;
}

function stripTrailingSlash(value: string) {
  return value.replace(/\/$/, "");
}

function printUsage() {
  console.log(`Usage: pnpm deploy:testnet:check [options]

Options:
  --env-file <path>       Load environment variables from a file before checking.
  --allow-placeholders    Allow placeholder URLs and accounts in example files.
`);
}

async function main() {
  const result = await runDeploymentCheck(parseDeploymentCheckArgs(process.argv.slice(2)));
  console.log(JSON.stringify(result, null, 2));

  if (!result.ok) {
    process.exitCode = 1;
  }
}

const entrypoint = process.argv[1] === undefined ? undefined : pathToFileURL(process.argv[1]).href;

if (entrypoint === import.meta.url) {
  await main();
}
