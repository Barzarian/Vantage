import { getMarketDataProvider } from "@/lib/market-data";
import { quoteSchema } from "@/lib/market-data/schemas";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const symbols = [...new Set(new URL(request.url).searchParams.getAll("symbol"))]
    .map((symbol) => symbol.trim())
    .filter((symbol) => symbol.length > 0 && symbol.length <= 32)
    .slice(0, 100);

  if (symbols.length === 0) {
    return new Response("At least one symbol is required.", { status: 400 });
  }

  const encoder = new TextEncoder();
  let unsubscribe = () => {};
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
      };
      unsubscribe = getMarketDataProvider().subscribe(symbols, (tick) => {
        const parsed = quoteSchema.safeParse(tick);
        if (parsed.success) send("tick", parsed.data);
      });
      heartbeat = setInterval(() => send("heartbeat", Date.now()), 15000);
      request.signal.addEventListener("abort", () => {
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        controller.close();
      }, { once: true });
    },
    cancel() {
      unsubscribe();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}
