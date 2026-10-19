import { type FastifyInstance, type FastifyRequest } from "fastify";
import { z } from "zod";

import { type SellerApiKeyPrincipal } from "@lumenbazaar/shared";

import { parseBody, parseParams, parseQuery } from "../http/validation.js";
import { type ResourceService } from "../services/resources.js";

export type ResourceRouteOptions = {
  resourceService: ResourceService;
};

export function registerResourceRoutes(app: FastifyInstance, options: ResourceRouteOptions) {
  app.get("/v1/resources", async (request) => options.resourceService.listResources(request.query));

  app.post("/v1/resources", async (request) =>
    options.resourceService.createResource(
      parseBody(request, z.unknown()),
      getSellerContext(request)
    )
  );

  app.get("/v1/resources/:id", async (request) => {
    const params = parseParams(request, z.object({ id: z.string().min(1) }));
    return options.resourceService.getResource(params.id);
  });

  app.patch("/v1/resources/:id", async (request) => {
    const params = parseParams(request, z.object({ id: z.string().min(1) }));
    return options.resourceService.updateResource(
      params.id,
      parseBody(request, z.unknown()),
      getSellerContext(request)
    );
  });

  app.delete("/v1/resources/:id", async (request) => {
    const params = parseParams(request, z.object({ id: z.string().min(1) }));
    return options.resourceService.deleteResource(params.id, getSellerContext(request));
  });

  app.get("/v1/resources/:id/versions", async (request) => {
    const params = parseParams(request, z.object({ id: z.string().min(1) }));
    return options.resourceService.listResourceVersions(params.id);
  });

  app.get("/v1/resources/:id/versions/:version", async (request) => {
    const params = parseParams(
      request,
      z.object({ id: z.string().min(1), version: z.coerce.number().int().positive() })
    );
    return options.resourceService.getResourceVersion(params.id, params.version);
  });

  app.post("/v1/resources/:id/rollback", async (request) => {
    const params = parseParams(
      request,
      z.object({ id: z.string().min(1), version: z.coerce.number().int().positive() })
    );
    return options.resourceService.rollbackResource(params.id, params.version, getSellerContext(request));
  });

  app.get("/v1/sellers/:sellerId/resources", async (request) => {
    const params = parseParams(request, z.object({ sellerId: z.string().min(1) }));
    const query = parseQuery(request, z.record(z.string(), z.unknown()));
    return options.resourceService.listResources({ ...query, sellerId: params.sellerId });
  });
}

function getSellerContext(request: FastifyRequest): { sellerId: string; auditable: boolean } | undefined {
  const principal = (request as any).sellerApiKeyPrincipal as SellerApiKeyPrincipal | undefined;
  if (principal === undefined) {
    return undefined;
  }
  return {
    sellerId: principal.sellerId,
    auditable: true
  };
}
