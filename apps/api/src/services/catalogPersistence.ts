import { randomUUID } from "node:crypto";

import { Prisma, PrismaClient } from "@prisma/client";
import { Queue } from "bullmq";
import { Redis } from "ioredis";

import {
  decodeCursor,
  encodeCursor,
  isSellerApiKeyScope,
  isSupportedNetwork,
  LumenError,
  normalizeLimit,
  type AppConfig,
  type CatalogEvent,
  type JsonObject,
  type PaymentRequirement,
  type Resource,
  type ResourceSchema,
  type ResourceVersion,
  type SearchDocument,
  type Seller,
  type SellerApiKey,
  type SellerApiKeyScope,
  type SellerDomain
} from "@lumenbazaar/shared";

import {
  InMemoryCatalogEventStore,
  InMemoryResourceIndexingQueue,
  type CatalogEventStore,
  type ResourceIndexingJob,
  type ResourceIndexingQueue
} from "./cataloging.js";
import {
  InMemoryResourceStore,
  resourceMatchesFilters,
  resourceToMetadata,
  type CreateResourceInput,
  type ListResourceFilters,
  type ResourceStore,
  type UpdateResourceInput
} from "./resources.js";
import {
  InMemorySearchDocumentStore,
  type SearchDocumentStore
} from "./search.js";
import {
  InMemorySellerApiKeyStore,
  type SellerApiKeyRecord,
  type SellerApiKeyStore
} from "./sellerApiKeys.js";
import { InMemorySellerStore, type CreateSellerInput, type SellerStore } from "./sellers.js";

export class PrismaSellerStore implements SellerStore {
  constructor(private readonly db: PrismaClient) {}

  async createSeller(input: CreateSellerInput) {
    try {
      return mapSeller(await this.db.seller.create({ data: input }));
    } catch (error) {
      if (isUniqueViolation(error)) {
        throw new LumenError("VALIDATION_FAILED", "Seller wallet address already exists.");
      }
      throw error;
    }
  }

  async getSeller(sellerId: string) {
    const row = await this.db.seller.findUnique({ where: { id: sellerId } });
    return row === null ? undefined : mapSeller(row);
  }

  async findSellerByWallet(walletAddress: string) {
    const row = await this.db.seller.findUnique({ where: { walletAddress } });
    return row === null ? undefined : mapSeller(row);
  }

  async upsertDomainChallenge(
    sellerId: string,
    domain: string,
    method: SellerDomain["verificationMethod"]
  ) {
    return mapSellerDomain(
      await this.db.sellerDomain.upsert({
        where: { sellerId_domain: { sellerId, domain } },
        create: {
          sellerId,
          domain,
          verificationMethod: method,
          challengeToken: `lumenbazaar-${randomUUID().replaceAll("-", "")}`
        },
        update: {}
      })
    );
  }

  async markDomainVerified(sellerId: string, domain: string) {
    const verifiedAt = new Date();
    return this.db.$transaction(async (tx) => {
      const seller = await tx.seller.update({
        where: { id: sellerId, domain },
        data: { domainVerifiedAt: verifiedAt }
      });
      await tx.sellerDomain.updateMany({
        where: { sellerId, domain },
        data: { verifiedAt }
      });
      return mapSeller(seller);
    });
  }
}

export class PrismaResourceStore implements ResourceStore {
  constructor(private readonly db: PrismaClient) {}

  async createResource(input: CreateResourceInput) {
    return this.db.$transaction(async (tx) => {
      const resource = mapResource(await tx.resource.create({ data: resourceCreateData(input) }));
      await tx.resourceVersion.create({
        data: { resourceId: resource.id, version: 1, metadata: json(resourceToMetadata(resource)) }
      });
      await tx.resourceSchema.create({ data: resourceSchemaData(resource) });
      await tx.paymentRequirement.create({ data: paymentRequirementData(resource) });
      return resource;
    });
  }

  async getResource(resourceId: string) {
    const row = await this.db.resource.findUnique({ where: { id: resourceId } });
    return row === null ? undefined : mapResource(row);
  }

