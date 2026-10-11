import { randomUUID } from "node:crypto";
import { and, asc, eq, inArray, max } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { seedWatchlists } from "@/db/seed";
import { watchlistItems, watchlists } from "@/db/schema";
import {
  reorderByIds,
  WatchlistError,
  watchlistSchema,
  type Watchlist,
  type WatchlistItem,
} from "./model";

const USER_ID = "local-user";

function seedInMemory(): Watchlist[] {
  const lists = [
    { name: "Core", symbols: [["AAPL", "stock"], ["NVDA", "stock"], ["MSFT", "stock"], ["TSLA", "stock"], ["AMZN", "stock"]] },
    { name: "Macro", symbols: [["SPX", "index"], ["NDX", "index"], ["VIX", "index"], ["ES", "future"], ["NQ", "future"], ["CL", "future"], ["GC", "future"]] },
  ];
  return lists.map(({ name, symbols }, position) => {
    const id = randomUUID();
    return watchlistSchema.parse({
      id,
      name,
      position,
      items: symbols.map(([symbol, assetClass], itemPosition) => ({
        id: randomUUID(),
        watchlistId: id,
        symbol,
        assetClass,
        position: itemPosition,
        note: "",
      })),
    });
  });
}

declare global {
  var inMemoryWatchlists: Watchlist[] | undefined;
}

function memoryLists(): Watchlist[] {
  globalThis.inMemoryWatchlists ??= seedInMemory();
  return globalThis.inMemoryWatchlists;
}

function cloneLists(lists: Watchlist[]): Watchlist[] {
  return lists.map((list) => ({ ...list, items: list.items.map((item) => ({ ...item })) }));
}

async function databaseLists(): Promise<Watchlist[] | null> {
  const database = getDatabase();
  if (!database) return null;
  await seedWatchlists(database.db);
  const rows = await database.db.select().from(watchlists)
    .where(eq(watchlists.userId, USER_ID)).orderBy(asc(watchlists.position));
  if (!rows.length) return [];
  const itemRows = await database.db.select().from(watchlistItems)
    .where(inArray(watchlistItems.watchlistId, rows.map((row) => row.id)))
    .orderBy(asc(watchlistItems.position));
  return rows.map((row) => watchlistSchema.parse({
    id: row.id,
    name: row.name,
    position: row.position,
    items: itemRows.filter((item) => item.watchlistId === row.id).map((item) => ({
      id: item.id,
      watchlistId: item.watchlistId,
      symbol: item.symbol,
      assetClass: item.assetClass,
      position: item.position,
      note: item.note,
    })),
  }));
}

export async function getWatchlists(): Promise<Watchlist[]> {
  return (await databaseLists()) ?? cloneLists(memoryLists());
}

export async function createWatchlist(name: string): Promise<Watchlist> {
  const id = randomUUID();
  const database = getDatabase();
  if (database) {
    await seedWatchlists(database.db);
    const [{ nextPosition }] = await database.db.select({ nextPosition: max(watchlists.position) }).from(watchlists)
      .where(eq(watchlists.userId, USER_ID));
    await database.db.insert(watchlists).values({
      id, userId: USER_ID, name, position: (nextPosition ?? -1) + 1,
    });
    return { id, name, position: (nextPosition ?? -1) + 1, items: [] };
  }
  const lists = memoryLists();
  const created = { id, name, position: lists.length, items: [] };
  lists.push(created);
  return cloneLists([created])[0]!;
}

export async function duplicateWatchlist(sourceId: string, name?: string): Promise<Watchlist> {
  const source = await getWatchlists().then((lists) => requireList(lists, sourceId));
  const copy = await createWatchlist(name ?? `${source.name} copy`);
  const database = getDatabase();
  if (database && source.items.length) {
    await database.db.insert(watchlistItems).values(source.items.map((item, position) => ({
      id: randomUUID(),
      watchlistId: copy.id,
      symbol: item.symbol,
      assetClass: item.assetClass,
      position,
      note: item.note,
    })));
  } else if (!database) {
    const target = memoryLists().find((list) => list.id === copy.id)!;
    target.items = source.items.map((item, position) => ({
      ...item, id: randomUUID(), watchlistId: target.id, position,
    }));
  }
  return (await getWatchlists()).find((list) => list.id === copy.id)!;
}

export async function renameWatchlist(id: string, name: string): Promise<Watchlist> {
  const database = getDatabase();
  if (database) {
    const rows = await database.db.update(watchlists).set({ name }).where(and(
      eq(watchlists.id, id),
      eq(watchlists.userId, USER_ID),
    )).returning();
    if (!rows.length) throw missingList();
  } else {
    requireList(memoryLists(), id).name = name;
  }
  return requireList(await getWatchlists(), id);
}

export async function deleteWatchlist(id: string): Promise<void> {
  const database = getDatabase();
  if (database) {
    const rows = await database.db.delete(watchlists).where(and(
      eq(watchlists.id, id),
      eq(watchlists.userId, USER_ID),
    )).returning({ id: watchlists.id });
    if (!rows.length) throw missingList();
    return;
  }
  const lists = memoryLists();
  const index = lists.findIndex((list) => list.id === id);
  if (index < 0) throw missingList();
  lists.splice(index, 1);
  lists.forEach((list, position) => { list.position = position; });
}

