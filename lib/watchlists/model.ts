import { z } from "zod";

export const assetClassSchema = z.enum(["stock", "future", "option", "index"]);

export const watchlistItemSchema = z.object({
  id: z.string().uuid(),
  watchlistId: z.string().uuid(),
  symbol: z.string().min(1).max(32),
  assetClass: assetClassSchema,
  position: z.number().int().nonnegative(),
  note: z.string().max(500),
});
export type WatchlistItem = z.infer<typeof watchlistItemSchema>;

export const watchlistSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(48),
  position: z.number().int().nonnegative(),
  items: z.array(watchlistItemSchema),
});
export type Watchlist = z.infer<typeof watchlistSchema>;

export const createWatchlistSchema = z.object({ name: z.string().trim().min(1).max(48) });
export const updateWatchlistSchema = z.object({ name: z.string().trim().min(1).max(48) });
export const duplicateWatchlistSchema = z.object({
  sourceId: z.string().uuid(),
  name: z.string().trim().min(1).max(48).optional(),
});
export const addItemSchema = z.object({
  symbol: z.string().trim().min(1).max(32).transform((value) => value.toUpperCase()),
  assetClass: assetClassSchema,
  note: z.string().max(500).default(""),
});
export const updateItemSchema = z.object({
  note: z.string().max(500).optional(),
  watchlistId: z.string().uuid().optional(),
}).refine((value) => value.note !== undefined || value.watchlistId !== undefined);
export const reorderSchema = z.object({
  orderedIds: z.array(z.string().uuid()).max(500),
});

export class WatchlistError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "WatchlistError";
  }
}

export function reorderByIds<T extends { id: string }>(items: T[], orderedIds: string[]): T[] {
  if (items.length !== orderedIds.length || new Set(orderedIds).size !== orderedIds.length) {
    throw new WatchlistError("The reorder payload must include each item exactly once.", 400, "INVALID_ORDER");
  }
  const byId = new Map(items.map((item) => [item.id, item]));
  if (orderedIds.some((id) => !byId.has(id))) {
    throw new WatchlistError("The reorder payload contains an unknown item.", 400, "INVALID_ORDER");
  }
  return orderedIds.map((id) => byId.get(id)!);
}
