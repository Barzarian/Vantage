import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { createPositionTransaction, getPositionsData, PositionServiceError } from "@/lib/positions/service";
import { authenticationErrorResponse, requireCurrentUserId } from "@/lib/auth/user";

export async function GET() {
  try {
    return NextResponse.json(await getPositionsData(await requireCurrentUserId()));
  } catch (error) {
    return positionErrorResponse(error);
  }
}

export async function POST(request: Request) {
  try {
    const transaction = await createPositionTransaction(await request.json(), await requireCurrentUserId());
    return NextResponse.json(transaction, { status: 201 });
  } catch (error) {
    return positionErrorResponse(error);
  }
}

function positionErrorResponse(error: unknown): Response {
  const authResponse = authenticationErrorResponse(error);
  if (authResponse) return authResponse;
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Request body must contain valid JSON." }, { status: 400 });
  }
  if (error instanceof ZodError) {
    return NextResponse.json({
      error: "Request validation failed.",
      details: error.issues.map(({ path, message }) => ({ path: path.join("."), message })),
    }, { status: 400 });
  }
  if (error instanceof PositionServiceError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(`[positions] ${error instanceof Error ? error.message : "Unknown positions error."}`);
  return NextResponse.json({ error: "Positions request failed." }, { status: 500 });
}
