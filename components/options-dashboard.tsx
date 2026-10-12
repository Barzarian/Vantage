"use client";

import Link from "next/link";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueries, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  Bar,
  BarChart,
  CartesianGrid,
  ComposedChart,
  Line,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Activity, Save, Trash2 } from "lucide-react";
import { quoteSchema, optionChainItemSchema, optionExpiriesSchema, type OptionChainItem, type OptionQuote } from "@/lib/market-data/schemas";
import { marketStreamManager } from "@/lib/market-data/stream-manager";
import { quoteStore, useOptionQuote, useQuote } from "@/lib/market-data/quote-store";
import {
  analyzeStrategy,
  createStrategyPreset,
  optionLegFromChain,
  savedStrategySchema,
  strategyPresetSchema,
  type SavedStrategy,
  type StrategyLeg,
  type StrategyPreset,
} from "@/lib/options/strategy";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./theme-toggle";

const GRID_COLUMNS = "repeat(11,minmax(58px,1fr)) minmax(76px,1.15fr) repeat(11,minmax(58px,1fr))";
const PRESETS = strategyPresetSchema.options;
type SideFilter = "both" | "calls" | "puts";
type VolAxis = "strike" | "moneyness" | "delta";
type OptionFilters = {
  strikeRange: number;
  minVolume: number;
  minOi: number;
  minDelta: number;
  maxDelta: number;
  maxSpread: number;
};
const DEFAULT_OPTION_FILTERS: OptionFilters = {
  strikeRange: 24,
  minVolume: 0,
  minOi: 0,
  minDelta: -1,
  maxDelta: 1,
  maxSpread: 100,
};

async function fetchParsed<T>(url: string, parser: (value: unknown) => T): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const body: unknown = await response.json();
  if (!response.ok) {
    const error = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : `Request failed (${response.status}).`;
    throw new Error(error);
  }
  return parser(body);
}

function parseChain(value: unknown): OptionChainItem[] {
  return optionChainItemSchema.array().parse(value);
}

function currentQuote(entry: OptionChainItem): OptionQuote {
  return quoteStore.getOption(entry.contract.occSymbol)?.quote ?? entry.quote;
}

function useOptionData(underlying: string, expiry: string | undefined) {
  return useQuery({
    queryKey: ["option-chain", underlying, expiry],
    enabled: Boolean(expiry),
    queryFn: () => fetchParsed(`/api/options/${encodeURIComponent(underlying)}/chain?expiry=${encodeURIComponent(expiry!)}`, parseChain),
    staleTime: 5_000,
  });
}

function formatOptionPrice(value: number | null | undefined): string {
  return value == null ? "—" : value.toFixed(value < 3 ? 2 : 2);
}

