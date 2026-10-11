"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AreaSeries,
  BarSeries,
  CandlestickSeries,
  ColorType,
  createChart,
  HistogramSeries,
  LineSeries,
  PriceScaleMode,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LogicalRange,
  type Time,
} from "lightweight-charts";
import { ArrowLeft, Maximize2, Plus, Search, Trash2 } from "lucide-react";
import { useQuote } from "@/lib/market-data/quote-store";
import { marketStreamManager } from "@/lib/market-data/stream-manager";
import { barSchema, quoteSchema, type Bar, type Quote } from "@/lib/market-data/schemas";
import type { Timeframe } from "@/lib/market-data/provider";
import {
  chartRangeSchema,
  chartTypeSchema,
  indicatorConfigSchema,
  timeframeSchema,
  type ChartPaneConfig,
  type IndicatorConfig,
} from "@/lib/watchlists/preferences";
import {
  bollingerBands,
  exponentialMovingAverage,
  movingAverageConvergenceDivergence,
  relativeStrengthIndex,
  sessionVolumeWeightedAveragePrice,
  simpleMovingAverage,
} from "@/lib/indicators";
import { cn } from "@/lib/utils";

const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d", "1w", "1M"] as const;
const RANGES = ["1D", "5D", "1M", "6M", "YTD", "1Y", "5Y", "Max"] as const;
const RANGE_SECONDS: Record<(typeof RANGES)[number], number> = {
  "1D": 86_400,
  "5D": 5 * 86_400,
  "1M": 31 * 86_400,
  "6M": 183 * 86_400,
  YTD: Math.ceil((Date.now() - Date.UTC(new Date().getUTCFullYear(), 0, 1)) / 1000),
  "1Y": 365 * 86_400,
  "5Y": 5 * 365 * 86_400,
  Max: 5 * 365 * 86_400,
};
type Props = {
  config: ChartPaneConfig;
  onChange: (config: ChartPaneConfig) => void;
  paneIndex: number;
  paneCount: number;
  onRemove?: () => void;
  syncCrosshair: boolean;
  syncTimeRange: boolean;
  onCrosshair?: (time: number | null) => void;
  synchronizedTime?: number | null;
};

function rangeStart(range: ChartPaneConfig["range"], to: number): number {
  if (range === "YTD") return Math.floor(Date.UTC(new Date(to * 1000).getUTCFullYear(), 0, 1) / 1000);
  return Math.max(1, to - RANGE_SECONDS[range]);
}

function parseBars(value: unknown): Bar[] {
  return barSchema.array().parse(value);
}

function useBars(symbol: string, timeframe: Timeframe, range: ChartPaneConfig["range"]) {
  const [to] = useState(() => Math.floor(Date.now() / 1000));
  const from = rangeStart(range, to);
  const query = useQuery({
    queryKey: ["bars", symbol, timeframe, range, to],
    queryFn: async () => {
      const params = new URLSearchParams({
        symbol,
        timeframe,
        from: String(from),
        to: String(to),
        limit: "5000",
      });
      const response = await fetch(`/api/bars?${params.toString()}`, { cache: "no-store" });
      const body: unknown = await response.json();
      if (!response.ok) {
        const message = typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
          ? body.error
          : "Historical bars request failed.";
        throw new Error(message);
      }
      return parseBars(body);
    },
    staleTime: 15_000,
  });
  return query;
}

