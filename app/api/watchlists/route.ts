import { NextResponse } from "next/server";
import {
  createWatchlistSchema,
  duplicateWatchlistSchema,
} from "@/lib/watchlists/model";
import {
  createWatchlist,
  duplicateWatchlist,
  getWatchlists,
} from "@/lib/watchlists/service";
import { watchlistErrorResponse } from "@/lib/watchlists/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ watchlists: await getWatchlists() }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return watchlistErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const body: unknown = await request.json();
    if (typeof body === "object" && body !== null && "sourceId" in body) {
      const input = duplicateWatchlistSchema.parse(body);
      return NextResponse.json({
        watchlist: await duplicateWatchlist(input.sourceId, input.name),
      }, { status: 201 });
    }
    const input = createWatchlistSchema.parse(body);
    return NextResponse.json({ watchlist: await createWatchlist(input.name) }, { status: 201 });
  } catch (error) {
    return watchlistErrorResponse(error);
  }
}