function displayVol(value: number | null | undefined): string {
  return value == null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function OptionChainRow({
  strike,
  call,
  put,
  atm,
  spot,
  onAddLeg,
}: {
  strike: number;
  call?: OptionChainItem;
  put?: OptionChainItem;
  atm: boolean;
  spot: number;
  onAddLeg: (entry: OptionChainItem, side: "long" | "short", price: number) => void;
}) {
  const callSnapshot = useOptionQuote(call?.contract.occSymbol ?? "");
  const putSnapshot = useOptionQuote(put?.contract.occSymbol ?? "");
  const callQuote = callSnapshot?.quote ?? call?.quote;
  const putQuote = putSnapshot?.quote ?? put?.quote;
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const previousMarks = useRef<{ call: number | null; put: number | null }>({ call: null, put: null });
  const callMark = callQuote?.mark ?? null;
  const putMark = putQuote?.mark ?? null;

  useEffect(() => {
    const previous = previousMarks.current;
    const direction = callMark !== null && previous.call !== null && callMark !== previous.call
      ? callMark > previous.call ? "up" : "down"
      : putMark !== null && previous.put !== null && putMark !== previous.put
        ? putMark > previous.put ? "up" : "down"
        : null;
    previousMarks.current = { call: callMark, put: putMark };
    if (direction) {
      setFlash(direction);
      const timer = setTimeout(() => setFlash(null), 400);
      return () => clearTimeout(timer);
    }
  }, [callMark, putMark]);

  const quoteCells = (entry: OptionChainItem | undefined, quote: OptionQuote | undefined, kind: "call" | "put") => {
    const itm = kind === "call" ? strike < spot : strike > spot;
    const bid = quote?.bid;
    const ask = quote?.ask;
    return [
      <QuoteAction key="bid" value={bid} title={`Sell ${kind} at bid`} onClick={() => entry && bid != null && onAddLeg(entry, "short", bid)} />,
      <QuoteAction key="ask" value={ask} title={`Buy ${kind} at ask`} onClick={() => entry && ask != null && onAddLeg(entry, "long", ask)} />,
      <ValueCell key="last" value={quote?.last} />,
      <ValueCell key="mark" value={quote?.mark} />,
      <ValueCell key="volume" value={quote?.volume} digits={0} />,
      <ValueCell key="oi" value={quote?.openInterest} digits={0} />,
      <ValueCell key="iv" value={quote?.impliedVolatility} percent />,
      <ValueCell key="delta" value={quote?.delta} digits={3} />,
      <ValueCell key="gamma" value={quote?.gamma} digits={4} />,
      <ValueCell key="theta" value={quote?.theta} digits={3} />,
      <ValueCell key="vega" value={quote?.vega} digits={3} />,
    ].map((cell, index) => (
      <div key={`${kind}-${index}`} className={cn("flex min-w-0 items-center justify-end px-1 font-mono tabular-nums", itm && "bg-emerald-400/[0.035]")}>
        {cell}
      </div>
    ));
  };

  return (
    <div
      role="row"
      className={cn(
        "grid h-9 min-w-max items-stretch border-b border-[var(--border)] text-[11px] text-slate-300",
        atm && "border-t-2 border-t-sky-500/80",
        flash === "up" && "flash-up",
        flash === "down" && "flash-down",
      )}
      style={{ gridTemplateColumns: GRID_COLUMNS }}
      data-testid={`option-strike-${strike}`}
    >
      {quoteCells(call, callQuote, "call")}
      <div className="sticky left-0 z-10 flex items-center justify-center border-x border-[var(--border)] bg-[#10151b] font-mono font-bold text-slate-100">
        {strike.toFixed(strike % 1 ? 2 : 0)}
        {atm && <span className="ml-1 text-[8px] text-sky-300">ATM</span>}
      </div>
      {quoteCells(put, putQuote, "put")}
    </div>
  );
}

const MemoizedOptionChainRow = memo(OptionChainRow);

function ValueCell({
  value,
  digits = 2,
  percent = false,
}: {
  value: number | null | undefined;
  digits?: number;
  percent?: boolean;
}) {
  if (value == null) return <span className="text-slate-700">—</span>;
  const text = percent ? `${(value * 100).toFixed(1)}%` : digits === 0 ? value.toLocaleString("en-US") : value.toFixed(digits);
  return <span className="truncate">{text}</span>;
}

function QuoteAction({ value, title, onClick }: { value: number | null | undefined; title: string; onClick: () => void }) {
  return (
    <button
      type="button"
      title={title}
      disabled={value == null}
      onClick={onClick}
      className="rounded px-1 text-right hover:bg-emerald-400/10 hover:text-emerald-300 disabled:cursor-default disabled:text-slate-700"
    >
      {formatOptionPrice(value)}
    </button>
  );
}

function optionValue(entry: OptionChainItem, quote: OptionQuote, key: "volume" | "openInterest" | "delta"): number | null {
  if (key === "delta") return quote.delta ?? null;
  return quote[key];
}

function OptionChain({
  chain,
  spot,
  filters,
  onAddLeg,
}: {
  chain: OptionChainItem[];
  spot: number;
  filters: OptionFilters;
  onAddLeg: (entry: OptionChainItem, side: "long" | "short", price: number) => void;
}) {
  const scroll = useRef<HTMLDivElement>(null);
  const [side, setSide] = useState<SideFilter>("both");
  const byStrike = useMemo(() => {
    const values = new Map<number, { call?: OptionChainItem; put?: OptionChainItem }>();
    for (const entry of chain) {
      const row = values.get(entry.contract.strike) ?? {};
      if (entry.contract.type === "call") row.call = entry;
      else row.put = entry;
      values.set(entry.contract.strike, row);
    }
    return [...values].sort(([left], [right]) => left - right);
  }, [chain]);
  const strikes = byStrike.map(([strike]) => strike);
  const atmIndex = strikes.reduce((closest, strike, index) =>
    Math.abs(strike - spot) < Math.abs(strikes[closest]! - spot) ? index : closest,
  0);
  const atmStrike = strikes[atmIndex];
  const filteredRows = useMemo(() => byStrike.filter(([, legs], index) => {
    if (Math.abs(index - atmIndex) > filters.strikeRange) return false;
    const selected = [
      ...(side !== "puts" && legs.call ? [legs.call] : []),
      ...(side !== "calls" && legs.put ? [legs.put] : []),
    ];
    return selected.some((entry) => {
      const quote = entry.quote;
      const delta = optionValue(entry, quote, "delta");
      const mark = quote.mark ?? 0;
      const spread = quote.bid !== null && quote.ask !== null && mark > 0
        ? ((quote.ask - quote.bid) / mark) * 100
        : 0;
      return quote.volume >= filters.minVolume &&
        quote.openInterest >= filters.minOi &&
        (delta == null || (delta >= filters.minDelta && delta <= filters.maxDelta)) &&
        spread <= filters.maxSpread;
    });
  }), [atmIndex, byStrike, filters, side]);
  // TanStack Virtual exposes imperative scroll APIs that React Compiler cannot memoize safely.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: filteredRows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 36,
    overscan: 2,
  });
  const virtualItems = virtualizer.getVirtualItems();
  const visibleSymbols = useMemo(() => {
    const symbols = new Set<string>();
    for (const item of virtualItems) {
      const legs = filteredRows[item.index]?.[1];
      if (side !== "puts" && legs?.call) symbols.add(legs.call.contract.occSymbol);
      if (side !== "calls" && legs?.put) symbols.add(legs.put.contract.occSymbol);
    }
    return [...symbols];
  }, [filteredRows, side, virtualItems]);
  const subscriptionKey = visibleSymbols.join("|");

  useEffect(() => {
    const symbols = subscriptionKey ? subscriptionKey.split("|") : [];
    if (!symbols.length) return;
    return marketStreamManager.subscribeOptions(symbols);
  }, [subscriptionKey]);

  const jumpToAtm = () => {
    const visibleIndex = filteredRows.findIndex(([strike]) => strike === atmStrike);
    if (visibleIndex >= 0) virtualizer.scrollToIndex(visibleIndex, { align: "center" });
  };

  return (
    <section className="min-w-0 rounded border border-[var(--border)] bg-[var(--panel)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
        <div className="text-xs font-semibold text-slate-200">Option chain <span className="ml-1 font-normal text-slate-500">{filteredRows.length} strikes</span></div>
        <div className="flex items-center gap-2">
          <button type="button" onClick={jumpToAtm} className="rounded border border-[var(--border)] px-2 py-1 text-[10px] text-slate-300 hover:text-white">Jump to ATM</button>
          <select aria-label="Option side filter" value={side} onChange={(event) => setSide(event.target.value as SideFilter)} className="rounded border border-[var(--border)] bg-[#0d1117] px-2 py-1 text-[10px]">
            <option value="both">Calls + puts</option><option value="calls">Calls only</option><option value="puts">Puts only</option>
          </select>
        </div>
      </div>
      <div className="overflow-x-auto">
        <div className="min-w-max">
          <div className="grid h-7 items-center border-b border-[var(--border)] bg-[#0c1015] text-[9px] uppercase tracking-wide text-slate-500" style={{ gridTemplateColumns: GRID_COLUMNS }}>
            <div className="col-span-11 text-center text-emerald-300">Calls</div>
            <div className="sticky left-0 z-10 flex h-full items-center justify-center border-x border-[var(--border)] bg-[#0c1015]">Strike</div>
            <div className="col-span-11 text-center text-rose-300">Puts</div>
          </div>
          <div className="grid h-6 items-center border-b border-[var(--border)] bg-[#10151b] text-[9px] text-slate-500" style={{ gridTemplateColumns: GRID_COLUMNS }}>
            {[..."Bid Ask Last Mark Vol OI IV Δ Γ Θ Vega".split(" "), "Strike", ..."Bid Ask Last Mark Vol OI IV Δ Γ Θ Vega".split(" ")].map((label, index) =>
              <div key={`${label}-${index}`} className="px-1 text-right">{label}</div>,
            )}
          </div>
          <div ref={scroll} role="rowgroup" className="h-[min(56vh,560px)] min-h-[320px] overflow-y-auto">
            <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
              {virtualItems.map((virtual) => {
                const [strike, legs] = filteredRows[virtual.index]!;
                return (
                  <div key={strike} style={{ position: "absolute", top: 0, left: 0, width: "100%", height: 36, transform: `translateY(${virtual.start}px)` }}>
                    <MemoizedOptionChainRow
                      strike={strike}
                      call={side === "puts" ? undefined : legs.call}
                      put={side === "calls" ? undefined : legs.put}
                      atm={strike === atmStrike}
                      spot={spot}
                      onAddLeg={onAddLeg}
                    />
                  </div>
                );
              })}
            </div>
            {!filteredRows.length && <div className="p-8 text-center text-xs text-slate-500">No contracts match the selected filters.</div>}
          </div>
        </div>
      </div>
    </section>
  );
}

