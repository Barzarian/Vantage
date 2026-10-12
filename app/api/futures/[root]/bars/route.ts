import { NextResponse } from "next/server";
import { z } from "zod";
import { getMarketDataProvider } from "@/lib/market-data";
import { futuresAdjustmentSchema, barSchema } from "@/lib/market-data/schemas";
import { getFuturesRoot } from "@/lib/futures/specs";
import type { Timeframe } from "@/lib/market-data/provider";

const querySchema = z.object({
  timeframe: z.enum(["1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M"]),
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
  adjustment: futuresAdjustmentSchema,
}).refine(({ from, to }) => from < to, { path: ["from"], message: "from must precede to" });

export async function GET(request: Request, context: { params: Promise<{ root: string }> }) {
  const parsed = querySchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!parsed.success) {
    return NextResponse.json({ error: "Invalid continuous futures bars request.", code: "VALIDATION_ERROR" }, { status: 400 });
  }
  try {
    const { root: routeRoot } = await context.params;
    const root = getFuturesRoot(decodeURIComponent(routeRoot));
    const bars = await getMarketDataProvider().getContinuousBars(
      root.root,
      parsed.data.timeframe as Timeframe,
      { from: parsed.data.from, to: parsed.data.to, limit: 5000 },
      parsed.data.adjustment,
    );
    return NextResponse.json(barSchema.array().parse(bars), { headers: { "Cache-Control": "private, max-age=5, stale-while-revalidate=30" } });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Could not load continuous futures bars.",
      code: "CONTINUOUS_BARS_FAILED",
    }, { status: 502 });
  }
}
