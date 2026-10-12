import { readFile } from "node:fs/promises";
import postgres from "postgres";

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required to run database migrations.");
  process.exitCode = 1;
} else {
  const client = postgres(url, { max: 1 });
  try {
    for (const name of [
      "0001_watchlists.sql",
      "0002_saved_strategies.sql",
      "0003_futures_preferences.sql",
      "0004_positions.sql",
      "0005_alerts.sql",
    ]) {
      const migration = await readFile(new URL(`./migrations/${name}`, import.meta.url), "utf8");
      await client.unsafe(migration);
      console.info(`Applied migration ${name}`);
    }
  } finally {
    await client.end();
  }
}
