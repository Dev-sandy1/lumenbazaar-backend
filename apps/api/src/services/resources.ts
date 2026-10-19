import { randomUUID } from "node:crypto";
import { isIP } from "node:net";

import { z } from "zod";

import {
  LumenError,
  type AppConfig,
  type JsonObject,
  type PaymentRequirement,
  type Resource,
  type ResourceSchema,
  type ResourceVersion,
  decodeCursor,
  encodeCursor,
  normalizeLimit,
  validateRouteTemplate
} from "@lumenbazaar/shared";
import {
  assertStellarPublicKey,
  compareExactAmounts,
  normalizeExactAmount,
  requireSupportedAsset
} from "@lumenbazaar/stellar-payments";

import { type AuditLogService } from "./audit.js";
import { type SellerService } from "./sellers.js";

const jsonObjectSchema = z.record(z.string(), z.unknown());

export const createResourceSchema = z.object({
  sellerId: z.string().min(1),
  type: z.enum(["http", "mcp"]),
  name: z.string().trim().min(1).max(160),
  description: z.string().trim().min(1).max(2000),
  url: z.string().url(),
  routeTemplate: z.string().min(1),
  network: z.enum(["stellar:testnet", "stellar:pubnet"]),
  payTo: z.string().min(1),
  assetCode: z.string().min(1).max(12),
  assetIssuer: z.string().min(1),
  amount: z.string().min(1),
  inputSchema: jsonObjectSchema,
  outputSchema: jsonObjectSchema,
  extensions: jsonObjectSchema.default({}),
  status: z.enum(["draft", "active", "inactive"]).default("active")
});

export const updateResourceSchema = createResourceSchema.partial().omit({ sellerId: true });

export const listResourcesSchema = z.object({
  sellerId: z.string().optional(),
  status: z.enum(["draft", "active", "inactive"]).optional(),
  network: z.enum(["stellar:testnet", "stellar:pubnet"]).optional(),
  asset: z.string().optional(),
  type: z.enum(["http", "mcp"]).optional(),
  minPrice: z.string().optional(),
  maxPrice: z.string().optional(),
  extension: z.string().optional(),
  cursor: z.string().optional(),
  limit: z.coerce.number().optional()
});

export type CreateResourceInput = z.output<typeof createResourceSchema>;
export type UpdateResourceInput = z.output<typeof updateResourceSchema>;
export type ListResourceFilters = z.output<typeof listResourcesSchema>;

export type ResourceStore = {
  createResource: (input: CreateResourceInput) => Promise<Resource>;
  getResource: (resourceId: string) => Promise<Resource | undefined>;
  updateResource: (resourceId: string, input: UpdateResourceInput) => Promise<Resource>;
  listResources: (
    filters: ListResourceFilters
  ) => Promise<{ resources: Resource[]; nextCursor: string | null }>;
  createVersion: (resource: Resource, metadata: JsonObject) => Promise<ResourceVersion>;
  getLatestVersion: (resourceId: string) => Promise<ResourceVersion | undefined>;
  getVersion: (resourceId: string, version: number) => Promise<ResourceVersion | undefined>;
  listVersions: (resourceId: string) => Promise<ResourceVersion[]>;
  rollbackResource: (
    resourceId: string,
    patch: UpdateResourceInput,
    metadata: JsonObject
  ) => Promise<{ resource: Resource; version: ResourceVersion }>;
  createSchema: (resource: Resource) => Promise<ResourceSchema>;
  createPaymentRequirement: (resource: Resource) => Promise<PaymentRequirement>;
};

export type ResourceChangeQueue = {
  addResourceIndexingJob: (job: {
    name: "resource.index";
    resourceId: string;
    versionId: string;
  }) => Promise<void>;
};

export class InMemoryResourceStore implements ResourceStore {
  private readonly resources = new Map<string, Resource>();
  private readonly versions = new Map<string, ResourceVersion[]>();
  private readonly schemas = new Map<string, ResourceSchema[]>();
  private readonly paymentRequirements = new Map<string, PaymentRequirement[]>();

