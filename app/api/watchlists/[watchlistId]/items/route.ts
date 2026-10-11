import { NextResponse } from "next/server";
import { addItemSchema } from "@/lib/watchlists/model";
import { addWatchlistItem } from "@/lib/watchlists/service";
import { parseJson, watchlistErrorResponse } from "@/lib/watchlists/http";

type RouteContext = { params: Promise<{ watchlistId: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const [{ watchlistId }, input] = await Promise.all([
      params,
      parseJson(request, addItemSchema),
    ]);
    return NextResponse.json({
      item: await addWatchlistItem(watchlistId, input),
    }, { status: 201 });
  } catch (error) {
    return watchlistErrorResponse(error);
  }
}
