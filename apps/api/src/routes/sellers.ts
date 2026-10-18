import { type FastifyInstance } from "fastify";
import { z } from "zod";

import { parseBody, parseParams } from "../http/validation.js";
import { SellerApiKeyService } from "../services/sellerApiKeys.js";
import { SellerService } from "../services/sellers.js";

export type SellerRouteOptions = {
  sellerService?: SellerService;
  sellerApiKeyService?: SellerApiKeyService;
};

export function registerSellerRoutes(app: FastifyInstance, options: SellerRouteOptions = {}) {
  const sellerService = options.sellerService ?? new SellerService();
  const sellerApiKeyService = options.sellerApiKeyService ?? new SellerApiKeyService();

  app.post("/v1/sellers", async (request) =>
    sellerService.createSeller(parseBody(request, z.unknown()))
  );

  app.get("/v1/sellers/:sellerId", async (request) => {
    const params = parseParams(request, z.object({ sellerId: z.string().min(1) }));
    return sellerService.getSeller(params.sellerId);
  });

  app.post("/v1/sellers/:sellerId/verify-domain", async (request) => {
    const params = parseParams(request, z.object({ sellerId: z.string().min(1) }));
    return sellerService.verifyDomain(params.sellerId, parseBody(request, z.unknown()));
  });

  /**
   * POST /v1/sellers/:sellerId/api-keys
   * Issue a scoped seller API key. The plaintext key is returned exactly once;
   * only a SHA-256 hash is stored.
   */
  app.post("/v1/sellers/:sellerId/api-keys", async (request) => {
    const params = parseParams(request, z.object({ sellerId: z.string().min(1) }));
    await sellerService.getSeller(params.sellerId);
    return sellerApiKeyService.createKey(params.sellerId, parseBody(request, z.unknown()));
  });

  /**
   * GET /v1/sellers/:sellerId/api-keys
   * List key metadata (never plaintext or hashes).
   */
  app.get("/v1/sellers/:sellerId/api-keys", async (request) => {
    const params = parseParams(request, z.object({ sellerId: z.string().min(1) }));
    await sellerService.getSeller(params.sellerId);
    return sellerApiKeyService.listKeys(params.sellerId);
  });

  /**
   * POST /v1/sellers/:sellerId/api-keys/:keyId/rotate
   * Issue a replacement key; the previous key stays valid for a bounded
   * overlap window. The new plaintext is returned exactly once.
   */
  app.post("/v1/sellers/:sellerId/api-keys/:keyId/rotate", async (request) => {
    const params = parseParams(
      request,
      z.object({ sellerId: z.string().min(1), keyId: z.string().min(1) })
    );
    await sellerService.getSeller(params.sellerId);
    return sellerApiKeyService.rotateKey(
      params.sellerId,
      params.keyId,
      parseBody(request, z.object({}).passthrough())
    );
  });

  /**
   * DELETE /v1/sellers/:sellerId/api-keys/:keyId
   * Immediately revoke a key. Revocation is terminal.
   */
  app.delete("/v1/sellers/:sellerId/api-keys/:keyId", async (request) => {
    const params = parseParams(
      request,
      z.object({ sellerId: z.string().min(1), keyId: z.string().min(1) })
    );
    await sellerService.getSeller(params.sellerId);
    return sellerApiKeyService.revokeKey(params.sellerId, params.keyId);
  });
}
