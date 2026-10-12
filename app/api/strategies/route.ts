import { NextResponse } from "next/server";
import { z } from "zod";
import { listSavedStrategies, saveStrategy } from "@/lib/options/strategies-service";
import { savedStrategySchema, strategyLegSchema } from "@/lib/options/strategy";

const createSchema = z.object({
  name: z.string().trim().min(1).max(64),
  legs: strategyLegSchema.array().max(32),
});

export async function GET() {
  try {
    return NextResponse.json({ strategies: savedStrategySchema.array().parse(await listSavedStrategies()) });
  } catch (error) {
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Could not load saved strategies.",
      code: "STRATEGIES_LOAD_FAILED",
    }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const input = createSchema.parse(await request.json() as unknown);
    const strategy = await saveStrategy(input.name, input.legs);
    return NextResponse.json({ strategy: savedStrategySchema.parse(strategy) }, { status: 201 });
  } catch (error) {
    const isValidation = error instanceof z.ZodError;
    return NextResponse.json({
      error: isValidation ? "Invalid saved strategy." : error instanceof Error ? error.message : "Could not save strategy.",
      code: isValidation ? "VALIDATION_ERROR" : "STRATEGY_SAVE_FAILED",
      ...(isValidation ? { details: error.issues } : {}),
    }, { status: isValidation ? 400 : 500 });
  }
}
