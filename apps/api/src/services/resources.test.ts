import { describe, expect, it } from "vitest";

import { loadConfig, localIssuerPublicKey } from "@lumenbazaar/shared";

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
});
