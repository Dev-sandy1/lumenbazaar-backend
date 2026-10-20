import { describe, expect, it } from "vitest";

import {
  parseDeploymentCheckArgs,
  parseEnvFile,
  validateTestnetDeploymentEnv
} from "./deployment-check.js";

const validEnv = {
  NODE_ENV: "production",
  LUMEN_ENV: "testnet",
  API_PUBLIC_URL: "https://api.testnet.lumenbazaar.dev",
  MCP_PUBLIC_URL: "https://mcp.testnet.lumenbazaar.dev/mcp",
  MCP_TRUST_PROXY: "true",
  DATABASE_URL: "postgresql://postgres:postgres@postgres:5432/lumenbazaar",
  REDIS_URL: "redis://redis:6379",
  DEFAULT_ASSET_CODE: "USDC",
  STELLAR_TESTNET_RPC_URL: "https://soroban-testnet.stellar.org",
  STELLAR_TESTNET_HORIZON_URL: "https://horizon-testnet.stellar.org",
  STELLAR_TESTNET_USDC_ISSUER: "GCYEX7MPJL64ZJ7ABZSPRC7YEBSI7OMC62FFEVFHCZFREBOYJPQDUCYJ",
  STELLAR_TESTNET_USDC_CONTRACT_ID: "CB256KDRXDO2FYJN3YBYZE5KCU46WIIE67DRP5T7HI45DRH2GM6YOJFS",
  FACILITATOR_ACCOUNT: "GCYEX7MPJL64ZJ7ABZSPRC7YEBSI7OMC62FFEVFHCZFREBOYJPQDUCYJ",
  FACILITATOR_SIGNER_PROVIDER: "environment",
  FACILITATOR_SIGNER_NETWORK: "stellar:testnet",
  FACILITATOR_SIGNING_KEY_VERSION: "render-secret-v1",
  STELLAR_MAX_TRANSACTION_FEE_STROOPS: "50000",
  STELLAR_INCLUSION_FEE_STROOPS: "100"
};

describe("testnet deployment check", () => {
  it("parses dotenv style env files", () => {
    expect(
      parseEnvFile(`
        # comment
        NODE_ENV=production
        API_PUBLIC_URL="https://api.testnet.lumenbazaar.dev"
        REDIS_URL='redis://redis:6379'
      `)
    ).toEqual({
      API_PUBLIC_URL: "https://api.testnet.lumenbazaar.dev",
      NODE_ENV: "production",
      REDIS_URL: "redis://redis:6379"
    });
  });

  it("validates testnet deployment settings and derives public endpoints", () => {
    const result = validateTestnetDeploymentEnv(validEnv, { allowPlaceholders: false });

    expect(result).toMatchObject({
      ok: true,
      endpoints: {
        api: {
          health: "https://api.testnet.lumenbazaar.dev/health",
          readiness: "https://api.testnet.lumenbazaar.dev/ready",
          metrics: "https://api.testnet.lumenbazaar.dev/metrics",
          openapi: "https://api.testnet.lumenbazaar.dev/openapi.json",
          supported: "https://api.testnet.lumenbazaar.dev/v1/supported",
          version: "https://api.testnet.lumenbazaar.dev/version"
        },
        mcp: {
          health: "https://mcp.testnet.lumenbazaar.dev/health",
          metrics: "https://mcp.testnet.lumenbazaar.dev/metrics",
          readiness: "https://mcp.testnet.lumenbazaar.dev/ready",
          schema: "https://mcp.testnet.lumenbazaar.dev/schema",
          streamableHttp: "https://mcp.testnet.lumenbazaar.dev/mcp",
          version: "https://mcp.testnet.lumenbazaar.dev/version"
        }
      }
    });
  });

  it("requires an explicit MCP proxy trust decision", () => {
    const result = validateTestnetDeploymentEnv(
      { ...validEnv, MCP_TRUST_PROXY: "sometimes" },
      { allowPlaceholders: false }
    );

    expect(result.errors).toContain(
      "MCP_TRUST_PROXY must be true or false for testnet deployment."
    );
  });

  it("fails closed on placeholders unless examples are explicitly allowed", () => {
    const placeholderEnv = {
      ...validEnv,
      API_PUBLIC_URL: "https://api.testnet.lumenbazaar.example",
      MCP_PUBLIC_URL: "https://mcp.testnet.lumenbazaar.example/mcp"
    };

    expect(
      validateTestnetDeploymentEnv(placeholderEnv, { allowPlaceholders: false }).errors
    ).toContain("API_PUBLIC_URL still contains a placeholder value.");
    expect(
      validateTestnetDeploymentEnv(placeholderEnv, { allowPlaceholders: true }).warnings
    ).toContain("API_PUBLIC_URL uses a placeholder value.");
  });

  it("requires the hosted environment signer profile without reading the secret", () => {
    const result = validateTestnetDeploymentEnv(
      {
        ...validEnv,
        FACILITATOR_SIGNER_PROVIDER: "disabled",
        FACILITATOR_SIGNER_NETWORK: "stellar:pubnet"
      },
      { allowPlaceholders: false }
    );

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "FACILITATOR_SIGNER_PROVIDER must be environment for testnet deployment.",
        "FACILITATOR_SIGNER_NETWORK must be stellar:testnet for testnet deployment."
      ])
    );
    expect(JSON.stringify(result)).not.toContain("FACILITATOR_SIGNING_KEY=");
  });

  it("rejects invalid settlement fee controls", () => {
    const result = validateTestnetDeploymentEnv(
      {
        ...validEnv,
        STELLAR_MAX_TRANSACTION_FEE_STROOPS: "0",
        STELLAR_INCLUSION_FEE_STROOPS: "invalid"
      },
      { allowPlaceholders: false }
    );

    expect(result.errors).toEqual(
      expect.arrayContaining([
        "STELLAR_MAX_TRANSACTION_FEE_STROOPS must be a positive integer.",
        "STELLAR_INCLUSION_FEE_STROOPS must be a positive integer."
      ])
    );
  });

  it("parses CLI arguments", () => {
    expect(
      parseDeploymentCheckArgs(["--env-file", ".env.testnet", "--allow-placeholders"])
    ).toEqual({
      allowPlaceholders: true,
      envFile: ".env.testnet"
    });
  });

  it("exposes rollback and evidence gates for the runbook", () => {
    const result = validateTestnetDeploymentEnv(validEnv, { allowPlaceholders: false });

    expect(result.ok).toBe(true);
    expect(result.endpoints.api.readiness).to.typeof("string");
    expect(result.endpoints.mcp.readiness).to.typeof("string");
    expect(JSON.stringify(result)).not.toMatch(/FACILITATOR_SIGNING_KEY=/);
  });
});
