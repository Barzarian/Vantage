"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Columns2, LayoutGrid, Plus, Settings2 } from "lucide-react";
import {
  chartPreferencesSchema,
  chartPaneSchema,
  userPreferencesSchema,
  type ChartPaneConfig,
  type ChartPreferences,
} from "@/lib/watchlists/preferences";
import { defaultUserPreferences } from "@/lib/watchlists/user-preferences";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "./theme-toggle";

const PriceChartPanel = dynamic(
  () => import("./price-chart-panel").then((module) => module.PriceChartPanel),
  { ssr: false, loading: () => <div className="h-[460px] animate-pulse bg-[var(--panel)]" /> },
);

type Props = { symbol: string };

function defaultPane(symbol: string): ChartPaneConfig {
  return chartPaneSchema.parse({
    symbol,
    timeframe: "1m",
    range: "1D",
    type: "candlestick",
    indicators: [],
  });
}

function loadLocalPreferences(): ChartPreferences | null {
  try {
    const raw = localStorage.getItem("vantage.chart.preferences");
    if (!raw) return null;
    const parsed = chartPreferencesSchema.parse(JSON.parse(raw) as unknown);
    return {
      ...parsed,
      panes: parsed.panes.map((pane, index) => index === 0 ? { ...pane, symbol: "" } : pane),
    };
  } catch {
    return null;
  }
}

