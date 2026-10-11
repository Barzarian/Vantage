import { NextResponse } from "next/server";
import { reorderSchema, watchlistIdSchema } from "@/lib/watchlists/model";
import { reorderWatchlistItems } from "@/lib/watchlists/service";
import { parseJson, watchlistErrorResponse } from "@/lib/watchlists/http";

type RouteContext = { params: Promise<{ watchlistId: string }> };

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const [{ watchlistId }, input] = await Promise.all([
      params.then(({ watchlistId }) => ({ watchlistId: watchlistIdSchema.parse(watchlistId) })),
      parseJson(request, reorderSchema),
    ]);
    return NextResponse.json({
      watchlist: await reorderWatchlistItems(watchlistId, input.orderedIds),
    });
  } catch (error) {
    return watchlistErrorResponse(error);
  }
}
