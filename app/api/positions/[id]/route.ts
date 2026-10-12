import { NextResponse } from "next/server";
import { ZodError } from "zod";
import {
  deletePositionTransaction,
  PositionServiceError,
  updatePositionTransaction,
} from "@/lib/positions/service";
import { authenticationErrorResponse, requireCurrentUserId } from "@/lib/auth/user";

type RouteContext = { params: Promise<{ id: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    return NextResponse.json(await updatePositionTransaction(id, await request.json(), await requireCurrentUserId()));
  } catch (error) {
    return positionErrorResponse(error);
  }
}

export async function DELETE(_request: Request, context: RouteContext) {
  try {
    const { id } = await context.params;
    await deletePositionTransaction(id, await requireCurrentUserId());
    return new NextResponse(null, { status: 204 });
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
