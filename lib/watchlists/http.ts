import { NextResponse } from "next/server";
import { ZodError, type ZodType } from "zod";
import { WatchlistError } from "./model";

export async function parseJson<T>(request: Request, schema: ZodType<T>): Promise<T> {
  const input = await readJsonBody(request);
  return schema.parse(input);
}

export async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new WatchlistError("Request body must contain valid JSON.", 400, "INVALID_JSON");
    }
    throw error;
  }
}

export function watchlistErrorResponse(error: unknown): NextResponse {
  if (error instanceof ZodError) {
    return NextResponse.json({
      error: "Request validation failed.",
      code: "VALIDATION_ERROR",
      details: error.issues.map(({ path, message }) => ({ path: path.join("."), message })),
    }, { status: 400 });
  }
  if (error instanceof WatchlistError) {
    return NextResponse.json({ error: error.message, code: error.code }, { status: error.status });
  }
  const message = error instanceof Error ? error.message : "Watchlist request failed.";
  console.error(`[watchlists] ${message}`);
  return NextResponse.json({ error: "Watchlist request failed.", code: "INTERNAL_ERROR" }, { status: 500 });
}