  async createResource(input: CreateResourceInput) {
    const now = new Date().toISOString();
    const resource: Resource = {
      id: `resource_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      sellerId: input.sellerId,
      type: input.type,
      name: input.name,
      description: input.description,
      url: input.url,
      routeTemplate: input.routeTemplate,
      network: input.network,
      payTo: input.payTo,
      assetCode: input.assetCode,
      assetIssuer: input.assetIssuer,
      amount: input.amount,
      inputSchema: input.inputSchema as JsonObject,
      outputSchema: input.outputSchema as JsonObject,
      extensions: input.extensions as JsonObject,
      status: input.status,
      createdAt: now,
      updatedAt: now
    };

    this.resources.set(resource.id, resource);
    await this.createVersion(resource, resourceToMetadata(resource));
    await this.createSchema(resource);
    await this.createPaymentRequirement(resource);

    return resource;
  }

  async getResource(resourceId: string) {
    return this.resources.get(resourceId);
  }

  async updateResource(resourceId: string, input: UpdateResourceInput) {
    const existing = this.resources.get(resourceId);

    if (existing === undefined) {
      throw new LumenError("RESOURCE_NOT_FOUND", "Resource was not found.");
    }

    const updated: Resource = {
      ...existing,
      type: input.type ?? existing.type,
      name: input.name ?? existing.name,
      description: input.description ?? existing.description,
      url: input.url ?? existing.url,
      routeTemplate: input.routeTemplate ?? existing.routeTemplate,
      network: input.network ?? existing.network,
      payTo: input.payTo ?? existing.payTo,
      assetCode: input.assetCode ?? existing.assetCode,
      assetIssuer: input.assetIssuer ?? existing.assetIssuer,
      amount: input.amount ?? existing.amount,
      inputSchema: (input.inputSchema ?? existing.inputSchema) as JsonObject,
      outputSchema: (input.outputSchema ?? existing.outputSchema) as JsonObject,
      extensions: (input.extensions ?? existing.extensions) as JsonObject,
      status: input.status ?? existing.status,
      updatedAt: new Date().toISOString()
    };

    this.resources.set(resourceId, updated);
    await this.createVersion(updated, resourceToMetadata(updated));

    return updated;
  }

  async listResources(filters: ListResourceFilters) {
    const limit = normalizeLimit(filters.limit);
    const cursor = decodeCursor(filters.cursor);
    const filtered = [...this.resources.values()]
      .filter((resource) => resourceMatchesFilters(resource, filters))
      .sort(
        (left, right) =>
          left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)
      );
    const startIndex =
      cursor === undefined ? 0 : filtered.findIndex((resource) => resource.id === cursor.id) + 1;
    const page = filtered.slice(Math.max(startIndex, 0), Math.max(startIndex, 0) + limit);
    const last = page.at(-1);

    return {
      resources: page,
      nextCursor:
        last === undefined || startIndex + limit >= filtered.length
          ? null
          : encodeCursor({ id: last.id, createdAt: last.createdAt })
    };
  }

  async createVersion(resource: Resource, metadata: JsonObject) {
    const existing = this.versions.get(resource.id) ?? [];
    const version: ResourceVersion = {
      id: `resource_version_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      resourceId: resource.id,
      version: existing.length + 1,
      metadata,
      createdAt: new Date().toISOString()
    };

    this.versions.set(resource.id, [...existing, version]);
    return version;
  }

  async getLatestVersion(resourceId: string) {
    return this.versions.get(resourceId)?.at(-1);
  }

  async getVersion(resourceId: string, version: number) {
    return this.versions.get(resourceId)?.find((record) => record.version === version);
  }

  async listVersions(resourceId: string) {
    return [...(this.versions.get(resourceId) ?? [])].sort((left, right) => left.version - right.version);
  }

  async rollbackResource(resourceId: string, patch: UpdateResourceInput, metadata: JsonObject) {
    const existing = this.resources.get(resourceId);
    if (existing === undefined) {
      throw new LumenError("RESOURCE_NOT_FOUND", "Resource was not found.");
    }
    const updated: Resource = {
      ...existing,
      ...patch,
      updatedAt: new Date().toISOString()
    };
    this.resources.set(resourceId, updated);
    const version = await this.createVersion(updated, metadata);
    return { resource: updated, version };
  }

