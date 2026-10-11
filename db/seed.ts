import { randomUUID } from "node:crypto";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { watchlistItems, watchlists } from "./schema";
import * as schema from "./schema";

export async function seedWatchlists(db: PostgresJsDatabase<typeof schema>): Promise<void> {
  const existing = await db.select({ id: watchlists.id }).from(watchlists).limit(1);
  if (existing.length) return;
  const userId = "local-user";
  const lists = [
    { id: randomUUID(), name: "Core", position: 0, symbols: ["AAPL", "NVDA", "MSFT", "TSLA", "AMZN"] },
    { id: randomUUID(), name: "Macro", position: 1, symbols: ["SPX", "NDX", "VIX", "ES", "NQ", "CL", "GC"] },
  ];
  await db.transaction(async (tx) => {
    for (const list of lists) {
      await tx.insert(watchlists).values({
        id: list.id,
        userId,
        name: list.name,
        position: list.position,
      });
      await tx.insert(watchlistItems).values(
        list.symbols.map((symbol, position) => ({
          id: randomUUID(),
          watchlistId: list.id,
          symbol,
          assetClass: ["ES", "NQ", "CL", "GC"].includes(symbol) ? "future" : "stock",
          position,
          note: "",
        })),
      );
    }
  });
}