export function ChartWorkspace({ symbol }: Props) {
  const [preferences, setPreferences] = useState<ChartPreferences>({
    ...defaultUserPreferences.chart,
    panes: [defaultPane(symbol)],
  });
  const [loaded, setLoaded] = useState(false);
  const [syncTime, setSyncTime] = useState<number | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    let alive = true;
    const local = loadLocalPreferences();
    void fetch("/api/preferences", { cache: "no-store" })
      .then(async (response) => {
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error("Could not load chart preferences.");
        return userPreferencesSchema.parse((payload as { preferences: unknown }).preferences);
      })
      .then((stored) => {
        if (!alive) return;
        const saved = local ?? stored.chart;
        const params = new URLSearchParams(window.location.search);
        const first = {
          ...(saved.panes[0] ?? defaultPane(symbol)),
          symbol: params.get("symbol") ?? symbol,
          timeframe: params.has("timeframe")
            ? params.get("timeframe") as ChartPaneConfig["timeframe"]
            : saved.panes[0]?.timeframe ?? "1m",
        };
        if (params.has("indicators")) {
          try {
            first.indicators = JSON.parse(params.get("indicators")!) as ChartPaneConfig["indicators"];
          } catch {
            first.indicators = saved.panes[0]?.indicators ?? [];
          }
        }
        setPreferences(chartPreferencesSchema.parse({
          ...saved,
          panes: [first, ...saved.panes.slice(1)],
        }));
        setLoaded(true);
      })
      .catch(() => {
        if (!alive) return;
        const saved = local ?? defaultUserPreferences.chart;
        setPreferences(chartPreferencesSchema.parse({
          ...saved,
          panes: [{ ...(saved.panes[0] ?? defaultPane(symbol)), symbol }, ...saved.panes.slice(1)],
        }));
        setLoaded(true);
      });
    return () => { alive = false; };
  }, [symbol]);

  useEffect(() => {
    if (!loaded) return;
    localStorage.setItem("vantage.chart.preferences", JSON.stringify(preferences));
    const first = preferences.panes[0]!;
    const params = new URLSearchParams({
      symbol: first.symbol,
      timeframe: first.timeframe,
      indicators: JSON.stringify(first.indicators),
    });
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
    const timer = setTimeout(() => {
      void fetch("/api/preferences", { method: "GET", cache: "no-store" })
        .then((response) => response.json())
        .then((payload: unknown) => userPreferencesSchema.parse((payload as { preferences: unknown }).preferences))
        .then((current) => fetch("/api/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...current, chart: preferences }),
        }))
        .catch((error: unknown) => console.error(`[chart] Could not persist chart preferences: ${error instanceof Error ? error.message : "unknown error"}`));
    }, 400);
    return () => clearTimeout(timer);
  }, [loaded, preferences]);

  const changePane = useCallback((index: number, pane: ChartPaneConfig) => {
    setPreferences((current) => ({
      ...current,
      panes: current.panes.map((entry, paneIndex) => paneIndex === index ? chartPaneSchema.parse(pane) : entry),
    }));
  }, []);

  const changeLayout = (layout: ChartPreferences["layout"]) => {
    const targetCount = Number(layout);
    setPreferences((current) => {
      const panes = current.panes.slice(0, targetCount);
      const symbols = ["AAPL", "NVDA", "MSFT", "ES"];
      while (panes.length < targetCount) panes.push(defaultPane(symbols[panes.length] ?? symbol));
      return chartPreferencesSchema.parse({ ...current, layout, panes });
    });
  };

  const crosshairUpdate = (time: number | null) => setSyncTime(time);
  const gridClass = useMemo(() => {
    if (preferences.layout === "1") return "grid-cols-1";
    return "grid-cols-1 lg:grid-cols-2";
  }, [preferences.layout]);

  return (
    <main className="min-h-screen bg-[var(--background)]">
      <header className="flex min-h-14 flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-2">
        <div className="flex items-center gap-3">
          <Link href="/" className="flex items-center gap-2 font-semibold text-white"><span className="grid size-7 place-items-center rounded bg-emerald-400 text-black"><Activity size={15} /></span>VANTAGE</Link>
          <span className="text-slate-700">/</span>
          <Link href="/watchlists" className="text-xs text-slate-400 hover:text-white">Watchlists</Link>
          <span className="text-slate-700">/</span>
          <h1 className="font-mono text-sm font-semibold">{preferences.panes[0]?.symbol ?? symbol}</h1>
        </div>
        <div className="flex items-center gap-2 text-xs">
          <span className="mr-1 text-[10px] text-slate-600">LAYOUT</span>
          {(["1", "2", "4"] as const).map((layout) => <button key={layout} aria-label={`${layout} chart layout`} data-testid={`layout-${layout}`} onClick={() => changeLayout(layout)} className={cn("flex items-center gap-1 rounded border px-2 py-1.5", preferences.layout === layout ? "border-emerald-500/30 bg-emerald-400/10 text-emerald-300" : "border-[var(--border)] text-slate-500 hover:text-white")}>
            {layout === "1" ? <LayoutGrid size={13} /> : layout === "2" ? <Columns2 size={13} /> : <span className="grid size-3 grid-cols-2 grid-rows-2 gap-0.5"><i className="bg-current" /><i className="bg-current" /><i className="bg-current" /><i className="bg-current" /></span>}{layout === "4" ? "2×2" : layout}
          </button>)}
          <button aria-label="Chart sync settings" onClick={() => setSettingsOpen(!settingsOpen)} className="grid size-7 place-items-center rounded border border-[var(--border)] text-slate-500 hover:text-white"><Settings2 size={13} /></button>
          <ThemeToggle />
        </div>
      </header>
      {settingsOpen && <div className="flex flex-wrap gap-5 border-b border-[var(--border)] px-4 py-2 text-xs text-slate-400">
        <label className="flex items-center gap-2"><input type="checkbox" checked={preferences.syncCrosshair} onChange={(event) => setPreferences((current) => ({ ...current, syncCrosshair: event.target.checked }))} /> Sync crosshair</label>
        <label className="flex items-center gap-2"><input type="checkbox" checked={preferences.syncTimeRange} onChange={(event) => setPreferences((current) => ({ ...current, syncTimeRange: event.target.checked }))} /> Sync visible range</label>
        <button className="flex items-center gap-1 text-slate-500" onClick={() => changeLayout(preferences.layout)}><Plus size={12} /> Reset layout</button>
      </div>}
      {loaded && <div className={cn("grid", gridClass)}>
        {preferences.panes.map((pane, index) => <PriceChartPanel
          key={`pane-${index}`}
          config={pane}
          onChange={(next) => changePane(index, next)}
          paneIndex={index}
          paneCount={preferences.panes.length}
          onRemove={preferences.panes.length > 1 ? () => changeLayout(preferences.panes.length === 4 ? "2" : "1") : undefined}
          syncCrosshair={preferences.syncCrosshair}
          syncTimeRange={preferences.syncTimeRange}
          onCrosshair={crosshairUpdate}
          synchronizedTime={syncTime}
        />)}
      </div>}
      <footer className="border-t border-[var(--border)] px-4 py-3 text-[10px] text-slate-600">Market data is provided for informational purposes only. Not financial advice.</footer>
    </main>
  );
}
