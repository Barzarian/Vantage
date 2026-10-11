import { NextResponse } from "next/server";
import { z } from "zod";
import { getMarketDataProvider } from "@/lib/market-data";

const symbolsSchema = z.array(z.string().trim().min(1).max(32)).min(1).max(100);

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const parsed = symbolsSchema.safeParse(params.getAll("symbol"));
  if (!parsed.success) {
    return NextResponse.json({ error: "Provide between 1 and 100 symbols." }, { status: 400 });
  }

  const quotes = await getMarketDataProvider().getQuote(parsed.data);
  return NextResponse.json(quotes, {
    headers: { "Cache-Control": "private, max-age=1, stale-while-revalidate=4" },
  });
}
