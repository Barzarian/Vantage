import { NextResponse } from "next/server";
import { updateItemSchema } from "@/lib/watchlists/model";
import {
  removeWatchlistItem,
  updateWatchlistItem,
} from "@/lib/watchlists/service";
import { parseJson, watchlistErrorResponse } from "@/lib/watchlists/http";

type RouteContext = { params: Promise<{ watchlistId: string; itemId: string }> };

export async function PATCH(request: Request, { params }: RouteContext) {
  try {
    const [{ watchlistId, itemId }, input] = await Promise.all([
      params,
      parseJson(request, updateItemSchema),
    ]);
    return NextResponse.json({
      item: await updateWatchlistItem(watchlistId, itemId, input),
    });
  } catch (error) {
    return watchlistErrorResponse(error);
  }
}

export async function DELETE(_request: Request, { params }: RouteContext) {
  try {
    const { watchlistId, itemId } = await params;
    await removeWatchlistItem(watchlistId, itemId);
    return new NextResponse(null, { status: 204 });
  } catch (error) {
    return watchlistErrorResponse(error);
  }
}
