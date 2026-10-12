import { randomUUID } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { savedStrategies } from "@/db/schema";
import { savedStrategySchema, strategyLegSchema, type SavedStrategy, type StrategyLeg } from "./strategy";

const USER_ID = "local-user";

declare global {
  var inMemorySavedStrategies: SavedStrategy[] | undefined;
}

function memoryStrategies(): SavedStrategy[] {
  globalThis.inMemorySavedStrategies ??= [];
  return globalThis.inMemorySavedStrategies;
}

export async function listSavedStrategies(): Promise<SavedStrategy[]> {
  const database = getDatabase();
  if (!database) return memoryStrategies().map((strategy) => savedStrategySchema.parse(strategy));
  const rows = await database.db.select().from(savedStrategies)
    .where(eq(savedStrategies.userId, USER_ID))
    .orderBy(desc(savedStrategies.createdAt));
  return rows.map((row) => savedStrategySchema.parse({
    id: row.id,
    name: row.name,
    legs: strategyLegSchema.array().parse(JSON.parse(row.legs) as unknown),
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function saveStrategy(name: string, legs: StrategyLeg[]): Promise<SavedStrategy> {
  const created = savedStrategySchema.parse({
    id: randomUUID(),
    name,
    legs: strategyLegSchema.array().max(32).parse(legs),
    createdAt: new Date().toISOString(),
  });
  const database = getDatabase();
  if (database) {
    await database.db.insert(savedStrategies).values({
      id: created.id,
      userId: USER_ID,
      name: created.name,
      legs: JSON.stringify(created.legs),
      createdAt: new Date(created.createdAt),
    });
  } else {
    memoryStrategies().unshift(created);
  }
  return created;
}

export async function deleteSavedStrategy(id: string): Promise<void> {
  const database = getDatabase();
  if (database) {
    const rows = await database.db.delete(savedStrategies).where(and(
      eq(savedStrategies.id, id),
      eq(savedStrategies.userId, USER_ID),
    )).returning({ id: savedStrategies.id });
    if (!rows.length) throw new Error("Saved strategy not found.");
    return;
  }
  const strategies = memoryStrategies();
  const index = strategies.findIndex((strategy) => strategy.id === id);
  if (index < 0) throw new Error("Saved strategy not found.");
  strategies.splice(index, 1);
}