  async updateResource(resourceId: string, input: UpdateResourceInput) {
    return this.db.$transaction(async (tx) => {
      const resource = mapResource(
        await tx.resource.update({
          where: { id: resourceId },
          data: resourceUpdateData(input)
        })
      );
      const latest = await tx.resourceVersion.aggregate({
        where: { resourceId },
        _max: { version: true }
      });
      await tx.resourceVersion.create({
        data: {
          resourceId,
          version: (latest._max.version ?? 0) + 1,
          metadata: json(resourceToMetadata(resource))
        }
      });
      await tx.resourceSchema.create({ data: resourceSchemaData(resource) });
      await tx.paymentRequirement.create({ data: paymentRequirementData(resource) });
      await tx.searchDocument.updateMany({
        where: { resourceId },
        data: { stale: true }
      });
      return resource;
    });
  }

  async listResources(filters: ListResourceFilters) {
    const resources = (
      await this.db.resource.findMany({ orderBy: [{ createdAt: "asc" }, { id: "asc" }] })
    )
      .map(mapResource)
      .filter((resource) => resourceMatchesFilters(resource, filters));
    const limit = normalizeLimit(filters.limit);
    const cursor = decodeCursor(filters.cursor);
    const startIndex =
      cursor === undefined ? 0 : resources.findIndex((resource) => resource.id === cursor.id) + 1;
    const page = resources.slice(Math.max(startIndex, 0), Math.max(startIndex, 0) + limit);
    const last = page.at(-1);
    return {
      resources: page,
      nextCursor:
        last === undefined || startIndex + limit >= resources.length
          ? null
          : encodeCursor({ id: last.id, createdAt: last.createdAt })
    };
  }

  async createVersion(resource: Resource, metadata: JsonObject) {
    const latest = await this.db.resourceVersion.aggregate({
      where: { resourceId: resource.id },
      _max: { version: true }
    });
    return mapResourceVersion(
      await this.db.resourceVersion.create({
        data: {
          resourceId: resource.id,
          version: (latest._max.version ?? 0) + 1,
          metadata: json(metadata)
        }
      })
    );
  }

  async getLatestVersion(resourceId: string) {
    const row = await this.db.resourceVersion.findFirst({
      where: { resourceId },
      orderBy: { version: "desc" }
    });
    return row === null ? undefined : mapResourceVersion(row);
  }

  async createSchema(resource: Resource) {
    return mapResourceSchema(
      await this.db.resourceSchema.create({ data: resourceSchemaData(resource) })
    );
  }

  async createPaymentRequirement(resource: Resource) {
    return mapPaymentRequirement(
      await this.db.paymentRequirement.create({ data: paymentRequirementData(resource) })
    );
  }
}

export class PrismaSellerApiKeyStore implements SellerApiKeyStore {
  constructor(private readonly db: PrismaClient) {}

  async create(input: {
    sellerId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    scopes: SellerApiKeyScope[];
    expiresAt: Date | null;
  }) {
    return mapSellerApiKey(
      await this.db.sellerApiKey.create({
        data: {
          sellerId: input.sellerId,
          name: input.name,
          keyPrefix: input.keyPrefix,
          keyHash: input.keyHash,
          scopes: input.scopes as unknown as Prisma.InputJsonValue,
          expiresAt: input.expiresAt
        }
      })
    );
  }

  async list(sellerId: string) {
    const rows = await this.db.sellerApiKey.findMany({
      where: { sellerId },
      orderBy: { createdAt: "desc" }
    });
    return rows.map(mapSellerApiKey);
  }

  async get(keyId: string) {
    const row = await this.db.sellerApiKey.findUnique({ where: { id: keyId } });
    return row === null ? undefined : mapSellerApiKey(row);
  }

  async findByPrefix(keyPrefix: string) {
    const rows = await this.db.sellerApiKey.findMany({ where: { keyPrefix } });
    return rows.map(mapSellerApiKey);
  }

  async markRevoked(keyId: string, revokedAt: Date) {
    return mapSellerApiKey(
      await this.db.sellerApiKey.update({
        where: { id: keyId },
        data: { status: "revoked", revokedAt }
      })
    );
  }

  async markRotatedOut(keyId: string, rotatedOutAt: Date) {
    return mapSellerApiKey(
      await this.db.sellerApiKey.update({
        where: { id: keyId },
        data: { rotatedOutAt }
      })
    );
  }

  async touchLastUsed(keyId: string, lastUsedAt: Date) {
    await this.db.sellerApiKey.updateMany({
      where: { id: keyId },
      data: { lastUsedAt }
    });
  }
}

export class PrismaCatalogEventStore implements CatalogEventStore {
  constructor(private readonly db: PrismaClient) {}

