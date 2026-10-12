import { NextResponse } from "next/server";
import { z } from "zod";
import { getMarketDataProvider } from "@/lib/market-data";
import { completeOptionGreeks } from "@/lib/greeks/option-quote";
import {
  optionChainItemSchema,
  optionExpiriesSchema,
  quoteSchema,
} from "@/lib/market-data/schemas";

const underlyingSchema = z.string().trim().min(1).max(16).regex(/^[A-Z0-9.]+$/);
const expirySchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function GET(
  request: Request,
  context: { params: Promise<{ underlying: string }> },
) {
  const provider = getMarketDataProvider();
  try {
    const { underlying } = await context.params;
    const root = underlyingSchema.parse(decodeURIComponent(underlying).toUpperCase());
    const url = new URL(request.url);
    const expiry = expirySchema.parse(url.searchParams.get("expiry"));
    const expiries = optionExpiriesSchema.parse(await provider.getOptionExpiries(root));
    if (!expiries.includes(expiry)) {
      return NextResponse.json({ error: "Expiry is not available for this underlying.", code: "INVALID_EXPIRY" }, { status: 400 });
    }
    const [quote, rawChain] = await Promise.all([
      provider.getQuote([root]).then((quotes) => quoteSchema.array().parse(quotes)),
      provider.getOptionChain(root, expiry).then((chain) => optionChainItemSchema.array().parse(chain)),
    ]);
    const spot = quote[0]?.last;
    if (spot === undefined) throw new Error(`No underlying quote available for ${root}.`);
    const chain = rawChain.map((entry) => ({
      contract: entry.contract,
      quote: completeOptionGreeks(entry, spot),
    }));
    return NextResponse.json(optionChainItemSchema.array().parse(chain), {
      headers: { "Cache-Control": "private, max-age=1, stale-while-revalidate=5" },
    });
  } catch (error) {
    const status =
      typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
        ? error.status
        : error instanceof z.ZodError ? 400 : 502;
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Could not load option chain.",
      code: error instanceof z.ZodError ? "VALIDATION_ERROR" : "OPTION_CHAIN_FAILED",
    }, { status });
  }
}
