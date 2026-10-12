import { withAlertUser } from "@/lib/alerts/http";
import { deleteAlert, saveAlert, setAlertActive } from "@/lib/alerts/service";
import { alertActiveSchema } from "@/lib/alerts/model";

export const runtime = "nodejs";

type RouteContext = { params: Promise<{ alertId: string }> };

export async function PATCH(request: Request, context: RouteContext) {
  return withAlertUser(async (userId) => {
    const { alertId } = await context.params;
    const input: unknown = await request.json();
    const activeToggle = alertActiveSchema.safeParse(input);
    if (activeToggle.success) {
      return Response.json(await setAlertActive(userId, alertId, activeToggle.data.active));
    }
    return Response.json(await saveAlert(userId, input, alertId));
  });
}

export async function DELETE(_request: Request, context: RouteContext) {
  return withAlertUser(async (userId) => {
    const { alertId } = await context.params;
    await deleteAlert(userId, alertId);
    return new Response(null, { status: 204 });
  });
}
