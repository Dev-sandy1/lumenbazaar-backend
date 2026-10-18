import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import {
  LumenError,
  SELLER_API_KEY_MAX_TTL_DAYS,
  SELLER_API_KEY_PREFIX,
  SELLER_API_KEY_ROTATION_OVERLAP_SECONDS,
  sellerApiKeyScopeSchema,
  type SellerApiKey,
  type SellerApiKeyPrincipal,
  type SellerApiKeyScope
} from "@lumenbazaar/shared";

import { type AuditLogService } from "./audit.js";

export const createSellerApiKeySchema = z.object({
  name: z.string().trim().min(1).max(120),
  scopes: z
    .array(sellerApiKeyScopeSchema)
    .min(1)
    .refine((scopes) => new Set(scopes).size === scopes.length, {
      message: "Scopes must not contain duplicates."
    }),
  expiresInDays: z.number().int().min(1).max(SELLER_API_KEY_MAX_TTL_DAYS).optional()
});

export type CreateSellerApiKeyInput = z.output<typeof createSellerApiKeySchema>;

export type SellerApiKeyRecord = SellerApiKey & {
  /** SHA-256 hex digest of the full plaintext key. Never leaves the store. */
  keyHash: string;
};

/**
 * A key record paired with its plaintext. Only ever produced by the store
 * during issuance/rotation and stripped before any response is returned.
 */
export type SellerApiKeyIssuance = SellerApiKeyRecord & {
  key: string;
};

export type SellerApiKeyStore = {
  create: (input: {
    sellerId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    scopes: SellerApiKeyScope[];
    expiresAt: Date | null;
  }) => Promise<SellerApiKeyRecord>;
  list: (sellerId: string) => Promise<SellerApiKeyRecord[]>;
  get: (keyId: string) => Promise<SellerApiKeyRecord | undefined>;
  findByPrefix: (keyPrefix: string) => Promise<SellerApiKeyRecord[]>;
  markRevoked: (keyId: string, revokedAt: Date) => Promise<SellerApiKeyRecord>;
  markRotatedOut: (keyId: string, rotatedOutAt: Date) => Promise<SellerApiKeyRecord>;
  touchLastUsed: (keyId: string, lastUsedAt: Date) => Promise<void>;
};

export class InMemorySellerApiKeyStore implements SellerApiKeyStore {
  private readonly keys = new Map<string, SellerApiKeyRecord>();

  async create(input: {
    sellerId: string;
    name: string;
    keyPrefix: string;
    keyHash: string;
    scopes: SellerApiKeyScope[];
    expiresAt: Date | null;
  }) {
    const now = new Date().toISOString();
    const record: SellerApiKeyRecord = {
      id: `apikey_${randomBytes(12).toString("hex")}`,
      sellerId: input.sellerId,
      name: input.name,
      keyPrefix: input.keyPrefix,
      keyHash: input.keyHash,
      scopes: [...input.scopes],
      status: "active",
      expiresAt: input.expiresAt?.toISOString() ?? null,
      lastUsedAt: null,
      revokedAt: null,
      rotatedOutAt: null,
      createdAt: now,
      updatedAt: now
    };

    this.keys.set(record.id, record);
    return { ...record, scopes: [...record.scopes] };
  }

  async list(sellerId: string) {
    return [...this.keys.values()]
      .filter((record) => record.sellerId === sellerId)
      .map((record) => ({ ...record, scopes: [...record.scopes] }));
  }

  async get(keyId: string) {
    const record = this.keys.get(keyId);
    return record === undefined ? undefined : { ...record, scopes: [...record.scopes] };
  }

  async findByPrefix(keyPrefix: string) {
    return [...this.keys.values()]
      .filter((record) => record.keyPrefix === keyPrefix)
      .map((record) => ({ ...record, scopes: [...record.scopes] }));
  }

  async markRevoked(keyId: string, revokedAt: Date) {
    const record = this.requireRecord(keyId);
    const updated: SellerApiKeyRecord = {
      ...record,
      status: "revoked",
      revokedAt: revokedAt.toISOString(),
      updatedAt: revokedAt.toISOString()
    };
    this.keys.set(keyId, updated);
    return { ...updated, scopes: [...updated.scopes] };
  }

