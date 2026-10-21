-- Transaction hashes are unique per network, not globally.
-- The same hash string cannot appear on two different networks, but the
-- constraint is scoped to (transactionHash, network) so the uniqueness
-- invariant is correctly enforced per-chain.

DROP INDEX IF EXISTS "Settlement_transactionHash_key";

CREATE UNIQUE INDEX "Settlement_transactionHash_network_key"
  ON "Settlement" ("transactionHash", "network")
  WHERE "transactionHash" IS NOT NULL;
