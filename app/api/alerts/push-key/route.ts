import { env } from "@/lib/market-data/env";
import { withAlertUser } from "@/lib/alerts/http";

export const runtime = "nodejs";

export async function GET() {
  return withAlertUser(async () => {
    if (!env.ALERTS_VAPID_PUBLIC_KEY || !env.ALERTS_VAPID_PRIVATE_KEY || !env.ALERTS_VAPID_SUBJECT) {
      return Response.json({ error: "Web Push VAPID is not configured." }, { status: 503 });
    }
    return Response.json({ publicKey: env.ALERTS_VAPID_PUBLIC_KEY });
  });
}