  async markRotatedOut(keyId: string, rotatedOutAt: Date) {
    const record = this.requireRecord(keyId);
    const updated: SellerApiKeyRecord = {
      ...record,
      rotatedOutAt: rotatedOutAt.toISOString(),
      updatedAt: rotatedOutAt.toISOString()
    };
    this.keys.set(keyId, updated);
    return { ...updated, scopes: [...updated.scopes] };
  }

  async touchLastUsed(keyId: string, lastUsedAt: Date) {
    const record = this.keys.get(keyId);
    if (record !== undefined) {
      this.keys.set(keyId, {
        ...record,
        lastUsedAt: lastUsedAt.toISOString(),
        updatedAt: lastUsedAt.toISOString()
      });
    }
  }

  private requireRecord(keyId: string) {
    const record = this.keys.get(keyId);
    if (record === undefined) {
      throw new LumenError("UNAUTHORIZED", "API key was not found.");
    }
    return record;
  }
}

/**
 * Generate a seller API key plaintext: `lbk_<prefix>_<secret>`.
 * The prefix is stored so keys can be located by hash lookup; the secret
 * carries 256 bits of entropy.
 */
export function generateSellerApiKey(): { key: string; keyPrefix: string; keyHash: string } {
  const keyPrefix = randomBytes(6).toString("hex");
  const secret = randomBytes(32).toString("base64url");
  const key = `${SELLER_API_KEY_PREFIX}_${keyPrefix}_${secret}`;
  return { key, keyPrefix, keyHash: hashSellerApiKey(key) };
}

/**
 * Hash a seller API key for storage/lookup. Plaintext keys are never persisted.
 */
export function hashSellerApiKey(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex");
}

const sellerApiKeyPattern = new RegExp(`^${SELLER_API_KEY_PREFIX}_([0-9a-f]{12})_(.+)$`, "u");

function parseSellerApiKey(key: string): { keyPrefix: string } | undefined {
  const match = sellerApiKeyPattern.exec(key);
  if (match === null) {
    return undefined;
  }
  const [, keyPrefix, secret] = match;
  if (keyPrefix === undefined || secret === undefined || secret.length < 32) {
    return undefined;
  }
  return { keyPrefix };
}

