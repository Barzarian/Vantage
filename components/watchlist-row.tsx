"use client";

import { memo, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { GripVertical, MoreHorizontal, X } from "lucide-react";
import type { WatchlistItem } from "@/lib/watchlists/model";
import { useQuote } from "@/lib/market-data/quote-store";
import { formatPrice, type WatchlistColumn } from "@/lib/watchlists/preferences";
import { futuresRootFromSymbol } from "@/lib/futures/contracts";
import { cn } from "@/lib/utils";

type Props = {
  item: WatchlistItem;
  columns: WatchlistColumn[];
  selected: boolean;
  selectedListId: string;
  watchlists: Array<{ id: string; name: string }>;
  onSelect: () => void;
  onRemove: () => void;
  onNote: (note: string) => void;
  onMove: (watchlistId: string) => void;
  dragHandle?: React.HTMLAttributes<HTMLButtonElement>;
  rowRef?: (element: HTMLTableRowElement | null) => void;
  rowStyle?: React.CSSProperties;
  rowAttributes?: React.HTMLAttributes<HTMLTableRowElement>;
  virtualStart?: number;
};

const captions: Record<WatchlistColumn, string> = {
  symbol: "Symbol",
  name: "Name",
  last: "Last",
  change: "Change",
  changePercent: "% Chg",
  bid: "Bid",
  ask: "Ask",
  volume: "Volume",
  dayRange: "Day Range",
  weekRange: "52W Range",
  sparkline: "Trend",
};

export const watchlistColumnCaptions = captions;

function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="text-slate-700">—</span>;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const spread = max - min || 1;
  const points = values.map((value, index) =>
    `${(index / (values.length - 1)) * 80},${28 - ((value - min) / spread) * 24}`,
  ).join(" ");
  return (
    <svg aria-label="Recent price trend" role="img" width="80" height="30" viewBox="0 0 80 30">
      <polyline points={points} fill="none" stroke={values.at(-1)! >= values[0]! ? "#42c88a" : "#f16c72"} strokeWidth="1.5" />
    </svg>
  );
}

function RangeBar({ low, high, last }: { low: number; high: number; last: number }) {
  const position = high === low ? 50 : Math.min(100, Math.max(0, ((last - low) / (high - low)) * 100));
  return (
    <div className="min-w-28">
      <div className="relative h-1 rounded bg-slate-700">
        <span className="absolute -top-0.5 size-2 rounded-full bg-emerald-300" style={{ left: `calc(${position}% - 4px)` }} />
      </div>
      <div className="mt-1 flex justify-between font-mono text-[9px] text-slate-600">
        <span>{formatPrice(low, "", "stock")}</span><span>{formatPrice(high, "", "stock")}</span>
      </div>
    </div>
  );
}

