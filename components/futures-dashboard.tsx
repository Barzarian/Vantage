"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { memo, useEffect, useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  CartesianGrid,
  ComposedChart,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Activity } from "lucide-react";
import { z } from "zod";
import { chartPaneSchema, userPreferencesSchema } from "@/lib/watchlists/preferences";
import { classifyCurve, calendarSpread, roundToTick } from "@/lib/futures/curve";
import { buildFuturesContracts, resolveFrontIndex } from "@/lib/futures/contracts";
import { futuresSessionStatus, futuresTradeDate } from "@/lib/futures/sessions";
import { futuresContractSchema, futuresCurvePointSchema, futuresRootSchema, type FuturesContract, type FuturesCurvePoint, type FuturesRoot, type FuturesPreference } from "@/lib/market-data/schemas";
import { marketStreamManager } from "@/lib/market-data/stream-manager";
import { useFuturesQuote, useQuoteConnection } from "@/lib/market-data/quote-store";
import { watchlistSchema } from "@/lib/watchlists/model";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./theme-toggle";

const PriceChartPanel = dynamic(
  () => import("./price-chart-panel").then((module) => module.PriceChartPanel),
  { ssr: false, loading: () => <div className="h-[420px] animate-pulse rounded border border-[var(--border)] bg-[var(--panel)]" /> },
);

type OverviewRow = { root: FuturesRoot; front: FuturesCurvePoint; curveShape: ReturnType<typeof classifyCurve>; curve: FuturesCurvePoint[] };
const curvesSchema = futuresCurvePointSchema.array();
const curveClassificationSchema = z.object({
  shape: z.enum(["contango", "backwardation", "mixed"]),
  annualizedRollYield: z.number().finite().nullable(),
});
const overviewSchema = z.array(z.object({
  root: futuresRootSchema,
  front: futuresCurvePointSchema,
  curveShape: curveClassificationSchema,
  curve: curvesSchema,
}));
const adjustmentLabels = {
  unadjusted: "Unadjusted",
  ratio: "Ratio back-adjusted",
  difference: "Difference (Panama)",
} as const;

async function fetchParsed<T>(url: string, parser: (value: unknown) => T): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  const body: unknown = await response.json();
  if (!response.ok) {
    const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
      ? body.error
      : `Request failed (${response.status}).`;
    throw new Error(message);
  }
  return parser(body);
}

function parseOverview(value: unknown): OverviewRow[] {
  return overviewSchema.parse(value);
}