const MemoizedOptionChain = memo(OptionChain);

function NumberFilter({
  label,
  value,
  min,
  max,
  step = 1,
  onChange,
  onBlur,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step?: number;
  onChange: (value: number) => void;
  onBlur?: () => void;
}) {
  return <label className="grid gap-1">{label}<input aria-label={label} data-testid={`option-filter-${label.toLowerCase().replaceAll(" ", "-")}`} type="number" min={min} max={max} step={step} value={value} onChange={(event) => onChange(Number(event.target.value))} onBlur={onBlur} className="w-24 rounded border border-[var(--border)] bg-[#0d1117] px-2 py-1 font-mono text-slate-200" /></label>;
}

function OptionFilterPanel({
  filters,
  onChange,
}: {
  filters: OptionFilters;
  onChange: (filters: OptionFilters) => void;
}) {
  const [draft, setDraft] = useState(filters);
  const update = <K extends keyof OptionFilters>(key: K, value: OptionFilters[K]) =>
    setDraft((current) => ({ ...current, [key]: value }));
  const apply = () => onChange(draft);
  return (
    <section aria-label="Option filters" className="flex flex-wrap items-end gap-3 rounded border border-[var(--border)] bg-[var(--panel)] px-3 py-2 text-[10px] text-slate-400">
      <span className="mr-1 uppercase tracking-widest text-slate-600">Filters</span>
      <NumberFilter label="Strikes from ATM" value={draft.strikeRange} min={1} max={48} onChange={(value) => update("strikeRange", value)} onBlur={apply} />
      <NumberFilter label="Min volume" value={draft.minVolume} min={0} max={1_000_000} onChange={(value) => update("minVolume", value)} onBlur={apply} />
      <NumberFilter label="Min OI" value={draft.minOi} min={0} max={1_000_000} onChange={(value) => update("minOi", value)} onBlur={apply} />
      <NumberFilter label="Min delta" value={draft.minDelta} min={-1} max={1} step={0.05} onChange={(value) => update("minDelta", value)} onBlur={apply} />
      <NumberFilter label="Max delta" value={draft.maxDelta} min={-1} max={1} step={0.05} onChange={(value) => update("maxDelta", value)} onBlur={apply} />
      <NumberFilter label="Max spread %" value={draft.maxSpread} min={0} max={500} step={5} onChange={(value) => update("maxSpread", value)} onBlur={apply} />
    </section>
  );
}

