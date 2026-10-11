import { NextResponse } from "next/server";
import { addItemSchema, watchlistIdSchema } from "@/lib/watchlists/model";
import { addWatchlistItem } from "@/lib/watchlists/service";
import { parseJson, watchlistErrorResponse } from "@/lib/watchlists/http";

type RouteContext = { params: Promise<{ watchlistId: string }> };

export async function POST(request: Request, { params }: RouteContext) {
  try {
    const [{ watchlistId }, input] = await Promise.all([
      params.then(({ watchlistId }) => ({ watchlistId: watchlistIdSchema.parse(watchlistId) })),
      parseJson(request, addItemSchema),
    ]);
    return NextResponse.json({
      item: await addWatchlistItem(watchlistId, input),
    }, { status: 201 });
  } catch (error) {
    return watchlistErrorResponse(error);
  }
}
