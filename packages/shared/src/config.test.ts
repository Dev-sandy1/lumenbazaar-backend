import { describe, expect, it } from "vitest";
import { ZodError } from "zod";

import { listConfiguredNetworks, loadConfig, localIssuerPublicKey } from "./index.js";

describe("loadConfig", () => {
  it("loads local defaults while exposing only testnet", () => {
    const config = loadConfig({});

    expect(config.lumenEnv).toBe("local");
    expect(config.api.port).toBe(3000);
    expect(config.features.uptoScheme).toBe(false);
    expect(config.signer).toEqual({
      provider: "disabled",
      network: "stellar:testnet"
    });
    expect(config.settlement).toEqual({
      maxTransactionFeeStroops: 50_000,
      inclusionFeeStroops: 100
    });
    expect(config.networks["stellar:testnet"].passphrase).toContain("Test SDF Network");
    expect(config.networks["stellar:testnet"].assets[0]).toMatchObject({
      code: "USDC",
      issuer: localIssuerPublicKey,
      decimals: 7
    });
    expect(config.networks["stellar:pubnet"].passphrase).toContain("Public Global Stellar");
    expect(listConfiguredNetworks(config).map((network) => network.id)).toEqual([
      "stellar:testnet"
    ]);
  });

  it("fails startup when a numeric setting is malformed", () => {
    expect(() => loadConfig({ API_PORT: "not-a-number" })).toThrow(ZodError);
    expect(() => loadConfig({ STELLAR_MAX_TRANSACTION_FEE_STROOPS: "0" })).toThrow(ZodError);
    expect(() => loadConfig({ STELLAR_INCLUSION_FEE_STROOPS: "not-a-number" })).toThrow(ZodError);
    expect(() =>
      loadConfig({
        STELLAR_MAX_TRANSACTION_FEE_STROOPS: "100",
        STELLAR_INCLUSION_FEE_STROOPS: "101"
      })
    ).toThrow("must not exceed");
  });

  it("fails closed for mainnet without an explicit pubnet USDC issuer", () => {
    expect(() => loadConfig({ LUMEN_ENV: "mainnet" })).toThrow(
      "STELLAR_PUBNET_USDC_ISSUER must be configured"
    );
  });

  it.each([
    ["local", "stellar:testnet"],
    ["testnet", "stellar:testnet"],
    ["staging", "stellar:testnet"],
    ["mainnet", "stellar:pubnet"]
  ] as const)("uses the %s environment network profile", (lumenEnv, expectedNetwork) => {
    const config = loadConfig({
      LUMEN_ENV: lumenEnv,
      ...(lumenEnv === "local"
        ? {}
        : {
            NODE_ENV: "production",
            API_PUBLIC_URL: `https://api.${lumenEnv}.lumenbazaar.dev`,
            MCP_PUBLIC_URL: `https://mcp.${lumenEnv}.lumenbazaar.dev/mcp`,
            DATABASE_URL: "postgresql://lumenbazaar@postgres:5432/lumenbazaar",
            REDIS_URL: "redis://redis:6379",
            FACILITATOR_ACCOUNT: "GCYEX7MPJL64ZJ7ABZSPRC7YEBSI7OMC62FFEVFHCZFREBOYJPQDUCYJ",
            STELLAR_TESTNET_USDC_ISSUER: "GCYEX7MPJL64ZJ7ABZSPRC7YEBSI7OMC62FFEVFHCZFREBOYJPQDUCYJ"
          }),
      ...(lumenEnv === "mainnet"
        ? { STELLAR_PUBNET_USDC_ISSUER: "GCYEX7MPJL64ZJ7ABZSPRC7YEBSI7OMC62FFEVFHCZFREBOYJPQDUCYJ" }
        : {})
    });

    expect(listConfiguredNetworks(config).map((network) => network.id)).toEqual([expectedNetwork]);
  });

  it("rejects local and placeholder values in hosted environments", () => {
    expect(() => loadConfig({ NODE_ENV: "production", LUMEN_ENV: "testnet" })).toThrow(
      "API_PUBLIC_URL must not use a local or placeholder value in testnet"
    );

    expect(() =>
      loadConfig({ NODE_ENV: "production", LUMEN_ENV: "testnet" }, { allowPlaceholders: true })
    ).not.toThrow();
  });

  it("parses boolean feature flags explicitly", () => {
    expect(loadConfig({ ENABLE_UPTO_SCHEME: "true" }).features.uptoScheme).toBe(true);
    expect(loadConfig({ ENABLE_UPTO_SCHEME: "0" }).features.uptoScheme).toBe(false);
  });

  it("rejects test signers and signer networks that do not match the active network", () => {
    expect(() => loadConfig({ FACILITATOR_SIGNER_PROVIDER: "test" } as never)).toThrow(ZodError);
    expect(() =>
      loadConfig({
        FACILITATOR_SIGNER_PROVIDER: "environment",
        FACILITATOR_SIGNER_NETWORK: "stellar:pubnet"
      })
    ).toThrow("FACILITATOR_SIGNER_NETWORK must match the active Stellar network");
  });

  it("requires a key version for a hosted environment signer", () => {
    expect(() =>
      loadConfig({
        NODE_ENV: "production",
        LUMEN_ENV: "testnet",
        API_PUBLIC_URL: "https://api.testnet.lumenbazaar.dev",
        MCP_PUBLIC_URL: "https://mcp.testnet.lumenbazaar.dev/mcp",
        DATABASE_URL: "postgresql://lumenbazaar@postgres:5432/lumenbazaar",
        REDIS_URL: "redis://redis:6379",
        FACILITATOR_ACCOUNT: "GCYEX7MPJL64ZJ7ABZSPRC7YEBSI7OMC62FFEVFHCZFREBOYJPQDUCYJ",
        STELLAR_TESTNET_USDC_ISSUER: "GCYEX7MPJL64ZJ7ABZSPRC7YEBSI7OMC62FFEVFHCZFREBOYJPQDUCYJ",
        FACILITATOR_SIGNER_PROVIDER: "environment",
        FACILITATOR_SIGNER_NETWORK: "stellar:testnet"
      })
    ).toThrow("FACILITATOR_SIGNING_KEY_VERSION is required");
  });

  it("parses explicit CORS origins", () => {
    const config = loadConfig({
      CORS_ALLOWED_ORIGINS: "http://localhost:3000,https://frontend.example.test"
    });

    expect(config.api.corsAllowedOrigins).toEqual([
      "http://localhost:3000",
      "https://frontend.example.test"
    ]);
    expect(() => loadConfig({ CORS_ALLOWED_ORIGINS: "*" })).toThrow(
      "CORS_ALLOWED_ORIGINS contains an invalid origin"
    );
  });

  it("loads optional contract IDs for capped session deployments", () => {
    const config = loadConfig({
      STELLAR_TESTNET_USDC_CONTRACT_ID: "CDLZUSDCTOKENCONTRACT0000000000000000000000000000000000",
      STELLAR_TESTNET_UPTO_SESSION_CONTRACT_ID:
        "CDLZUPTOSESSIONCONTRACT000000000000000000000000000000000"
    });

    expect(config.networks["stellar:testnet"].assets[0]).toMatchObject({
      contractId: "CDLZUSDCTOKENCONTRACT0000000000000000000000000000000000"
    });
    expect(config.networks["stellar:testnet"].uptoSessionContractId).toBe(
      "CDLZUPTOSESSIONCONTRACT000000000000000000000000000000000"
    );
    expect(
      loadConfig({ STELLAR_TESTNET_USDC_CONTRACT_ID: "" }).networks["stellar:testnet"].assets[0]
    ).not.toHaveProperty("contractId");
  });

  it("defaults to official testnet USDC when TESTNET_ASSET is not set or is 'usdc'", () => {
    const config1 = loadConfig({});
    const config2 = loadConfig({ TESTNET_ASSET: "usdc" });

    const officialUsdcIssuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    expect(config1.networks["stellar:testnet"].assets[0]).toMatchObject({
      code: "USDC",
      issuer: officialUsdcIssuer,
      kind: "usdc",
      isTestOnly: false
    });
    expect(config2.networks["stellar:testnet"].assets[0]).toMatchObject({
      code: "USDC",
      issuer: officialUsdcIssuer,
      kind: "usdc",
      isTestOnly: false
    });
  });

  it("uses official Circle testnet USDC issuer by default", () => {
    const config = loadConfig({ LUMEN_ENV: "testnet" });
    const officialUsdcIssuer = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
    expect(config.networks["stellar:testnet"].assets[0].issuer).toBe(officialUsdcIssuer);
  });

  it("allows overriding testnet USDC issuer explicitly", () => {
    const customIssuer = "GCYEX7MPJL64ZJ7ABZSPRC7YEBSI7OMC62FFEVFHCZFREBOYJPQDUCYJ";
    const config = loadConfig({ STELLAR_TESTNET_USDC_ISSUER: customIssuer });
    expect(config.networks["stellar:testnet"].assets[0]).toMatchObject({
      code: "USDC",
      issuer: customIssuer,
      kind: "usdc"
    });
  });

  it("loads custom LBT test-only asset when TESTNET_ASSET=lbt", () => {
    const lbtIssuer = "GCYEX7MPJL64ZJ7ABZSPRC7YEBSI7OMC62FFEVFHCZFREBOYJPQDUCYJ";
    const lbtContract = "CB256KDRXDO2FYJN3YBYZE5KCU46WIIE67DRP5T7HI45DRH2GM6YOJFS";
    const config = loadConfig({
      TESTNET_ASSET: "lbt",
      TESTNET_LBT_ISSUER: lbtIssuer,
      TESTNET_LBT_CONTRACT_ID: lbtContract
    });

    expect(config.networks["stellar:testnet"].assets[0]).toMatchObject({
      code: "LBT",
      issuer: lbtIssuer,
      contractId: lbtContract,
      kind: "lbt",
      isTestOnly: true
    });
  });

  it("flags LBT as test-only in metadata", () => {
    const config = loadConfig({ TESTNET_ASSET: "lbt" });
    const lbtAsset = config.networks["stellar:testnet"].assets[0];
    expect(lbtAsset.kind).toBe("lbt");
    expect(lbtAsset.isTestOnly).toBe(true);
  });

  it("rejects LBT on pubnet with a clear error", () => {
    expect(() =>
      loadConfig({
        LUMEN_ENV: "mainnet",
        NODE_ENV: "production",
        API_PUBLIC_URL: "https://api.example.com",
        MCP_PUBLIC_URL: "https://mcp.example.com/mcp",
        DATABASE_URL: "postgresql://localhost:5432/lumenbazaar",
        REDIS_URL: "redis://localhost:6379",
        FACILITATOR_ACCOUNT: "GCYEX7MPJL64ZJ7ABZSPRC7YEBSI7OMC62FFEVFHCZFREBOYJPQDUCYJ",
        STELLAR_TESTNET_USDC_ISSUER: "GCYEX7MPJL64ZJ7ABZSPRC7YEBSI7OMC62FFEVFHCZFREBOYJPQDUCYJ",
        STELLAR_PUBNET_USDC_ISSUER: "GCYEX7MPJL64ZJ7ABZSPRC7YEBSI7OMC62FFEVFHCZFREBOYJPQDUCYJ",
        TESTNET_ASSET: "lbt"
      })
    ).toThrow("cannot be used on pubnet");
  });

  it("rejects invalid TESTNET_ASSET values", () => {
    expect(() => loadConfig({ TESTNET_ASSET: "invalid" })).toThrow(
      'TESTNET_ASSET must be "usdc" or "lbt"'
    );
  });

  it("ensures USDC and LBT never have mixed asset codes in output", () => {
    const usdcConfig = loadConfig({ TESTNET_ASSET: "usdc" });
    const lbtConfig = loadConfig({ TESTNET_ASSET: "lbt" });

    expect(usdcConfig.networks["stellar:testnet"].assets[0].code).toBe("USDC");
    expect(lbtConfig.networks["stellar:testnet"].assets[0].code).toBe("LBT");
  });

  it("marks USDC as not test-only", () => {
    const config = loadConfig({ TESTNET_ASSET: "usdc" });
    const usdcAsset = config.networks["stellar:testnet"].assets[0];
    expect(usdcAsset.isTestOnly).toBe(false);
    expect(usdcAsset.kind).toBe("usdc");
  });

  it("pubnet only supports USDC (never LBT)", () => {
    const config = loadConfig({
      LUMEN_ENV: "mainnet",
      NODE_ENV: "test",
      STELLAR_PUBNET_USDC_ISSUER: "GCYEX7MPJL64ZJ7ABZSPRC7YEBSI7OMC62FFEVFHCZFREBOYJPQDUCYJ"
    });

    const pubnetAsset = config.networks["stellar:pubnet"].assets[0];
    expect(pubnetAsset.code).toBe("USDC");
    expect(pubnetAsset.kind).toBe("usdc");
    expect(pubnetAsset.isTestOnly).toBe(false);
  });
});
