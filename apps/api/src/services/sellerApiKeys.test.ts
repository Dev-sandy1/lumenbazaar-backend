import { describe, expect, it } from "vitest";

import { SELLER_API_KEY_ROTATION_OVERLAP_SECONDS } from "@lumenbazaar/shared";

import {
  InMemorySellerApiKeyStore,
  SellerApiKeyService,
  generateSellerApiKey,
  hashSellerApiKey
} from "./sellerApiKeys.js";

function fixedClock(startIso: string) {
  let current = new Date(startIso).getTime();
  return {
    now: () => new Date(current),
    advanceSeconds: (seconds: number) => {
      current += seconds * 1000;
    }
  };
}

const sellerId = "seller_one";

function createService(clock = fixedClock("2026-01-01T00:00:00.000Z")) {
  const store = new InMemorySellerApiKeyStore();
  const service = new SellerApiKeyService(store, undefined, clock.now);
  return { store, service, clock };
}

describe("SellerApiKeyService", () => {
  it("issues keys shown once and stores only strong hashes", async () => {
    const { store, service } = createService();

    const issued = await service.createKey(sellerId, {
      name: "warehouse integration",
      scopes: ["resources:read", "resources:write"]
    });

    expect(issued.key).toMatch(/^lbk_[0-9a-f]{12}_/u);
    expect(issued.apiKey).toMatchObject({
      sellerId,
      name: "warehouse integration",
      scopes: ["resources:read", "resources:write"],
      status: "active",
      expiresAt: null,
      lastUsedAt: null
    });

    // Only the SHA-256 hash of the full key is persisted.
    const stored = await store.get(issued.apiKey.id);
    expect(stored?.keyHash).toBe(hashSellerApiKey(issued.key));
    expect(stored?.keyHash).not.toContain(issued.key);

    // Listing never leaks plaintext keys or hashes.
    const listed = await service.listKeys(sellerId);
    expect(listed.apiKeys).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(issued.key);
    expect(JSON.stringify(listed)).not.toContain(stored!.keyHash);
  });

  it("authenticates valid keys and tracks usage", async () => {
    const { service } = createService();
    const issued = await service.createKey(sellerId, {
      name: "read only",
      scopes: ["resources:read"]
    });

    const principal = await service.authenticate(issued.key);

    expect(principal).toMatchObject({
      keyId: issued.apiKey.id,
      sellerId,
      scopes: ["resources:read"]
    });
    await expect(service.listKeys(sellerId)).resolves.toMatchObject({
      apiKeys: [expect.objectContaining({ lastUsedAt: expect.any(String) })]
    });
  });

  it("rejects malformed keys and wrong secrets", async () => {
    const { service } = createService();
    const issued = await service.createKey(sellerId, {
      name: "integration",
      scopes: ["resources:write"]
    });

    await expect(service.authenticate("not-a-key")).rejects.toMatchObject({
      code: "UNAUTHORIZED"
    });
    await expect(service.authenticate(`${issued.key}tampered`)).rejects.toMatchObject({
      code: "UNAUTHORIZED"
    });

    const wrongSecret = issued.key.replace(/_[^_]+$/u, `_wrong${"0".repeat(40)}`);
    await expect(service.authenticate(wrongSecret)).rejects.toMatchObject({
      code: "UNAUTHORIZED"
    });
  });

  it("supports bounded overlap rotation and rejects rotated keys after the window", async () => {
    const { service, clock } = createService();
    const original = await service.createKey(sellerId, {
      name: "integration",
      scopes: ["resources:write"]
    });

    const rotated = await service.rotateKey(sellerId, original.apiKey.id, {});

    expect(rotated.key).not.toBe(original.key);
    expect(rotated.previousKeyId).toBe(original.apiKey.id);
    expect(rotated.overlapSeconds).toBe(SELLER_API_KEY_ROTATION_OVERLAP_SECONDS);

    // Both keys are valid during the overlap window.
    await expect(service.authenticate(original.key)).resolves.toMatchObject({
      keyId: original.apiKey.id
    });
    await expect(service.authenticate(rotated.key)).resolves.toMatchObject({
      keyId: rotated.apiKey.id
    });

    clock.advanceSeconds(SELLER_API_KEY_ROTATION_OVERLAP_SECONDS + 1);

    await expect(service.authenticate(original.key)).rejects.toMatchObject({
      code: "UNAUTHORIZED"
    });
    await expect(service.authenticate(rotated.key)).resolves.toMatchObject({
      keyId: rotated.apiKey.id
    });
  });

  it("revokes keys immediately and terminally", async () => {
    const { service } = createService();
    const issued = await service.createKey(sellerId, {
      name: "integration",
      scopes: ["resources:write"]
    });

    const revoked = await service.revokeKey(sellerId, issued.apiKey.id);
    expect(revoked.status).toBe("revoked");

    await expect(service.authenticate(issued.key)).rejects.toMatchObject({
      code: "UNAUTHORIZED"
    });
    await expect(service.rotateKey(sellerId, issued.apiKey.id, {})).rejects.toMatchObject({
      code: "VALIDATION_FAILED"
    });
  });

  it("rejects expired keys", async () => {
    const { service, clock } = createService();
    const issued = await service.createKey(sellerId, {
      name: "short lived",
      scopes: ["resources:read"],
      expiresInDays: 1
    });

    await expect(service.authenticate(issued.key)).resolves.toMatchObject({
      keyId: issued.apiKey.id
    });

    clock.advanceSeconds(24 * 60 * 60 + 1);

    await expect(service.authenticate(issued.key)).rejects.toMatchObject({
      code: "AUTH_EXPIRED",
      statusCode: 401
    });
  });

  it("scopes keys to their owning seller", async () => {
    const { service } = createService();
    const otherSellerKey = await service.createKey("seller_two", {
      name: "other seller",
      scopes: ["resources:write"]
    });

    const principal = await service.authenticate(otherSellerKey.key);
    expect(principal.sellerId).toBe("seller_two");

    await expect(service.revokeKey(sellerId, otherSellerKey.apiKey.id)).rejects.toMatchObject({
      code: "UNAUTHORIZED"
    });
    await expect(service.rotateKey(sellerId, otherSellerKey.apiKey.id, {})).rejects.toMatchObject(
      { code: "UNAUTHORIZED" }
    );
  });

  it("validates key creation input", async () => {
    const { service } = createService();

    await expect(
      service.createKey(sellerId, { name: "bad", scopes: [] })
    ).rejects.toThrow();
    await expect(
      service.createKey(sellerId, { name: "bad", scopes: ["admin:*"] })
    ).rejects.toThrow();
    await expect(
      service.createKey(sellerId, {
        name: "bad",
        scopes: ["resources:read", "resources:read"]
      })
    ).rejects.toThrow();
    await expect(
      service.createKey(sellerId, {
        name: "bad",
        scopes: ["resources:read"],
        expiresInDays: 10_000
      })
    ).rejects.toThrow();
  });

  it("generates unique prefixes and hashes per key", () => {
    const first = generateSellerApiKey();
    const second = generateSellerApiKey();

    expect(first.keyPrefix).not.toBe(second.keyPrefix);
    expect(first.keyHash).not.toBe(second.keyHash);
    expect(first.keyHash).toBe(hashSellerApiKey(first.key));
    expect(first.keyHash).toHaveLength(64);
  });
});
