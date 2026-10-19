import { describe, expect, it } from "vitest";

import { loadConfig, localIssuerPublicKey } from "@lumenbazaar/shared";

import { CatalogService, InMemoryResourceIndexingQueue } from "./cataloging.js";
import { CatalogValidationService } from "./catalogValidation.js";
import { ResourceService } from "./resources.js";
import { SellerService } from "./sellers.js";

function metadata(sellerId: string) {
  return {
    sellerId,
    resource: {
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
    }
  };
}

describe("CatalogService", () => {
  it("catalogs valid resources and queues indexing jobs", async () => {
    const sellerService = new SellerService();
    const seller = await sellerService.createSeller({
      displayName: "Weather Seller",
      walletAddress: localIssuerPublicKey,
      domain: "seller.example"
    });
    const challenge = await sellerService.verifyDomain(seller.id, {});
    await sellerService.verifyDomain(seller.id, { evidence: challenge.challenge });
    const config = loadConfig({});
    const resourceService = new ResourceService(config, sellerService);
    const validationService = new CatalogValidationService(config, sellerService);
    const indexingQueue = new InMemoryResourceIndexingQueue();
    const catalogService = new CatalogService(validationService, resourceService, {
      indexingQueue
    });

    const result = await catalogService.catalog(metadata(seller.id));

    expect(result).toMatchObject({
      ok: true,
      indexingStatus: "queued"
    });
    expect(indexingQueue.jobs).toEqual([
      {
        name: "resource.index",
        resourceId: result.resourceId,
        versionId: result.versionId
      }
    ]);
  });

  it("rejects invalid resources with stable reasons", async () => {
    const sellerService = new SellerService();
    const config = loadConfig({});
    const resourceService = new ResourceService(config, sellerService);
    const validationService = new CatalogValidationService(config, sellerService);
    const catalogService = new CatalogService(validationService, resourceService);

    await expect(catalogService.catalog(metadata("missing_seller"))).rejects.toMatchObject({
      code: "CATALOG_VALIDATION_FAILED"
    });
  });

  describe("seller ownership enforcement", () => {
    it("allows catalog when seller context matches", async () => {
      const sellerService = new SellerService();
      const seller = await sellerService.createSeller({
        displayName: "Weather Seller",
        walletAddress: localIssuerPublicKey,
        domain: "seller.example"
      });

      const config = loadConfig({});
      const resourceService = new ResourceService(config, sellerService);
      const validationService = new CatalogValidationService(config, sellerService);
      const catalogService = new CatalogService(validationService, resourceService);

      const result = await catalogService.catalog(metadata(seller.id), {
        sellerId: seller.id,
        auditable: true
      });

      expect(result).toMatchObject({
        ok: true,
        indexingStatus: "queued"
      });
    });

    it("denies catalog when seller context mismatches", async () => {
      const { AuditLogService, InMemoryAuditLogStore } = await import("./audit.js");
      const sellerService = new SellerService();
      const seller1 = await sellerService.createSeller({
        displayName: "Seller 1",
        walletAddress: localIssuerPublicKey,
        domain: "seller1.example"
      });
      const seller2 = await sellerService.createSeller({
        displayName: "Seller 2",
        walletAddress: `G${localIssuerPublicKey.slice(1)}`,
        domain: "seller2.example"
      });

      const config = loadConfig({});
      const resourceService = new ResourceService(config, sellerService);
      const validationService = new CatalogValidationService(config, sellerService);
      const auditLogStore = new InMemoryAuditLogStore();
      const auditLogService = new AuditLogService(auditLogStore);
      const catalogService = new CatalogService(validationService, resourceService, {
        auditLogService
      });

      // Seller 2's API key tries to catalog for Seller 1
      await expect(
        catalogService.catalog(metadata(seller1.id), {
          sellerId: seller2.id,
          auditable: true
        })
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringMatching(/cannot catalog resources for another seller/i)
      });

      // Verify ownership denial was audited
      const logs = await auditLogStore.list();
      const ownershipDenial = logs.find(
        (log) =>
          log.action === "resource.ownership_denied" &&
          log.actorId === seller2.id &&
          log.targetType === "catalog"
      );
      expect(ownershipDenial).toBeDefined();
      expect(ownershipDenial!.metadata).toMatchObject({
        reason: "Attempted to catalog resource for different seller",
        attemptedSellerId: seller1.id,
        actualSellerId: seller2.id
      });
    });

    it("allows unauthenticated catalog (seller context undefined)", async () => {
      const sellerService = new SellerService();
      const seller = await sellerService.createSeller({
        displayName: "Weather Seller",
        walletAddress: localIssuerPublicKey,
        domain: "seller.example"
      });

      const config = loadConfig({});
      const resourceService = new ResourceService(config, sellerService);
      const validationService = new CatalogValidationService(config, sellerService);
      const catalogService = new CatalogService(validationService, resourceService);

      // Unauthenticated catalog (no seller context)
      const result = await catalogService.catalog(metadata(seller.id), undefined);

      expect(result).toMatchObject({
        ok: true,
        indexingStatus: "queued"
      });
    });
  });
});
