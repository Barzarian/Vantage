import { NextResponse } from "next/server";
import { getMarketDataProvider } from "@/lib/market-data";
import { classifyCurve } from "@/lib/futures/curve";
import { futuresCurvePointSchema, futuresRootSchema } from "@/lib/market-data/schemas";

export async function GET() {
  try {
    const provider = getMarketDataProvider();
    const roots = futuresRootSchema.array().parse(await provider.getFuturesRoots());
    const rows = [];
    for (const root of roots) {
      const curve = futuresCurvePointSchema.array().parse(await provider.getFuturesCurve(root.root));
      const front = curve.find(({ contract }) => contract.isFront) ?? curve[0];
      if (!front) continue;
      rows.push({ root, front, curveShape: classifyCurve(curve), curve });
    }
    return NextResponse.json(rows, { headers: { "Cache-Control": "private, max-age=1, stale-while-revalidate=3" } });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Could not load futures overview.",
      code: "FUTURES_OVERVIEW_FAILED",
    }, { status: 502 });
  }
}