  async createSchema(resource: Resource) {
    const existing = this.schemas.get(resource.id) ?? [];
    const schema: ResourceSchema = {
      id: `resource_schema_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      resourceId: resource.id,
      inputSchema: resource.inputSchema,
      outputSchema: resource.outputSchema,
      createdAt: new Date().toISOString()
    };

    this.schemas.set(resource.id, [...existing, schema]);
    return schema;
  }

  async createPaymentRequirement(resource: Resource) {
    const existing = this.paymentRequirements.get(resource.id) ?? [];
    const paymentRequirement: PaymentRequirement = {
      id: `payreq_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      resourceId: resource.id,
      scheme: "exact",
      network: resource.network,
      assetCode: resource.assetCode,
      assetIssuer: resource.assetIssuer,
      amount: resource.amount,
      payTo: resource.payTo,
      createdAt: new Date().toISOString()
    };

    this.paymentRequirements.set(resource.id, [...existing, paymentRequirement]);
    return paymentRequirement;
  }
}

export class ResourceService {
  constructor(
    private readonly config: AppConfig,
    private readonly sellerService: SellerService,
    private readonly store: ResourceStore = new InMemoryResourceStore(),
    private readonly indexingQueue?: ResourceChangeQueue,
    private readonly auditLogService?: AuditLogService
  ) {}

  async createResource(input: unknown, sellerContext?: { sellerId: string; auditable: boolean }) {
    const resource = normalizeResourceInput(createResourceSchema.parse(input), this.config);
    
    // Enforce seller ownership when seller context is provided (authenticated request)
    if (sellerContext?.auditable && resource.sellerId !== sellerContext.sellerId) {
      await this.auditLogService?.record({
        action: "resource.ownership_denied",
        actorType: "seller",
        actorId: sellerContext.sellerId,
        targetType: "resource",
        targetId: undefined,
        metadata: {
          reason: "Attempted to create resource for different seller",
          attemptedSellerId: resource.sellerId,
          actualSellerId: sellerContext.sellerId
        }
      });
      throw new LumenError(
        "FORBIDDEN",
        "API key cannot create resources for another seller."
      );
    }
    
    const seller = await this.sellerService.getSeller(resource.sellerId);
    assertSafeResourceTarget(resource.url, resource.type, resource.routeTemplate, seller.domain);
    const created = await this.store.createResource(resource);
    await this.queueLatestVersion(created.id);
    return created;
  }

  async listResources(input: unknown) {
    const filters = listResourcesSchema.parse(input);
    return this.store.listResources(filters);
  }

  async getResource(resourceId: string) {
    const resource = await this.store.getResource(resourceId);

    if (resource === undefined) {
      throw new LumenError("RESOURCE_NOT_FOUND", "Resource was not found.");
    }

    return resource;
  }

  async updateResource(resourceId: string, input: unknown, sellerContext?: { sellerId: string; auditable: boolean }) {
    const existing = await this.getResource(resourceId);
    
    // Enforce seller ownership when seller context is provided (authenticated request)
    if (sellerContext?.auditable && existing.sellerId !== sellerContext.sellerId) {
      await this.auditLogService?.record({
        action: "resource.ownership_denied",
        actorType: "seller",
        actorId: sellerContext.sellerId,
        targetType: "resource",
        targetId: resourceId,
        metadata: {
          reason: "Attempted to update resource owned by different seller",
          attemptedOperation: "update",
          actualOwnerId: existing.sellerId
        }
      });
      throw new LumenError("FORBIDDEN", "API key does not own this resource.");
    }
    
    const patch = updateResourceSchema.parse(input);
    const normalized = normalizeResourceInput(mergeResourcePatch(existing, patch), this.config);

    const seller = await this.sellerService.getSeller(existing.sellerId);
    assertSafeResourceTarget(
      normalized.url,
      normalized.type,
      normalized.routeTemplate,
      seller.domain
    );
    const updated = await this.store.updateResource(resourceId, normalized);
    await this.queueLatestVersion(updated.id);
    return updated;
  }

  async deleteResource(resourceId: string, sellerContext?: { sellerId: string; auditable: boolean }) {
    return this.updateResource(resourceId, { status: "inactive" }, sellerContext);
  }

  async listResourceVersions(resourceId: string) {
    await this.getResource(resourceId);
    return this.store.listVersions(resourceId);
  }

  async getResourceVersion(resourceId: string, version: number) {
    await this.getResource(resourceId);
    const found = await this.store.getVersion(resourceId, version);
    if (found === undefined) {
      throw new LumenError("RESOURCE_VERSION_NOT_FOUND", "Resource version was not found.");
    }
    return found;
  }

