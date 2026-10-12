import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { AuthenticationRequiredError, requireCurrentUserId } from "@/lib/auth/user";
import { AlertServiceError } from "./service";

export async function withAlertUser(
  handler: (userId: string) => Promise<Response>,
): Promise<Response> {
  try {
    return await handler(await requireCurrentUserId());
  } catch (error) {
    return alertErrorResponse(error);
  }
}

export function alertErrorResponse(error: unknown): Response {
  if (error instanceof AuthenticationRequiredError) {
    return NextResponse.json({ error: error.message }, { status: 401 });
  }
  if (error instanceof SyntaxError) {
    return NextResponse.json({ error: "Request body must contain valid JSON." }, { status: 400 });
  }
  if (error instanceof ZodError) {
    return NextResponse.json({
      error: "Request validation failed.",
      details: error.issues.map(({ path, message }) => ({ path: path.join("."), message })),
    }, { status: 400 });
  }
  if (error instanceof AlertServiceError) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }
  console.error(`[alerts] ${error instanceof Error ? error.message : "Unknown alert request error."}`);
  return NextResponse.json({ error: "Alert request failed." }, { status: 500 });
}
