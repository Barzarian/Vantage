import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { BridgeConfig } from "./config.js";
import type { IbkrConnection } from "./connection.js";
import { ContractResolver } from "./contracts.js";
import { LineLimitError, MarketDataSubscriptions, type NormalizedQuote } from "./streaming.js";
import { HistoricalDataService, type HistoryTimeframe } from "./history.js";
import { z } from "zod";

function authorized(request: IncomingMessage, token: string): boolean {
  const candidate = request.headers["x-ibkr-bridge-token"];
  if (typeof candidate !== "string") return false;
  const supplied = Buffer.from(candidate);
  const expected = Buffer.from(token);
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(value));
}

export function createBridgeServer(
  config: BridgeConfig,
  connection: IbkrConnection,
  contracts: ContractResolver,
  subscriptions: MarketDataSubscriptions,
  history: HistoricalDataService,
) {
  return createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", `http://${config.IBKR_BRIDGE_HOST}:${config.IBKR_BRIDGE_PORT}`);
    if (request.method !== "GET") {
      sendJson(response, 405, { error: "Method not allowed." });
      return;
    }
    if (!authorized(request, config.IBKR_BRIDGE_TOKEN)) {
      sendJson(response, 401, { error: "Unauthorized." });
      return;
    }
    if (url.pathname === "/health") {
      sendJson(response, 200, {
        ...connection.getHealth(),
        activeLines: subscriptions.activeLines,
        queuedHistoricalRequests: history.queue.queuedRequests,
      });
      return;
    }
    try {
      if (url.pathname === "/search") {
        const query = url.searchParams.get("q") ?? "";
        const results = await contracts.search(query);
        sendJson(response, 200, results);
        return;
      }
      const contractMatch = /^\/contract\/(\d+)$/.exec(url.pathname);
      if (contractMatch) {
        const conId = Number(contractMatch[1]);
        if (!Number.isSafeInteger(conId) || conId <= 0) {
          sendJson(response, 400, { error: "Invalid conId." });
          return;
        }
        sendJson(response, 200, await contracts.byConId(conId));
        return;
      }
      if (url.pathname === "/quotes") {
        const symbols = [...new Set([...url.searchParams.getAll("symbol"), ...(url.searchParams.get("symbols") ?? "").split(",")])]
          .map((symbol) => symbol.trim().toUpperCase())
          .filter(Boolean)
          .slice(0, 100);
        if (symbols.length === 0) {
          sendJson(response, 400, { error: "Provide at least one symbol." });
          return;
        }
        const quotes = await Promise.all(
          symbols.map(async (symbol) => {
            const resolved = await resolveContract(symbol, contracts);
            const exact = resolved.matches;
            if (exact.length > 1) {
              throw new AmbiguousContractError(symbol, exact);
            }
            const contract = resolved.contract;
            if (!contract) throw new MissingContractError(symbol);
            return waitForQuote(contract, subscriptions);
          }),
        );
        sendJson(response, 200, quotes);
        return;
      }
      if (url.pathname === "/stream") {
        const symbols = [...new Set([...url.searchParams.getAll("symbol"), ...(url.searchParams.get("symbols") ?? "").split(",")])]
          .map((symbol) => symbol.trim().toUpperCase())
          .filter(Boolean)
          .slice(0, 100);
        if (symbols.length === 0) {
          sendJson(response, 400, { error: "Provide at least one symbol." });
          return;
        }
        const requestedTimeframe = url.searchParams.get("timeframe") ?? "1m";
        const timeframeParsed = z.enum(["1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M"]).safeParse(requestedTimeframe);
        if (!timeframeParsed.success) {
          sendJson(response, 400, { error: "Unsupported bar timeframe." });
          return;
        }
        const timeframe: HistoryTimeframe = timeframeParsed.data;
        response.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache, no-transform",
          Connection: "keep-alive",
          "X-Accel-Buffering": "no",
        });
        const cleanups: Array<() => void> = [];
        const send = (event: string, data: unknown) => {
          if (!response.destroyed) response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        };
        try {
          const onConnectionState = (state: string) => {
            send("status", { ...connection.getHealth(), state, activeLines: subscriptions.activeLines });
          };
          const onConnectionError = (error: unknown) => send("error", error);
          connection.on("state", onConnectionState);
          connection.on("ibError", onConnectionError);
          cleanups.push(() => connection.removeListener("state", onConnectionState));
          cleanups.push(() => connection.removeListener("ibError", onConnectionError));
          cleanups.push(subscriptions.onError((error) => {
            const action =
              error.code === 354
                ? "Market data is not subscribed for this instrument. Enable the required IBKR market data subscription or set IB_MARKET_DATA_TYPE=3."
                : error.code === 200
                  ? "IBKR could not find a security definition. Refine the symbol or select a different listing."
                  : `IBKR market-data error ${error.code}: ${error.message}`;
            send("error", { ...error, action });
          }));
          const resolved = await Promise.all(symbols.map((symbol) => resolveContract(symbol, contracts)));
          for (let index = 0; index < symbols.length; index += 1) {
            const exact = resolved[index]!.matches;
            if (exact.length > 1) {
              send("error", { code: "AMBIGUOUS_SYMBOL", symbol: symbols[index], matches: exact });
              continue;
            }
            const contract = resolved[index]!.contract;
            if (!contract) {
              send("error", { code: "UNKNOWN_SYMBOL", symbol: symbols[index] });
              continue;
            }
            try {
              cleanups.push(
                subscriptions.subscribe(
                  contract,
                  (quote) => send("tick", quote),
                  (bar) => send("bar", { symbol: contract.symbol, bar }),
                  timeframe,
                  url.searchParams.get("evictable") === "true",
                ),
              );
            } catch (error) {
              if (!(error instanceof LineLimitError)) throw error;
              send("error", { code: "LINE_LIMIT", message: error.message });
            }
          }
          send("status", connection.getHealth());
        } catch (error) {
          const message = error instanceof Error ? error.message : "Unable to subscribe.";
          send("error", { code: "SUBSCRIPTION_FAILED", message });
        }
        const heartbeat = setInterval(() => send("heartbeat", Date.now()), 15_000);
        response.on("close", () => {
          clearInterval(heartbeat);
          for (const cleanup of cleanups) cleanup();
        });
        return;
      }
      if (url.pathname === "/bars") {
        const parsed = z.object({
          symbol: z.string().min(1).max(64),
          timeframe: z.enum(["1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M"]),
          from: z.coerce.number().int().positive(),
          to: z.coerce.number().int().positive(),
          useRTH: z.enum(["true", "false"]).optional(),
        }).safeParse(Object.fromEntries(url.searchParams));
        if (!parsed.success) {
          sendJson(response, 400, { error: "Provide a symbol, supported timeframe, and epoch-second from/to range." });
          return;
        }
        if (parsed.data.to <= parsed.data.from) {
          sendJson(response, 400, { error: "The to timestamp must be after from." });
          return;
        }
        const resolved = await resolveContract(parsed.data.symbol.toUpperCase(), contracts);
        if (resolved.matches.length > 1) {
          throw new AmbiguousContractError(parsed.data.symbol, resolved.matches);
        }
        if (!resolved.contract) throw new MissingContractError(parsed.data.symbol);
        const bars = await history.getBars(
          resolved.contract,
          parsed.data.timeframe,
          parsed.data.from,
          parsed.data.to,
          parsed.data.useRTH === undefined ? undefined : parsed.data.useRTH === "true",
        );
        sendJson(response, 200, bars);
        return;
      }
      if (url.pathname === "/front-month") {
        const parsed = z.object({
          root: z.string().min(1).max(16),
          exchange: z.string().min(1).max(32),
          currency: z.string().min(1).max(8).default("USD"),
        }).safeParse(Object.fromEntries(url.searchParams));
        if (!parsed.success) {
          sendJson(response, 400, { error: "Provide a futures root and exchange." });
          return;
        }
        sendJson(response, 200, await contracts.resolveFrontMonth(
          parsed.data.root.toUpperCase(),
          parsed.data.exchange.toUpperCase(),
          parsed.data.currency.toUpperCase(),
        ));
        return;
      }
      if (url.pathname === "/curve") {
        const parsed = z.object({
          root: z.string().min(1).max(16),
          exchange: z.string().optional(),
          currency: z.string().default("USD"),
        }).safeParse(Object.fromEntries(url.searchParams));
        if (!parsed.success) {
          sendJson(response, 400, { error: "Provide a futures root." });
          return;
        }
        const all = await contracts.search(parsed.data.root.toUpperCase());
        const current = all
          .filter((contract) => contract.secType === "FUT")
          .filter((contract) => !parsed.data.exchange || contract.exchange === parsed.data.exchange!.toUpperCase())
          .filter((contract) => contract.currency === parsed.data.currency.toUpperCase())
          .filter((contract) => contract.lastTradeDate || contract.contractMonth)
          .sort((left, right) =>
            (left.lastTradeDate ?? left.contractMonth ?? "").localeCompare(
              right.lastTradeDate ?? right.contractMonth ?? "",
            ),
          )
          .slice(0, 12);
        const quotes = await Promise.all(current.map((contract) => waitForQuote(contract, subscriptions)));
        const curve = quotes.map((quote, index) => {
          const contract = current[index]!;
          const rawExpiry = contract.lastTradeDate ?? contract.contractMonth ?? "";
          const expiry = rawExpiry.length === 8
            ? `${rawExpiry.slice(0, 4)}-${rawExpiry.slice(4, 6)}-${rawExpiry.slice(6, 8)}`
            : `${rawExpiry.slice(0, 4)}-${rawExpiry.slice(4, 6)}-01`;
          const daysToExpiry = Math.max(0, Math.ceil((Date.parse(`${expiry}T00:00:00Z`) - Date.now()) / 86_400_000));
          return { symbol: contract.localSymbol ?? contract.symbol, expiry, last: quote.last, daysToExpiry };
        });
        sendJson(response, 200, curve);
        return;
      }
      sendJson(response, 404, { error: "Not found." });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Bridge request failed.";
      if (error instanceof AmbiguousContractError) {
        sendJson(response, 409, { error: message, symbol: error.symbol, matches: error.matches });
        return;
      }
      const status = error instanceof LineLimitError ? 429 : error instanceof MissingContractError ? 404 : error instanceof RangeError ? 400 : message.includes("not connected") ? 503 : 502;
      sendJson(response, status, {
        error: message,
        code:
          error instanceof LineLimitError
            ? "LINE_LIMIT"
            : error instanceof MissingContractError
              ? "UNKNOWN_SYMBOL"
              : message.includes("market data is not subscribed")
                ? "MARKET_DATA_NOT_SUBSCRIBED"
                : undefined,
      });
    }
  });
}

