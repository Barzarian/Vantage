import { NextResponse } from "next/server";
import { z } from "zod";
import { deleteSavedStrategy } from "@/lib/options/strategies-service";

const idSchema = z.string().uuid();

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ strategyId: string }> },
) {
  try {
    const { strategyId } = await context.params;
    await deleteSavedStrategy(idSchema.parse(strategyId));
    return NextResponse.json({ ok: true });
  } catch (error) {
    const isValidation = error instanceof z.ZodError;
    const status = isValidation ? 400 : error instanceof Error && error.message === "Saved strategy not found." ? 404 : 500;
    return NextResponse.json({
      error: error instanceof Error ? error.message : "Could not delete strategy.",
      code: isValidation ? "VALIDATION_ERROR" : status === 404 ? "STRATEGY_NOT_FOUND" : "STRATEGY_DELETE_FAILED",
    }, { status });
  }
}
