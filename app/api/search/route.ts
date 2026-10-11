import { NextResponse } from "next/server";
import { getMarketDataProvider } from "@/lib/market-data";
import { instrumentSearchResultSchema } from "@/lib/market-data/schemas";

export async function GET(request: Request) {
  const query = new URL(request.url).searchParams.get("q")?.trim() ?? "";
  if (!query || query.length > 32) {
    return NextResponse.json({ error: "Search query must contain 1 to 32 characters." }, { status: 400 });
  }
  const provider = getMarketDataProvider();
  if (!provider.searchSymbols) {
    return NextResponse.json(
      { error: "Symbol search is not available for the selected market-data provider." },
      { status: 501 },
    );
  }
  try {
    const results = instrumentSearchResultSchema.array().parse(await provider.searchSymbols(query));
    return NextResponse.json(results, {
      headers: { "Cache-Control": "private, max-age=15" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Symbol search failed.";
    const status =
      typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
        ? error.status
        : 502;
    return NextResponse.json({ error: message }, { status });
  }
}
