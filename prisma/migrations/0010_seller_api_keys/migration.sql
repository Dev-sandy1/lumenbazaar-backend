-- Create SellerApiKey table for scoped, revocable seller credentials
CREATE TABLE "SellerApiKey" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sellerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyPrefix" VARCHAR(32) NOT NULL,
    "keyHash" TEXT NOT NULL,
    "scopes" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'active',
    "expiresAt" TIMESTAMP,
    "lastUsedAt" TIMESTAMP,
    "revokedAt" TIMESTAMP,
    "rotatedOutAt" TIMESTAMP,
    "createdAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "SellerApiKey_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "Seller" ("id") ON DELETE CASCADE
);

-- Plaintext keys are never stored; keyHash is a SHA-256 digest of the full key
CREATE UNIQUE INDEX "SellerApiKey_keyHash_key" ON "SellerApiKey" ("keyHash");

CREATE INDEX "SellerApiKey_sellerId_status_idx" ON "SellerApiKey" ("sellerId", "status");

CREATE INDEX "SellerApiKey_keyPrefix_idx" ON "SellerApiKey" ("keyPrefix");
