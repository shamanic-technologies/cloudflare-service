import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

/**
 * Apply ./drizzle migrations. 0000 is written IF NOT EXISTS / idempotent, so it
 * applies cleanly over the `files` table that predates this runner.
 */
export async function runMigrations(): Promise<void> {
  const url = process.env.CLOUDFLARE_SERVICE_DATABASE_URL;
  if (!url) throw new Error("CLOUDFLARE_SERVICE_DATABASE_URL environment variable is required");
  const client = postgres(url, { max: 1, onnotice: () => {} });
  try {
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
  } finally {
    await client.end();
  }
}
