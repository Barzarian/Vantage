import { NextResponse } from "next/server";
import { z } from "zod";
import { getMarketDataProvider } from "@/lib/market-data";
import { barSchema } from "@/lib/market-data/schemas";

const requestSchema = z.object({
  symbol: z.string().trim().min(1).max(32),
  timeframe: z.enum(["1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M"]),
  from: z.coerce.number().int().positive(),
  to: z.coerce.number().int().positive(),
  limit: z.coerce.number().int().min(1).max(5000).optional(),
}).refine((value) => value.from < value.to, { message: "from must precede to", path: ["from"] });

export async function GET(request: Request) {
  const input = requestSchema.safeParse(Object.fromEntries(new URL(request.url).searchParams));
  if (!input.success) {
    return NextResponse.json({
      error: "Invalid bar request.",
      code: "VALIDATION_ERROR",
      details: input.error.issues,
    }, { status: 400 });
  }
  try {
    const bars = await getMarketDataProvider().getBars(
      input.data.symbol,
      input.data.timeframe,
      { from: input.data.from, to: input.data.to, limit: input.data.limit },
    );
    return NextResponse.json(z.array(barSchema).parse(bars), {
      headers: { "Cache-Control": "private, max-age=5, stale-while-revalidate=30" },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Historical bars failed.";
    const status =
      typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
        ? error.status
        : 502;
    return NextResponse.json({ error: message, code: "BAR_REQUEST_FAILED" }, { status });
  }
}
