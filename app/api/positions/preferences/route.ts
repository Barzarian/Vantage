import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { savePositionsPreferences } from "@/lib/positions/service";
import { authenticationErrorResponse, requireCurrentUserId } from "@/lib/auth/user";

export async function PATCH(request: Request) {
  try {
    return NextResponse.json(await savePositionsPreferences(await request.json(), await requireCurrentUserId()));
  } catch (error) {
    const authResponse = authenticationErrorResponse(error);
    if (authResponse) return authResponse;
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: "Request body must contain valid JSON." }, { status: 400 });
    }
    if (error instanceof ZodError) {
      return NextResponse.json({ error: "Request validation failed.", details: error.issues }, { status: 400 });
    }
    console.error(`[positions] ${error instanceof Error ? error.message : "Unknown preferences error."}`);
    return NextResponse.json({ error: "Positions preferences could not be saved." }, { status: 500 });
  }
}
