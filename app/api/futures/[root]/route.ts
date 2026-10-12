import { NextResponse } from "next/server";
import { z } from "zod";
import { getMarketDataProvider } from "@/lib/market-data";
import { getFuturesRoot } from "@/lib/futures/specs";
import { futuresContractSchema, futuresCurvePointSchema } from "@/lib/market-data/schemas";

export async function GET(_request: Request, context: { params: Promise<{ root: string }> }) {
  try {
    const { root: routeRoot } = await context.params;
    const root = getFuturesRoot(decodeURIComponent(routeRoot));
    const provider = getMarketDataProvider();
    const [contracts, curve] = await Promise.all([
      provider.getFuturesContracts(root.root),
      provider.getFuturesCurve(root.root),
    ]);
    return NextResponse.json({
      root,
      contracts: futuresContractSchema.array().parse(contracts),
      curve: futuresCurvePointSchema.array().parse(curve),
    }, { headers: { "Cache-Control": "private, max-age=2, stale-while-revalidate=5" } });
  } catch (error) {
    const status = error instanceof z.ZodError ? 400
      : typeof error === "object" && error !== null && "status" in error && typeof error.status === "number"
        ? error.status : 502;
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Could not load futures contracts.",
      code: error instanceof z.ZodError ? "VALIDATION_ERROR" : "FUTURES_CURVE_FAILED",
    }, { status });
  }
}
