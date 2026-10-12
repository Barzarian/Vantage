import { getMarketDataProvider } from "@/lib/market-data";
import { barSchema, optionQuoteSchema, quoteSchema } from "@/lib/market-data/schemas";
import { parseOccSymbol } from "@/lib/greeks/occ";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const symbols = [...new Set(new URL(request.url).searchParams.getAll("symbol"))]
    .map((symbol) => symbol.trim())
    .filter((symbol) => symbol.length > 0 && symbol.length <= 32)
    .slice(0, 100);
  const optionSymbols = [...new Set(new URL(request.url).searchParams.getAll("optionSymbol"))]
    .map((symbol) => symbol.trim().toUpperCase())
    .slice(0, 500);

  if (symbols.length === 0 && optionSymbols.length === 0) {
    return new Response("At least one symbol or optionSymbol is required.", { status: 400 });
  }

  const encoder = new TextEncoder();
  const unsubscribes: Array<() => void> = [];
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`));
        } catch (error) {
          if (error instanceof TypeError) return;
          throw error;
        }
      };
      try {
        const provider = getMarketDataProvider();
        if (symbols.length) {
          unsubscribes.push(provider.subscribe(symbols, (tick) => {
            const parsed = quoteSchema.safeParse(tick);
            if (parsed.success) send("tick", parsed.data);
            else send("error", { code: "INVALID_TICK", message: "The market-data provider returned an invalid quote." });
          }, (symbol, bar) => {
            const parsed = barSchema.safeParse(bar);
            if (parsed.success) send("bar", { symbol, bar: parsed.data });
            else send("error", { code: "INVALID_BAR", message: "The market-data provider returned an invalid bar." });
          }, undefined, (status, event) => {
            send(event, status);
          }));
        }
        if (optionSymbols.length) {
          const validSymbols = optionSymbols.map((symbol) => parseOccSymbol(symbol).occSymbol);
          unsubscribes.push(provider.subscribeOptions(validSymbols, (tick) => {
            const parsed = optionQuoteSchema.safeParse(tick);
            if (parsed.success) send("optionTick", parsed.data);
            else send("error", { code: "INVALID_OPTION_TICK", message: "The market-data provider returned an invalid option quote." });
          }));
        }
      } catch (error) {
        send("error", {
          code: typeof error === "object" && error !== null && "code" in error ? error.code : "STREAM_FAILED",
          message: error instanceof Error ? error.message : "Market stream failed.",
        });
      }
      heartbeat = setInterval(() => send("heartbeat", Date.now()), 15000);
      request.signal.addEventListener("abort", () => {
        for (const unsubscribe of unsubscribes) unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
        controller.close();
      }, { once: true });
    },
    cancel() {
      for (const unsubscribe of unsubscribes) unsubscribe();
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
