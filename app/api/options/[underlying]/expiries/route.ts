import { NextResponse } from "next/server";
import { z } from "zod";
import { getMarketDataProvider } from "@/lib/market-data";
import { optionExpiriesSchema } from "@/lib/market-data/schemas";

const underlyingSchema = z.string().trim().min(1).max(16).regex(/^[A-Z0-9.]+$/);

export async function GET(
  _request: Request,
  context: { params: Promise<{ underlying: string }> },
) {
  try {
    const { underlying } = await context.params;
    const parsedUnderlying = underlyingSchema.parse(decodeURIComponent(underlying).toUpperCase());
    const expiries = optionExpiriesSchema.parse(
      await getMarketDataProvider().getOptionExpiries(parsedUnderlying),
    );
    return NextResponse.json(expiries, {
      headers: { "Cache-Control": "private, max-age=30, stale-while-revalidate=120" },
    });
  } catch (error) {
    const status =
      typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
        ? error.status
        : error instanceof z.ZodError ? 400 : 502;
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Could not load option expiries.",
      code: error instanceof z.ZodError ? "VALIDATION_ERROR" : "OPTION_EXPIRIES_FAILED",
    }, { status });
  }
}
