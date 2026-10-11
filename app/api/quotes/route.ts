import { NextResponse } from "next/server";
import { z } from "zod";
import { getMarketDataProvider } from "@/lib/market-data";
import { quoteSchema } from "@/lib/market-data/schemas";

const symbolsSchema = z.array(z.string().trim().min(1).max(32)).min(1).max(100);

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const parsed = symbolsSchema.safeParse(params.getAll("symbol"));
  if (!parsed.success) {
    return NextResponse.json({ error: "Provide between 1 and 100 symbols." }, { status: 400 });
  }

  try {
    const quotes = quoteSchema.array().parse(await getMarketDataProvider().getQuote(parsed.data));
    return NextResponse.json(quotes, {
      headers: { "Cache-Control": "private, max-age=1, stale-while-revalidate=4" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Quote request failed.";
    const status =
      typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
        ? error.status
        : 502;
    const code =
      typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
        ? error.code
        : undefined;
    return NextResponse.json({ error: message, code }, { status });
  }
}