function WatchlistRowComponent({
  item,
  columns,
  selected,
  selectedListId,
  watchlists,
  onSelect,
  onRemove,
  onNote,
  onMove,
  dragHandle,
  rowRef,
  rowStyle,
  rowAttributes,
  virtualStart,
}: Props) {
  const snapshot = useQuote(item.symbol);
  const quote = snapshot?.quote;
  const [flash, setFlash] = useState<"up" | "down" | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const previousLast = useRef<number | undefined>(undefined);
  const flashTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const rangeValues = useMemo(() => snapshot?.history ?? [], [snapshot?.history]);

  useEffect(() => {
    if (!quote) return;
    if (previousLast.current !== undefined && previousLast.current !== quote.last) {
      setFlash(quote.last > previousLast.current ? "up" : "down");
      if (flashTimer.current) clearTimeout(flashTimer.current);
      flashTimer.current = setTimeout(() => setFlash(null), 400);
    }
    previousLast.current = quote.last;
    return () => {
      if (flashTimer.current) clearTimeout(flashTimer.current);
    };
  }, [quote]);

  const cell = (column: WatchlistColumn) => {
    if (!quote) {
      return <span className="text-slate-600" aria-label="Quote loading">—</span>;
    }
    if (snapshot?.stale && ["last", "change", "changePercent", "bid", "ask"].includes(column)) {
      if (column === "last") return <span className="text-amber-400">{formatPrice(quote.last, item.symbol, item.assetClass)} <small>STALE</small></span>;
    }
    switch (column) {
      case "symbol":
        return <span className="font-semibold text-slate-100">
          <Link href={item.assetClass === "future"
            ? `/futures/${encodeURIComponent(futuresRootFromSymbol(item.symbol))}?contract=${encodeURIComponent(item.symbol)}`
            : `/chart/${encodeURIComponent(item.symbol)}`}
            className="hover:text-emerald-300">{item.symbol}</Link>
          {snapshot?.stale && <span className="ml-1 text-[9px] text-amber-400">STALE</span>}
          {quote.dataType === "delayed" && <span className="ml-1 rounded bg-amber-400/10 px-1 text-[9px] text-amber-300">DELAYED</span>}
          {quote.dataType === "frozen" && <span className="ml-1 rounded bg-slate-500/20 px-1 text-[9px] text-slate-400">FROZEN</span>}
        </span>;
      case "name": return <span className="max-w-36 truncate text-slate-400">{quote.name}</span>;
      case "last": return <span className="font-mono text-slate-100">{formatPrice(quote.last, item.symbol, item.assetClass)}</span>;
      case "change": return <span className={cn("font-mono", quote.change >= 0 ? "text-emerald-400" : "text-rose-400")}>{quote.change >= 0 ? "+" : ""}{quote.change.toFixed(2)}</span>;
      case "changePercent": return <span className={cn("font-mono", quote.changePercent >= 0 ? "text-emerald-400" : "text-rose-400")}>{quote.changePercent >= 0 ? "+" : ""}{quote.changePercent.toFixed(2)}%</span>;
      case "bid": return <span className="font-mono text-slate-300">{formatPrice(quote.bid, item.symbol, item.assetClass)}</span>;
      case "ask": return <span className="font-mono text-slate-300">{formatPrice(quote.ask, item.symbol, item.assetClass)}</span>;
      case "volume": return <span className="font-mono text-slate-400">{quote.volume.toLocaleString("en-US")}</span>;
      case "dayRange": return <RangeBar low={quote.dayLow} high={quote.dayHigh} last={quote.last} />;
      case "weekRange": return <RangeBar low={quote.weekLow} high={quote.weekHigh} last={quote.last} />;
      case "sparkline": return <Sparkline values={rangeValues} />;
    }
  };

  return (
    <tr
      ref={rowRef}
      style={{
        ...rowStyle,
        ...(virtualStart !== undefined ? { position: "absolute", insetInlineStart: 0, top: virtualStart, width: "100%" } : {}),
      }}
      {...rowAttributes}
      data-testid={`watchlist-row-${item.symbol}`}
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "group h-12 cursor-pointer border-b border-[var(--border)] text-xs hover:bg-white/[0.025]",
        selected && "bg-emerald-400/[0.045]",
        flash === "up" && "flash-up",
        flash === "down" && "flash-down",
      )}
    >
      <td className="w-7 px-1">
        <button aria-label={`Reorder ${item.symbol}`} className="cursor-grab text-slate-700 hover:text-slate-300" {...dragHandle}>
          <GripVertical size={13} />
        </button>
      </td>
      {columns.map((column) => (
        <td key={column} className={cn("px-2 py-2", ["last", "change", "changePercent", "bid", "ask", "volume"].includes(column) && "text-right")}>
          {cell(column)}
        </td>
      ))}
      <td className="relative w-9 px-1" onClick={(event) => event.stopPropagation()}>
        <button aria-label={`Actions for ${item.symbol}`} onClick={() => setMenuOpen(!menuOpen)} className="grid size-7 place-items-center rounded text-slate-500 hover:bg-slate-700 hover:text-white">
          <MoreHorizontal size={15} />
        </button>
        {menuOpen && (
          <div className="absolute right-2 top-9 z-30 min-w-40 rounded border border-[var(--border)] bg-[#12161d] p-1 shadow-xl">
            <Link href={item.assetClass === "future"
              ? `/futures/${encodeURIComponent(futuresRootFromSymbol(item.symbol))}?contract=${encodeURIComponent(item.symbol)}`
              : `/chart/${encodeURIComponent(item.symbol)}`}
              className="block rounded px-2 py-1.5 text-left text-xs hover:bg-white/5">{item.assetClass === "future" ? "Open futures" : "Open chart"}</Link>
            <button className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-white/5" onClick={() => {
              const note = window.prompt("Note for " + item.symbol, item.note);
              if (note !== null) onNote(note);
              setMenuOpen(false);
            }}>Add / edit note</button>
            {watchlists.filter((list) => list.id !== selectedListId).map((list) => (
              <button key={list.id} className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-white/5" onClick={() => { onMove(list.id); setMenuOpen(false); }}>Move to {list.name}</button>
            ))}
            <button className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-rose-300 hover:bg-white/5" onClick={onRemove}><X size={12} /> Remove</button>
          </div>
        )}
      </td>
    </tr>
  );
}

export const WatchlistRow = memo(WatchlistRowComponent, (previous, next) =>
  previous.item === next.item &&
  previous.columns === next.columns &&
  previous.selected === next.selected &&
  previous.selectedListId === next.selectedListId &&
  previous.watchlists === next.watchlists &&
  previous.dragHandle === next.dragHandle &&
  previous.onSelect === next.onSelect &&
  previous.onRemove === next.onRemove &&
  previous.onNote === next.onNote &&
  previous.onMove === next.onMove &&
  previous.virtualStart === next.virtualStart,
);