  /**
   * Roll back a resource to a historical version. The historical version is
   * never modified; rollback creates a new immutable version containing the
   * restored data and queues it for reindexing.
   */
  async rollbackResource(resourceId: string, targetVersion: number, sellerContext?: { sellerId: string; auditable: boolean }) {
    const existing = await this.getResource(resourceId);
    
    // Enforce seller ownership when seller context is provided (authenticated request)
    if (sellerContext?.auditable && existing.sellerId !== sellerContext.sellerId) {
      await this.auditLogService?.record({
        action: "resource.ownership_denied",
        actorType: "seller",
        actorId: sellerContext.sellerId,
        targetType: "resource",
        targetId: resourceId,
        metadata: {
          reason: "Attempted to rollback resource owned by different seller",
          attemptedOperation: "rollback",
          targetVersion: targetVersion,
          actualOwnerId: existing.sellerId
        }
      });
      throw new LumenError("FORBIDDEN", "API key does not own this resource.");
    }
    
    const target = await this.store.getVersion(resourceId, targetVersion);
    if (target === undefined) {
      throw new LumenError("RESOURCE_VERSION_NOT_FOUND", "Resource version was not found.");
    }

    const latest = await this.store.getLatestVersion(resourceId);
    if (latest === undefined || target.version >= latest.version) {
      throw new LumenError(
        "CONFLICT",
        "Can only roll back to an older historical version."
      );
    }

    const metadata: JsonObject = {
      ...target.metadata,
      rolledBackFromVersion: target.version,
      rolledBackAt: new Date().toISOString()
    };

    const { resource, version } = await this.store.rollbackResource(
      resourceId,
      target.metadata as unknown as UpdateResourceInput,
      metadata
    );
    await this.queueLatestVersion(resource.id);
    return { resource, version };
  }

  getStore() {
    return this.store;
  }

  private async queueLatestVersion(resourceId: string) {
    const version = await this.store.getLatestVersion(resourceId);
    if (version !== undefined) {
      await this.indexingQueue?.addResourceIndexingJob({
        name: "resource.index",
        resourceId,
        versionId: version.id
      });
    }
  }
}

function normalizeResourceInput<T extends CreateResourceInput | (Resource & UpdateResourceInput)>(
  input: T,
  config: AppConfig
): T {
  assertStellarPublicKey(input.payTo, "payTo");
  if (input.type === "mcp") {
    validateMcpRouteTemplate(input.routeTemplate);
  } else {
    validateRouteTemplate(input.routeTemplate, input.inputSchema as JsonObject);
  }
  assertCatalogJsonSafe(input.inputSchema as JsonObject, "Input schema", 64 * 1024);
  assertCatalogJsonSafe(input.outputSchema as JsonObject, "Output schema", 64 * 1024);
  assertCatalogJsonSafe(input.extensions as JsonObject, "Resource extensions", 32 * 1024);
  const amount = normalizeExactAmount(input.amount);
  const assetCode = input.assetCode.toUpperCase();
  requireSupportedAsset(config, input.network, assetCode, input.assetIssuer);

  return {
    ...input,
    amount,
    assetCode
  };
}

export function resourceMatchesFilters(resource: Resource, filters: ListResourceFilters) {
  return (
    (filters.sellerId === undefined || resource.sellerId === filters.sellerId) &&
    (filters.status === undefined || resource.status === filters.status) &&
    (filters.network === undefined || resource.network === filters.network) &&
    (filters.asset === undefined || resource.assetCode === filters.asset.toUpperCase()) &&
    (filters.type === undefined || resource.type === filters.type) &&
    (filters.minPrice === undefined ||
      compareExactAmounts(resource.amount, filters.minPrice) >= 0) &&
    (filters.maxPrice === undefined ||
      compareExactAmounts(resource.amount, filters.maxPrice) <= 0) &&
    (filters.extension === undefined ||
      Boolean(resource.extensions[filters.extension as keyof typeof resource.extensions]))
  );
}

