import { NextResponse } from "next/server";
import { userPreferencesSchema } from "@/lib/watchlists/preferences";
import { getUserPreferences, saveUserPreferences } from "@/lib/watchlists/user-preferences";
import { watchlistErrorResponse } from "@/lib/watchlists/http";

export const runtime = "nodejs";

export async function GET() {
  try {
    return NextResponse.json({ preferences: await getUserPreferences() }, {
      headers: { "Cache-Control": "private, no-store" },
    });
  } catch (error) {
    return watchlistErrorResponse(error);
  }
}

export async function PUT(request: Request) {
  try {
    const input = userPreferencesSchema.parse(await request.json());
    return NextResponse.json({ preferences: await saveUserPreferences(input) });
  } catch (error) {
    return watchlistErrorResponse(error);
  }
}