  async createCatalogEvent(input: Omit<CatalogEvent, "id" | "createdAt">, tx?: Prisma.TransactionClient) {
    // Use provided transaction client if available, otherwise use root client
    const client = tx ?? this.db;
    return mapCatalogEvent(
      await client.catalogEvent.create({
        data: { ...input, metadata: json(input.metadata) }
      })
    );
  }
}

export class PrismaSearchDocumentStore implements SearchDocumentStore {
  constructor(private readonly db: PrismaClient) {}

  async get(resourceId: string) {
    const row = await this.db.searchDocument.findUnique({ where: { resourceId } });
    return row === null ? undefined : mapSearchDocument(row);
  }

  async upsert(document: SearchDocument) {
    return mapSearchDocument(
      await this.db.searchDocument.upsert({
        where: { resourceId: document.resourceId },
        create: {
          id: document.id,
          resourceId: document.resourceId,
          sellerId: document.sellerId,
          body: document.body,
          ranking: json(document.ranking),
          indexedAt: new Date(document.indexedAt ?? document.updatedAt),
          stale: document.stale
        },
        update: {
          sellerId: document.sellerId,
          body: document.body,
          ranking: json(document.ranking),
          indexedAt: new Date(document.indexedAt ?? document.updatedAt),
          stale: document.stale
        }
      })
    );
  }
}

class BullMqResourceIndexingQueue implements ResourceIndexingQueue {
  constructor(private readonly queue: Queue<ResourceIndexingJob>) {}

  async addResourceIndexingJob(job: ResourceIndexingJob) {
    await this.queue.add(job.name, job, {
      jobId: `resource-index-${job.resourceId}-${job.versionId}`,
      attempts: 5,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: false
    });
  }
}

export function createCatalogPersistence(config: AppConfig) {
  if (
    process.env.VITEST !== undefined ||
    process.env.NODE_ENV === "test" ||
    config.nodeEnv !== "production" ||
    config.lumenEnv === "local"
  ) {
  return {
    sellerStore: new InMemorySellerStore() as SellerStore,
    sellerApiKeyStore: new InMemorySellerApiKeyStore() as SellerApiKeyStore,
    resourceStore: new InMemoryResourceStore() as ResourceStore,
      eventStore: new InMemoryCatalogEventStore() as CatalogEventStore,
      searchDocumentStore: new InMemorySearchDocumentStore() as SearchDocumentStore,
      indexingQueue: new InMemoryResourceIndexingQueue() as ResourceIndexingQueue,
      close: async () => undefined
    };
  }

  const db = new PrismaClient({ datasources: { db: { url: config.databaseUrl } } });
  const redis = new Redis(config.redisUrl, { maxRetriesPerRequest: null });
  const queue = new Queue<ResourceIndexingJob>("resource-indexing", { connection: redis });
  return {
    sellerStore: new PrismaSellerStore(db) as SellerStore,
    sellerApiKeyStore: new PrismaSellerApiKeyStore(db) as SellerApiKeyStore,
    resourceStore: new PrismaResourceStore(db) as ResourceStore,
    eventStore: new PrismaCatalogEventStore(db) as CatalogEventStore,
    searchDocumentStore: new PrismaSearchDocumentStore(db) as SearchDocumentStore,
    indexingQueue: new BullMqResourceIndexingQueue(queue) as ResourceIndexingQueue,
    close: async () => {
      await queue.close();
      await redis.quit();
      await db.$disconnect();
    }
  };
}

function resourceCreateData(input: CreateResourceInput): Prisma.ResourceUncheckedCreateInput {
  return {
    ...input,
    amount: input.amount,
    inputSchema: json(input.inputSchema as JsonObject),
    outputSchema: json(input.outputSchema as JsonObject),
    extensions: json(input.extensions as JsonObject)
  };
}

function resourceUpdateData(input: UpdateResourceInput): Prisma.ResourceUncheckedUpdateInput {
  return {
    ...(input.type === undefined ? {} : { type: input.type }),
    ...(input.name === undefined ? {} : { name: input.name }),
    ...(input.description === undefined ? {} : { description: input.description }),
    ...(input.url === undefined ? {} : { url: input.url }),
    ...(input.routeTemplate === undefined ? {} : { routeTemplate: input.routeTemplate }),
    ...(input.network === undefined ? {} : { network: input.network }),
    ...(input.payTo === undefined ? {} : { payTo: input.payTo }),
    ...(input.assetCode === undefined ? {} : { assetCode: input.assetCode }),
    ...(input.assetIssuer === undefined ? {} : { assetIssuer: input.assetIssuer }),
    ...(input.amount === undefined ? {} : { amount: input.amount }),
    ...(input.inputSchema === undefined
      ? {}
      : { inputSchema: json(input.inputSchema as JsonObject) }),
    ...(input.outputSchema === undefined
      ? {}
      : { outputSchema: json(input.outputSchema as JsonObject) }),
    ...(input.extensions === undefined ? {} : { extensions: json(input.extensions as JsonObject) }),
    ...(input.status === undefined ? {} : { status: input.status })
  };
}

