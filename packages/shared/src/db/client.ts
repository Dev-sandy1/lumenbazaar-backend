import { PrismaClient } from "@prisma/client";

let sharedClient: PrismaClient | undefined;

export function createPrismaClient(databaseUrl = process.env.DATABASE_URL) {
  if (databaseUrl === undefined) {
    return new PrismaClient();
  }

  return new PrismaClient({
    datasources: {
      db: {
        url: databaseUrl
      }
    }
  });
}

export function getPrismaClient() {
  sharedClient ??= createPrismaClient();
  return sharedClient;
}

export async function disconnectPrismaClient() {
  await sharedClient?.$disconnect();
  sharedClient = undefined;
}

/**
 * Lightweight connectivity probe for the database.
 *
 * Opens a short-lived connection, runs `SELECT 1`, then disconnects. Throws on
 * any failure so the caller can classify the outcome (timeout, unavailable,
 * etc.). The raw error is intentionally not enriched here — callers are
 * responsible for redacting error details before surfacing them.
 *
 * @param databaseUrl - Overrides the DATABASE_URL env var when provided.
 */
export async function probeDatabaseConnection(databaseUrl?: string): Promise<void> {
  const client = createPrismaClient(databaseUrl);
  try {
    await client.$queryRawUnsafe("SELECT 1");
  } finally {
    await client.$disconnect();
  }
}
