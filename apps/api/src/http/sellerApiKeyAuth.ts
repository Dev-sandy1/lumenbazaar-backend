import { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";

import {
  LumenError,
  SELLER_API_KEY_PREFIX,
  type SellerApiKeyPrincipal,
  type SellerApiKeyScope
} from "@lumenbazaar/shared";

import { type SellerApiKeyService } from "../services/sellerApiKeys.js";

declare module "fastify" {
  interface FastifyRequest {
    /** Attached when a valid seller API key was presented on the request. */
    sellerApiKeyPrincipal?: SellerApiKeyPrincipal;
  }
}

export type SellerApiKeyAuthOptions = {
  sellerApiKeyService: SellerApiKeyService;
  /** Resolves the owning seller of a resource for write authorization. */
  resolveResourceSeller?: (resourceId: string) => Promise<string | undefined>;
};

/**
 * Authenticate seller API keys and enforce scopes on seller-owned routes.
 *
 * Registered BEFORE the rate-limit hook so authenticated keys are used as the
 * rate-limit identity and invalid keys are rejected before consuming quota.
 * Requests without a seller API key keep the existing unauthenticated
 * (testnet/public) behaviour; requests carrying a malformed, revoked, or
 * expired seller key always fail closed.
 */
export function registerSellerApiKeyAuth(app: FastifyInstance, options: SellerApiKeyAuthOptions) {
  app.addHook("onRequest", async (request) => {
    const presented = presentedSellerApiKey(request);
    if (presented === undefined) {
      return;
    }

    // Throws LumenError (401/400) for invalid, revoked, or expired keys.
    request.sellerApiKeyPrincipal = await options.sellerApiKeyService.authenticate(presented);
  });

  app.addHook("preHandler", async (request) => {
    const principal = request.sellerApiKeyPrincipal;
    if (principal === undefined) {
      return;
    }

    const route = request.routeOptions.url;
    const method = request.method;

    if (route === "/v1/resources" && method === "POST") {
      requireScope(principal, "resources:write");
      await requireBodySellerOwnership(request, principal);
      return;
    }

    if (route === "/v1/resources/:id" && (method === "PATCH" || method === "DELETE")) {
      requireScope(principal, "resources:write");
      await requireResourceOwnership(request, principal, options);
      return;
    }

    if (route === "/v1/resources/:id/versions" && (method === "GET")) {
      // Version listing requires read scope and resource ownership
      requireScope(principal, "resources:read");
      await requireResourceOwnership(request, principal, options);
      return;
    }

    if (route === "/v1/resources/:id/versions/:version" && (method === "GET")) {
      // Version retrieval requires read scope and resource ownership
      requireScope(principal, "resources:read");
      await requireResourceOwnership(request, principal, options);
      return;
    }

    if (route === "/v1/resources/:id/rollback" && method === "POST") {
      requireScope(principal, "resources:write");
      await requireResourceOwnership(request, principal, options);
      return;
    }

    if (route === "/v1/sellers/:sellerId/catalog" && method === "POST") {
      requireScope(principal, "resources:write");
      const sellerId = parseSellerIdParam(request);
      if (sellerId !== principal.sellerId) {
        throw new LumenError("FORBIDDEN", "API key does not belong to this seller.");
      }
      return;
    }

    if (route !== undefined && route.startsWith("/v1/sellers/:sellerId")) {
      const sellerId = parseSellerIdParam(request);
      if (sellerId !== principal.sellerId) {
        throw new LumenError("FORBIDDEN", "API key does not belong to this seller.");
      }
      requireScope(principal, sellerReadScope(route, method));
    }
  });
}

function presentedSellerApiKey(request: FastifyRequest) {
  const header = request.headers["x-api-key"];
  if (typeof header !== "string") {
    return undefined;
  }
  const value = header.trim();
  if (!value.startsWith(`${SELLER_API_KEY_PREFIX}_`)) {
    return undefined;
  }
  return value;
}

function requireScope(principal: SellerApiKeyPrincipal, scope: SellerApiKeyScope) {
  if (!principal.scopes.includes(scope)) {
    throw new LumenError("FORBIDDEN", `API key is missing the ${scope} scope.`, {
      details: { requiredScope: scope }
    });
  }
}

function sellerReadScope(route: string, method: string): SellerApiKeyScope {
  if (method !== "GET") {
    return "seller:write";
  }
  return route === "/v1/sellers/:sellerId/resources" ? "resources:read" : "seller:read";
}

function parseSellerIdParam(request: FastifyRequest) {
  return sellerParamsSchema.parse(request.params).sellerId;
}

function parseResourceId(request: FastifyRequest) {
  return resourceParamsSchema.parse(request.params).id;
}

const sellerParamsSchema = z.object({
  sellerId: z.string().min(1)
});

const resourceParamsSchema = z.object({
  id: z.string().min(1)
});

async function requireBodySellerOwnership(
  request: FastifyRequest,
  principal: SellerApiKeyPrincipal
) {
  const body = z.object({ sellerId: z.string().min(1) }).safeParse(request.body);
  if (body.success && body.data.sellerId !== principal.sellerId) {
    throw new LumenError("FORBIDDEN", "API key cannot create resources for another seller.");
  }
}

async function requireResourceOwnership(
  request: FastifyRequest,
  principal: SellerApiKeyPrincipal,
  options: SellerApiKeyAuthOptions
) {
  const resourceId = parseResourceId(request);
  const owner = await options.resolveResourceSeller?.(resourceId);
  if (owner === undefined || owner !== principal.sellerId) {
    throw new LumenError("FORBIDDEN", "API key does not own this resource.");
  }
}