export function assertSafeResourceTarget(
  urlValue: string,
  resourceType: Resource["type"],
  routeTemplate: string,
  sellerDomain: string
) {
  const url = new URL(urlValue);
  const hostname = url.hostname.toLowerCase();
  const normalizedDomain = sellerDomain.toLowerCase();
  if (url.protocol !== "https:") {
    throw new LumenError("CATALOG_VALIDATION_FAILED", "Resource URL must use HTTPS.");
  }
  if (
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw new LumenError(
      "CATALOG_VALIDATION_FAILED",
      "Resource URL must not contain credentials, query parameters, or fragments."
    );
  }
  if (
    isIP(hostname) !== 0 ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local") ||
    !(hostname === normalizedDomain || hostname.endsWith(`.${normalizedDomain}`))
  ) {
    throw new LumenError(
      "CATALOG_VALIDATION_FAILED",
      "Resource URL must use the verified seller domain and cannot target a local address."
    );
  }
  const pathSegments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  if (resourceType === "mcp") {
    const toolName = routeTemplate.split("/").at(-1);
    if (toolName === undefined || pathSegments.at(-1) !== toolName) {
      throw new LumenError(
        "ROUTE_TEMPLATE_INVALID",
        "MCP resource URL must end with the declared tool name."
      );
    }
    return;
  }

  const templateSegments = routeTemplate.split("/").filter(Boolean);
  const matches =
    templateSegments.length === pathSegments.length &&
    templateSegments.every((segment, index) => {
      const value = pathSegments[index];
      return /^\{[A-Za-z][A-Za-z0-9_]*\}$/u.test(segment)
        ? value !== undefined && value.length > 0
        : segment === value;
    });
  if (!matches) {
    throw new LumenError(
      "ROUTE_TEMPLATE_INVALID",
      "Resource URL path must match the declared route template."
    );
  }
}

function validateMcpRouteTemplate(routeTemplate: string) {
  if (!/^mcp:\/\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_-]+$/u.test(routeTemplate)) {
    throw new LumenError(
      "ROUTE_TEMPLATE_INVALID",
      "MCP route template must use mcp://server/tool format."
    );
  }
}

export function assertCatalogJsonSafe(value: JsonObject, label: string, maxBytes: number) {
  if (Buffer.byteLength(JSON.stringify(value), "utf8") > maxBytes) {
    throw new LumenError("CATALOG_VALIDATION_FAILED", `${label} exceeds ${maxBytes} bytes.`);
  }

  let nodes = 0;
  const visit = (current: unknown, depth: number): void => {
    nodes += 1;
    if (depth > 12 || nodes > 2_000) {
      throw new LumenError(
        "CATALOG_VALIDATION_FAILED",
        `${label} exceeds catalog complexity limits.`
      );
    }
    if (Array.isArray(current)) {
      current.forEach((entry) => visit(entry, depth + 1));
    } else if (typeof current === "object" && current !== null) {
      Object.values(current).forEach((entry) => visit(entry, depth + 1));
    }
  };
  visit(value, 0);
}

function mergeResourcePatch(existing: Resource, patch: UpdateResourceInput): Resource {
  return {
    ...existing,
    type: patch.type ?? existing.type,
    name: patch.name ?? existing.name,
    description: patch.description ?? existing.description,
    url: patch.url ?? existing.url,
    routeTemplate: patch.routeTemplate ?? existing.routeTemplate,
    network: patch.network ?? existing.network,
    payTo: patch.payTo ?? existing.payTo,
    assetCode: patch.assetCode ?? existing.assetCode,
    assetIssuer: patch.assetIssuer ?? existing.assetIssuer,
    amount: patch.amount ?? existing.amount,
    inputSchema: (patch.inputSchema ?? existing.inputSchema) as JsonObject,
    outputSchema: (patch.outputSchema ?? existing.outputSchema) as JsonObject,
    extensions: (patch.extensions ?? existing.extensions) as JsonObject,
    status: patch.status ?? existing.status
  };
}

export function resourceToMetadata(resource: Resource): JsonObject {
  return {
    type: resource.type,
    name: resource.name,
    description: resource.description,
    url: resource.url,
    routeTemplate: resource.routeTemplate,
    network: resource.network,
    payTo: resource.payTo,
    assetCode: resource.assetCode,
    assetIssuer: resource.assetIssuer,
    amount: resource.amount,
    inputSchema: resource.inputSchema,
    outputSchema: resource.outputSchema,
    extensions: resource.extensions,
    status: resource.status
  };
}
