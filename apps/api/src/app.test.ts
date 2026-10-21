import { describe, expect, it } from "vitest";
import { z } from "zod";

import { LumenError, loadConfig, localIssuerPublicKey } from "@lumenbazaar/shared";
import { createTestPaymentRequest, testPaymentConfigEnv } from "@lumenbazaar/testkit";
import {
  InMemoryPaymentAttemptStore,
  PaymentVerificationService,
  ReceiptService,
  SettlementService,
  type X402StellarAdapter
} from "@lumenbazaar/stellar-payments";

import { buildApiApp } from "./app.js";
import { parseBody } from "./http/validation.js";
import { ResourceService } from "./services/resources.js";
import { createStaticReadinessService } from "./services/readiness.js";
import { SellerService } from "./services/sellers.js";

describe("API server base", () => {
  it("adds request IDs to responses", async () => {
    const app = buildApiApp({ logger: false });

    const response = await app.inject({
      method: "GET",
      url: "/health",
      headers: {
        traceparent: "00-0123456789abcdef0123456789abcdef-0123456789abcdef-01"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers.traceparent).toMatch(
      /^00-0123456789abcdef0123456789abcdef-[0-9a-f]{16}-01$/
    );
    expect(response.headers["x-request-id"]).toBeDefined();
    expect(response.headers["x-correlation-id"]).toBe(response.headers["x-request-id"]);
    expect(response.json()).toMatchObject({
      ok: true,
      service: "lumenbazaar-backend",
      app: "api"
    });
    await app.close();
  });

  it("returns version, metrics, and only non-mainnet networks", async () => {
    const app = buildApiApp({ logger: false });

    const version = await app.inject({ method: "GET", url: "/version" });
    const openapi = await app.inject({ method: "GET", url: "/openapi.json" });
    const metrics = await app.inject({ method: "GET", url: "/metrics" });
    const networks = await app.inject({ method: "GET", url: "/v1/networks" });

    expect(version.json()).toMatchObject({
      service: "lumenbazaar-backend",
      version: "0.1.0",
      commit: expect.any(String)
    });
    expect(openapi.json()).toMatchObject({
      openapi: "3.1.0",
      paths: {
        "/v1/conformance/runs": expect.any(Object)
      }
    });
    expect(metrics.body).toContain("lumenbazaar_api_uptime_seconds");
    expect(networks.json().networks.map((network: { id: string }) => network.id)).toEqual([
      "stellar:testnet"
    ]);
    await app.close();
  });

  it("does not advertise payment schemes without live runtime adapters", async () => {
    const app = buildApiApp({ logger: false });

    const response = await app.inject({ method: "GET", url: "/v1/supported" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      kinds: [],
      extensions: ["bazaar"],
      signers: {}
    });
    await app.close();
  });

  it("keeps liveness available while readiness reports dependency failures", async () => {
    const config = loadConfig({ LUMEN_ENV: "testnet" });
    const readinessService = createStaticReadinessService(
      config,
      { exact: true, upto: false },
      { database: { status: "unavailable", reason: "dependency_check_failed" } }
    );
    const app = buildApiApp({ config, logger: false, readinessService });

    const health = await app.inject({ method: "GET", url: "/health" });
    const ready = await app.inject({ method: "GET", url: "/ready" });
    const supported = await app.inject({ method: "GET", url: "/v1/supported" });

    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json()).toMatchObject({
      ok: false,
      environment: "testnet",
      checks: { database: { status: "unavailable" } },
      capabilities: { exact: false, upto: false }
    });
    expect(supported.json().kinds).toEqual([]);
    await app.close();
  });

  it("health stays 200 when redis is down", async () => {
    const config = loadConfig({ LUMEN_ENV: "testnet" });
    const readinessService = createStaticReadinessService(config, { exact: false, upto: false }, {
      redis: { status: "unavailable", reason: "dependency_check_failed" }
    });
    const app = buildApiApp({ config, logger: false, readinessService });

    const health = await app.inject({ method: "GET", url: "/health" });
    const ready = await app.inject({ method: "GET", url: "/ready" });

    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json().checks.redis.status).toBe("unavailable");
    await app.close();
  });

  it("health stays 200 when horizon is timed out", async () => {
    const config = loadConfig({ LUMEN_ENV: "testnet" });
    const readinessService = createStaticReadinessService(config, { exact: false, upto: false }, {
      horizon: { status: "timeout", latencyMs: 2001, reason: "probe_timeout" }
    });
    const app = buildApiApp({ config, logger: false, readinessService });

    const health = await app.inject({ method: "GET", url: "/health" });
    const ready = await app.inject({ method: "GET", url: "/ready" });

    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json().checks.horizon.status).toBe("timeout");
    await app.close();
  });

  it("health stays 200 when stellarRpc is timed out", async () => {
    const config = loadConfig({ LUMEN_ENV: "testnet" });
    const readinessService = createStaticReadinessService(config, { exact: false, upto: false }, {
      stellarRpc: { status: "timeout", latencyMs: 2001, reason: "probe_timeout" }
    });
    const app = buildApiApp({ config, logger: false, readinessService });

    const health = await app.inject({ method: "GET", url: "/health" });
    const ready = await app.inject({ method: "GET", url: "/ready" });

    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json().checks.stellarRpc.status).toBe("timeout");
    await app.close();
  });

  it("health stays 200 when signer is not_configured (required but missing)", async () => {
    const config = loadConfig({ LUMEN_ENV: "testnet" });
    const readinessService = createStaticReadinessService(config, { exact: true, upto: false }, {
      signer: { status: "not_configured" }
    });
    const app = buildApiApp({ config, logger: false, readinessService });

    const health = await app.inject({ method: "GET", url: "/health" });
    const ready = await app.inject({ method: "GET", url: "/ready" });

    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json().checks.signer.status).toBe("not_configured");
    await app.close();
  });

  it("health stays 200 when multiple dependencies are down simultaneously", async () => {
    const config = loadConfig({ LUMEN_ENV: "testnet" });
    const readinessService = createStaticReadinessService(config, { exact: false, upto: false }, {
      database: { status: "unavailable", reason: "dependency_check_failed" },
      redis: { status: "timeout", latencyMs: 2001, reason: "probe_timeout" },
      horizon: { status: "unavailable", reason: "dependency_check_failed" }
    });
    const app = buildApiApp({ config, logger: false, readinessService });

    const health = await app.inject({ method: "GET", url: "/health" });
    const ready = await app.inject({ method: "GET", url: "/ready" });

    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(503);
    expect(ready.json().checks.database.status).toBe("unavailable");
    expect(ready.json().checks.redis.status).toBe("timeout");
    expect(ready.json().checks.horizon.status).toBe("unavailable");
    await app.close();
  });

  it("health stays 200 when all dependencies are down", async () => {
    const config = loadConfig({ LUMEN_ENV: "testnet" });
    const readinessService = createStaticReadinessService(config, { exact: true, upto: false }, {
      database: { status: "unavailable", reason: "dependency_check_failed" },
      redis: { status: "unavailable", reason: "dependency_check_failed" },
      stellarRpc: { status: "timeout", reason: "probe_timeout" },
      horizon: { status: "timeout", reason: "probe_timeout" },
      signer: { status: "not_configured" },
      migrations: { status: "unavailable", reason: "dependency_check_failed" },
      assets: { status: "unavailable", reason: "dependency_check_failed" }
    });
    const app = buildApiApp({ config, logger: false, readinessService });

    const health = await app.inject({ method: "GET", url: "/health" });
    const ready = await app.inject({ method: "GET", url: "/ready" });

    expect(health.statusCode).toBe(200);
    expect(health.json().ok).toBe(true);
    expect(ready.statusCode).toBe(503);
    expect(ready.json().ok).toBe(false);
    await app.close();
  });

  it("readiness returns 200 when all dependencies are ready", async () => {
    const config = loadConfig({ LUMEN_ENV: "testnet" });
    const readinessService = createStaticReadinessService(config, { exact: false, upto: false });
    const app = buildApiApp({ config, logger: false, readinessService });

    const health = await app.inject({ method: "GET", url: "/health" });
    const ready = await app.inject({ method: "GET", url: "/ready" });

    expect(health.statusCode).toBe(200);
    expect(ready.statusCode).toBe(200);
    expect(ready.json().ok).toBe(true);
    await app.close();
  });

  it("readiness response never contains raw error messages or credentials", async () => {
    const config = loadConfig({ LUMEN_ENV: "testnet" });
    const readinessService = createStaticReadinessService(config, { exact: false, upto: false }, {
      database: { status: "unavailable", reason: "dependency_check_failed" }
    });
    const app = buildApiApp({ config, logger: false, readinessService });

    const ready = await app.inject({ method: "GET", url: "/ready" });
    const body = ready.body;

    // Must never contain anything that could leak sensitive data
    expect(body).not.toMatch(/postgresql:\/\//);
    expect(body).not.toMatch(/redis:\/\//);
    expect(body).not.toMatch(/password/i);
    expect(body).not.toMatch(/secret/i);
    expect(body).not.toMatch(/ECONNREFUSED/);
    await app.close();
  });

  it("adds CORS headers only for configured frontend origins", async () => {
    const app = buildApiApp({ logger: false });

    const allowed = await app.inject({
      headers: { origin: "https://lumenbazaar-frontend.vercel.app" },
      method: "OPTIONS",
      url: "/health"
    });
    const rejected = await app.inject({
      headers: { origin: "https://untrusted.example" },
      method: "GET",
      url: "/health"
    });

    expect(allowed.headers["access-control-allow-origin"]).toBe(
      "https://lumenbazaar-frontend.vercel.app"
    );
    expect(rejected.headers["access-control-allow-origin"]).toBeUndefined();
    await app.close();
  });

  it("verifies exact payment requests through the facilitator route", async () => {
    const adapter: X402StellarAdapter = {
      async verifyExact() {
        return {
          valid: true,
          adapter: "@x402/stellar"
        };
      }
    };
    const config = loadConfig(testPaymentConfigEnv);
    const app = buildApiApp({
      logger: false,
      verificationService: new PaymentVerificationService(config, { adapter })
    });

    const response = await app.inject({
      method: "POST",
      url: "/v1/verify",
      payload: exactPaymentRequest()
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      isValid: true,
      extra: {
        lumenbazaar: {
          network: "stellar:testnet",
          status: "verified",
          adapter: "@x402/stellar"
        }
      }
    });
    expect(response.json().extra.lumenbazaar.paymentHash).toHaveLength(64);
    expect(response.json().extra.lumenbazaar.correlationId).toBe(
      response.headers["x-correlation-id"]
    );
    const repeated = await app.inject({
      method: "POST",
      url: "/v1/verify",
      payload: exactPaymentRequest()
    });
    expect(repeated.headers["x-correlation-id"]).toBe(
      response.json().extra.lumenbazaar.correlationId
    );
    expect(repeated.headers["x-correlation-id"]).not.toBe(repeated.headers["x-request-id"]);
    await app.close();
  });

  it("settles verified exact payment requests through the facilitator route", async () => {
    const adapter: X402StellarAdapter = {
      async verifyExact() {
        return {
          valid: true,
          adapter: "@x402/stellar"
        };
      },
      async settleExact() {
        return {
          transactionHash: "tx_api_settle",
          ledger: 456,
          status: "confirmed",
          adapter: "@x402/stellar"
        };
      }
    };
    const config = loadConfig(testPaymentConfigEnv);
    const attemptStore = new InMemoryPaymentAttemptStore();
    const verificationService = new PaymentVerificationService(config, { adapter, attemptStore });
    const receiptService = new ReceiptService();
    const settlementService = new SettlementService(config, {
      adapter,
      attemptStore,
      receiptService
    });
    const app = buildApiApp({
      logger: false,
      verificationService,
      settlementService,
      receiptService
    });
    const verified = await verificationService.verify(exactPaymentRequest());

    const response = await app.inject({
      method: "POST",
      url: "/v1/settle",
      payload: exactPaymentRequest()
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["x-correlation-id"]).toBe(verified.correlationId);
    expect(response.json()).toMatchObject({
      success: true,
      transaction: "tx_api_settle",
      network: "stellar:testnet",
      extra: {
        lumenbazaar: {
          transactionHash: "tx_api_settle",
          receiptId: expect.stringMatching(/^receipt_/),
          ledger: 456,
          status: "confirmed"
        }
      }
    });

    const receiptId = response.json().extra.lumenbazaar.receiptId;

    const receipt = await app.inject({
      method: "GET",
      url: `/v1/receipts/${receiptId}`
    });

    expect(receipt.statusCode).toBe(200);
    expect(receipt.headers["x-correlation-id"]).toBe(verified.correlationId);
    expect(receipt.json()).toMatchObject({
      correlationId: verified.correlationId,
      paymentAttemptId: verified.paymentAttemptId,
      transactionHash: "tx_api_settle",
      status: "finalized"
    });
    await app.close();
  });

  it("creates and fetches sellers through API routes", async () => {
    const sellerService = new SellerService();
    const app = buildApiApp({ logger: false, sellerService });

    const created = await app.inject({
      method: "POST",
      url: "/v1/sellers",
      payload: {
        displayName: "Weather Seller",
        walletAddress: localIssuerPublicKey,
        domain: "seller.example"
      }
    });

    expect(created.statusCode).toBe(200);

    const fetched = await app.inject({
      method: "GET",
      url: `/v1/sellers/${created.json().id}`
    });

    expect(fetched.statusCode).toBe(200);
    expect(fetched.json()).toMatchObject({
      displayName: "Weather Seller",
      walletAddress: localIssuerPublicKey,
      domain: "seller.example"
    });

    const challenge = await app.inject({
      method: "POST",
      url: `/v1/sellers/${created.json().id}/verify-domain`,
      payload: {
        method: "dns"
      }
    });
    const verified = await app.inject({
      method: "POST",
      url: `/v1/sellers/${created.json().id}/verify-domain`,
      payload: {
        evidence: challenge.json().challenge
      }
    });

    expect(challenge.json()).toMatchObject({
      method: "dns",
      verified: false
    });
    expect(verified.json()).toMatchObject({
      verified: true,
      domainVerifiedAt: expect.any(String)
    });
    await app.close();
  });

  it("manages resources through API routes with seller ownership", async () => {
    const sellerService = new SellerService();
    const resourceService = new ResourceService(loadConfig({}), sellerService);
    const app = buildApiApp({ logger: false, sellerService, resourceService });
    const seller = await sellerService.createSeller({
      displayName: "Weather Seller",
      walletAddress: localIssuerPublicKey,
      domain: "seller.example"
    });
    const created = await app.inject({
      method: "POST",
      url: "/v1/resources",
      payload: resourcePayload(seller.id)
    });

    expect(created.statusCode).toBe(200);

    const listed = await app.inject({
      method: "GET",
      url: `/v1/resources?sellerId=${seller.id}`
    });
    const updated = await app.inject({
      method: "PATCH",
      url: `/v1/resources/${created.json().id}`,
      payload: {
        name: "Paid Forecast API"
      }
    });
    const deleted = await app.inject({
      method: "DELETE",
      url: `/v1/resources/${created.json().id}`
    });

    expect(listed.json().resources).toHaveLength(1);
    expect(updated.json().name).toBe("Paid Forecast API");
    expect(deleted.json().status).toBe("inactive");
    await app.close();
  });

  it("validates discovery metadata without cataloging it", async () => {
    const sellerService = new SellerService();
    const app = buildApiApp({ logger: false, sellerService });
    const seller = await sellerService.createSeller({
      displayName: "Weather Seller",
      walletAddress: localIssuerPublicKey,
      domain: "seller.example"
    });
    const challenge = await sellerService.verifyDomain(seller.id, {});
    await sellerService.verifyDomain(seller.id, { evidence: challenge.challenge });

    const response = await app.inject({
      method: "POST",
      url: "/v1/discovery/validate",
      payload: {
        sellerId: seller.id,
        resource: resourcePayload(seller.id)
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      ok: true,
      warnings: [],
      errors: []
    });
    await app.close();
  });

  it("catalogs valid discovery metadata through the API route", async () => {
    const sellerService = new SellerService();
    const app = buildApiApp({ logger: false, sellerService });
    const seller = await sellerService.createSeller({
      displayName: "Weather Seller",
      walletAddress: localIssuerPublicKey,
      domain: "seller.example"
    });
    const challenge = await sellerService.verifyDomain(seller.id, {});
    await sellerService.verifyDomain(seller.id, { evidence: challenge.challenge });

    const response = await app.inject({
      method: "POST",
      url: "/v1/discovery/catalog",
      payload: {
        sellerId: seller.id,
        resource: resourcePayload(seller.id)
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      resourceId: expect.stringMatching(/^resource_/),
      versionId: expect.stringMatching(/^resource_version_/),
      catalogEventId: expect.stringMatching(/^catalog_event_/),
      indexingStatus: "queued"
    });

    const browse = await app.inject({
      method: "GET",
      url: "/v1/discovery/resources?network=stellar:testnet&asset=USDC&type=http&extension=bazaar"
    });

    expect(browse.statusCode).toBe(200);
    expect(browse.json()).toMatchObject({
      resources: [
        {
          id: response.json().resourceId,
          name: "Paid Weather API"
        }
      ],
      partialResults: false,
      nextCursor: null
    });

    const search = await app.inject({
      method: "GET",
      url: "/v1/discovery/search?q=weather&network=stellar:testnet&asset=USDC&type=http"
    });

    expect(search.statusCode).toBe(200);
    expect(search.json()).toMatchObject({
      resources: [
        {
          id: response.json().resourceId,
          ranking: {
            matchedTerms: ["weather"]
          }
        }
      ],
      ranking: {
        strategy: "postgres-full-text-v1"
      },
      partialResults: true,
      nextCursor: null
    });
    await app.close();
  });

  it("returns stable envelopes for application errors", async () => {
    const app = buildApiApp({ logger: false });
    app.get("/boom", async () => {
      throw new LumenError("UNSUPPORTED_NETWORK", "Network not supported.");
    });

    const response = await app.inject({ method: "GET", url: "/boom" });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: "UNSUPPORTED_NETWORK",
        message: "Network not supported."
      }
    });
    await app.close();
  });

  it("maps JSON schema validation failures to stable errors", async () => {
    const app = buildApiApp({ logger: false });
    app.post(
      "/schema-check",
      {
        schema: {
          body: {
            type: "object",
            required: ["name"],
            properties: {
              name: { type: "string" }
            }
          }
        }
      },
      async () => ({ ok: true })
    );

    const response = await app.inject({
      method: "POST",
      url: "/schema-check",
      payload: {}
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_FAILED");
    await app.close();
  });

  it("maps Zod parsing failures to stable errors", async () => {
    const app = buildApiApp({ logger: false });
    app.post("/zod-check", async (request) => {
      parseBody(request, z.object({ amount: z.string().regex(/^\d+$/) }));
      return { ok: true };
    });

    const response = await app.inject({
      method: "POST",
      url: "/zod-check",
      payload: { amount: "bad" }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().error.code).toBe("VALIDATION_FAILED");
    await app.close();
  });
});

function exactPaymentRequest() {
  return createTestPaymentRequest("api");
}

function resourcePayload(sellerId: string) {
  return {
    sellerId,
    type: "http",
    name: "Paid Weather API",
    description: "Returns current weather for a city.",
    url: "https://seller.example/weather/Lagos",
    routeTemplate: "/weather/{city}",
    network: "stellar:testnet",
    payTo: localIssuerPublicKey,
    assetCode: "USDC",
    assetIssuer: localIssuerPublicKey,
    amount: "0.05",
    inputSchema: {
      type: "object",
      properties: {
        city: {
          type: "string"
        }
      }
    },
    outputSchema: {
      type: "object"
    },
    extensions: {
      bazaar: true
    }
  };
}