function IndicatorPane({ indicator, bars }: { indicator: IndicatorConfig; bars: Bar[] }) {
  const closes = bars.map((bar) => bar.close);
  let series: Array<Array<number | null>> = [];
  let title: string = indicator.kind;
  if (indicator.kind === "RSI") {
    series = [relativeStrengthIndex(closes, indicator.period ?? 14)];
  } else if (indicator.kind === "MACD") {
    const macd = movingAverageConvergenceDivergence(closes);
    series = [
      macd.map((point) => point?.macd ?? null),
      macd.map((point) => point?.signal ?? null),
      macd.map((point) => point?.histogram ?? null),
    ];
  }
  const recentSeries = series.map((values) => values.filter((value): value is number => value !== null).slice(-80));
  const recent = recentSeries.flat();
  const min = Math.min(...recent, 0);
  const max = Math.max(...recent, indicator.kind === "RSI" ? 100 : 0);
  const spread = max - min || 1;
  const polylines = recentSeries.map((values) => values.map((value, index) =>
    `${(index / Math.max(1, values.length - 1)) * 100},${30 - ((value - min) / spread) * 26}`,
  ).join(" "));
  const latest = recentSeries.at(-1)?.at(-1);
  if (indicator.kind === "MACD") title = "MACD histogram";
  if (!recent.length) return null;
  return (
    <div className="h-20 border-t border-[var(--border)] px-3 py-2" data-testid={`indicator-pane-${indicator.kind}`}>
      <div className="mb-1 flex items-center justify-between text-[10px] text-slate-500">
        <span>{title}{indicator.period ? ` ${indicator.period}` : ""}</span>
        <span className="font-mono text-slate-300">{latest?.toFixed(2)}</span>
      </div>
      <svg className="h-10 w-full overflow-visible" viewBox="0 0 100 32" preserveAspectRatio="none">
        {indicator.kind === "RSI" && <line x1="0" x2="100" y1="9" y2="9" stroke="#475569" strokeDasharray="1 1" />}
        {polylines.map((points, index) => <polyline key={index} points={points} fill="none" stroke={indicator.kind === "RSI" ? "#a78bfa" : ["#60a5fa", "#fbbf24", "#f472b6"][index]} strokeWidth="1.2" vectorEffect="non-scaling-stroke" />)}
      </svg>
    </div>
  );
}

