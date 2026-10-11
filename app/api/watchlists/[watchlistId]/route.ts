import { NextResponse } from "next/server";
import { updateWatchlistSchema, watchlistIdSchema } from "@/lib/watchlists/model";
import { deleteWatchlist, renameWatchlist } from "@/lib/watchlists/service";
import { parseJson, watchlistErrorResponse } from "@/lib/watchlists/http";

type RouteContext = { params: Promise<{ watchlistId: string }> };

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const [{ watchlistId }, input] = await Promise.all([
      params.then(({ watchlistId }) => ({ watchlistId: watchlistIdSchema.parse(watchlistId) })),
      parseJson(request, updateWatchlistSchema),
    ]);
    return NextResponse.json({ watchlist: await renameWatchlist(watchlistId, input.name) });
  } catch (error) {
    return watchlistErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  try {
    const { watchlistId: rawWatchlistId } = await params;
    const watchlistId = watchlistIdSchema.parse(rawWatchlistId);
    await deleteWatchlist(watchlistId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return watchlistErrorResponse(error);
  }
}