function constantTimeEquals(left: string, right: string) {
  const leftBuffer = Buffer.from(left, "utf8");
  const rightBuffer = Buffer.from(right, "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

export class SellerApiKeyService {
  constructor(
    private readonly store: SellerApiKeyStore = new InMemorySellerApiKeyStore(),
    private readonly auditLogService?: AuditLogService,
    private readonly now: () => Date = () => new Date()
  ) {}

  /**
   * Issue a new scoped API key. The plaintext is returned exactly once and
   * only its SHA-256 hash is persisted.
   */
  async createKey(sellerId: string, input: unknown) {
    const request = createSellerApiKeySchema.parse(input);
    const generated = generateSellerApiKey();
    const expiresAt =
      request.expiresInDays === undefined
        ? null
        : new Date(this.now().getTime() + request.expiresInDays * 24 * 60 * 60 * 1000);

    const record = await this.store.create({
      sellerId,
      name: request.name,
      keyPrefix: generated.keyPrefix,
      keyHash: generated.keyHash,
      scopes: request.scopes,
      expiresAt
    });

    await this.auditLogService?.record({
      action: "seller.api_key.created",
      actorId: sellerId,
      actorType: "seller",
      targetId: record.id,
      targetType: "seller_api_key",
      metadata: {
        name: record.name,
        scopes: [...record.scopes],
        expiresAt: record.expiresAt
      }
    });

    return { apiKey: toPublicApiKey(record), key: generated.key };
  }

  /**
   * List key metadata for a seller. Hashes and plaintext are never included.
   */
  async listKeys(sellerId: string) {
    const keys = await this.store.list(sellerId);
    return { apiKeys: keys.map(toPublicApiKey) };
  }

  async getKey(sellerId: string, keyId: string) {
    const record = await this.store.get(keyId);
    if (record === undefined || record.sellerId !== sellerId) {
      throw new LumenError("UNAUTHORIZED", "API key was not found.");
    }
    return toPublicApiKey(record);
  }

  /**
   * Rotate a key: issue a replacement and keep the previous key valid for a
   * bounded overlap window so integrations can switch without downtime.
   */
  async rotateKey(sellerId: string, keyId: string, input: unknown = {}) {
    const previous = await this.requireOwnedKey(sellerId, keyId);
    if (previous.status === "revoked") {
      throw new LumenError("VALIDATION_FAILED", "Revoked API keys cannot be rotated.");
    }

    const rotatedOutAt = this.now();
    await this.store.markRotatedOut(previous.id, rotatedOutAt);

    const replacement = await this.createKey(sellerId, {
      name: previous.name,
      scopes: previous.scopes,
      ...(previous.expiresAt === null
        ? {}
        : {
            expiresInDays: Math.max(
              1,
              Math.ceil(
                (new Date(previous.expiresAt).getTime() - rotatedOutAt.getTime()) /
                  (24 * 60 * 60 * 1000)
              )
            )
          }),
      ...(input as Record<string, unknown>)
    });

    await this.auditLogService?.record({
      action: "seller.api_key.rotated",
      actorId: sellerId,
      actorType: "seller",
      targetId: previous.id,
      targetType: "seller_api_key",
      metadata: {
        rotatedOutAt: rotatedOutAt.toISOString(),
        overlapSeconds: SELLER_API_KEY_ROTATION_OVERLAP_SECONDS,
        replacementKeyId: replacement.apiKey.id
      }
    });

    return {
      ...replacement,
      overlapSeconds: SELLER_API_KEY_ROTATION_OVERLAP_SECONDS,
      previousKeyId: previous.id
    };
  }

  /**
   * Immediately revoke a key. Revocation is terminal and takes effect for
   * every subsequent request.
   */
  async revokeKey(sellerId: string, keyId: string) {
    const record = await this.requireOwnedKey(sellerId, keyId);
    if (record.status === "revoked") {
      return toPublicApiKey(record);
    }

    const revoked = await this.store.markRevoked(record.id, this.now());

    await this.auditLogService?.record({
      action: "seller.api_key.revoked",
      actorId: sellerId,
      actorType: "seller",
      targetId: record.id,
      targetType: "seller_api_key",
      metadata: { name: record.name }
    });

    return toPublicApiKey(revoked);
  }

  /**
   * Authenticate a presented key. Returns the principal for rate-limit
   * identity and scope enforcement, or throws a public auth error.
   */
  async authenticate(plaintext: string): Promise<SellerApiKeyPrincipal> {
    const parsed = parseSellerApiKey(plaintext.trim());
    if (parsed === undefined) {
      throw new LumenError("UNAUTHORIZED", "API key is invalid.");
    }

    const candidates = await this.store.findByPrefix(parsed.keyPrefix);
    const presentedHash = hashSellerApiKey(plaintext.trim());
    const record = candidates.find((candidate) =>
      constantTimeEquals(candidate.keyHash, presentedHash)
    );

    if (record === undefined) {
      throw new LumenError("UNAUTHORIZED", "API key is invalid.");
    }

    if (record.status === "revoked") {
      throw new LumenError("UNAUTHORIZED", "API key was revoked.");
    }

    if (record.rotatedOutAt !== null) {
      const overlapDeadline =
        new Date(record.rotatedOutAt).getTime() + SELLER_API_KEY_ROTATION_OVERLAP_SECONDS * 1000;
      if (this.now().getTime() > overlapDeadline) {
        throw new LumenError("UNAUTHORIZED", "API key was revoked.");
      }
    }

    if (record.expiresAt !== null && new Date(record.expiresAt).getTime() <= this.now().getTime()) {
      throw new LumenError("AUTH_EXPIRED", "API key has expired.", { statusCode: 401 });
    }

    await this.store.touchLastUsed(record.id, this.now());

    return {
      keyId: record.id,
      sellerId: record.sellerId,
      scopes: [...record.scopes],
      expiresAt: record.expiresAt
    };
  }

  getStore() {
    return this.store;
  }

  private async requireOwnedKey(sellerId: string, keyId: string) {
    const record = await this.store.get(keyId);
    if (record === undefined || record.sellerId !== sellerId) {
      throw new LumenError("UNAUTHORIZED", "API key was not found.");
    }
    return record;
  }
}

/**
 * Strip store-internal fields before a key record leaves the service.
 */
export function toPublicApiKey(record: SellerApiKeyRecord): SellerApiKey {
  return {
    id: record.id,
    sellerId: record.sellerId,
    name: record.name,
    keyPrefix: record.keyPrefix,
    scopes: [...record.scopes],
    status: record.status,
    expiresAt: record.expiresAt,
    lastUsedAt: record.lastUsedAt,
    revokedAt: record.revokedAt,
    rotatedOutAt: record.rotatedOutAt,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt
  };
}
