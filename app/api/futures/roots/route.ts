import { NextResponse } from "next/server";
import { getMarketDataProvider } from "@/lib/market-data";
import { futuresRootSchema } from "@/lib/market-data/schemas";

export async function GET() {
  try {
    const roots = futuresRootSchema.array().parse(await getMarketDataProvider().getFuturesRoots());
    return NextResponse.json(roots, { headers: { "Cache-Control": "private, max-age=60, stale-while-revalidate=300" } });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Could not load futures roots.",
      code: "FUTURES_ROOTS_FAILED",
    }, { status: 502 });
  }
}
