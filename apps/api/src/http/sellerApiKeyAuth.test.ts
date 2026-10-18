import { describe, expect, it } from "vitest";
import Fastify from "fastify";

import { type SellerApiKeyScope } from "@lumenbazaar/shared";
import {
  SellerApiKeyService,
  InMemorySellerApiKeyStore
} from "../services/sellerApiKeys.js";
import { registerErrorHandling } from "./errors.js";
import { registerSellerApiKeyAuth } from "./sellerApiKeyAuth.js";
import { registerRateLimitHook } from "./rateLimit.js";
import { type RateLimitRequest, type RateLimitResult, type RateLimitService } from "../services/rateLimit.js";

function jsonBodyParser(app: Fastify.FastifyInstance) {
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    try {
      done(null, JSON.parse(String(body)));
    } catch {
      done(new Error("invalid JSON body"));
    }
  });
}

function buildAuthApp(
  sellerApiKeyService: SellerApiKeyService,
  options: { resolveResourceSeller?: (resourceId: string) => Promise<string | undefined> } = {}
) {
  const app = Fastify({ logger: false });
  jsonBodyParser(app);
  registerErrorHandling(app);
  registerSellerApiKeyAuth(app, {
    sellerApiKeyService,
    resolveResourceSeller: options.resolveResourceSeller ?? (async () => undefined)
  });
  app.post("/v1/resources", async (request) => ({
    accepted: true,
    sellerId: request.sellerApiKeyPrincipal?.sellerId,
    scopes: request.sellerApiKeyPrincipal?.scopes
  }));
  app.patch("/v1/resources/:id", async () => ({ accepted: true }));
  app.get("/v1/sellers/:sellerId", async () => ({ accepted: true }));
  app.get("/unauthenticated", async () => ({ accepted: true }));
  return app;
}

async function issueKey(
  service: SellerApiKeyService,
  sellerId: string,
  scopes: SellerApiKeyScope[]
) {
  return service.createKey(sellerId, { name: "test key", scopes });
}

describe("seller API key authentication", () => {
  it("lets requests without a seller API key pass through unauthenticated", async () => {
    const service = new SellerApiKeyService(new InMemorySellerApiKeyStore());
    const app = buildAuthApp(service);
    const response = await app.inject({ method: "GET", url: "/unauthenticated" });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: true });
    await app.close();
  });

  it("rejects malformed seller keys before reaching the route handler", async () => {
    const service = new SellerApiKeyService(new InMemorySellerApiKeyStore());
    const { key } = await issueKey(service, "seller_one", ["resources:write"]);
    const tampered = key.replace(/_[^_]+$/u, "_tampered-secret");
    const app = buildAuthApp(service);
    const response = await app.inject({
      method: "GET",
      url: "/unauthenticated",
      headers: { "x-api-key": tampered }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED", message: "API key is invalid." }
    });
    await app.close();
  });

  it("rejects revoked seller keys", async () => {
    const service = new SellerApiKeyService(new InMemorySellerApiKeyStore());
    const { apiKey, key: plaintext } = await issueKey(service, "seller_one", ["resources:write"]);
    await service.revokeKey("seller_one", apiKey.id);
    const app = buildAuthApp(service);
    const response = await app.inject({
      method: "POST",
      url: "/v1/resources",
      headers: { "x-api-key": plaintext },
      payload: { sellerId: "seller_one" }
    });
    expect(response.statusCode).toBe(401);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: "UNAUTHORIZED", message: "API key was revoked." }
    });
    await app.close();
  });

  it("enforces scope on resource-writing routes", async () => {
    const service = new SellerApiKeyService(new InMemorySellerApiKeyStore());
    const { key: plaintext } = await issueKey(service, "seller_one", ["seller:read"]);
    const app = buildAuthApp(service);
    const response = await app.inject({
      method: "POST",
      url: "/v1/resources",
      headers: { "x-api-key": plaintext },
      payload: { sellerId: "seller_one" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", details: { requiredScope: "resources:write" } }
    });
    await app.close();
  });

  it("binds resource creation to the key's owning seller", async () => {
    const service = new SellerApiKeyService(new InMemorySellerApiKeyStore());
    const { key: plaintext } = await issueKey(service, "seller_one", ["resources:write"]);
    const app = buildAuthApp(service);
    const response = await app.inject({
      method: "POST",
      url: "/v1/resources",
      headers: { "x-api-key": plaintext },
      payload: { sellerId: "seller_two" }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      ok: false,
      error: {
        code: "FORBIDDEN",
        message: "API key cannot create resources for another seller."
      }
    });
    await app.close();
  });

  it("binds resource updates to the resource-owning seller", async () => {
    const service = new SellerApiKeyService(new InMemorySellerApiKeyStore());
    const { key: plaintext } = await issueKey(service, "seller_one", ["resources:write"]);
    const app = buildAuthApp(service, {
      resolveResourceSeller: async () => "seller_two"
    });
    const response = await app.inject({
      method: "PATCH",
      url: "/v1/resources/resource_one",
      headers: { "x-api-key": plaintext }
    });
    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({
      ok: false,
      error: { code: "FORBIDDEN", message: "API key does not own this resource." }
    });
    await app.close();
  });

  it("allows a key with the required scope and matching seller", async () => {
    const service = new SellerApiKeyService(new InMemorySellerApiKeyStore());
    const { key: plaintext } = await issueKey(service, "seller_one", ["resources:write"]);
    const app = buildAuthApp(service);
    const response = await app.inject({
      method: "POST",
      url: "/v1/resources",
      headers: { "x-api-key": plaintext },
      payload: { sellerId: "seller_one" }
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ accepted: true, sellerId: "seller_one" });
    await app.close();
  });

  it("uses the authenticated key ID as the rate-limit identity", async () => {
    const service = new SellerApiKeyService(new InMemorySellerApiKeyStore());
    const { apiKey, key: plaintext } = await issueKey(service, "seller_one", ["seller:read"]);
    const capturedKeys: string[] = [];
    const app = buildAuthApp(service);
    const rateLimitService = {
      consume: async (request: RateLimitRequest): Promise<RateLimitResult> => {
        capturedKeys.push(request.key);
        return {
          key: request.key,
          scope: request.scope,
          limit: 100,
          remaining: 99,
          resetAt: new Date(),
          allowed: true
        };
      }
    } as unknown as RateLimitService;
    registerRateLimitHook(app, { rateLimitService });
    const response = await app.inject({
      method: "GET",
      url: "/v1/sellers/seller_one",
      headers: { "x-api-key": plaintext }
    });
    expect(response.statusCode).toBe(200);
    expect(capturedKeys).toEqual([`key:${apiKey.id}`]);
    await app.close();
  });
});
