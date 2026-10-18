import { z } from "zod";

/**
 * Prefix used by every seller API key so keys can be recognized (and safely
 * excluded from logs) without ever storing the plaintext value.
 */
export const SELLER_API_KEY_PREFIX = "lbk";

/**
 * Number of seconds a rotated-out key remains valid after rotation.
 * Gives integrations a bounded window to deploy the replacement key.
 */
export const SELLER_API_KEY_ROTATION_OVERLAP_SECONDS = 3600;

/**
 * Maximum lifetime (days) a newly issued key may request.
 */
export const SELLER_API_KEY_MAX_TTL_DAYS = 365;

/**
 * Scopes a seller API key may carry. Scopes are the only authorization
 * mechanism for key-authenticated calls; anything not listed here is denied.
 */
export const SELLER_API_KEY_SCOPES = [
  "resources:read",
  "resources:write",
  "seller:read",
  "seller:write"
] as const;

export type SellerApiKeyScope = (typeof SELLER_API_KEY_SCOPES)[number];

export const sellerApiKeyScopeSchema = z.enum(SELLER_API_KEY_SCOPES);

export function isSellerApiKeyScope(value: string): value is SellerApiKeyScope {
  return (SELLER_API_KEY_SCOPES as readonly string[]).includes(value);
}

/**
 * Key lifecycle status. Revocation is terminal; rotated-out keys stay usable
 * only for the rotation overlap window and are then treated as revoked.
 */
export type SellerApiKeyStatus = "active" | "revoked";

/**
 * Persisted seller API key metadata. Never contains the plaintext key; the
 * secret itself is only present in the creation response.
 */
export type SellerApiKey = {
  id: string;
  sellerId: string;
  name: string;
  keyPrefix: string;
  scopes: SellerApiKeyScope[];
  status: SellerApiKeyStatus;
  expiresAt: string | null;
  lastUsedAt: string | null;
  revokedAt: string | null;
  rotatedOutAt: string | null;
  createdAt: string;
  updatedAt: string;
};

/**
 * Authenticated identity attached to a request that presented a valid seller
 * API key. Used for rate-limit identity and scope enforcement.
 */
export type SellerApiKeyPrincipal = {
  keyId: string;
  sellerId: string;
  scopes: SellerApiKeyScope[];
  expiresAt: string | null;
};
