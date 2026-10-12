import { alertFilterSchema } from "@/lib/alerts/model";
import { markAlertEventRead, listAlertEvents } from "@/lib/alerts/service";
import { withAlertUser } from "@/lib/alerts/http";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return withAlertUser(async (userId) => {
    const params = new URL(request.url).searchParams;
    const filters = alertFilterSchema.parse({
      status: "all",
      symbol: params.get("symbol") ?? undefined,
      from: params.get("from") ?? undefined,
      to: params.get("to") ?? undefined,
    });
    return Response.json({
      events: await listAlertEvents(userId, filters),
    }, { headers: { "Cache-Control": "private, no-store" } });
  });
}

export async function POST(request: Request) {
  return withAlertUser(async (userId) => {
    const input: unknown = await request.json();
    if (typeof input !== "object" || input === null || !("eventId" in input) || typeof input.eventId !== "string") {
      return Response.json({ error: "eventId is required." }, { status: 400 });
    }
    await markAlertEventRead(userId, input.eventId);
    return Response.json({ ok: true });
  });
}