function money(value: number | null | undefined, digits = 2): string {
  return value == null || !Number.isFinite(value)
    ? "—"
    : value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function formatRootPrice(value: number | null | undefined, root: FuturesRoot): string {
  if (value == null) return "—";
  const digits = Math.max(0, (String(root.tickSize).split(".")[1] ?? "").length);
  return value.toLocaleString("en-US", { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

function useFuturesOverview() {
  return useQuery({
    queryKey: ["futures-overview"],
    queryFn: () => fetchParsed("/api/futures/overview", parseOverview),
    staleTime: 1_000,
    refetchInterval: 15_000,
  });
}

function CurveSparkline({ values }: { values: number[] }) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values.map((value, index) =>
    `${(index / Math.max(values.length - 1, 1)) * 100},${22 - ((value - min) / range) * 18}`,
  ).join(" ");
  return <svg viewBox="0 0 100 24" className="h-6 w-20" aria-label="Futures curve sparkline"><polyline points={points} fill="none" stroke="#38bdf8" strokeWidth="1.5" vectorEffect="non-scaling-stroke" /></svg>;
}

function OverviewRowView({ row, curveValues }: { row: OverviewRow; curveValues: number[] }) {
  const live = useFuturesQuote(row.front.contract.symbol);
  const quote = live?.quote;
  const last = quote?.last ?? row.front.quote.last;
  const change = quote?.change ?? row.front.quote.change;
  const volume = quote?.volume ?? row.front.quote.volume;
  const oi = quote?.openInterest ?? row.front.quote.openInterest;
  return (
    <tr className="h-11 border-b border-[var(--border)] text-xs hover:bg-white/[0.025]" data-testid={`futures-row-${row.root.root}`}>
      <td className="px-3"><Link className="font-mono font-bold text-slate-100 hover:text-emerald-300" href={`/futures/${row.root.root}`}>{row.root.root}</Link></td>
      <td className="px-2 text-slate-400">{row.root.name}</td>
      <td className="px-2"><Link href={`/futures/${row.root.root}?contract=${encodeURIComponent(row.front.contract.symbol)}`} className="font-mono text-slate-300 hover:text-white">{row.front.contract.symbol}</Link></td>
      <td className="px-2 text-right font-mono tabular-nums">{formatRootPrice(last, row.root)}</td>
      <td className={cn("px-2 text-right font-mono tabular-nums", change == null ? "text-slate-500" : change >= 0 ? "text-emerald-400" : "text-rose-400")}>{change == null ? "—" : `${change >= 0 ? "+" : ""}${money(change, Math.max(2, String(row.root.tickSize).split(".")[1]?.length ?? 0))}`}</td>
      <td className="px-2 text-right font-mono tabular-nums text-slate-400">{change == null || !row.front.quote.settle ? "—" : `${((change / row.front.quote.settle) * 100).toFixed(2)}%`}</td>
      <td className="px-2 text-right font-mono tabular-nums text-slate-400">{volume?.toLocaleString("en-US") ?? "—"}</td>
      <td className="px-2 text-right font-mono tabular-nums text-slate-400">{oi?.toLocaleString("en-US") ?? "—"}</td>
      <td className="px-2 text-right font-mono tabular-nums text-slate-400">{row.front.daysToExpiry}</td>
      <td className="px-2"><span className={cn("rounded px-1.5 py-1 text-[9px] uppercase", row.curveShape.shape === "contango" ? "bg-sky-400/10 text-sky-300" : row.curveShape.shape === "backwardation" ? "bg-amber-400/10 text-amber-300" : "bg-slate-700 text-slate-400")}>{row.curveShape.shape}</span></td>
      <td className="px-2"><CurveSparkline values={curveValues} /></td>
    </tr>
  );
}

const MemoOverviewRow = memo(OverviewRowView);

function FuturesOverview() {
  const query = useFuturesOverview();
  const [sector, setSector] = useState("all");
  const [sort, setSort] = useState<{ key: "root" | "last" | "change" | "volume" | "days"; direction: "asc" | "desc" }>({ key: "root", direction: "asc" });
  const rows = useMemo(() => query.data ?? [], [query.data]);
  const symbols = rows.map(({ front }) => front.contract.symbol).sort().join("|");
  useEffect(() => {
    if (!symbols) return;
    return marketStreamManager.subscribe(symbols.split("|"));
  }, [symbols]);
  const filtered = useMemo(() => {
    const result = rows.filter(({ root }) => sector === "all" || root.sector === sector);
    const value = (row: OverviewRow): number | string => {
      if (sort.key === "root") return row.root.root;
      if (sort.key === "last") return row.front.quote.last ?? Number.NEGATIVE_INFINITY;
      if (sort.key === "change") return row.front.quote.change ?? Number.NEGATIVE_INFINITY;
      if (sort.key === "volume") return row.front.quote.volume ?? Number.NEGATIVE_INFINITY;
      return row.front.daysToExpiry;
    };
    return result.sort((a, b) => {
      const compared = value(a) < value(b) ? -1 : value(a) > value(b) ? 1 : 0;
      return sort.direction === "asc" ? compared : -compared;
    });
  }, [rows, sector, sort]);
  const sortBy = (key: typeof sort.key) => setSort((current) => ({ key, direction: current.key === key && current.direction === "asc" ? "desc" : "asc" }));
  if (query.isPending) return <div className="p-8 text-sm text-slate-500">Loading futures market…</div>;
  if (query.isError) return <div role="alert" className="m-4 rounded border border-rose-900 p-4 text-sm text-rose-300">{query.error.message}</div>;
  return (
    <div className="space-y-3 p-3 lg:p-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div><h2 className="text-sm font-semibold">Futures markets</h2><p className="mt-1 text-[10px] text-slate-500">Indicative simulated quotes · futures risk and margin estimates apply</p></div>
        <label className="flex items-center gap-2 text-xs text-slate-400">Sector
          <select aria-label="Filter futures sector" value={sector} onChange={(event) => setSector(event.target.value)} className="rounded border border-[var(--border)] bg-[#0d1117] px-2 py-1.5">
            <option value="all">All sectors</option>{["equity index", "energy", "metals", "rates", "grains", "FX"].map((entry) => <option key={entry} value={entry}>{entry}</option>)}
          </select>
        </label>
      </div>
      <div className="overflow-auto rounded border border-[var(--border)] bg-[var(--panel)]">
        <table className="w-full min-w-[1030px] text-left">
          <thead className="sticky top-0 bg-[#10151b] text-[9px] uppercase tracking-wide text-slate-500"><tr>
            <th className="px-3 py-2" onClick={() => sortBy("root")}>Root</th><th className="px-2">Name</th><th className="px-2">Front contract</th>
            <th className="cursor-pointer px-2 text-right" onClick={() => sortBy("last")}>Last</th><th className="cursor-pointer px-2 text-right" onClick={() => sortBy("change")}>Change</th><th className="px-2 text-right">% change</th><th className="cursor-pointer px-2 text-right" onClick={() => sortBy("volume")}>Volume</th><th className="px-2 text-right">OI</th><th className="cursor-pointer px-2 text-right" onClick={() => sortBy("days")}>DTE</th><th className="px-2">Curve</th><th className="px-2">Term structure</th>
          </tr></thead>
          <tbody>{filtered.map((row) => <MemoOverviewRow key={row.root.root} row={row} curveValues={row.curve.map(({ quote }) => quote.last ?? 0)} />)}</tbody>
        </table>
        {!filtered.length && <p className="p-8 text-center text-xs text-slate-500">No futures match this sector.</p>}
      </div>
      <p className="text-[10px] text-slate-600">Contract specifications and margins are estimates that may change; verify exchange specifications before trading.</p>
    </div>
  );
}

type RootPayload = { root: FuturesRoot; contracts: FuturesContract[]; curve: FuturesCurvePoint[] };
const rootPayloadSchema = z.object({
  root: futuresRootSchema,
  contracts: futuresContractSchema.array(),
  curve: curvesSchema,
});

function parseRootPayload(value: unknown): RootPayload {
  return rootPayloadSchema.parse(value);
}

function LiveContractRow({
  point,
  root,
  selected,
  rollWindow,
  onSelect,
}: {
  point: FuturesCurvePoint;
  root: FuturesRoot;
  selected: boolean;
  rollWindow: boolean;
  onSelect: () => void;
}) {
  const live = useFuturesQuote(point.contract.symbol);
  const quote = live?.quote;
  const change = quote?.change ?? point.quote.change;
  return (
    <div
      role="row"
      data-testid={`contract-row-${point.contract.symbol}`}
      onClick={onSelect}
      className={cn("grid h-9 cursor-pointer items-center border-b border-[var(--border)] px-2 text-[10px] hover:bg-white/[0.025]", selected && "bg-sky-400/[0.07]", point.contract.isFront && "border-l-2 border-l-emerald-400")}
      style={{ gridTemplateColumns: "1.1fr 1.2fr 0.8fr 0.9fr 0.9fr 1fr 0.8fr 1.1fr" }}
    >
      <span className="flex items-center gap-1.5 font-mono text-slate-200">{point.contract.symbol}{point.contract.isFront && <small className="text-emerald-400">FRONT</small>}</span>
      <span className="font-mono text-slate-400">{point.contract.expiry}</span>
      <span className="text-right font-mono tabular-nums">{formatRootPrice(quote?.last ?? point.quote.last, root)}</span>
      <span className={cn("text-right font-mono tabular-nums", (change ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400")}>
        {change == null ? "—" : money(change)}
      </span>
      <span className="text-right font-mono tabular-nums text-slate-400">{point.quote.settle == null ? "—" : formatRootPrice(point.quote.settle, root)}</span>
      <span className="text-right font-mono tabular-nums text-slate-400">{(quote?.volume ?? point.quote.volume)?.toLocaleString("en-US") ?? "—"}</span>
      <span className="text-right font-mono tabular-nums text-slate-400">{(quote?.openInterest ?? point.quote.openInterest)?.toLocaleString("en-US") ?? "—"}</span>
      <span className="flex justify-end gap-1 font-mono tabular-nums text-slate-500">{point.daysToExpiry}d {rollWindow && <small className="rounded bg-amber-500/10 px-1 text-amber-300">ROLL</small>}</span>
    </div>
  );
}

function FuturesDetail({ rootSymbol }: { rootSymbol: string }) {
  const rootName = rootSymbol.toUpperCase();
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: ["futures-root", rootName],
    queryFn: () => fetchParsed(`/api/futures/${encodeURIComponent(rootName)}`, parseRootPayload),
    staleTime: 2_000,
    refetchInterval: 15_000,
  });
  const [chartMode, setChartMode] = useState<"price" | "spread" | "percent">("price");
  const [adjustment, setAdjustment] = useState<"unadjusted" | "ratio" | "difference">("unadjusted");
  const [rollRuleType, setRollRuleType] = useState<FuturesPreference["rollRule"]["type"]>("days-before-expiry");
  const [rollDays, setRollDays] = useState(5);
  const [selectedSymbol, setSelectedSymbol] = useState("");
  const [pairIndex, setPairIndex] = useState(0);
  const [contractsCount, setContractsCount] = useState(1);
  const [calculatorPrice, setCalculatorPrice] = useState(0);
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [chartConfig, setChartConfig] = useState(() => chartPaneSchema.parse({
    symbol: rootName,
    timeframe: "5m",
    range: "5D",
    type: "candlestick",
    indicators: [],
  }));
  const [contractViewport, setContractViewport] = useState<HTMLDivElement | null>(null);
  const contracts = useMemo(() => query.data?.contracts ?? [], [query.data?.contracts]);
  const curve = useMemo(() => query.data?.curve ?? [], [query.data?.curve]);
  const root = query.data?.root;
  const sortedCurve = useMemo(() => [...curve].sort((a, b) => a.daysToExpiry - b.daysToExpiry), [curve]);
  const effectiveCurve = useMemo(() => {
    if (!root || !sortedCurve.length) return sortedCurve;
    const index = resolveFrontIndex(
      sortedCurve.map(({ contract }) => contract),
      root,
      new Date(),
      rollRuleType === "days-before-expiry" ? { type: rollRuleType, days: rollDays } : { type: rollRuleType },
      sortedCurve.map(({ quote }) => quote.volume ?? 0),
      sortedCurve.map(({ quote }) => quote.openInterest ?? 0),
    );
    return sortedCurve.map((point, pointIndex) => ({
      ...point,
      contract: { ...point.contract, isFront: pointIndex === index },
    }));
  }, [rollDays, rollRuleType, root, sortedCurve]);
  const frontPoint = effectiveCurve.find(({ contract }) => contract.isFront) ?? effectiveCurve[0];
  const selectedPoint = effectiveCurve.find(({ contract }) => contract.symbol === selectedSymbol) ?? frontPoint;
  const frontQuote = frontPoint?.quote;
  const frontLive = useFuturesQuote(frontPoint?.contract.symbol ?? "");
  const frontChange = frontLive?.quote.change ?? frontQuote?.change;
  const session = root ? futuresSessionStatus(root) : "closed";
  const tradeDate = root ? futuresTradeDate(root) : "—";
  const rollDates = useMemo(() => {
    if (!root) return [];
    const historyStart = new Date();
    historyStart.setUTCFullYear(historyStart.getUTCFullYear() - 2);
    return buildFuturesContracts(root, historyStart, 36)
      .map((contract) => Math.floor(Date.parse(`${contract.lastTradeDate}T16:00:00Z`) / 1000))
      .filter((date) => date <= Math.floor(Date.now() / 1000));
  }, [root]);
  // TanStack Virtual exposes an imperative API that React Compiler cannot safely memoize.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: sortedCurve.length,
    getScrollElement: () => contractViewport,
    estimateSize: () => 36,
    overscan: 2,
  });
  const visibleIndices = virtualizer.getVirtualItems();
  const visibleSymbols = visibleIndices.map((item) => sortedCurve[item.index]?.contract.symbol).filter((symbol): symbol is string => Boolean(symbol)).join("|");

  useEffect(() => {
    if (!visibleSymbols) return;
    return marketStreamManager.subscribe(visibleSymbols.split("|"));
  }, [visibleSymbols]);

  useEffect(() => {
    let active = true;
    void fetch("/api/preferences", { cache: "no-store" })
      .then(async (response) => {
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error("Could not load futures preferences.");
        return userPreferencesSchema.parse((payload as { preferences: unknown }).preferences);
      })
      .then((prefs) => {
        if (!active) return;
        setAdjustment(prefs.futures.adjustment);
        setRollRuleType(prefs.futures.rollRule.type);
        setRollDays(prefs.futures.rollRule.type === "days-before-expiry" ? prefs.futures.rollRule.days : 5);
        setChartConfig((current) => chartPaneSchema.parse({
          ...current,
          indicators: prefs.futures.chartOverlays.map((kind, index) => ({ id: `futures-${kind}-${index}`, kind, pane: "overlay" })),
        }));
        setPreferencesLoaded(true);
      })
      .catch((error: unknown) => {
        console.error(`[futures] Could not load preferences: ${error instanceof Error ? error.message : "unknown error"}`);
        if (active) setPreferencesLoaded(true);
      });
    return () => { active = false; };
  }, [rootName]);

  useEffect(() => {
    if (!root || !preferencesLoaded) return;
    const timer = setTimeout(() => {
      void fetch("/api/preferences", { cache: "no-store" })
        .then(async (response) => {
          const payload: unknown = await response.json();
          if (!response.ok) throw new Error("Could not read saved preferences before updating futures settings.");
          return userPreferencesSchema.parse((payload as { preferences: unknown }).preferences);
        })
        .then((current) => fetch("/api/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...current,
            futures: {
              adjustment,
              rollRule: rollRuleType === "days-before-expiry"
                ? { type: rollRuleType, days: rollDays }
                : { type: rollRuleType },
              chartOverlays: chartConfig.indicators.filter(({ pane }) => pane === "overlay").map(({ kind }) => kind),
              lastRoot: root.root,
            },
          }),
        }))
        .then((response) => { if (!response.ok) throw new Error("Could not save futures preferences."); })
        .catch((error: unknown) => console.error(`[futures] Could not save preferences: ${error instanceof Error ? error.message : "unknown error"}`));
    }, 350);
    return () => clearTimeout(timer);
  }, [adjustment, chartConfig.indicators, preferencesLoaded, rollDays, rollRuleType, root]);

  useEffect(() => {
    if (frontPoint) {
      setCalculatorPrice(frontPoint.quote.last ?? 0);
      const requested = !selectedSymbol && typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("contract")
        : null;
      const initialSymbol = contracts.some((contract) => contract.symbol === requested)
        ? requested!
        : frontPoint.contract.symbol;
      if (!selectedSymbol) setSelectedSymbol(initialSymbol);
      setChartConfig((current) => chartPaneSchema.parse({ ...current, symbol: selectedSymbol || initialSymbol }));
    }
  }, [contracts, frontPoint, selectedSymbol]);

  const watchlistsQuery = useQuery({
    queryKey: ["watchlists"],
    queryFn: () => fetchParsed("/api/watchlists", (value) => {
      if (typeof value !== "object" || value === null || !("watchlists" in value)) throw new Error("Invalid watchlists response.");
      return watchlistSchema.array().parse(value.watchlists);
    }),
  });
  const addToWatchlist = async () => {
    const list = watchlistsQuery.data?.[0];
    const contract = selectedPoint?.contract;
    if (!list || !contract) throw new Error("Load a watchlist and select a futures contract first.");
    const response = await fetch(`/api/watchlists/${list.id}/items`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol: contract.symbol, assetClass: "future" }),
    });
    if (!response.ok) throw new Error("Could not add the futures contract to the watchlist.");
    await queryClient.invalidateQueries({ queryKey: ["watchlists"] });
  };

  const termData = sortedCurve.map((point, index) => {
    const front = frontQuote?.last;
    const price = point.quote.last;
    const spread = front !== null && front !== undefined && price !== null ? price - front : null;
    return {
      contract: point.contract.symbol,
      expiry: point.contract.expiry.slice(5),
      price,
      spread,
      percentSpread: front ? (spread === null ? null : spread / front * 100) : null,
      front: point.contract.isFront,
      index,
    };
  });
  const pair = sortedCurve[Math.min(pairIndex, Math.max(0, sortedCurve.length - 2))];
  const nextPair = sortedCurve[Math.min(pairIndex + 1, sortedCurve.length - 1)];
  const spread = pair?.quote.last != null && nextPair?.quote.last != null
    ? calendarSpread(pair.quote.last, nextPair.quote.last)
    : null;
  const classification = classifyCurve(effectiveCurve);

  if (query.isPending) return <div className="p-8 text-sm text-slate-500">Loading {rootName} futures…</div>;
  if (query.isError || !root) return <div role="alert" className="m-4 rounded border border-rose-900 p-4 text-sm text-rose-300">{query.error?.message ?? `No contract data for ${rootName}.`}</div>;
  const selectedLast = selectedPoint?.quote.last;
  const dollarsPerTick = root.tickValue;
  const dollarsPerPoint = root.multiplier;
  const notional = selectedLast == null ? null : contractsCount * root.multiplier * selectedLast;
  const chartConfigChange = (next: typeof chartConfig) => {
    setChartConfig(chartPaneSchema.parse(next));
    setSelectedSymbol(next.symbol);
  };
  const inRollWindow = (point: FuturesCurvePoint) =>
    point.daysToExpiry <= rollDays ||
    (point.daysToFirstNotice !== null && point.daysToFirstNotice <= rollDays);

  return (
    <div className="space-y-3 p-3 lg:p-4">
      <section className="flex flex-wrap items-center justify-between gap-3 rounded border border-[var(--border)] bg-[var(--panel)] p-3">
        <div>
          <div className="flex flex-wrap items-center gap-2"><h2 className="font-mono text-lg font-bold">{root.root}</h2><span className="text-sm text-slate-400">{root.name}</span><span className={cn("rounded px-1.5 py-1 text-[9px] uppercase", session === "open" ? "bg-emerald-400/10 text-emerald-300" : session === "maintenance break" ? "bg-amber-400/10 text-amber-300" : "bg-slate-700 text-slate-400")}>{session}</span><span className="text-[9px] text-slate-600">TRADE DATE {tradeDate}</span></div>
          <div className="mt-2 flex flex-wrap items-center gap-2 text-xs"><span className="font-mono text-slate-200">{frontPoint?.contract.symbol ?? "—"}</span><span className="font-mono text-lg tabular-nums">{formatRootPrice(frontLive?.quote.last ?? frontQuote?.last, root)}</span><span className={cn("font-mono", (frontChange ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400")}>{frontChange == null ? "—" : `${frontChange >= 0 ? "+" : ""}${money(frontChange)}`}</span>{frontLive?.stale && <span className="rounded bg-amber-400/10 px-1.5 py-1 text-[9px] text-amber-300">STALE</span>}<span className="rounded bg-slate-800 px-1.5 py-1 text-[9px] text-slate-400">SHARED STREAM</span></div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="text-[10px] text-slate-500">Contract <select aria-label="Selected futures contract" value={selectedPoint?.contract.symbol ?? ""} onChange={(event) => { const next = event.target.value; setSelectedSymbol(next); setChartConfig((current) => chartPaneSchema.parse({ ...current, symbol: next })); }} className="ml-1 rounded border border-[var(--border)] bg-[#0d1117] px-2 py-1.5 font-mono text-slate-200">{contracts.map((contract) => <option key={contract.symbol} value={contract.symbol}>{contract.symbol}</option>)}</select></label>
          <button type="button" onClick={() => void addToWatchlist().catch((error: unknown) => window.alert(error instanceof Error ? error.message : "Could not add contract."))} className="rounded border border-emerald-700/50 px-2 py-1.5 text-[10px] text-emerald-300 hover:bg-emerald-400/10">Add to watchlist</button>
          <ThemeToggle />
        </div>
      </section>

      <div className="grid gap-3 xl:grid-cols-[minmax(0,1.6fr)_minmax(280px,0.8fr)]">
        <section className="rounded border border-[var(--border)] bg-[var(--panel)] p-3">
          <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="text-xs font-semibold">Term structure</h3><label className="text-[10px] text-slate-500">View <select aria-label="Term structure mode" value={chartMode} onChange={(event) => setChartMode(event.target.value as typeof chartMode)} className="ml-1 rounded border border-[var(--border)] bg-[#0d1117] px-2 py-1"><option value="price">Price</option><option value="spread">Spread to front</option><option value="percent">Percent spread</option></select></label></div>
          <ResponsiveContainer width="100%" height={230}>
            <ComposedChart data={termData}><CartesianGrid stroke="#202832" strokeDasharray="3 3" /><XAxis dataKey="expiry" stroke="#64748b" fontSize={9} /><YAxis stroke="#64748b" fontSize={9} /><Tooltip contentStyle={{ background: "#10151b", border: "1px solid #29313b", fontSize: 10 }} /><ReferenceLine x={termData.find(({ front }) => front)?.expiry} stroke="#34d399" strokeDasharray="4 3" label={{ value: "FRONT", fill: "#34d399", fontSize: 9 }} /><Line type="monotone" dataKey={chartMode === "price" ? "price" : chartMode === "spread" ? "spread" : "percentSpread"} name={chartMode === "price" ? "Price" : chartMode === "spread" ? "Spread" : "Spread %"} stroke="#38bdf8" strokeWidth={2} connectNulls dot={{ r: 2 }} /></ComposedChart>
          </ResponsiveContainer>
          <p className="mt-1 text-[9px] text-slate-600">No previous-day or previous-week curve snapshots are stored. Holiday hours and exchange exceptions can vary by contract.</p>
        </section>
        <section className="rounded border border-[var(--border)] bg-[var(--panel)] p-3">
          <h3 className="mb-2 text-xs font-semibold">Contract specifications</h3>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-2 text-[10px]">
            <Spec label="Tick size" value={String(root.tickSize)} /><Spec label="$ per tick" value={`$${money(dollarsPerTick)}`} />
            <Spec label="$ per point" value={`$${money(dollarsPerPoint)}`} /><Spec label="Multiplier" value={root.multiplier.toLocaleString()} />
            <Spec label="Approx. margin" value={`$${root.approximateMargin.toLocaleString()}`} /><Spec label="Settlement" value={root.settlement} />
            <Spec label="Months" value={root.contractMonths.join(" ")} /><Spec label="Trading hours" value={root.tradingHours} />
          </dl>
          <p className="mt-2 text-[9px] text-amber-300/70">Margins are estimates and change frequently; confirm current exchange and broker requirements.</p>
          <div className="mt-3 border-t border-[var(--border)] pt-3">
            <h4 className="text-[10px] font-semibold text-slate-300">Position size helper</h4>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[9px] text-slate-500">
              <label>Contracts<input aria-label="Number of futures contracts" type="number" min={1} value={contractsCount} onChange={(event) => setContractsCount(Math.max(1, Number(event.target.value)))} className="mt-1 w-full rounded border border-[var(--border)] bg-[#0d1117] px-2 py-1.5 font-mono text-slate-200" /></label>
              <label>Price<input aria-label="Futures calculator price" type="number" step={root.tickSize} value={calculatorPrice} onChange={(event) => setCalculatorPrice(roundToTick(Number(event.target.value), root.tickSize))} className="mt-1 w-full rounded border border-[var(--border)] bg-[#0d1117] px-2 py-1.5 font-mono text-slate-200" /></label>
            </div>
            <div className="mt-2 space-y-1 text-[10px]"><Metric label="Notional value" value={notional === null ? "—" : `$${notional.toLocaleString("en-US", { maximumFractionDigits: 2 })}`} /><Metric label="One tick P&L" value={`$${(contractsCount * dollarsPerTick).toLocaleString()}`} /><Metric label="One point P&L" value={`$${(contractsCount * dollarsPerPoint).toLocaleString()}`} /></div>
          </div>
        </section>
      </div>

      <section className="rounded border border-[var(--border)] bg-[var(--panel)]">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2"><h3 className="text-xs font-semibold">Listed contracts <span className="ml-1 font-normal text-slate-500">{contracts.length}</span></h3><div className="flex items-center gap-3"><label className="text-[9px] text-slate-500">Roll rule<select aria-label="Futures roll rule" value={rollRuleType} onChange={(event) => setRollRuleType(event.target.value as typeof rollRuleType)} className="ml-1 rounded border border-[var(--border)] bg-[#0d1117] px-2 py-1 text-slate-200"><option value="days-before-expiry">Days before expiry / first notice</option><option value="volume-crossover">Volume crossover</option><option value="open-interest-crossover">Open-interest crossover</option></select></label>{rollRuleType === "days-before-expiry" && <label className="text-[9px] text-slate-500">Roll window days <input aria-label="Roll window days" type="number" min={0} max={90} value={rollDays} onChange={(event) => setRollDays(Math.min(90, Math.max(0, Number(event.target.value))))} className="ml-1 w-12 rounded border border-[var(--border)] bg-[#0d1117] px-1 py-1 font-mono text-slate-200" /></label>}</div></div>
        <div className="grid h-7 items-center border-b border-[var(--border)] px-2 text-[9px] uppercase text-slate-500" style={{ gridTemplateColumns: "1.1fr 1.2fr 0.8fr 0.9fr 0.9fr 1fr 0.8fr 1.1fr" }}><span>Symbol</span><span>Expiry</span><span className="text-right">Last</span><span className="text-right">Change</span><span className="text-right">Settle</span><span className="text-right">Volume</span><span className="text-right">OI</span><span className="text-right">DTE / status</span></div>
        <div ref={setContractViewport} className="h-[min(38vh,360px)] min-h-[180px] overflow-y-auto" role="rowgroup">
          <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
            {visibleIndices.map((item) => {
              const point = effectiveCurve[item.index];
              if (!point) return null;
              return <div key={point.contract.symbol} style={{ position: "absolute", top: 0, left: 0, height: 36, width: "100%", transform: `translateY(${item.start}px)` }}>
                <LiveContractRow point={point} root={root} selected={selectedPoint?.contract.symbol === point.contract.symbol} rollWindow={inRollWindow(point)} onSelect={() => { setSelectedSymbol(point.contract.symbol); setChartConfig((current) => chartPaneSchema.parse({ ...current, symbol: point.contract.symbol })); }} />
              </div>;
            })}
          </div>
        </div>
      </section>

      <section className="grid gap-3 xl:grid-cols-[minmax(0,1fr)_320px]">
        <div className="rounded border border-[var(--border)] bg-[var(--panel)] p-2">
          <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-1"><h3 className="text-xs font-semibold">Continuous contract · {root.root}</h3><label className="text-[10px] text-slate-500">Adjustment <select aria-label="Continuous adjustment mode" data-testid="continuous-adjustment" value={adjustment} onChange={(event) => setAdjustment(event.target.value as typeof adjustment)} className="ml-1 rounded border border-[var(--border)] bg-[#0d1117] px-2 py-1.5 text-slate-200">{Object.entries(adjustmentLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label></div>
          <PriceChartPanel
            config={chartConfig}
            onChange={chartConfigChange}
            paneIndex={0}
            paneCount={1}
            syncCrosshair={false}
            syncTimeRange={false}
            continuousRoot={root.root}
            continuousAdjustment={adjustment}
            rollDates={rollDates}
          />
        </div>
        <section className="rounded border border-[var(--border)] bg-[var(--panel)] p-3">
          <h3 className="text-xs font-semibold">Adjacent calendar spread</h3>
          <label className="mt-2 block text-[10px] text-slate-500">Contract pair<select aria-label="Calendar spread pair" value={pairIndex} onChange={(event) => setPairIndex(Number(event.target.value))} className="mt-1 w-full rounded border border-[var(--border)] bg-[#0d1117] px-2 py-1.5 font-mono text-slate-200">{sortedCurve.slice(0, -1).map((point, index) => <option key={point.contract.symbol} value={index}>{point.contract.symbol} / {sortedCurve[index + 1]?.contract.symbol}</option>)}</select></label>
          <div className="mt-2 grid grid-cols-2 gap-2 text-[10px]"><Spec label="Front − next" value={spread ? formatRootPrice(spread.value, root) : "—"} /><Spec label="Spread %" value={spread ? `${spread.percent.toFixed(3)}%` : "—"} /></div>
          <ResponsiveContainer width="100%" height={140}><LineChart data={[{ name: pair?.contract.symbol ?? "front", price: pair?.quote.last ?? null }, { name: nextPair?.contract.symbol ?? "next", price: nextPair?.quote.last ?? null }]}><CartesianGrid stroke="#202832" strokeDasharray="3 3" /><XAxis dataKey="name" stroke="#64748b" fontSize={8} /><YAxis domain={["auto", "auto"]} stroke="#64748b" fontSize={8} /><Tooltip contentStyle={{ background: "#10151b", border: "1px solid #29313b", fontSize: 9 }} /><Line dataKey="price" stroke="#a78bfa" dot connectNulls /></LineChart></ResponsiveContainer>
          <div className="mt-2 flex items-center justify-between text-[10px] text-slate-500"><span>Curve shape</span><span className="uppercase text-slate-200">{classification.shape}</span></div>
          <div className="mt-1 flex items-center justify-between text-[10px] text-slate-500"><span>Annualized roll yield</span><span className="font-mono text-slate-200">{classification.annualizedRollYield === null ? "—" : `${(classification.annualizedRollYield * 100).toFixed(2)}%`}</span></div>
        </section>
      </section>
      <footer className="border-t border-[var(--border)] px-2 py-3 text-[10px] text-slate-600">Futures involve substantial risk of loss. Specifications and margin values are estimates, may change, and informational only—not financial advice.</footer>
    </div>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return <div><dt className="text-slate-600">{label}</dt><dd className="mt-0.5 break-words font-mono text-slate-300">{value}</dd></div>;
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div className="flex items-center justify-between gap-3"><span className="text-slate-500">{label}</span><span className="font-mono tabular-nums text-slate-200">{value}</span></div>;
}

export function FuturesDashboard({ root }: { root?: string }) {
  const normalized = root?.trim().toUpperCase();
  const connection = useQuoteConnection();
  return (
    <main className="min-h-screen bg-[var(--background)] text-[var(--foreground)]">
      <header className="sticky top-0 z-20 flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] bg-[#0c1015]/95 px-4 py-2 backdrop-blur">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 font-semibold"><span className="grid size-7 place-items-center rounded bg-emerald-400 text-black"><Activity size={15} /></span>VANTAGE</Link>
          <span className="text-slate-700">/</span><Link href="/futures" className="text-xs text-slate-400 hover:text-white">Futures</Link>
          {normalized && <><span className="text-slate-700">/</span><span className="font-mono text-xs font-semibold">{normalized}</span></>}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-slate-500"><span className={cn("rounded px-1.5 py-1 uppercase", connection.state === "live" ? "bg-emerald-400/10 text-emerald-300" : connection.state === "stale" ? "bg-amber-400/10 text-amber-300" : "bg-slate-700 text-slate-400")}>{connection.state}</span>{connection.lastUpdate && <span>Updated {new Date(connection.lastUpdate).toLocaleTimeString()}</span>}<span className="rounded bg-amber-400/10 px-1.5 py-1 text-amber-300">SIMULATED DATA</span><ThemeToggle /></div>
      </header>
      {normalized ? <FuturesDetail rootSymbol={normalized} /> : <FuturesOverview />}
    </main>
  );
}