const MemoizedOptionFilterPanel = memo(OptionFilterPanel);

function StrategyBuilder({
  chain,
  expiry,
  nextExpiry,
  spot,
  legs,
  onLegsChange,
}: {
  chain: OptionChainItem[];
  expiry: string;
  nextExpiry?: string;
  spot: number;
  legs: StrategyLeg[];
  onLegsChange: (legs: StrategyLeg[]) => void;
}) {
  const queryClient = useQueryClient();
  const [name, setName] = useState("Untitled strategy");
  const [savedId, setSavedId] = useState("");
  const [daysForward, setDaysForward] = useState(0);
  const [ivShift, setIvShift] = useState(0);
  const strategies = useQuery({
    queryKey: ["saved-strategies"],
    queryFn: () => fetchParsed("/api/strategies", (value) =>
      zodStrategyList(value),
    ),
  });
  const saveMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/strategies", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name, legs }),
      });
      const body: unknown = await response.json();
      if (!response.ok) throw new Error(typeof body === "object" && body !== null && "error" in body ? String(body.error) : "Could not save strategy.");
      return savedStrategySchema.parse((body as { strategy: unknown }).strategy);
    },
    onSuccess: async (saved) => {
      setSavedId(saved.id);
      await queryClient.invalidateQueries({ queryKey: ["saved-strategies"] });
    },
  });
  const removeMutation = useMutation({
    mutationFn: async (id: string) => {
      const response = await fetch(`/api/strategies/${encodeURIComponent(id)}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not delete saved strategy.");
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["saved-strategies"] }),
  });
  const analysis = useMemo(() => analyzeStrategy(legs, spot, { daysForward, ivShift }), [daysForward, ivShift, legs, spot]);
  const addPreset = (preset: StrategyPreset) => {
    const result = createStrategyPreset(preset, chain, spot, nextExpiry);
    if (result.length) onLegsChange(result);
  };
  const changeLeg = (id: string, patch: Partial<StrategyLeg>) => {
    onLegsChange(legs.map((leg) => leg.id === id ? ({ ...leg, ...patch } as StrategyLeg) : leg));
  };
  const formatted = (value: number | "unlimited") => value === "unlimited" ? "Unlimited" : `$${Math.abs(value).toLocaleString("en-US", { maximumFractionDigits: 2 })}`;

  return (
    <section className="rounded border border-[var(--border)] bg-[var(--panel)]">
      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
        <h2 className="text-xs font-semibold text-slate-200">Strategy builder</h2>
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((preset) => <button key={preset} type="button" onClick={() => addPreset(preset)} className="rounded border border-[var(--border)] px-2 py-1 text-[9px] text-slate-400 hover:text-white">{preset}</button>)}
        </div>
      </header>
      <div className="grid gap-3 p-3 xl:grid-cols-[minmax(320px,1fr)_minmax(400px,1.2fr)]">
        <div className="min-w-0">
          <div className="mb-2 flex items-center gap-2">
            <input aria-label="Strategy name" value={name} onChange={(event) => setName(event.target.value)} className="min-w-0 flex-1 rounded border border-[var(--border)] bg-[#0d1117] px-2 py-1.5 text-xs" />
            <button type="button" onClick={() => saveMutation.mutate()} disabled={!legs.length || saveMutation.isPending} className="flex items-center gap-1 rounded bg-emerald-400 px-2 py-1.5 text-[10px] font-semibold text-black disabled:opacity-50"><Save size={12} /> Save</button>
          </div>
          {saveMutation.error && <p role="alert" className="mb-2 text-[10px] text-rose-300">{saveMutation.error.message}</p>}
          <div className="max-h-52 overflow-auto">
            {!legs.length && <p className="py-5 text-center text-xs text-slate-600">Click an option bid/ask or choose a preset to add legs.</p>}
            {legs.map((leg) => <div key={leg.id} className="grid grid-cols-[1fr_54px_78px_78px_26px] items-center gap-1 border-b border-[var(--border)] py-1.5 text-[10px]">
              <span className="truncate font-mono text-slate-300">{leg.instrument === "shares" ? `${leg.underlying} shares` : `${leg.underlying} ${leg.expiry} ${leg.strike} ${leg.type.toUpperCase()}`}</span>
              <select aria-label={`${leg.id} side`} value={leg.side} onChange={(event) => changeLeg(leg.id, { side: event.target.value as "long" | "short" })} className="bg-transparent text-slate-400"><option value="long">Long</option><option value="short">Short</option></select>
              <input aria-label={`${leg.id} quantity`} type="number" min="1" value={leg.quantity} onChange={(event) => changeLeg(leg.id, { quantity: Math.max(1, Number(event.target.value)) })} className="w-full rounded border border-[var(--border)] bg-[#0d1117] px-1 py-1 font-mono" />
              <input aria-label={`${leg.id} entry price`} type="number" min="0" step="0.01" value={leg.entryPrice} onChange={(event) => changeLeg(leg.id, { entryPrice: Math.max(0, Number(event.target.value)) })} className="w-full rounded border border-[var(--border)] bg-[#0d1117] px-1 py-1 font-mono" />
              <button type="button" aria-label={`Remove ${leg.underlying} leg`} onClick={() => onLegsChange(legs.filter((entry) => entry.id !== leg.id))} className="text-slate-600 hover:text-rose-300"><Trash2 size={12} /></button>
            </div>)}
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <select aria-label="Load saved strategy" value={savedId} onChange={(event) => {
              setSavedId(event.target.value);
              const saved = strategies.data?.find((strategy) => strategy.id === event.target.value);
              if (saved) { onLegsChange(saved.legs); setName(saved.name); }
            }} className="min-w-44 rounded border border-[var(--border)] bg-[#0d1117] px-2 py-1.5 text-[10px]">
              <option value="">Load saved strategy…</option>
              {(strategies.data ?? []).map((strategy) => <option key={strategy.id} value={strategy.id}>{strategy.name}</option>)}
            </select>
            {savedId && <button type="button" aria-label="Delete saved strategy" onClick={() => removeMutation.mutate(savedId)} className="text-slate-500 hover:text-rose-300"><Trash2 size={13} /></button>}
            <label className="ml-auto text-[9px] text-slate-500">T+ days <input aria-label="Days forward" type="number" min={0} max={365} value={daysForward} onChange={(event) => setDaysForward(Number(event.target.value))} className="ml-1 w-14 rounded border border-[var(--border)] bg-[#0d1117] px-1 py-1 font-mono text-slate-200" /></label>
            <label className="text-[9px] text-slate-500">IV shift {`${(ivShift * 100).toFixed(0)}%`} <input aria-label="IV shift" type="range" min={-0.5} max={0.5} step={0.01} value={ivShift} onChange={(event) => setIvShift(Number(event.target.value))} /></label>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
            <Metric label="Net debit / credit" value={`${analysis.netDebitCredit >= 0 ? "Debit" : "Credit"} $${Math.abs(analysis.netDebitCredit).toFixed(2)}`} />
            <Metric label="Max profit" value={formatted(analysis.maxProfit)} />
            <Metric label="Max loss" value={formatted(analysis.maxLoss)} />
            <Metric label="Breakevens" value={analysis.breakevens.length ? analysis.breakevens.map((value) => `$${value.toFixed(2)}`).join(", ") : "—"} />
            <Metric label="Approx. probability of profit" value={analysis.probabilityOfProfit == null ? "n/a" : `${(analysis.probabilityOfProfit * 100).toFixed(1)}%`} />
          </div>
          <div className="mt-2 grid grid-cols-5 gap-1 rounded bg-[#0d1117] p-2 text-center text-[9px]">
            {Object.entries(analysis.netGreeks).map(([key, value]) => <div key={key}><div className="uppercase text-slate-600">{key}</div><div className="mt-1 font-mono text-slate-300">{value.toFixed(3)}</div></div>)}
          </div>
        </div>
        <div className="min-h-56 min-w-0">
          <div className="mb-1 text-[9px] uppercase tracking-wide text-slate-500">Theoretical P&amp;L · expiry vs T+{daysForward}</div>
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={analysis.payoff}>
              <CartesianGrid stroke="#202832" strokeDasharray="3 3" />
              <XAxis dataKey="spot" type="number" domain={["dataMin", "dataMax"]} tickFormatter={(value: number) => `$${value.toFixed(0)}`} stroke="#64748b" fontSize={9} />
              <YAxis tickFormatter={(value: number) => `$${value.toFixed(0)}`} stroke="#64748b" fontSize={9} />
              <Tooltip contentStyle={{ background: "#10151b", border: "1px solid #29313b", fontSize: 10 }} labelFormatter={(value) => `Spot $${Number(value).toFixed(2)}`} />
              <ReferenceLine y={0} stroke="#64748b" />
              <ReferenceLine x={spot} stroke="#38bdf8" strokeDasharray="4 4" label={{ value: "Spot", fill: "#7dd3fc", fontSize: 9 }} />
              {analysis.breakevens.map((value) => <ReferenceLine key={value} x={value} stroke="#a3a3a3" strokeDasharray="2 3" />)}
              <Line type="monotone" dataKey="expiryPnl" name="At expiry" stroke="#34d399" dot={false} strokeWidth={1.5} />
              <Line type="monotone" dataKey="forwardPnl" name={`T+${daysForward}`} stroke="#a78bfa" dot={false} strokeWidth={1.5} />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      </div>
      <div className="sr-only">Strategy expiry is {expiry}.</div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="flex justify-between gap-2 text-slate-500"><span>{label}</span><span className="text-right font-mono text-slate-200">{value}</span></div>;
}

function zodStrategyList(value: unknown): SavedStrategy[] {
  if (typeof value !== "object" || value === null || !("strategies" in value)) throw new Error("Invalid strategy response.");
  return savedStrategySchema.array().parse(value.strategies);
}

function OptionAnalytics({
  chain,
  spot,
  expiry,
  expiryChains,
  termExpiries,
  axis,
  onAxisChange,
}: {
  chain: OptionChainItem[];
  spot: number;
  expiry: string;
  expiryChains: OptionChainItem[][];
  termExpiries: string[];
  axis: VolAxis;
  onAxisChange: (axis: VolAxis) => void;
}) {
  const [, setSnapshot] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setSnapshot((value) => value + 1), 1_000);
    return () => clearInterval(timer);
  }, []);
  const selectedDate = expiry ? new Date(`${expiry}T12:00:00Z`) : null;
  const today = new Date();
  const dte = selectedDate
    ? Math.max(0, Math.ceil((selectedDate.getTime() - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 86400000))
    : null;
  const sampled = chain.map((entry) => ({
    ...entry,
    quote: quoteStore.getOption(entry.contract.occSymbol)?.quote ?? entry.quote,
  }));
  const selectedCalls = sampled.filter(({ contract }) => contract.type === "call");
  const selectedPuts = sampled.filter(({ contract }) => contract.type === "put");
  const atmCall = selectedCalls.reduce<OptionChainItem | undefined>((closest, entry) =>
    !closest || Math.abs(entry.contract.strike - spot) < Math.abs(closest.contract.strike - spot) ? entry : closest,
  undefined);
  const atmIv = atmCall?.quote.impliedVolatility ?? null;
  const callVolume = selectedCalls.reduce((sum, entry) => sum + entry.quote.volume, 0);
  const putVolume = selectedPuts.reduce((sum, entry) => sum + entry.quote.volume, 0);
  const callOi = selectedCalls.reduce((sum, entry) => sum + entry.quote.openInterest, 0);
  const putOi = selectedPuts.reduce((sum, entry) => sum + entry.quote.openInterest, 0);
  const expectedMove = atmIv !== null && dte !== null ? spot * atmIv * Math.sqrt(dte / 365) : null;
  const skewData = sampled
    .filter(({ contract }) => contract.type === "call")
    .map(({ contract, quote }) => ({
      strike: contract.strike,
      moneyness: Number((contract.strike / (spot || 1)).toFixed(3)),
      delta: quote.delta,
      iv: quote.impliedVolatility == null ? null : quote.impliedVolatility * 100,
    }))
    .filter((entry) => entry.iv !== null && (axis !== "delta" || entry.delta !== null));
  const termData = expiryChains.flatMap((entries, index) => {
    const atm = entries.filter(({ contract }) => contract.type === "call").reduce((best, entry) =>
      !best || Math.abs(entry.contract.strike - spot) < Math.abs(best.contract.strike - spot) ? entry : best,
    undefined as OptionChainItem | undefined);
    return atm?.quote.impliedVolatility == null ? [] : [{
      expiry: termExpiries[index]!.slice(5),
      iv: atm.quote.impliedVolatility * 100,
    }];
  });
  const oiVolumeData = [...new Set(sampled.map(({ contract }) => contract.strike))]
    .map((strike) => {
      const call = sampled.find((entry) => entry.contract.type === "call" && entry.contract.strike === strike)?.quote;
      const put = sampled.find((entry) => entry.contract.type === "put" && entry.contract.strike === strike)?.quote;
      return {
        strike,
        callsOi: call?.openInterest ?? 0,
        putsOi: put?.openInterest ?? 0,
        callsVolume: call?.volume ?? 0,
        putsVolume: put?.volume ?? 0,
      };
    });
  return (
    <>
      <section className="grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
        <SummaryMetric label="ATM IV" value={displayVol(atmIv)} />
        <SummaryMetric label="Put / Call Volume" value={callVolume ? (putVolume / callVolume).toFixed(2) : "n/a"} />
        <SummaryMetric label="Put / Call OI" value={callOi ? (putOi / callOi).toFixed(2) : "n/a"} />
        <SummaryMetric label="Expected move" value={expectedMove === null ? "—" : `±$${expectedMove.toFixed(2)}`} />
        <SummaryMetric label="IV rank" value="n/a" />
        <SummaryMetric label="Expiry" value={expiry || "—"} />
        <SummaryMetric label="DTE" value={dte === null ? "—" : `${dte} days`} />
      </section>
      <section className="grid gap-3 xl:grid-cols-3">
        <div className="rounded border border-[var(--border)] bg-[var(--panel)] p-2">
          <div className="flex items-center justify-between px-1 pb-2 text-[10px] text-slate-400"><span>IV skew</span><select aria-label="Volatility x axis" value={axis} onChange={(event) => onAxisChange(event.target.value as VolAxis)} className="bg-[#0d1117] text-slate-300"><option value="strike">Strike</option><option value="moneyness">Moneyness</option><option value="delta">Delta</option></select></div>
          <ResponsiveContainer width="100%" height={170}><ComposedChart data={skewData}><CartesianGrid stroke="#202832" strokeDasharray="3 3" /><XAxis dataKey={axis} tickFormatter={(value: number) => axis === "strike" ? value.toFixed(0) : value.toFixed(2)} stroke="#64748b" fontSize={8} /><YAxis stroke="#64748b" fontSize={8} /><Tooltip contentStyle={{ background: "#10151b", border: "1px solid #29313b", fontSize: 9 }} /><Line dataKey="iv" name="IV %" stroke="#a78bfa" dot={false} connectNulls /></ComposedChart></ResponsiveContainer>
        </div>
        <div className="rounded border border-[var(--border)] bg-[var(--panel)] p-2">
          <div className="px-1 pb-2 text-[10px] text-slate-400">ATM IV term structure</div>
          <ResponsiveContainer width="100%" height={170}><ComposedChart data={termData}><CartesianGrid stroke="#202832" strokeDasharray="3 3" /><XAxis dataKey="expiry" stroke="#64748b" fontSize={8} /><YAxis stroke="#64748b" fontSize={8} /><Tooltip contentStyle={{ background: "#10151b", border: "1px solid #29313b", fontSize: 9 }} /><Line dataKey="iv" name="ATM IV %" stroke="#38bdf8" dot connectNulls /></ComposedChart></ResponsiveContainer>
        </div>
        <div className="rounded border border-[var(--border)] bg-[var(--panel)] p-2">
          <div className="px-1 pb-2 text-[10px] text-slate-400">Open interest / volume by strike</div>
          <ResponsiveContainer width="100%" height={170}><BarChart data={oiVolumeData}><CartesianGrid stroke="#202832" strokeDasharray="3 3" /><XAxis dataKey="strike" stroke="#64748b" fontSize={8} /><YAxis stroke="#64748b" fontSize={8} /><Tooltip contentStyle={{ background: "#10151b", border: "1px solid #29313b", fontSize: 9 }} /><Bar dataKey="callsOi" name="Call OI" fill="#34d399" /><Bar dataKey="putsOi" name="Put OI" fill="#fb7185" /></BarChart></ResponsiveContainer>
        </div>
      </section>
    </>
  );
}

const MemoizedOptionAnalytics = memo(OptionAnalytics);

export function OptionsDashboard({ underlying: rawUnderlying }: { underlying: string }) {
  const underlying = rawUnderlying.toUpperCase();
  const [expiry, setExpiry] = useState("");
  const [legs, setLegs] = useState<StrategyLeg[]>([]);
  const [optionFilters, setOptionFilters] = useState(DEFAULT_OPTION_FILTERS);
  const [axis, setAxis] = useState<VolAxis>("strike");
  const expiryQuery = useQuery({
    queryKey: ["option-expiries", underlying],
    queryFn: () => fetchParsed(`/api/options/${encodeURIComponent(underlying)}/expiries`, (value) => optionExpiriesSchema.parse(value)),
    staleTime: 60_000,
  });
  const expiries = useMemo(() => expiryQuery.data ?? [], [expiryQuery.data]);
  const activeExpiry = expiry || expiries[0] || "";
  const chainQuery = useOptionData(underlying, activeExpiry || undefined);
  const quoteQuery = useQuery({
    queryKey: ["quote", underlying],
    queryFn: () => fetchParsed(`/api/quotes?symbol=${encodeURIComponent(underlying)}`, (value) => quoteSchema.array().parse(value)),
  });
  const spot = quoteQuery.data?.[0]?.last ?? 0;
  const chain = chainQuery.data ?? [];
  const termExpiries = useMemo(
    () => expiries.filter((_, index) => index === 0 || index % 3 === 0).slice(0, 6),
    [expiries],
  );
  const expiryQueries = useQueries({
    queries: termExpiries.map((entryExpiry) => ({
      queryKey: ["option-chain", underlying, entryExpiry],
      queryFn: () => fetchParsed(`/api/options/${encodeURIComponent(underlying)}/chain?expiry=${encodeURIComponent(entryExpiry)}`, parseChain),
      staleTime: 30_000,
    })),
  });
  const expiryChains = useMemo(
    () => expiryQueries.map((query) => query.data ?? []),
    [expiryQueries],
  );
  useEffect(() => {
    if (!underlying) return;
    return marketStreamManager.subscribe([underlying]);
  }, [underlying]);
  const pageError = chainQuery.error?.message ?? "";
  const today = new Date();
  const addLeg = useCallback((entry: OptionChainItem, side: "long" | "short", price: number) => {
    const quote = currentQuote(entry);
    setLegs((current) => [...current, optionLegFromChain({ ...entry, quote: { ...quote, mark: price } }, side)]);
  }, []);
  const nextExpiry = activeExpiry ? expiries.find((candidate) => candidate > activeExpiry) : undefined;

  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <header className="sticky top-0 z-30 flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[#0c1015]/95 px-4 py-2 backdrop-blur">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 font-semibold"><span className="grid size-7 place-items-center rounded bg-emerald-400 text-black"><Activity size={15} /></span>VANTAGE</Link>
          <span className="text-slate-700">/</span><Link href="/watchlists" className="text-xs text-slate-400 hover:text-white">Watchlists</Link>
          <span className="text-slate-700">/ OPTIONS /</span><h1 className="font-mono text-sm font-bold">{underlying}</h1>
        </div>
        <div className="flex items-center gap-3 text-[10px] text-slate-500">
          <LiveSpot symbol={underlying} initial={spot || undefined} />
          <span className="rounded bg-amber-400/10 px-1.5 py-1 text-amber-300">MOCK · SIMULATED DATA</span>
          <ThemeToggle />
        </div>
      </header>
      <div className="space-y-3 p-3 lg:p-4">
        {expiryQuery.isPending && <p className="rounded border border-[var(--border)] p-4 text-xs text-slate-500">Loading expiries…</p>}
        {(expiryQuery.error || pageError) && <p role="alert" className="rounded border border-rose-900 bg-rose-950/40 p-3 text-xs text-rose-300">{pageError || expiryQuery.error?.message}</p>}
        {expiryQuery.data && <section className="flex flex-wrap items-center gap-1.5 rounded border border-[var(--border)] bg-[var(--panel)] p-2">
          <span className="mr-2 text-[9px] uppercase tracking-widest text-slate-600">Expiration</span>
          {expiries.map((date) => {
            const days = Math.max(0, Math.ceil((new Date(`${date}T12:00:00Z`).getTime() - Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())) / 86400000));
            return <button key={date} type="button" aria-label={`Expiry ${date}`} onClick={() => { setExpiry(date); setLegs([]); }} className={cn("rounded border px-2 py-1.5 text-[10px]", activeExpiry === date ? "border-emerald-500/40 bg-emerald-400/10 text-emerald-300" : "border-[var(--border)] text-slate-400 hover:text-white")}>
              {new Date(`${date}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" })}<span className="ml-1.5 text-slate-600">{days}d</span>
            </button>;
          })}
        </section>}
        {chainQuery.isPending && <div className="rounded border border-[var(--border)] p-10 text-center text-xs text-slate-500">Loading option chain…</div>}
        {chainQuery.isError && <div role="alert" className="rounded border border-rose-900 bg-rose-950/40 p-5 text-xs text-rose-300">{chainQuery.error.message}</div>}
        {chain.length > 0 && spot > 0 && <>
          <MemoizedOptionAnalytics
            chain={chain}
            spot={spot}
            expiry={activeExpiry}
            expiryChains={expiryChains}
            termExpiries={termExpiries}
            axis={axis}
            onAxisChange={setAxis}
          />
          <MemoizedOptionFilterPanel filters={optionFilters} onChange={setOptionFilters} />
          <MemoizedOptionChain chain={chain} spot={spot} filters={optionFilters} onAddLeg={addLeg} />
        </>}
        {chain.length === 0 && <OptionAnalytics chain={[]} spot={spot} expiry={activeExpiry} expiryChains={expiryChains} termExpiries={termExpiries} axis={axis} onAxisChange={setAxis} />}
        {chain.length > 0 && <StrategyBuilder
          chain={chain}
          expiry={activeExpiry}
          nextExpiry={nextExpiry}
          spot={spot}
          legs={legs}
          onLegsChange={setLegs}
        />}
      </div>
      <footer className="mt-3 border-t border-[var(--border)] px-4 py-3 text-[10px] text-slate-600">
        Informational only, not financial advice. Option marks, Greeks, probabilities, and payoff projections are theoretical estimates; American-style options are approximated with a European Black-Scholes model.
      </footer>
    </main>
  );
}

function SummaryMetric({ label, value }: { label: string; value: string }) {
  return <div className="rounded border border-[var(--border)] bg-[var(--panel)] px-2.5 py-2"><div className="text-[9px] uppercase tracking-wide text-slate-600">{label}</div><div className="mt-1 font-mono text-xs tabular-nums text-slate-200">{value}</div></div>;
}

function LiveSpot({ symbol, initial }: { symbol: string; initial?: number }) {
  const snapshot = useQuote(symbol);
  const value = snapshot?.quote.last ?? initial;
  return value === undefined ? null : <span>SPOT <b className="ml-1 font-mono text-slate-200">${value.toFixed(2)}</b></span>;
}
