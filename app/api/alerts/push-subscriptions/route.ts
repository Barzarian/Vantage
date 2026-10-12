import { withAlertUser } from "@/lib/alerts/http";
import {
  removePushSubscription,
  savePushSubscription,
} from "@/lib/alerts/service";

export const runtime = "nodejs";

export async function POST(request: Request) {
  return withAlertUser(async (userId) => {
    await savePushSubscription(userId, await request.json());
    return Response.json({ ok: true }, { status: 201 });
  });
}

export async function DELETE(request: Request) {
  return withAlertUser(async (userId) => {
    const body: unknown = await request.json();
    if (typeof body !== "object" || body === null || !("endpoint" in body) || typeof body.endpoint !== "string") {
      return Response.json({ error: "endpoint is required." }, { status: 400 });
    }
    await removePushSubscription(userId, body.endpoint);
    return Response.json({ ok: true });
  });
}