export async function addWatchlistItem(
  listId: string,
  input: { symbol: string; assetClass: WatchlistItem["assetClass"]; note: string },
): Promise<WatchlistItem> {
  const lists = await getWatchlists();
  const list = requireList(lists, listId);
  if (list.items.some((item) => item.symbol === input.symbol)) {
    throw new WatchlistError(`${input.symbol} is already in this watchlist.`, 409, "DUPLICATE_SYMBOL");
  }
  const item: WatchlistItem = {
    id: randomUUID(),
    watchlistId: listId,
    symbol: input.symbol,
    assetClass: input.assetClass,
    position: list.items.length,
    note: input.note,
  };
  const database = getDatabase();
  if (database) await database.db.insert(watchlistItems).values(item);
  else memoryLists().find((entry) => entry.id === listId)!.items.push(item);
  return item;
}

export async function removeWatchlistItem(listId: string, itemId: string): Promise<void> {
  const database = getDatabase();
  if (database) {
    const rows = await database.db.delete(watchlistItems).where(and(
      eq(watchlistItems.id, itemId),
      eq(watchlistItems.watchlistId, listId),
    ))
      .returning({ id: watchlistItems.id, watchlistId: watchlistItems.watchlistId });
    if (!rows.length) throw missingItem();
    return;
  }
  const list = requireList(memoryLists(), listId);
  const index = list.items.findIndex((item) => item.id === itemId);
  if (index < 0) throw missingItem();
  list.items.splice(index, 1);
  list.items.forEach((item, position) => { item.position = position; });
}

export async function updateWatchlistItem(
  listId: string,
  itemId: string,
  patch: { note?: string; watchlistId?: string },
): Promise<WatchlistItem> {
  const lists = await getWatchlists();
  const source = requireList(lists, listId);
  const item = source.items.find((entry) => entry.id === itemId);
  if (!item) throw missingItem();
  const targetId = patch.watchlistId ?? listId;
  const target = requireList(lists, targetId);
  if (targetId !== listId && target.items.some((entry) => entry.symbol === item.symbol)) {
    throw new WatchlistError(`${item.symbol} is already in the destination watchlist.`, 409, "DUPLICATE_SYMBOL");
  }
  const database = getDatabase();
  if (database) {
    const updated = {
      ...(patch.note !== undefined ? { note: patch.note } : {}),
      ...(targetId !== listId ? { watchlistId: targetId, position: target.items.length } : {}),
    };
    const rows = await database.db.update(watchlistItems).set(updated)
      .where(and(
        eq(watchlistItems.id, itemId),
        eq(watchlistItems.watchlistId, listId),
      )).returning();
    if (!rows.length) throw missingItem();
    return { ...rows[0]!, assetClass: rows[0]!.assetClass as WatchlistItem["assetClass"] };
  }
  const inMemorySource = memoryLists().find((entry) => entry.id === listId)!;
  const sourceIndex = inMemorySource.items.findIndex((entry) => entry.id === itemId);
  if (sourceIndex < 0) throw missingItem();
  if (targetId === listId) {
    const existing = inMemorySource.items[sourceIndex]!;
    if (patch.note !== undefined) existing.note = patch.note;
    return { ...existing };
  }
  const [moved] = inMemorySource.items.splice(sourceIndex, 1);
  inMemorySource.items.forEach((entry, position) => { entry.position = position; });
  if (patch.note !== undefined) moved!.note = patch.note;
  moved!.watchlistId = targetId;
  moved!.position = memoryLists().find((entry) => entry.id === targetId)!.items.length;
  memoryLists().find((entry) => entry.id === targetId)!.items.push(moved!);
  return { ...moved! };
}

export async function reorderWatchlistItems(listId: string, orderedIds: string[]): Promise<Watchlist> {
  const lists = await getWatchlists();
  const list = requireList(lists, listId);
  const ordered = reorderByIds(list.items, orderedIds);
  const database = getDatabase();
  if (database) {
    await database.db.transaction(async (tx) => {
      for (const [position, item] of ordered.entries()) {
        await tx.update(watchlistItems).set({ position }).where(eq(watchlistItems.id, item.id));
      }
    });
  } else {
    const target = memoryLists().find((entry) => entry.id === listId)!;
    target.items = ordered.map((item, position) => ({ ...item, position }));
  }
  return requireList(await getWatchlists(), listId);
}

function requireList(lists: Watchlist[], id: string): Watchlist {
  const list = lists.find((entry) => entry.id === id);
  if (!list) throw missingList();
  return list;
}

function missingList(): WatchlistError {
  return new WatchlistError("Watchlist not found.", 404, "WATCHLIST_NOT_FOUND");
}

function missingItem(): WatchlistError {
  return new WatchlistError("Watchlist item not found.", 404, "ITEM_NOT_FOUND");
}
