import { z } from "zod";
import { env } from "@/lib/market-data/env";
import type {
  BarRange,
  BarListener,
  MarketDataProvider,
  ProviderStreamStatus,
  TickListener,
  Timeframe,
} from "@/lib/market-data/provider";
import {
  barSchema,
  futuresContractSchema,
  quoteSchema,
  instrumentSearchResultSchema,
  type Bar,
  type FuturesContract,
  type OptionContract,
  type InstrumentSearchResult,
  type Quote,
} from "@/lib/market-data/schemas";

const normalizedQuoteSchema = z.object({
  conId: z.number().int().positive(),
  symbol: z.string(),
  name: z.string(),
  type: z.enum(["stock", "future", "index"]),
  last: z.number(),
  change: z.number(),
  changePercent: z.number(),
  bid: z.number(),
  ask: z.number(),
  bidSize: z.number(),
  askSize: z.number(),
  lastSize: z.number(),
  volume: z.number(),
  high: z.number(),
  low: z.number(),
  open: z.number(),
  prevClose: z.number(),
  updatedAt: z.string().datetime(),
  dataType: z.enum(["realtime", "delayed", "frozen"]),
});

export class IbkrBridgeError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code?: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = "IbkrBridgeError";
  }
}

export class IbkrProvider implements MarketDataProvider {
  private readonly headers: HeadersInit;

  constructor(
    private readonly bridgeUrl = env.IBKR_BRIDGE_URL,
    token = env.IBKR_BRIDGE_TOKEN,
  ) {
    if (!token || token.length < 32) {
      throw new Error("IBKR_BRIDGE_TOKEN must contain at least 32 characters.");
    }
    this.headers = { "x-ibkr-bridge-token": token };
  }

  async getQuote(symbols: string[]): Promise<Quote[]> {
    const params = new URLSearchParams();
    for (const symbol of symbols) params.append("symbol", symbol);
    const raw = await this.request(`/quotes?${params.toString()}`);
    const quotes = z.array(normalizedQuoteSchema).parse(raw);
    return quotes.map((quote) =>
      quoteSchema.parse({
        ...quote,
        dayLow: quote.low,
        dayHigh: quote.high,
        weekLow: quote.low,
        weekHigh: quote.high,
      }),
    );
  }

  async getBars(symbol: string, timeframe: Timeframe, range: BarRange): Promise<Bar[]> {
    const params = new URLSearchParams({
      symbol,
      timeframe,
      from: String(range.from),
      to: String(range.to),
    });
    if (range.limit !== undefined) params.set("limit", String(range.limit));
    return z.array(barSchema).parse(await this.request(`/bars?${params.toString()}`));
  }

  async getOptionChain(underlying: string, expiry?: string): Promise<OptionContract[]> {
    throw new IbkrBridgeError(
      `IBKR options are not supported in this integration stage (${underlying}${expiry ? ` ${expiry}` : ""}).`,
      501,
      "UNSUPPORTED",
    );
  }

  async getFuturesCurve(root: string): Promise<FuturesContract[]> {
    const raw = await this.request(`/curve?root=${encodeURIComponent(root)}`);
    return z.array(futuresContractSchema).parse(raw);
  }

  async searchSymbols(query: string): Promise<InstrumentSearchResult[]> {
    const raw = await this.request(`/search?q=${encodeURIComponent(query)}`);
    return z.array(instrumentSearchResultSchema).parse(raw);
  }

  subscribe(
    symbols: string[],
    onTick: TickListener,
    onBar?: BarListener,
    timeframe: Timeframe = "1m",
    onStatus?: (status: ProviderStreamStatus, event: "status" | "error") => void,
    evictable = false,
  ): () => void {
    const controller = new AbortController();
    const params = new URLSearchParams();
    for (const symbol of [...new Set(symbols)]) params.append("symbol", symbol);

    params.set("timeframe", timeframe);
    if (evictable) params.set("evictable", "true");
    void this.readStream(`/stream?${params.toString()}`, controller.signal, onTick, onBar, onStatus);
    return () => controller.abort();
  }