function resourceSchemaData(resource: Resource): Prisma.ResourceSchemaUncheckedCreateInput {
  return {
    resourceId: resource.id,
    inputSchema: json(resource.inputSchema),
    outputSchema: json(resource.outputSchema)
  };
}

function paymentRequirementData(resource: Resource): Prisma.PaymentRequirementUncheckedCreateInput {
  return {
    resourceId: resource.id,
    scheme: "exact",
    network: resource.network,
    assetCode: resource.assetCode,
    assetIssuer: resource.assetIssuer,
    amount: resource.amount,
    payTo: resource.payTo
  };
}

function mapSeller(row: Prisma.SellerGetPayload<object>): Seller {
  return {
    ...row,
    domainVerifiedAt: row.domainVerifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function mapSellerDomain(row: Prisma.SellerDomainGetPayload<object>): SellerDomain {
  return {
    ...row,
    verificationMethod: row.verificationMethod as SellerDomain["verificationMethod"],
    verifiedAt: row.verifiedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function mapResource(row: Prisma.ResourceGetPayload<object>): Resource {
  if (!isSupportedNetwork(row.network)) {
    throw new Error("Stored resource network is not supported.");
  }
  return {
    ...row,
    type: row.type as Resource["type"],
    network: row.network,
    amount: row.amount.toString(),
    inputSchema: row.inputSchema as JsonObject,
    outputSchema: row.outputSchema as JsonObject,
    extensions: row.extensions as JsonObject,
    status: row.status as Resource["status"],
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function mapResourceVersion(row: Prisma.ResourceVersionGetPayload<object>): ResourceVersion {
  return { ...row, metadata: row.metadata as JsonObject, createdAt: row.createdAt.toISOString() };
}

function mapResourceSchema(row: Prisma.ResourceSchemaGetPayload<object>): ResourceSchema {
  return {
    ...row,
    inputSchema: row.inputSchema as JsonObject,
    outputSchema: row.outputSchema as JsonObject,
    createdAt: row.createdAt.toISOString()
  };
}

function mapPaymentRequirement(
  row: Prisma.PaymentRequirementGetPayload<object>
): PaymentRequirement {
  if (!isSupportedNetwork(row.network)) {
    throw new Error("Stored payment requirement network is not supported.");
  }
  return {
    ...row,
    scheme: row.scheme as PaymentRequirement["scheme"],
    network: row.network,
    amount: row.amount.toString(),
    createdAt: row.createdAt.toISOString()
  };
}

function mapCatalogEvent(row: Prisma.CatalogEventGetPayload<object>): CatalogEvent {
  return {
    ...row,
    type: row.type as CatalogEvent["type"],
    metadata: row.metadata as JsonObject,
    createdAt: row.createdAt.toISOString()
  };
}

function mapSearchDocument(row: Prisma.SearchDocumentGetPayload<object>): SearchDocument {
  return {
    ...row,
    ranking: row.ranking as JsonObject,
    indexedAt: row.indexedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function mapSellerApiKey(row: Prisma.SellerApiKeyGetPayload<object>): SellerApiKeyRecord {
  const scopes = row.scopes as unknown;
  if (
    !Array.isArray(scopes) ||
    scopes.some((scope) => typeof scope !== "string" || !isSellerApiKeyScope(scope))
  ) {
    throw new Error("Stored seller API key scopes are invalid.");
  }
  return {
    id: row.id,
    sellerId: row.sellerId,
    name: row.name,
    keyPrefix: row.keyPrefix,
    keyHash: row.keyHash,
    scopes: scopes as SellerApiKeyScope[],
    status: row.status as SellerApiKey["status"],
    expiresAt: row.expiresAt?.toISOString() ?? null,
    lastUsedAt: row.lastUsedAt?.toISOString() ?? null,
    revokedAt: row.revokedAt?.toISOString() ?? null,
    rotatedOutAt: row.rotatedOutAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  };
}

function json(value: JsonObject) {
  return value as Prisma.InputJsonValue;
}

function isUniqueViolation(error: unknown) {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}
