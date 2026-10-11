import { readFile } from "node:fs/promises";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required to run database migrations.");
  process.exitCode = 1;
} else {
  const client = postgres(url, { max: 1 });
  try {
    const migration = await readFile(new URL("./migrations/0001_watchlists.sql", import.meta.url), "utf8");
    await client.unsafe(migration);
    console.info("Applied migration 0001_watchlists.sql");
  } finally {
    await client.end();
  }
}