class AmbiguousContractError extends Error {
  constructor(readonly symbol: string, readonly matches: Awaited<ReturnType<ContractResolver["search"]>>) {
    super(`Multiple listings found for ${symbol}. Choose an exchange and currency.`);
  }
}

class MissingContractError extends Error {
  constructor(readonly symbol: string) {
    super(`No IBKR contract found for ${symbol}. Search and select a listing first.`);
  }
}

async function waitForQuote(
  contract: Awaited<ReturnType<ContractResolver["byConId"]>>,
  subscriptions: MarketDataSubscriptions,
): Promise<NormalizedQuote> {
  return new Promise<NormalizedQuote>((resolve, reject) => {
    let unsubscribe = () => {};
    let unsubscribeError = () => {};
    let latest: NormalizedQuote | undefined;
    const timer = setTimeout(() => {
      unsubscribe();
      unsubscribeError();
      latest ??= subscriptions.snapshot(contract.conId);
      if (latest) resolve(latest);
      else reject(new Error(`Timed out waiting for market data for ${contract.symbol}. Check IBKR market data permissions.`));
    }, 1500);
    unsubscribeError = subscriptions.onError((error) => {
      if (error.conId !== contract.conId || (error.code !== 354 && error.code !== 200)) return;
      clearTimeout(timer);
      unsubscribe();
      unsubscribeError();
      reject(
        new Error(
          error.code === 354
            ? `IBKR market data is not subscribed for ${contract.symbol}. Enable the relevant subscription or use delayed data.`
            : `IBKR could not find a security definition for ${contract.symbol}.`,
        ),
      );
    });
    try {
      unsubscribe = subscriptions.subscribe(contract, (quote) => {
        latest = quote;
        if (!quote.last && !quote.bid && !quote.ask) return;
        clearTimeout(timer);
        unsubscribe();
        unsubscribeError();
        resolve(quote);
      });
    } catch (error) {
      clearTimeout(timer);
      unsubscribeError();
      reject(error);
    }

  });
}

async function resolveContract(symbol: string, resolver: ContractResolver) {
  const conIdMatch = /^conId:(\d+)$/i.exec(symbol);
  if (conIdMatch) {
    const contract = await resolver.byConId(Number(conIdMatch[1]));
    return { contract, matches: [contract] };
  }
  const matches = (await resolver.search(symbol)).filter(
    (match) => match.symbol.toUpperCase() === symbol,
  );
  return { contract: matches[0], matches };
}