export function PriceChartPanel({
  config,
  onChange,
  paneIndex,
  paneCount,
  onRemove,
  syncCrosshair,
  syncTimeRange,
  onCrosshair,
  synchronizedTime,
}: Props) {
  const container = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceSeries = useRef<ISeriesApi<"Candlestick" | "Line" | "Area" | "Bar"> | null>(null);
  const volumeSeries = useRef<ISeriesApi<"Histogram"> | null>(null);
  const compareSeries = useRef<ISeriesApi<"Line"> | null>(null);
  const lastPriceLine = useRef<IPriceLine | null>(null);
  const loadingOlder = useRef(false);
  const chartDataRef = useRef<Bar[]>([]);
  const queryPendingRef = useRef(true);
  const initialFit = useRef(false);
  const [olderBars, setOlderBars] = useState<Bar[]>([]);
  const [liveBar, setLiveBar] = useState<Bar | null>(null);
  const [hoveredBar, setHoveredBar] = useState<Bar | null>(null);
  const [chartError, setChartError] = useState("");
  const [linearScale, setLinearScale] = useState(false);
  const [indicatorMenu, setIndicatorMenu] = useState(false);
  const [compareQuery, setCompareQuery] = useState("");
  const [symbolValue, setSymbolValue] = useState(config.symbol);
  const quoteSnapshot = useQuote(config.symbol);
  const query = useBars(config.symbol, config.timeframe, config.range);
  const bars = useMemo(() => query.data ?? [], [query.data]);
  const compareQueryResult = useBars(
    config.compareSymbol ?? config.symbol,
    config.timeframe,
    config.range,
  );
  const compareBars = config.compareSymbol ? compareQueryResult.data ?? [] : [];
  const chartType = chartTypeSchema.parse(config.type);
  const latestQuote: Quote | undefined = quoteSnapshot?.quote;

  const chartData = useMemo(() => {
    const combined = [...olderBars, ...bars].sort((left, right) => left.time - right.time);
    const history = [...new Map(combined.map((bar) => [bar.time, bar])).values()];
    if (!history.length || !liveBar || liveBar.time < history.at(-1)!.time) return history;
    if (liveBar.time === history.at(-1)!.time) return [...history.slice(0, -1), liveBar];
    return [...history, liveBar];
  }, [bars, liveBar, olderBars]);

  useEffect(() => {
    chartDataRef.current = chartData;
    queryPendingRef.current = query.isPending;
  }, [chartData, query.isPending]);

  const updateConfig = (patch: Partial<ChartPaneConfig>) => {
    if (
      (patch.symbol !== undefined && patch.symbol !== config.symbol) ||
      (patch.timeframe !== undefined && patch.timeframe !== config.timeframe) ||
      (patch.range !== undefined && patch.range !== config.range)
    ) {
      setOlderBars([]);
      loadingOlder.current = false;
      initialFit.current = false;
    }
    onChange({ ...config, ...patch });
  };

  const loadOlder = useCallback(async () => {
    const current = chartDataRef.current;
    if (!current.length || loadingOlder.current) return;
    const earliest = current[0]!.time;
    const params = new URLSearchParams({
      symbol: config.symbol,
      timeframe: config.timeframe,
      from: String(Math.max(1, earliest - RANGE_SECONDS[config.range])),
      to: String(Math.max(1, earliest - 1)),
      limit: "5000",
    });
    loadingOlder.current = true;
    try {
      const response = await fetch(`/api/bars?${params}`, { cache: "no-store" });
      const payload: unknown = await response.json();
      if (!response.ok) {
        const message = typeof payload === "object" && payload !== null && "error" in payload && typeof payload.error === "string"
          ? payload.error
          : "Could not load older bars.";
        throw new Error(message);
      }
      const older = barSchema.array().parse(payload);
      setOlderBars((existing) => [...new Map([...older, ...existing].map((bar) => [bar.time, bar])).values()]);
      setChartError("");
    } catch (error) {
      setChartError(error instanceof Error ? error.message : "Could not load older bars.");
    } finally {
      loadingOlder.current = false;
    }
  }, [config.range, config.symbol, config.timeframe]);

  useEffect(() => {
    const element = container.current;
    if (!element) return;
    const style = getComputedStyle(document.documentElement);
    const foreground = style.getPropertyValue("--foreground").trim() || "#e7ebef";
    const border = style.getPropertyValue("--border").trim() || "#1d242d";
    const background = style.getPropertyValue("--panel").trim() || "#0e1116";
    const chart = createChart(element, {
      width: element.clientWidth,
      height: Math.max(300, element.clientHeight),
      layout: {
        background: { type: ColorType.Solid, color: background },
        textColor: foreground,
        attributionLogo: false,
        panes: { separatorColor: border },
      },
      grid: {
        vertLines: { color: border, style: 1 },
        horzLines: { color: border, style: 1 },
      },
      rightPriceScale: { borderColor: border, mode: linearScale ? PriceScaleMode.Normal : PriceScaleMode.Logarithmic },
      timeScale: {
        borderColor: border,
        timeVisible: true,
        secondsVisible: config.timeframe === "1m",
        rightOffset: 4,
        shiftVisibleRangeOnNewBar: true,
      },
      crosshair: { mode: 0 },
      localization: { locale: "en-US" },
    });
    const positive = "#42c88a";
    const negative = "#f16c72";
    let series: ISeriesApi<"Candlestick" | "Line" | "Area" | "Bar">;
    if (chartType === "candlestick") {
      series = chart.addSeries(CandlestickSeries, {
        upColor: positive, downColor: negative, borderVisible: false,
        wickUpColor: positive, wickDownColor: negative, lastValueVisible: true,
      });
    } else if (chartType === "line") {
      series = chart.addSeries(LineSeries, { color: "#42c88a", lineWidth: 2, lastValueVisible: true });
    } else if (chartType === "area") {
      series = chart.addSeries(AreaSeries, {
        lineColor: "#42c88a", topColor: "rgba(66,200,138,0.25)",
        bottomColor: "rgba(66,200,138,0.015)", lineWidth: 2,
      });
    } else {
      series = chart.addSeries(BarSeries, {
        upColor: positive, downColor: negative, lastValueVisible: true,
      });
    }
    const volumePane = chart.addPane();
    volumePane.setHeight(80);
    const volumes = chart.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" },
      lastValueVisible: false,
      priceLineVisible: false,
      base: 0,
    }, volumePane.paneIndex());
    volumePane.priceScale("right").applyOptions({ scaleMargins: { top: 0.1, bottom: 0 } });
    lastPriceLine.current = series.createPriceLine({
      price: latestQuote?.last ?? chartData.at(-1)?.close ?? 0,
      color: "#60a5fa",
      lineWidth: 1,
      lineStyle: 2,
      axisLabelVisible: true,
      title: "LIVE",
    });
    let comparison: ISeriesApi<"Line"> | null = null;
    if (config.compareSymbol && compareBars.length) {
      const baseline = compareBars[0]!.close;
      comparison = chart.addSeries(LineSeries, {
        color: "#a78bfa",
        lineWidth: 1,
        priceScaleId: "compare",
        priceFormat: { type: "custom", formatter: (value: number) => `${value.toFixed(1)}%` },
        title: `${config.compareSymbol} %`,
        lastValueVisible: true,
      });
      chart.priceScale("compare").applyOptions({
        mode: PriceScaleMode.Normal,
        visible: true,
        scaleMargins: { top: 0.08, bottom: 0.25 },
      });
      comparison.setData(compareBars.map((bar) => ({
        time: bar.time as Time,
        value: ((bar.close - baseline) / baseline) * 100,
      })));
    }
    chartRef.current = chart;
    priceSeries.current = series;
    volumeSeries.current = volumes;
    compareSeries.current = comparison;
    const resize = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) chart.applyOptions({ width: rect.width, height: rect.height });
    });
    resize.observe(element);
    chart.subscribeCrosshairMove((param) => {
      if (!param.time) {
        setHoveredBar(null);
        onCrosshair?.(null);
        return;
      }
      const time = typeof param.time === "number" ? param.time : null;
      if (time !== null) {
        const bar = chartDataRef.current.find((entry) => entry.time === time);
        setHoveredBar(bar ?? null);
        onCrosshair?.(time);
      }
    });
    chart.timeScale().subscribeVisibleLogicalRangeChange((visible: LogicalRange | null) => {
      if (!visible || visible.from > 8 || loadingOlder.current || queryPendingRef.current) return;
      if (!chartDataRef.current.length) return;
      void loadOlder();
    });
    chart.timeScale().subscribeVisibleTimeRangeChange((visible) => {
      if (!syncTimeRange || !visible || paneIndex > 0) return;
      onCrosshair?.(typeof visible.from === "number" ? visible.from : null);
    });
    return () => {
      resize.disconnect();
      chart.remove();
      chartRef.current = null;
      priceSeries.current = null;
      volumeSeries.current = null;
      compareSeries.current = null;
      lastPriceLine.current = null;
    };
    // Chart lifecycle changes only when its structural options change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.symbol, config.timeframe, config.type, chartType, config.compareSymbol, compareBars.length, linearScale, loadOlder]);

  useEffect(() => {
    const series = priceSeries.current;
    const volumes = volumeSeries.current;
    if (!series || !volumes) return;
    const formatted = chartData.map((bar) => {
      const base = { time: bar.time as Time };
      if (chartType === "line" || chartType === "area") return { ...base, value: bar.close };
      return { ...base, open: bar.open, high: bar.high, low: bar.low, close: bar.close };
    });
    series.setData(formatted as never);
    volumes.setData(chartData.map((bar) => ({
      time: bar.time as Time,
      value: bar.volume,
      color: bar.close >= bar.open ? "rgba(66,200,138,0.36)" : "rgba(241,108,114,0.36)",
    })));
    if (chartData.length && query.data?.length && !initialFit.current) {
      chartRef.current?.timeScale().fitContent();
      initialFit.current = true;
    }
  }, [chartData, chartType, query.data?.length]);

  useEffect(() => {
    if (latestQuote?.last === undefined || !lastPriceLine.current) return;
    lastPriceLine.current.applyOptions({ price: latestQuote.last });
  }, [latestQuote?.last, latestQuote]);

  useEffect(() => {
    if (!config.symbol) return;
    const unsubscribe = marketStreamManager.subscribe(
      [config.symbol],
      undefined,
      { timeframe: config.timeframe, onBar: (symbol, bar) => {
        if (symbol === config.symbol) setLiveBar(bar);
      } },
    );
    return unsubscribe;
  }, [config.symbol, config.timeframe]);

  useEffect(() => {
    if (!syncTimeRange || paneIndex === 0 || !chartRef.current || synchronizedTime === undefined || synchronizedTime === null) return;
    const index = chartData.findIndex((bar) => bar.time >= synchronizedTime);
    if (index >= 0) {
      const width = chartRef.current.timeScale().getVisibleLogicalRange();
      if (width) chartRef.current.timeScale().setVisibleLogicalRange({ from: index, to: index + (width.to - width.from) });
    }
  }, [chartData, paneIndex, syncTimeRange, synchronizedTime]);

  useEffect(() => {
    if (!syncCrosshair || paneIndex === 0 || synchronizedTime === undefined || synchronizedTime === null) return;
    const bar = chartData.find((entry) => entry.time === synchronizedTime);
    const chart = chartRef.current;
    const series = priceSeries.current;
    if (bar && chart && series) chart.setCrosshairPosition(bar.close, bar.time as Time, series);
    else chart?.clearCrosshairPosition();
  }, [chartData, paneIndex, syncCrosshair, synchronizedTime]);

  const addIndicator = (kind: IndicatorConfig["kind"]) => {
    const overlay = ["SMA", "EMA", "VWAP", "Bollinger"].includes(kind);
    const period = ["SMA", "EMA", "Bollinger", "RSI"].includes(kind) ? 20 : undefined;
    const configValue = indicatorConfigSchema.parse({
      id: `${kind}-${crypto.randomUUID()}`,
      kind,
      pane: overlay ? "overlay" : "separate",
      ...(period ? { period } : {}),
    });
    updateConfig({ indicators: [...config.indicators, configValue] });
    setIndicatorMenu(false);
  };

  const overlayData = useMemo(() => {
    const closes = chartData.map((bar) => bar.close);
    const values: Array<{ id: string; title: string; color: string; points: Array<number | null> }> = [];
    for (const indicator of config.indicators) {
      if (indicator.pane !== "overlay") continue;
      if (indicator.kind === "SMA") values.push({ id: indicator.id, title: `SMA ${indicator.period ?? 20}`, color: "#60a5fa", points: simpleMovingAverage(closes, indicator.period ?? 20) });
      if (indicator.kind === "EMA") values.push({ id: indicator.id, title: `EMA ${indicator.period ?? 20}`, color: "#e879f9", points: exponentialMovingAverage(closes, indicator.period ?? 20) });
      if (indicator.kind === "VWAP") values.push({
        id: indicator.id,
        title: "VWAP",
        color: "#fb923c",
        points: sessionVolumeWeightedAveragePrice(chartData, (index) =>
          new Date(chartData[index]!.time * 1000).toISOString().slice(0, 10),
        ),
      });
      if (indicator.kind === "Bollinger") {
        const bands = bollingerBands(closes, indicator.period ?? 20);
        values.push({ id: `${indicator.id}-middle`, title: `BB ${indicator.period ?? 20}`, color: "#a3a3a3", points: bands.map((point) => point?.middle ?? null) });
        values.push({ id: `${indicator.id}-upper`, title: "BB upper", color: "#737373", points: bands.map((point) => point?.upper ?? null) });
        values.push({ id: `${indicator.id}-lower`, title: "BB lower", color: "#737373", points: bands.map((point) => point?.lower ?? null) });
      }
    }
    return values;
  }, [chartData, config.indicators]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const overlays: ISeriesApi<"Line">[] = [];
    for (const overlay of overlayData) {
      const line = chart.addSeries(LineSeries, {
        color: overlay.color,
        lineWidth: 1,
        title: overlay.title,
        lastValueVisible: false,
        priceLineVisible: false,
        crosshairMarkerVisible: false,
      }, 0);
      line.setData(overlay.points.flatMap((value, index) => value === null ? [] : [{
        time: chartData[index]!.time as Time,
        value,
      }]));
      overlays.push(line);
    }
    return () => {
      if (chartRef.current === chart) for (const overlay of overlays) chart.removeSeries(overlay);
    };
  }, [chartData, overlayData]);

  const addCompareSymbol = async () => {
    const symbol = compareQuery.trim().toUpperCase();
    if (!symbol) return;
    try {
      const response = await fetch(`/api/quotes?symbol=${encodeURIComponent(symbol)}`);
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error("Could not resolve comparison symbol.");
      quoteSchema.array().parse(payload);
      updateConfig({ compareSymbol: symbol });
      setCompareQuery("");
    } catch (error) {
      setChartError(error instanceof Error ? error.message : "Could not add comparison.");
    }
  };

  const moveOlder = () => {
    void loadOlder();
  };

  const legend = hoveredBar ?? chartData.at(-1);

  return (
    <section className="flex min-w-0 flex-col border-b border-[var(--border)] bg-[var(--panel)]">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[var(--border)] px-3 py-2">
        <div className="flex items-center gap-2">
          {onRemove && <button aria-label={`Remove chart pane ${paneIndex + 1}`} onClick={onRemove} className="rounded p-1 text-slate-600 hover:text-rose-300"><Trash2 size={13} /></button>}
            <form onSubmit={async (event) => {
              event.preventDefault();
              const nextSymbol = symbolValue.trim().toUpperCase();
              if (!nextSymbol) return;
              try {
                const response = await fetch(`/api/quotes?symbol=${encodeURIComponent(nextSymbol)}`);
                const payload: unknown = await response.json();
                if (!response.ok) throw new Error("Symbol quote is unavailable.");
                quoteSchema.array().parse(payload);
                updateConfig({ symbol: nextSymbol });
                setChartError("");
              } catch (error) {
                setChartError(error instanceof Error ? error.message : "Symbol quote is unavailable.");
              }
            }}>
              <input aria-label="Chart symbol" value={symbolValue} onChange={(event) => setSymbolValue(event.target.value)} className="w-20 bg-transparent font-mono text-sm font-semibold outline-none" />
            </form>
          {latestQuote && <span className="font-mono text-xs text-slate-300">{latestQuote.last.toFixed(2)}</span>}
          <span className={cn("font-mono text-[10px]", (latestQuote?.change ?? 0) >= 0 ? "text-emerald-400" : "text-rose-400")}>
            {latestQuote ? `${latestQuote.change >= 0 ? "+" : ""}${latestQuote.change.toFixed(2)} (${latestQuote.changePercent.toFixed(2)}%)` : ""}
          </span>
          {quoteSnapshot?.stale && <span className="rounded bg-amber-400/10 px-1 py-0.5 text-[9px] text-amber-300">STALE</span>}
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <select aria-label="Chart type" value={config.type} onChange={(event) => updateConfig({ type: chartTypeSchema.parse(event.target.value) })} className="h-7 rounded border border-[var(--border)] bg-[#0a0d11] px-2 text-[10px]">
            <option value="candlestick">Candles</option><option value="line">Line</option><option value="area">Area</option><option value="bar">Bar</option>
          </select>
          {TIMEFRAMES.map((timeframe) => <button key={timeframe} aria-label={`Timeframe ${timeframe}`} onClick={() => updateConfig({ timeframe: timeframeSchema.parse(timeframe) })} className={cn("rounded px-1.5 py-1 text-[10px]", config.timeframe === timeframe ? "bg-slate-700 text-white" : "text-slate-500 hover:text-white")}>{timeframe}</button>)}
          <span className="mx-1 h-4 border-l border-[var(--border)]" />
          {RANGES.map((range) => <button key={range} onClick={() => updateConfig({ range: chartRangeSchema.parse(range) })} className={cn("rounded px-1.5 py-1 text-[10px]", config.range === range ? "bg-slate-700 text-white" : "text-slate-500 hover:text-white")}>{range}</button>)}
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] px-3 py-1.5">
        <div className="relative">
          <button aria-label="Add indicator" onClick={() => setIndicatorMenu(!indicatorMenu)} className="flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-[10px] text-slate-400 hover:text-white"><Plus size={11} /> Indicator</button>
          {indicatorMenu && <div className="absolute left-0 top-8 z-20 grid min-w-32 rounded border border-[var(--border)] bg-[#12161d] p-1 shadow-xl">
            {(["SMA", "EMA", "VWAP", "Bollinger", "RSI", "MACD"] as const).map((indicator) => <button key={indicator} onClick={() => addIndicator(indicator)} className="rounded px-2 py-1.5 text-left text-[10px] hover:bg-white/5">{indicator}</button>)}
          </div>}
        </div>
        {config.indicators.map((indicator) => <span key={indicator.id} className="flex items-center gap-1 rounded bg-slate-800 px-2 py-1 text-[9px] text-slate-300">
          {indicator.kind} {indicator.period && <input aria-label={`${indicator.kind} period`} type="number" min="2" max="500" value={indicator.period} onChange={(event) => updateConfig({
            indicators: config.indicators.map((entry) => entry.id === indicator.id
              ? indicatorConfigSchema.parse({ ...entry, period: Number(event.target.value) })
              : entry),
          })} className="w-10 bg-transparent font-mono outline-none" />}
          <button aria-label={`Remove ${indicator.kind}`} onClick={() => updateConfig({ indicators: config.indicators.filter((entry) => entry.id !== indicator.id) })} className="text-slate-600 hover:text-rose-300">×</button>
        </span>)}
        <form className="ml-auto flex items-center gap-1" onSubmit={(event) => { event.preventDefault(); void addCompareSymbol(); }}>
          <input aria-label="Comparison symbol" value={compareQuery} onChange={(event) => setCompareQuery(event.target.value)} placeholder={config.compareSymbol ?? "Compare"} className="w-20 bg-transparent text-[10px] outline-none placeholder:text-slate-600" />
          <button type="submit" aria-label="Add comparison symbol" className="text-slate-500 hover:text-white"><Search size={12} /></button>
          {config.compareSymbol && <button type="button" aria-label="Remove comparison symbol" onClick={() => updateConfig({ compareSymbol: undefined })} className="text-slate-500 hover:text-rose-300">×</button>}
        </form>
        <button aria-label={linearScale ? "Use logarithmic scale" : "Use linear scale"} onClick={() => setLinearScale(!linearScale)} className="rounded border border-[var(--border)] px-2 py-1 text-[9px] text-slate-500">{linearScale ? "LINEAR" : "LOG"}</button>
        <button aria-label="Fit chart" onClick={() => chartRef.current?.timeScale().fitContent()} className="text-slate-500 hover:text-white"><Maximize2 size={12} /></button>
        <button aria-label="Load older bars" onClick={moveOlder} className="text-slate-500 hover:text-white"><ArrowLeft size={12} /></button>
        {paneCount > 1 && <span className="text-[9px] text-slate-600">PANE {paneIndex + 1}</span>}
      </div>
      {(chartError || (query.isSuccess && !chartData.length && "No bars were returned for this symbol and period. It may be halted or outside its trading session.")) && <div role="status" className="border-b border-amber-500/20 bg-amber-500/5 px-3 py-1.5 text-[10px] text-amber-200">{chartError || "No bars were returned for this symbol and period. It may be halted or outside its trading session."}</div>}
      {!bars.length && query.isPending && <div className="absolute z-10 m-4 rounded bg-black/65 px-2 py-1 text-xs text-slate-400">Loading bars…</div>}
      <div className="flex items-center gap-3 px-3 py-1.5 font-mono text-[10px] text-slate-500" aria-label="OHLC legend">
        <span>{legend ? new Date(legend.time * 1000).toLocaleString("en-US", { hour12: false }) : "--"}</span>
        <span>O {legend?.open.toFixed(2) ?? "—"}</span><span>H {legend?.high.toFixed(2) ?? "—"}</span>
        <span>L {legend?.low.toFixed(2) ?? "—"}</span><span>C {legend?.close.toFixed(2) ?? "—"}</span>
        <span>VOL {legend?.volume.toLocaleString("en-US") ?? "—"}</span>
      </div>
      <div ref={container} className="h-[min(48vh,460px)] min-h-[280px] w-full" data-testid={`price-chart-${paneIndex}`} />
      {config.indicators.filter((indicator) => indicator.pane === "separate").map((indicator) => (
        <IndicatorPane key={indicator.id} indicator={indicator} bars={chartData} />
      ))}
      {query.isError && <div role="alert" className="px-3 py-2 text-xs text-rose-300">{query.error.message}</div>}
    </section>
  );
}
