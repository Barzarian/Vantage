import { requireCurrentUserId } from "@/lib/auth/user";
import { alertErrorResponse } from "@/lib/alerts/http";
import { getUnreadAlertCount, listAlertEvents } from "@/lib/alerts/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  let userId: string;
  try {
    userId = await requireCurrentUserId();
  } catch (error) {
    return alertErrorResponse(error);
  }
  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const afterText = new URL(request.url).searchParams.get("after");
      const parsedAfter = afterText ? Date.parse(afterText) : 0;
      let lastSentAt = new Date(Number.isFinite(parsedAfter) ? parsedAfter : 0);
      const sentIds = new Set<string>();
      let closed = false;
      let sending = false;
      const send = async () => {
        if (closed || sending) return;
        sending = true;
        try {
          const [events, unreadCount] = await Promise.all([
            listAlertEvents(userId, { from: lastSentAt.toISOString() }),
            getUnreadAlertCount(userId),
          ]);
          const unseenEvents = events.filter((event) => !sentIds.has(event.id));
          if (closed) return;
          if (unseenEvents.length) {
            const latest = unseenEvents.reduce((current, event) =>
              Date.parse(event.triggeredAt) > current ? Date.parse(event.triggeredAt) : current,
            lastSentAt.getTime());
            controller.enqueue(encoder.encode(`event: alerts\ndata: ${JSON.stringify({ events: unseenEvents, unreadCount })}\n\n`));
            lastSentAt = new Date(latest);
            for (const event of unseenEvents) sentIds.add(event.id);
            while (sentIds.size > 1000) sentIds.delete(sentIds.values().next().value!);
          } else {
            controller.enqueue(encoder.encode(`event: count\ndata: ${JSON.stringify({ unreadCount })}\n\n`));
          }
        } catch (error) {
          if (!closed) {
            controller.enqueue(encoder.encode(`event: error\ndata: ${JSON.stringify({
              message: error instanceof Error ? error.message : "Alert event stream failed.",
            })}\n\n`));
          }
        } finally {
          sending = false;
        }
      };
      const interval = setInterval(() => void send(), 2000);
      void send();
      request.signal.addEventListener("abort", () => {
        closed = true;
        clearInterval(interval);
        controller.close();
      }, { once: true });
    },
    cancel() {},
  });
  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "private, no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
