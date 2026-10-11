import postgres from "postgres";
import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import * as schema from "./schema";

declare global {
  var watchlistDatabase:
    | { client: ReturnType<typeof postgres>; db: PostgresJsDatabase<typeof schema> }
    | undefined;
}

export function getDatabase(): { client: ReturnType<typeof postgres>; db: PostgresJsDatabase<typeof schema> } | null {
  const url = process.env.DATABASE_URL;
  if (!url) return null;
  globalThis.watchlistDatabase ??= (() => {
    const client = postgres(url, { max: 1, idle_timeout: 20 });
    return { client, db: drizzle(client, { schema }) };
  })();
  return globalThis.watchlistDatabase;
}
