"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Activity,
  Bell,
  ChevronDown,
  CircleHelp,
  Command,
  LayoutGrid,
  Search,
  Settings2,
  SlidersHorizontal,
  Wifi,
} from "lucide-react";
import type { InstrumentSearchResult, Quote } from "@/lib/market-data/schemas";
import { instrumentSearchResultSchema, quoteSchema } from "@/lib/market-data/schemas";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./theme-toggle";

type MarketTerminalProps = {
  initialQuotes: Quote[];
  initialStrip: Quote[];
};

const sections = ["Overview", "Watchlists", "Charts", "Options", "Futures", "Positions", "Alerts"];
const fmt = (value: number, type: Quote["type"]) =>
  value.toLocaleString("en-US", {
    minimumFractionDigits: type === "future" && value >= 100 ? 2 : 2,
    maximumFractionDigits: type === "future" && value >= 100 ? 2 : 2,
  });

function Sign({ value }: { value: number }) {
  return <span className={value >= 0 ? "text-emerald-400" : "text-rose-400"}>{value >= 0 ? "+" : ""}{value.toFixed(2)}%</span>;
}

export function MarketTerminal({ initialQuotes, initialStrip }: MarketTerminalProps) {
  const [quotes, setQuotes] = useState(() => new Map(initialQuotes.map((quote) => [quote.symbol, quote])));
  const [strip, setStrip] = useState(() => new Map(initialStrip.map((quote) => [quote.symbol, quote])));
  const [connected, setConnected] = useState(false);
  const [connectionState, setConnectionState] = useState<"disconnected" | "connecting" | "reconnecting" | "live">("connecting");
  const [streamMessage, setStreamMessage] = useState("");
  const [activeSection, setActiveSection] = useState("Overview");
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<InstrumentSearchResult[]>([]);
  const [searchError, setSearchError] = useState("");
  const [watchSymbols, setWatchSymbols] = useState(() => initialQuotes.map((quote) => quote.symbol));
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    const symbols = [...new Set([...watchSymbols, ...initialStrip.map((quote) => quote.symbol)])];
    const query = new URLSearchParams();
    symbols.forEach((symbol) => query.append("symbol", symbol));
    const events = new EventSource(`/api/stream?${query.toString()}`);
    const isIbkr = initialQuotes.some((quote) => quote.dataType !== undefined);
    events.onopen = () => {
      setConnected(true);
      if (!isIbkr) setConnectionState("live");
    };
    events.onerror = () => {
      setConnected(false);
      setConnectionState("disconnected");
    };
    events.addEventListener("status", (event) => {
      const data = (event as MessageEvent<string>).data;
      try {
        const status = JSON.parse(data) as { state?: typeof connectionState; lastError?: string; message?: string };
        if (status.state) setConnectionState(status.state);
        setStreamMessage(status.message ?? status.lastError ?? "");
      } catch {
        setStreamMessage("Received an invalid market connection status.");
      }
    });
    events.addEventListener("error", (event) => {
      const data = (event as MessageEvent<string>).data;
      if (!data) return;
      try {
        const error = JSON.parse(data) as { action?: string; message?: string };
        setStreamMessage(error.action ?? error.message ?? "IBKR market-data error.");
      } catch {
        setStreamMessage("IBKR market-data error.");
      }
    });
    events.addEventListener("tick", (event) => {
      const quote = JSON.parse((event as MessageEvent<string>).data) as Quote;
      setQuotes((current) => current.has(quote.symbol) ? new Map(current).set(quote.symbol, quote) : current);
      setStrip((current) => current.has(quote.symbol) ? new Map(current).set(quote.symbol, quote) : current);
      setNow(new Date(quote.updatedAt));
    });
    const clock = setInterval(() => setNow(new Date()), 1000);
    return () => {
      events.close();
      clearInterval(clock);
    };
  }, [watchSymbols, initialQuotes, initialStrip]);

  useEffect(() => {
    if (!searchOpen || !searchQuery.trim()) return;
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(searchQuery.trim())}`, {
          signal: controller.signal,
        });
        const result: unknown = await response.json();
        if (!response.ok) {
          const message =
            typeof result === "object" && result !== null && "error" in result && typeof result.error === "string"
              ? result.error
              : "Search failed.";
          throw new Error(message);
        }
        setSearchResults(instrumentSearchResultSchema.array().parse(result));
        setSearchError("");
      } catch (error) {
        if (controller.signal.aborted) return;
        setSearchResults([]);
        setSearchError(error instanceof Error ? error.message : "Search failed.");
      }
    }, 180);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [searchOpen, searchQuery]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen((open) => !open);
      }
      if (event.key === "/" && !(event.target instanceof HTMLInputElement)) {
        event.preventDefault();
        setSearchOpen(true);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const rows = useMemo(
    () => watchSymbols.flatMap((symbol) => {
      const quote = quotes.get(symbol) ?? initialQuotes.find((item) => item.symbol === symbol);
      return quote ? [quote] : [];
    }),
    [initialQuotes, quotes, watchSymbols],
  );
  const dataType = [...quotes.values()].find((quote) => quote.dataType)?.dataType;

  const addInstrument = async (instrument: InstrumentSearchResult) => {
    const symbol = initialQuotes.some((quote) => quote.dataType)
      ? `conId:${instrument.conId}`
      : instrument.symbol;
    const params = new URLSearchParams({ symbol });
    try {
      const response = await fetch(`/api/quotes?${params.toString()}`);
      const body: unknown = await response.json();
      if (!response.ok) {
        const message =
          typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
            ? body.error
            : "Could not add this instrument to the watchlist.";
        throw new Error(message);
      }
      const quote = quoteSchema.parse(Array.isArray(body) ? body[0] : undefined);
      setQuotes((current) => new Map(current).set(quote.symbol, quote));
      setWatchSymbols((current) => current.includes(quote.symbol) ? current : [...current, quote.symbol]);
      setSearchOpen(false);
      setSearchQuery("");
    } catch (error) {
      setSearchError(error instanceof Error ? error.message : "Could not add this instrument.");
    }
  };

  return (
    <main className="min-h-screen bg-[var(--background)]">
      <header className="flex h-14 items-center justify-between border-b border-[var(--border)] px-5">
        <div className="flex items-center gap-8">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight text-white">
            <span className="grid size-7 place-items-center rounded-md bg-emerald-400 text-[var(--background)]"><Activity size={16} strokeWidth={2.5} /></span>
            VANTAGE <span className="text-[10px] font-normal tracking-[0.18em] text-slate-500">TERMINAL</span>
          </Link>
          <nav className="hidden h-14 items-center gap-1 md:flex">
            {sections.map((section) => section === "Watchlists" ? (
              <Link key={section} href="/watchlists" className="flex h-full items-center border-b-2 border-transparent px-3 text-xs text-slate-500 transition-colors hover:text-slate-200">{section}</Link>
            ) : section === "Charts" ? (
              <Link key={section} href={`/chart/${encodeURIComponent(watchSymbols[0] ?? "AAPL")}`} className="flex h-full items-center border-b-2 border-transparent px-3 text-xs text-slate-500 transition-colors hover:text-slate-200">{section}</Link>
            ) : section === "Options" ? (
              <Link key={section} href="/options/SPY" className="flex h-full items-center border-b-2 border-transparent px-3 text-xs text-slate-500 transition-colors hover:text-slate-200">{section}</Link>
            ) : section === "Futures" ? (
              <Link key={section} href="/futures" className="flex h-full items-center border-b-2 border-transparent px-3 text-xs text-slate-500 transition-colors hover:text-slate-200">{section}</Link>
            ) : (
              <button key={section} onClick={() => setActiveSection(section)} className={cn("h-full border-b-2 px-3 text-xs transition-colors", activeSection === section ? "border-emerald-400 text-white" : "border-transparent text-slate-500 hover:text-slate-200")}>
                {section}
              </button>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={() => setSearchOpen(true)} className="hidden h-8 items-center gap-2 rounded-md border border-[var(--border)] bg-[var(--panel)] px-2.5 text-xs text-slate-500 sm:flex">
            <Search size={13} /> Search symbols <span className="ml-3 flex items-center gap-0.5 rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px]"><Command size={10} /> K</span>
          </button>
          <button aria-label="Alerts" className="grid size-8 place-items-center rounded-md text-slate-400 hover:bg-[var(--panel-raised)]"><Bell size={16} /></button>
          <button aria-label="Settings" className="grid size-8 place-items-center rounded-md text-slate-400 hover:bg-[var(--panel-raised)]"><Settings2 size={16} /></button>
          <ThemeToggle />
          <div className="ml-1 hidden items-center gap-2 border-l border-[var(--border)] pl-3 sm:flex">
            <span className="grid size-7 place-items-center rounded-full bg-slate-700 text-[10px] font-medium text-slate-200">JD</span>
            <ChevronDown size={13} className="text-slate-500" />
          </div>
        </div>
      </header>

      <section className="flex min-h-10 flex-wrap items-center justify-between gap-x-5 gap-y-2 border-b border-[var(--border)] bg-[#0b0e12] px-5 py-2">
        <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
          {[...strip.values()].map((quote) => (
            <div key={quote.symbol} className="flex items-center gap-2 whitespace-nowrap text-[11px]">
              <span className="font-medium text-slate-400">{quote.symbol}</span>
              <span className="font-mono text-slate-200">{fmt(quote.last, quote.type)}</span>
              <Sign value={quote.changePercent} />
            </div>
          ))}
        </div>
        <div className="flex items-center gap-2 whitespace-nowrap text-[10px] text-slate-500">
          <span className="size-1.5 rounded-full bg-emerald-400" />
          U.S. MARKET OPEN
          <span className="mx-1 text-slate-700">|</span>
          {connectionState === "live" && connected ? <Wifi size={12} className="text-emerald-400" /> : <span className={cn("size-1.5 rounded-full", connectionState === "disconnected" ? "bg-rose-400" : "bg-amber-400")} />}
          {connectionState === "live" && connected ? "LIVE" : connectionState === "reconnecting" ? "RECONNECTING" : connectionState === "disconnected" ? "DISCONNECTED" : "CONNECTING"}
          <span className="text-slate-700">·</span>
          {dataType === "delayed" ? "DELAYED" : dataType === "frozen" ? "FROZEN" : dataType === "realtime" ? "REAL-TIME" : "MOCK DATA"}
          <span>{now ? now.toLocaleTimeString("en-US", { hour12: false, timeZone: "America/New_York" }) : "--:--:--"} ET</span>
        </div>
      </section>
      {streamMessage && (
        <div role="status" className="border-b border-amber-500/20 bg-amber-500/5 px-5 py-2 text-xs text-amber-200">
          {streamMessage}
        </div>
      )}

      <div className="mx-auto max-w-[1600px] px-5 py-6">
        <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
          <div>
            <div className="mb-1 flex items-center gap-2 text-[11px] font-medium uppercase tracking-[0.16em] text-slate-500"><LayoutGrid size={13} /> Market overview</div>
            <h1 className="text-xl font-medium tracking-tight text-slate-100">Good morning</h1>
            <p className="mt-1 text-xs text-slate-500">{dataType ? "Your markets at a glance. Data access is subject to your IBKR subscriptions." : "Your markets at a glance. Data is simulated for demonstration."}</p>
          </div>
          <div className="flex items-center gap-2">
            <span className={cn("flex items-center gap-1.5 rounded-md border px-2.5 py-1.5 text-[11px]", dataType ? "border-sky-500/20 bg-sky-500/5 text-sky-300" : "border-amber-500/20 bg-amber-500/5 text-amber-300")}><span className={cn("size-1.5 rounded-full", dataType ? "bg-sky-400" : "bg-amber-400")} /> {dataType === "delayed" ? "Delayed data" : dataType === "frozen" ? "Frozen data" : dataType === "realtime" ? "Real-time data" : "Simulated data"}</span>
            <button className="flex h-8 items-center gap-2 rounded-md border border-[var(--border)] px-2.5 text-xs text-slate-300 hover:bg-[var(--panel-raised)]"><SlidersHorizontal size={13} /> Customize</button>
          </div>
        </div>

        <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {[
            { label: "S&P 500", symbol: "SPX", sub: "INDEX", tone: "blue" },
            { label: "NASDAQ 100", symbol: "NDX", sub: "INDEX", tone: "violet" },
            { label: "VOLATILITY", symbol: "VIX", sub: "INDEX", tone: "amber" },
            { label: "E-MINI S&P", symbol: "ES", sub: "FUTURES", tone: "green" },
          ].map((card) => {
            const quote = strip.get(card.symbol)!;
            return (
              <article key={card.symbol} className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
                <div className="flex items-center justify-between">
                  <div className="text-[10px] font-medium tracking-[0.13em] text-slate-500">{card.label}</div>
                  <span className="text-[9px] font-medium tracking-wider text-slate-600">{card.sub}</span>
                </div>
                <div className="mt-3 flex items-end justify-between">
                  <div className="font-mono text-2xl tracking-tight">{fmt(quote.last, quote.type)}</div>
                  <div className={cn("rounded px-1.5 py-1 text-[11px] font-mono", quote.changePercent >= 0 ? "bg-emerald-400/10 text-emerald-400" : "bg-rose-400/10 text-rose-400")}>
                    {quote.changePercent >= 0 ? "+" : ""}{quote.changePercent.toFixed(2)}%
                  </div>
                </div>
                <div className="mt-2 text-[11px] text-slate-500">{quote.change >= 0 ? "+" : ""}{quote.change.toFixed(2)} today</div>
              </article>
            );
          })}
        </div>

        <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)]">
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium text-slate-100">Core Watchlist</h2>
              <span className="rounded bg-slate-800 px-1.5 py-0.5 text-[10px] text-slate-400">{rows.length}</span>
              <button aria-label="Select watchlist" className="text-slate-500 hover:text-slate-300"><ChevronDown size={14} /></button>
            </div>
            <div className="flex items-center gap-3 text-[11px] text-slate-500">
              <span className="hidden sm:inline">Updated {now ? now.toLocaleTimeString("en-US", { hour12: false }) : "—"}</span>
              <button aria-label="Watchlist help" className="hover:text-slate-300"><CircleHelp size={14} /></button>
              <button aria-label="Watchlist settings" className="hover:text-slate-300"><Settings2 size={14} /></button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[760px] border-collapse text-left">
              <thead>
                <tr className="border-b border-[var(--border)] text-[10px] uppercase tracking-wider text-slate-600">
                  <th className="px-4 py-2.5 font-medium">Symbol</th><th className="px-3 py-2.5 text-right font-medium">Last</th><th className="px-3 py-2.5 text-right font-medium">Change</th><th className="px-3 py-2.5 text-right font-medium">% Change</th><th className="px-3 py-2.5 text-right font-medium">Bid / Ask</th><th className="px-3 py-2.5 text-right font-medium">Volume</th><th className="px-4 py-2.5 text-right font-medium">Day range</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((quote) => (
                  <tr key={quote.symbol} className="group border-b border-[var(--border)]/70 last:border-0 hover:bg-white/[0.025]">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className={cn("size-1.5 rounded-full", quote.changePercent >= 0 ? "bg-emerald-400" : "bg-rose-400")} />
                        <div><div className="font-medium text-slate-200">{quote.symbol}</div><div className="mt-0.5 text-[10px] text-slate-600">{quote.name}</div></div>
                      </div>
                    </td>
                    <td className="px-3 py-3 text-right font-mono text-slate-200">{fmt(quote.last, quote.type)}</td>
                    <td className={cn("px-3 py-3 text-right font-mono", quote.change >= 0 ? "text-emerald-400" : "text-rose-400")}>{quote.change >= 0 ? "+" : ""}{quote.change.toFixed(2)}</td>
                    <td className="px-3 py-3 text-right font-mono"><Sign value={quote.changePercent} /></td>
                    <td className="px-3 py-3 text-right font-mono text-slate-400">{fmt(quote.bid, quote.type)} <span className="text-slate-700">/</span> {fmt(quote.ask, quote.type)}</td>
                    <td className="px-3 py-3 text-right font-mono text-slate-400">{(quote.volume / 1_000_000).toFixed(2)}M</td>
                    <td className="px-4 py-3 text-right font-mono text-[11px] text-slate-500">{fmt(quote.dayLow, quote.type)} <span className="text-slate-700">—</span> {fmt(quote.dayHigh, quote.type)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center justify-between border-t border-[var(--border)] px-4 py-2.5 text-[10px] text-slate-600">
            <span>Delayed/simulated market data · Not for trading decisions</span><span>7 instruments</span>
          </div>
        </section>

        <footer className="mt-6 flex flex-wrap items-center justify-between gap-2 text-[10px] text-slate-600">
          <span>Vantage Terminal <span className="mx-1.5 text-slate-800">|</span> Data is simulated, not live market data.</span>
          <span>For informational purposes only. Not financial advice.</span>
        </footer>
      </div>

      {searchOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[18vh]" onMouseDown={(event) => { if (event.target === event.currentTarget) setSearchOpen(false); }}>
          <div role="dialog" aria-modal="true" aria-label="Symbol search" className="w-full max-w-lg overflow-hidden rounded-lg border border-slate-700 bg-[#11151b] shadow-2xl">
            <div className="flex items-center gap-3 border-b border-[var(--border)] px-4">
              <Search size={16} className="text-slate-500" />
              <input autoFocus value={searchQuery} placeholder="Search symbols, futures, or options..." className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-600" onChange={(event) => { const value = event.target.value; setSearchQuery(value); if (!value.trim()) { setSearchResults([]); setSearchError(""); } }} onKeyDown={(event) => event.key === "Escape" && setSearchOpen(false)} />
              <kbd className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-slate-500">ESC</kbd>
            </div>
            <div className="px-4 py-3 text-[11px] text-slate-600">Popular symbols <span className="float-right">Stock · Future · Index</span></div>
            {searchError && <p role="alert" className="px-4 py-2 text-xs text-rose-400">{searchError}</p>}
            {(searchQuery.trim() ? searchResults : initialQuotes.slice(0, 4).map((quote) => ({
              conId: 0,
              symbol: quote.symbol,
              name: quote.name,
              secType: quote.type === "future" ? "FUT" as const : quote.type === "index" ? "IND" as const : "STK" as const,
              exchange: quote.type === "future" ? "CME" : quote.type === "index" ? "INDEX" : "SMART",
              currency: "USD",
            }))).map((instrument) => (
              <button key={`${instrument.conId}-${instrument.symbol}-${instrument.exchange}-${instrument.currency}`} onClick={() => void addInstrument(instrument)} className="flex w-full items-center justify-between px-4 py-2.5 text-left hover:bg-white/5">
                <span><span className="mr-2 font-medium text-slate-200">{instrument.symbol}</span><span className="text-xs text-slate-500">{instrument.name}</span></span><span className="text-[10px] uppercase text-slate-500">{instrument.exchange} · {instrument.currency} · {instrument.secType}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </main>
  );
}