  private async request(path: string): Promise<unknown> {
    let response: Response;
    try {
      response = await fetch(new URL(path, this.bridgeUrl), {
        headers: this.headers,
        cache: "no-store",
      });
    } catch (error) {
      throw new IbkrBridgeError(
        `Could not reach the IBKR bridge: ${error instanceof Error ? error.message : "network error"}`,
        503,
        "BRIDGE_UNAVAILABLE",
      );
    }
    const body: unknown = await response.json();
    if (!response.ok) {
      const errorBody = z.object({ error: z.string().optional(), code: z.string().optional() }).safeParse(body);
      throw new IbkrBridgeError(
        errorBody.success ? errorBody.data.error ?? "IBKR bridge request failed." : "IBKR bridge request failed.",
        response.status,
        errorBody.success ? errorBody.data.code : undefined,
        body,
      );
    }
    return body;
  }

  private async readStream(
    path: string,
    signal: AbortSignal,
    onTick: TickListener,
    onBar?: BarListener,
    onStatus?: (status: ProviderStreamStatus, event: "status" | "error") => void,
  ): Promise<void> {
    let attempt = 0;
    while (!signal.aborted) {
      try {
        onStatus?.({ state: attempt === 0 ? "connecting" : "reconnecting" }, "status");
        const response = await fetch(new URL(path, this.bridgeUrl), {
          headers: this.headers,
          signal,
          cache: "no-store",
        });
        if (!response.ok || !response.body) {
          const text = await response.text();
          throw new IbkrBridgeError(text || "IBKR stream connection failed.", response.status);
        }
        attempt = 0;
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        while (!signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const events = buffer.split("\n\n");
          buffer = events.pop() ?? "";
          for (const rawEvent of events) {
            const eventName = rawEvent.match(/^event: ([^\r\n]+)/m)?.[1];
            const data = rawEvent.match(/^data: (.+)$/m)?.[1];
            if (!data) continue;
            if (eventName === "status") {
              const status = z.object({
                state: z.enum(["disconnected", "connecting", "reconnecting", "live"]).optional(),
                marketDataType: z.number().optional(),
                activeLines: z.number().optional(),
                lastError: z.string().optional(),
              }).safeParse(JSON.parse(data));
              if (status.success) {
                onStatus?.(
                  {
                    state: status.data.state,
                    marketDataType: status.data.marketDataType,
                    activeLines: status.data.activeLines,
                    message: status.data.lastError,
                  },
                  "status",
                );
              }
            } else if (eventName === "error") {
              const error = z.object({
                code: z.union([z.number(), z.string()]).optional(),
                message: z.string().optional(),
                action: z.string().optional(),
                symbol: z.string().optional(),
              }).safeParse(JSON.parse(data));
              if (error.success) {
                onStatus?.(
                  {
                    code: typeof error.data.code === "number" ? error.data.code : undefined,
                    message: error.data.action ?? error.data.message ?? "IBKR market-data error.",
                  },
                  "error",
                );
              }
            } else if (eventName === "tick") {
              const parsed = normalizedQuoteSchema.safeParse(JSON.parse(data));
              if (!parsed.success) {
                console.error("[ibkr] ignored invalid normalized quote from bridge", parsed.error.issues);
                continue;
              }
              const quote = parsed.data;
              onTick(
                quoteSchema.parse({
                  ...quote,
                  dayLow: quote.low,
                  dayHigh: quote.high,
                  weekLow: quote.low,
                  weekHigh: quote.high,
                }),
              );
            } else if (eventName === "bar" && onBar) {
              const parsed = z.object({
                symbol: z.string(),
                bar: barSchema,
              }).safeParse(JSON.parse(data));
              if (parsed.success) onBar(parsed.data.symbol, parsed.data.bar);
              else console.error("[ibkr] ignored invalid live bar from bridge", parsed.error.issues);
            }
          }
        }
        if (signal.aborted) return;
      } catch (error) {
        if (signal.aborted) return;
        console.error("[ibkr] market data stream failed", error);
        onStatus?.(
          {
            state: "disconnected",
            message: error instanceof Error ? error.message : "IBKR stream connection failed.",
          },
          "status",
        );
      }
      attempt += 1;
      onStatus?.({ state: "reconnecting" }, "status");
      const delay = Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)) * (0.8 + Math.random() * 0.4);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, delay);
        signal.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        }, { once: true });
      });
    }
  }
}
