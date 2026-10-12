import { withAlertUser } from "@/lib/alerts/http";
import { listNotificationChannels, saveNotificationChannel, setNotificationChannelEnabled } from "@/lib/alerts/service";

export const runtime = "nodejs";

export async function GET() {
  return withAlertUser(async (userId) => Response.json({
    channels: await listNotificationChannels(userId),
  }, { headers: { "Cache-Control": "private, no-store" } }));
}

export async function POST(request: Request) {
  return withAlertUser(async (userId) => Response.json(
    await saveNotificationChannel(userId, await request.json()),
  ));
}

export async function PATCH(request: Request) {
  return withAlertUser(async (userId) => Response.json(
    await setNotificationChannelEnabled(userId, await request.json()),
  ));
}
