import { describe, expect, it } from "vitest";

import { loadConfig, localIssuerPublicKey } from "@lumenbazaar/shared";

import { AuditLogService, InMemoryAuditLogStore } from "./audit.js";
import { InMemoryResourceStore, ResourceService } from "./resources.js";
import { SellerService } from "./sellers.js";

function resourceInput(sellerId: string) {
  return {
    sellerId,
    type: "http",
    name: "Paid Weather API",
    description: "Returns current weather for a city.",
    url: "https://seller.example/weather/Lagos",
    routeTemplate: "/weather/{city}",
    network: "stellar:testnet",
    payTo: localIssuerPublicKey,
    assetCode: "usdc",
    assetIssuer: localIssuerPublicKey,
    amount: "0.0500000",
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

describe("ResourceService", () => {
  it("creates, lists, updates, and soft-deletes resources with seller ownership", async () => {
    const sellerService = new SellerService();
    const resourceService = new ResourceService(loadConfig({}), sellerService);
    const seller = await sellerService.createSeller({
      displayName: "Weather Seller",
      walletAddress: localIssuerPublicKey,
      domain: "seller.example"
    });
    const resource = await resourceService.createResource(resourceInput(seller.id));

    expect(resource).toMatchObject({
      sellerId: seller.id,
      assetCode: "USDC",
      amount: "0.05",
      status: "active"
    });
    await expect(resourceService.getResource(resource.id)).resolves.toEqual(resource);
    await expect(resourceService.listResources({ sellerId: seller.id })).resolves.toMatchObject({
      resources: [resource],
      nextCursor: null
    });

    const updated = await resourceService.updateResource(resource.id, {
      name: "Paid Forecast API"
    });
    const deleted = await resourceService.deleteResource(resource.id);

    expect(updated.name).toBe("Paid Forecast API");
    expect(deleted.status).toBe("inactive");
  });

  it("rejects resources for missing sellers and unsupported assets", async () => {
    const sellerService = new SellerService();
    const resourceService = new ResourceService(loadConfig({}), sellerService);

    await expect(resourceService.createResource(resourceInput("missing"))).rejects.toMatchObject({
      code: "SELLER_NOT_FOUND"
    });

    const seller = await sellerService.createSeller({
      displayName: "Weather Seller",
      walletAddress: localIssuerPublicKey,
      domain: "seller.example"
    });
    await expect(
      resourceService.createResource({
        ...resourceInput(seller.id),
        assetCode: "EURC"
      })
    ).rejects.toMatchObject({
      code: "UNSUPPORTED_ASSET"
    });
  });

  it.each([
    "http://seller.example/weather/Lagos",
    "https://evil.example/weather/Lagos",
    "https://127.0.0.1/weather/Lagos",
    "https://seller.example/admin/Lagos",
    "https://seller.example/weather/Lagos?target=https://internal.example"
  ])("rejects unsafe or template-conflicting resource target %s", async (url) => {
    const sellerService = new SellerService();
    const resourceService = new ResourceService(loadConfig({}), sellerService);
    const seller = await sellerService.createSeller({
      displayName: "Weather Seller",
      walletAddress: localIssuerPublicKey,
      domain: "seller.example"
    });

    await expect(
      resourceService.createResource({ ...resourceInput(seller.id), url })
    ).rejects.toMatchObject({
      code: expect.stringMatching(/CATALOG_VALIDATION_FAILED|ROUTE_TEMPLATE_INVALID/u)
    });
  });

  it("accepts safe MCP tool targets and rejects tool-name mismatches", async () => {
    const sellerService = new SellerService();
    const resourceService = new ResourceService(loadConfig({}), sellerService);
    const seller = await sellerService.createSeller({
      displayName: "MCP Seller",
      walletAddress: localIssuerPublicKey,
      domain: "seller.example"
    });
    const input = {
      ...resourceInput(seller.id),
      type: "mcp" as const,
      url: "https://seller.example/tools/quote_price",
      routeTemplate: "mcp://catalog/quote_price",
      extensions: {
        mcp: {
          serverName: "catalog",
          toolName: "quote_price"
        }
      }
    };

    await expect(resourceService.createResource(input)).resolves.toMatchObject({
      type: "mcp",
      routeTemplate: "mcp://catalog/quote_price"
    });
    await expect(
      resourceService.createResource({ ...input, url: "https://seller.example/tools/admin" })
    ).rejects.toMatchObject({ code: "ROUTE_TEMPLATE_INVALID" });
  });

  describe("resource versions", () => {
    function setup() {
      const sellerService = new SellerService();
      const store = new InMemoryResourceStore();
      const service = new ResourceService(
        loadConfig({ STELLAR_TESTNET_USDC_ISSUER: localIssuerPublicKey }),
        sellerService,
        store
      );
      return { sellerService, store, service };
    }

    it("creates an immutable version on create and update", async () => {
      const { store, service, sellerService } = setup();
      const seller = await sellerService.createSeller({
        displayName: "Weather Seller",
        walletAddress: localIssuerPublicKey,
        domain: "seller.example"
      });
      const resource = await service.createResource(resourceInput(seller.id));

      const first = await store.getLatestVersion(resource.id);
      expect(first).toMatchObject({ version: 1, metadata: { name: "Paid Weather API" } });

      const updated = await service.updateResource(resource.id, {
        name: "Paid Forecast API"
      });
      expect(updated.name).toBe("Paid Forecast API");

      const second = await store.getLatestVersion(resource.id);
      expect(second).toMatchObject({ version: 2, metadata: { name: "Paid Forecast API" } });

      // The historical version is never rewritten.
      const historical = await store.getVersion(resource.id, 1);
      expect(historical).toMatchObject({ version: 1, metadata: { name: "Paid Weather API" } });
    });

    it("lists versions in order and fetches a specific version", async () => {
      const { service, sellerService } = setup();
      const seller = await sellerService.createSeller({
        displayName: "Weather Seller",
        walletAddress: localIssuerPublicKey,
        domain: "seller.example"
      });
      const resource = await service.createResource(resourceInput(seller.id));
      await service.updateResource(resource.id, { name: "v2" });
      await service.updateResource(resource.id, { name: "v3" });

      const versions = await service.listResourceVersions(resource.id);
      expect(versions.map((version) => version.version)).toEqual([1, 2, 3]);
      expect(versions.map((version) => version.metadata.name)).toEqual([
        "Paid Weather API",
        "v2",
        "v3"
      ]);

      const specific = await service.getResourceVersion(resource.id, 2);
      expect(specific.version).toBe(2);
      expect(specific.metadata.name).toBe("v2");
    });

    it("rolls back to a historical version by creating a new version", async () => {
      const { store, service, sellerService } = setup();
      const seller = await sellerService.createSeller({
        displayName: "Weather Seller",
        walletAddress: localIssuerPublicKey,
        domain: "seller.example"
      });
      const resource = await service.createResource(resourceInput(seller.id));
      await service.updateResource(resource.id, { name: "v2" });

      const rolledBack = await service.rollbackResource(resource.id, 1);

      expect(rolledBack.version.version).toBe(3);
      expect(rolledBack.resource.name).toBe("Paid Weather API");
      expect(rolledBack.version.metadata.rolledBackFromVersion).toBe(1);

      const latest = await store.getLatestVersion(resource.id);
      expect(latest!.version).toBe(3);
      expect(latest!.metadata.name).toBe("Paid Weather API");

      // Historical versions stay intact.
      expect((await store.getVersion(resource.id, 1))!.metadata.name).toBe("Paid Weather API");
      expect((await store.getVersion(resource.id, 2))!.metadata.name).toBe("v2");
    });

    it("rejects rollback to an unknown version", async () => {
      const { service, sellerService } = setup();
      const seller = await sellerService.createSeller({
        displayName: "Weather Seller",
        walletAddress: localIssuerPublicKey,
        domain: "seller.example"
      });
      const resource = await service.createResource(resourceInput(seller.id));

      await expect(service.rollbackResource(resource.id, 42)).rejects.toMatchObject({
        code: "RESOURCE_VERSION_NOT_FOUND"
      });
    });

    it("rejects rollback to the current or a newer version", async () => {
      const { store, service, sellerService } = setup();
      const seller = await sellerService.createSeller({
        displayName: "Weather Seller",
        walletAddress: localIssuerPublicKey,
        domain: "seller.example"
      });
      const resource = await service.createResource(resourceInput(seller.id));
      await service.updateResource(resource.id, { name: "v2" });
      const latest = (await store.getLatestVersion(resource.id))!.version;

      await expect(service.rollbackResource(resource.id, latest)).rejects.toMatchObject({
        code: "CONFLICT"
      });
    });

    it("queues the rolled-back version for reindexing", async () => {
      const jobs: Array<{ name: "resource.index"; resourceId: string; versionId: string }> = [];
      const indexingQueue = {
        addResourceIndexingJob: async (job: {
          name: "resource.index";
          resourceId: string;
          versionId: string;
        }) => {
          jobs.push(job);
        }
      };
      const sellerService = new SellerService();
      const store = new InMemoryResourceStore();
      const service = new ResourceService(
        loadConfig({ STELLAR_TESTNET_USDC_ISSUER: localIssuerPublicKey }),
        sellerService,
        store,
        indexingQueue
      );
      const seller = await sellerService.createSeller({
        displayName: "Weather Seller",
        walletAddress: localIssuerPublicKey,
        domain: "seller.example"
      });
      const resource = await service.createResource(resourceInput(seller.id));
      await service.updateResource(resource.id, { name: "v2" });

      const rolledBack = await service.rollbackResource(resource.id, 1);

      expect(
        jobs.some((job) => job.versionId === rolledBack.version.id)
      ).toBe(true);
      expect(
        jobs.some((job) => job.resourceId === resource.id)
      ).toBe(true);
    });
  });

  describe("seller ownership enforcement", () => {
    function setup() {
      const sellerService = new SellerService();
      const store = new InMemoryResourceStore();
      const auditLogStore = new InMemoryAuditLogStore();
      const auditLogService = new AuditLogService(auditLogStore);
      const service = new ResourceService(
        loadConfig({ STELLAR_TESTNET_USDC_ISSUER: localIssuerPublicKey }),
        sellerService,
        store,
        undefined,
        auditLogService
      );
      return { sellerService, store, service, auditLogStore, auditLogService };
    }

    it("allows resource creation when seller context matches", async () => {
      const { service, sellerService } = setup();
      const seller = await sellerService.createSeller({
        displayName: "Weather Seller",
        walletAddress: localIssuerPublicKey,
        domain: "seller.example"
      });

      const resource = await service.createResource(resourceInput(seller.id), {
        sellerId: seller.id,
        auditable: true
      });

      expect(resource.sellerId).toBe(seller.id);
    });

    it("denies resource creation when seller context mismatches", async () => {
      const { service, sellerService, auditLogStore } = setup();
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

      // Seller 2's API key tries to create a resource for Seller 1
      await expect(
        service.createResource(resourceInput(seller1.id), {
          sellerId: seller2.id,
          auditable: true
        })
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringMatching(/cannot create resources for another seller/i)
      });

      // Verify ownership denial was audited
      const logs = await auditLogStore.list();
      const ownershipDenial = logs.find(
        (log) =>
          log.action === "resource.ownership_denied" &&
          log.actorId === seller2.id &&
          log.targetType === "resource"
      );
      expect(ownershipDenial).toBeDefined();
      expect(ownershipDenial!.metadata).toMatchObject({
        reason: "Attempted to create resource for different seller",
        attemptedSellerId: seller1.id,
        actualSellerId: seller2.id
      });
    });

    it("allows resource update when seller context matches", async () => {
      const { service, sellerService } = setup();
      const seller = await sellerService.createSeller({
        displayName: "Weather Seller",
        walletAddress: localIssuerPublicKey,
        domain: "seller.example"
      });
      const resource = await service.createResource(resourceInput(seller.id));

      const updated = await service.updateResource(
        resource.id,
        { name: "Updated Name" },
        {
          sellerId: seller.id,
          auditable: true
        }
      );

      expect(updated.name).toBe("Updated Name");
    });

    it("denies resource update when seller context mismatches", async () => {
      const { service, sellerService, auditLogStore } = setup();
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
      const resource = await service.createResource(resourceInput(seller1.id));

      // Seller 2's API key tries to update Seller 1's resource
      await expect(
        service.updateResource(
          resource.id,
          { name: "Hacked Name" },
          {
            sellerId: seller2.id,
            auditable: true
          }
        )
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringMatching(/does not own this resource/i)
      });

      // Verify ownership denial was audited
      const logs = await auditLogStore.list();
      const ownershipDenial = logs.find(
        (log) =>
          log.action === "resource.ownership_denied" &&
          log.actorId === seller2.id &&
          log.targetId === resource.id
      );
      expect(ownershipDenial).toBeDefined();
      expect(ownershipDenial!.metadata).toMatchObject({
        reason: expect.stringMatching(/attempted to update resource owned by different seller/i),
        attemptedOperation: "update",
        actualOwnerId: seller1.id
      });
    });

    it("allows resource deletion when seller context matches", async () => {
      const { service, sellerService } = setup();
      const seller = await sellerService.createSeller({
        displayName: "Weather Seller",
        walletAddress: localIssuerPublicKey,
        domain: "seller.example"
      });
      const resource = await service.createResource(resourceInput(seller.id));

      const deleted = await service.deleteResource(resource.id, {
        sellerId: seller.id,
        auditable: true
      });

      expect(deleted.status).toBe("inactive");
    });

    it("denies resource deletion when seller context mismatches", async () => {
      const { service, sellerService, auditLogStore } = setup();
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
      const resource = await service.createResource(resourceInput(seller1.id));

      // Seller 2's API key tries to delete Seller 1's resource
      await expect(
        service.deleteResource(resource.id, {
          sellerId: seller2.id,
          auditable: true
        })
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringMatching(/does not own this resource/i)
      });

      // Verify ownership denial was audited
      const logs = await auditLogStore.list();
      const ownershipDenial = logs.find(
        (log) =>
          log.action === "resource.ownership_denied" &&
          log.actorId === seller2.id &&
          log.targetId === resource.id
      );
      expect(ownershipDenial).toBeDefined();
    });

    it("allows resource rollback when seller context matches", async () => {
      const { service, sellerService } = setup();
      const seller = await sellerService.createSeller({
        displayName: "Weather Seller",
        walletAddress: localIssuerPublicKey,
        domain: "seller.example"
      });
      const resource = await service.createResource(resourceInput(seller.id));
      await service.updateResource(resource.id, { name: "v2" });

      const rolledBack = await service.rollbackResource(resource.id, 1, {
        sellerId: seller.id,
        auditable: true
      });

      expect(rolledBack.resource.name).toBe("Paid Weather API");
    });

    it("denies resource rollback when seller context mismatches", async () => {
      const { service, sellerService, auditLogStore } = setup();
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
      const resource = await service.createResource(resourceInput(seller1.id));
      await service.updateResource(resource.id, { name: "v2" });

      // Seller 2's API key tries to rollback Seller 1's resource
      await expect(
        service.rollbackResource(resource.id, 1, {
          sellerId: seller2.id,
          auditable: true
        })
      ).rejects.toMatchObject({
        code: "FORBIDDEN",
        message: expect.stringMatching(/does not own this resource/i)
      });

      // Verify ownership denial was audited
      const logs = await auditLogStore.list();
      const ownershipDenial = logs.find(
        (log) =>
          log.action === "resource.ownership_denied" &&
          log.actorId === seller2.id &&
          log.targetId === resource.id &&
          log.metadata.attemptedOperation === "rollback"
      );
      expect(ownershipDenial).toBeDefined();
      expect(ownershipDenial!.metadata).toMatchObject({
        reason: expect.stringMatching(/attempted to rollback resource owned by different seller/i),
        targetVersion: 1,
        actualOwnerId: seller1.id
      });
    });

    it("allows unauthenticated mutations (seller context undefined)", async () => {
      const { service, sellerService } = setup();
      const seller = await sellerService.createSeller({
        displayName: "Weather Seller",
        walletAddress: localIssuerPublicKey,
        domain: "seller.example"
      });

      // Unauthenticated create (no seller context)
      const resource = await service.createResource(resourceInput(seller.id), undefined);
      expect(resource.sellerId).toBe(seller.id);

      // Unauthenticated update
      const updated = await service.updateResource(
        resource.id,
        { name: "Updated" },
        undefined
      );
      expect(updated.name).toBe("Updated");
    });

    it("records authorization failures before side effects", async () => {
      const { service, sellerService, store, auditLogStore } = setup();
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
      const resource = await service.createResource(resourceInput(seller1.id));
      const resourceCountBefore = (await store.listResources({})).resources.length;

      // Attempt cross-seller update (should fail)
      await expect(
        service.updateResource(
          resource.id,
          { name: "Malicious Update" },
          {
            sellerId: seller2.id,
            auditable: true
          }
        )
      ).rejects.toThrow();

      // Verify no actual update occurred (side effect prevented)
      const resourceAfter = await store.getResource(resource.id);
      expect(resourceAfter!.name).toBe("Paid Weather API");

      // Verify audit log was created (before attempting update)
      const logs = await auditLogStore.list();
      expect(logs.some((log) => log.action === "resource.ownership_denied")).toBe(true);
    });
  });
});
