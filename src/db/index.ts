import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema.js";

let _db: ReturnType<typeof drizzle<typeof schema>> | null = null;

export function getDb() {
  if (!_db) {
    const CLOUDFLARE_SERVICE_DATABASE_URL = process.env.CLOUDFLARE_SERVICE_DATABASE_URL;
    if (!CLOUDFLARE_SERVICE_DATABASE_URL) {
      throw new Error("CLOUDFLARE_SERVICE_DATABASE_URL environment variable is required");
    }
    const client = postgres(CLOUDFLARE_SERVICE_DATABASE_URL);
    _db = drizzle(client, { schema });
  }
  return _db;
}

// Re-export as db for convenience (proxy that lazily initializes)
export const db = new Proxy({} as ReturnType<typeof drizzle<typeof schema>>, {
  get(_target, prop) {
    return (getDb() as unknown as Record<string | symbol, unknown>)[prop];
  },
});
