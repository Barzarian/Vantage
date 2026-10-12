import {
  getUnreadAlertCount,
  listAlertEvents,
  listAlerts,
  listNotificationChannels,
  saveAlert,
} from "@/lib/alerts/service";
import { withAlertUser } from "@/lib/alerts/http";

export const runtime = "nodejs";

export async function GET() {
  return withAlertUser(async (userId) => Response.json({
    alerts: await listAlerts(userId),
    events: await listAlertEvents(userId),
    channels: await listNotificationChannels(userId),
    unreadCount: await getUnreadAlertCount(userId),
  }, { headers: { "Cache-Control": "private, no-store" } }));
}

export async function POST(request: Request) {
  return withAlertUser(async (userId) => Response.json(
    await saveAlert(userId, await request.json()),
    { status: 201, headers: { "Cache-Control": "private, no-store" } },
  ));
}
