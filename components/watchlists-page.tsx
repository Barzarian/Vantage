"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  closestCenter,
  DndContext,
  KeyboardSensor,
  PointerSensor,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import { arrayMove, SortableContext, sortableKeyboardCoordinates, verticalListSortingStrategy } from "@dnd-kit/sortable";
import {
  Activity,
  BarChart3,
  ChevronDown,
  Command,
  Copy,
  LayoutGrid,
  Plus,
  Search,
  Settings2,
  Trash2,
} from "lucide-react";
import type { InstrumentSearchResult } from "@/lib/market-data/schemas";
import { instrumentSearchResultSchema, quoteSchema } from "@/lib/market-data/schemas";
import { quoteStore, useQuoteConnection } from "@/lib/market-data/quote-store";
import { marketStreamManager } from "@/lib/market-data/stream-manager";
import type { Watchlist } from "@/lib/watchlists/model";
import type { ChartPaneConfig } from "@/lib/watchlists/preferences";
import {
  defaultWatchlistPreferences,
  formatPrice,
  watchlistPreferencesSchema,
  userPreferencesSchema,
  type WatchlistColumn,
  type WatchlistPreferences,
} from "@/lib/watchlists/preferences";
import { cn } from "@/lib/utils";
import { SortableWatchlistRow } from "./sortable-watchlist-row";
import { ThemeToggle } from "./theme-toggle";

const QUERY_KEY = ["watchlists"];
const InlinePriceChart = dynamic(
  () => import("./price-chart-panel").then((module) => module.PriceChartPanel),
  { ssr: false, loading: () => <div className="h-72 animate-pulse bg-[var(--panel)]" /> },
);

function StreamStatusBadge() {
  const connection = useQuoteConnection();
  return (
    <>
      <span className={cn("size-1.5 rounded-full", connection.state === "live" ? "bg-emerald-400" : connection.state === "stale" ? "bg-amber-400" : "bg-rose-400")} />
      {connection.state.toUpperCase()}
      <span>UPDATED {connection.lastUpdate ? new Date(connection.lastUpdate).toLocaleTimeString("en-US", { hour12: false }) : "—"}</span>
    </>
  );
}
async function readJson<T>(response: Response, parser: (value: unknown) => T): Promise<T> {
  const value: unknown = await response.json();
  if (!response.ok) {
    const error = typeof value === "object" && value !== null && "error" in value && typeof value.error === "string"
      ? value.error
      : "Request failed.";
    throw new Error(error);
  }
  return parser(value);
}

function parseWatchlists(value: unknown): Watchlist[] {
  const result = (value as { watchlists?: unknown }).watchlists;
  if (!Array.isArray(result)) throw new Error("Invalid watchlist response.");
  return result as Watchlist[];
}

function parseWatchlist(value: unknown): Watchlist {
  return (value as { watchlist: Watchlist }).watchlist;
}

function parseItem(value: unknown): Watchlist["items"][number] {
  return (value as { item: Watchlist["items"][number] }).item;
}

function loadPreferences(): WatchlistPreferences {
  try {
    const saved = localStorage.getItem("vantage.watchlist.preferences");
    return saved ? watchlistPreferencesSchema.parse(JSON.parse(saved) as unknown) : defaultWatchlistPreferences;
  } catch {
    return defaultWatchlistPreferences;
  }
}

function commitPreferences(preferences: WatchlistPreferences) {
  localStorage.setItem("vantage.watchlist.preferences", JSON.stringify(preferences));
}

export function WatchlistsPage() {
  const queryClient = useQueryClient();
  const router = useRouter();
  const listQuery = useQuery({
    queryKey: QUERY_KEY,
    queryFn: async () => {
      const response = await fetch("/api/watchlists", { cache: "no-store" });
      return readJson(response, parseWatchlists);
    },
  });
  const lists = useMemo(() => listQuery.data ?? [], [listQuery.data]);
  const [activeId, setActiveId] = useState("");
  const [selectedItemId, setSelectedItemId] = useState("");
  const [preferences, setPreferences] = useState(defaultWatchlistPreferences);
  const [preferencesReady, setPreferencesReady] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<InstrumentSearchResult[]>([]);
  const [searchError, setSearchError] = useState("");
  const [watchlistError, setWatchlistError] = useState("");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [listMenuOpen, setListMenuOpen] = useState(false);
  const [splitPercent, setSplitPercent] = useState(62);
  const [chartConfig, setChartConfig] = useState<ChartPaneConfig | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const scrollParent = useRef<HTMLDivElement>(null);
  const selectedRemoval = useRef<((itemId: string, listId: string) => void) | null>(null);
  const watchlistNames = useMemo(() => lists.map(({ id, name }) => ({ id, name })), [lists]);
  const active = lists.find((list) => list.id === activeId) ?? lists[0];
  const selectedItem = active?.items.find((entry) => entry.id === selectedItemId) ?? active?.items[0];
  const selectedIndex = active?.items.findIndex((item) => item.id === selectedItemId) ?? -1;
  const columns = useMemo(
    () => preferences.order.filter((column) => preferences.visible.includes(column)),
    [preferences.order, preferences.visible],
  );
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/preferences", { signal: controller.signal, cache: "no-store" })
      .then(async (response) => {
        const payload: unknown = await response.json();
        if (!response.ok) throw new Error("Could not load saved preferences.");
        return userPreferencesSchema.parse((payload as { preferences: unknown }).preferences);
      })
      .then((saved) => {
        if (controller.signal.aborted) return;
        setPreferences(saved.watchlist);
        setPreferencesReady(true);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setPreferences(loadPreferences());
        setPreferencesReady(true);
        console.error(`[watchlists] Could not load persisted preferences: ${error instanceof Error ? error.message : "unknown error"}`);
      });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (active && !lists.some((list) => list.id === activeId)) setActiveId(active.id);
  }, [active, activeId, lists]);

  useEffect(() => {
    const symbols = [...new Set(lists.flatMap((list) => list.items.map((item) => item.symbol)))];
    if (!symbols.length) return;
    const abort = new AbortController();
    void fetch(`/api/quotes?${symbols.map((symbol) => `symbol=${encodeURIComponent(symbol)}`).join("&")}`, {
      signal: abort.signal,
      cache: "no-store",
    }).then(async (response) => {
      const payload: unknown = await response.json();
      if (!response.ok) throw new Error("Could not load watchlist quotes.");
      quoteStore.updateMany(quoteSchema.array().parse(payload));
    }).catch((error: unknown) => {
      if (!abort.signal.aborted) setWatchlistError(error instanceof Error ? error.message : "Could not load quotes.");
    });
    const unsubscribe = marketStreamManager.subscribe(symbols);
    return () => {
      abort.abort();
      unsubscribe();
    };
  }, [lists]);

  useEffect(() => {
    if (!preferencesReady) return;
    commitPreferences(preferences);
    const timer = setTimeout(() => {
      void fetch("/api/preferences", { cache: "no-store" })
        .then(async (response) => {
          const payload: unknown = await response.json();
          if (!response.ok) throw new Error("Could not load current preferences.");
          return userPreferencesSchema.parse((payload as { preferences: unknown }).preferences);
        })
        .then((current) => fetch("/api/preferences", {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ ...current, watchlist: preferences }),
        }))
        .catch((error: unknown) => console.error(`[watchlists] Could not persist preferences: ${error instanceof Error ? error.message : "unknown error"}`));
    }, 400);
    return () => clearTimeout(timer);
  }, [preferences, preferencesReady]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      const isEditing = target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setSearchOpen(true);
      } else if (event.key === "/" && !isEditing) {
        event.preventDefault();
        setSearchOpen(true);
      } else if (!isEditing && event.key.toLowerCase() === "j") {
        event.preventDefault();
        const next = active?.items[Math.min(active.items.length - 1, Math.max(0, selectedIndex + 1))];
        if (next) setSelectedItemId(next.id);
      } else if (!isEditing && event.key.toLowerCase() === "k") {
        event.preventDefault();
        const next = active?.items[Math.max(0, selectedIndex - 1)];
        if (next) setSelectedItemId(next.id);
      } else if (!isEditing && event.key === "Enter" && selectedIndex >= 0) {
        const item = active?.items[selectedIndex];
        if (item) router.push(`/chart/${encodeURIComponent(item.symbol)}`);
      } else if (!isEditing && event.key === "Delete" && selectedIndex >= 0) {
        const item = active?.items[selectedIndex];
        if (item) selectedRemoval.current?.(item.id, item.watchlistId);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active, selectedIndex, router]);

  useEffect(() => {
    if (!searchOpen) return;
    searchInput.current?.focus();
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen || !searchQuery.trim()) {
      setSearchResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => {
      void fetch(`/api/search?q=${encodeURIComponent(searchQuery.trim())}`, { signal: controller.signal })
        .then(async (response) => readJson(response, (data) => instrumentSearchResultSchema.array().parse(data)))
        .then((data) => { setSearchResults(data); setSearchError(""); })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            setSearchResults([]);
            setSearchError(error instanceof Error ? error.message : "Search failed.");
          }
        });
    }, 180);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [searchOpen, searchQuery]);

  const invalidate = () => queryClient.invalidateQueries({ queryKey: QUERY_KEY });
  const addItem = useMutation({
    mutationFn: async (instrument: InstrumentSearchResult) => {
      if (!active) throw new Error("Choose a watchlist first.");
      const quoteResponse = await fetch(`/api/quotes?symbol=${encodeURIComponent(instrument.symbol)}`);
      const quoteValue: unknown = await quoteResponse.json();
      if (!quoteResponse.ok) throw new Error("Could not resolve the selected instrument quote.");
      const quotes = quoteSchema.array().parse(quoteValue);
      quoteStore.updateMany(quotes);
      const response = await fetch(`/api/watchlists/${active.id}/items`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          symbol: instrument.symbol,
          assetClass: instrument.secType === "FUT" ? "future" : instrument.secType === "IND" ? "index" : "stock",
        }),
      });
      return readJson(response, parseItem);
    },
    onSuccess: async () => {
      setSearchOpen(false);
      setSearchQuery("");
      await invalidate();
    },
    onError: (error) => setSearchError(error.message),
  });
  const removeItem = useMutation({
    mutationFn: async ({ itemId, listId }: { itemId: string; listId: string }) => {
      const response = await fetch(`/api/watchlists/${listId}/items/${itemId}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not remove symbol.");
    },
    onSuccess: invalidate,
    onError: (error) => setWatchlistError(error.message),
  });
  useEffect(() => {
    selectedRemoval.current = (itemId, listId) => removeItem.mutate({ itemId, listId });
  }, [removeItem]);
  const updateItem = useMutation({
    mutationFn: async ({ itemId, listId, patch }: { itemId: string; listId: string; patch: { note?: string; watchlistId?: string } }) => {
      const response = await fetch(`/api/watchlists/${listId}/items/${itemId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      return readJson(response, parseItem);
    },
    onSuccess: invalidate,
    onError: (error) => setWatchlistError(error.message),
  });
  const reorder = useMutation({
    mutationFn: async (orderedIds: string[]) => {
      if (!active) throw new Error("Choose a watchlist first.");
      const response = await fetch(`/api/watchlists/${active.id}/items/reorder`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ orderedIds }),
      });
      return readJson(response, parseWatchlist);
    },
    onError: (error) => {
      setWatchlistError(error.message);
      void invalidate();
    },
  });

  const setLists = useCallback((updater: (current: Watchlist[]) => Watchlist[]) => {
    queryClient.setQueryData<Watchlist[]>(QUERY_KEY, (current) => updater(current ?? []));
  }, [queryClient]);

  const createList = async () => {
    const name = window.prompt("New watchlist name");
    if (!name?.trim()) return;
    try {
      const response = await fetch("/api/watchlists", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      });
      const created = await readJson(response, parseWatchlist);
      setLists((current) => [...current, created]);
      setActiveId(created.id);
    } catch (error) { setWatchlistError(error instanceof Error ? error.message : "Could not create watchlist."); }
  };

  const renameList = async () => {
    if (!active) return;
    const name = window.prompt("Rename watchlist", active.name);
    if (!name?.trim()) return;
    const previous = lists;
    setLists((current) => current.map((list) => list.id === active.id ? { ...list, name } : list));
    try {
      const response = await fetch(`/api/watchlists/${active.id}`, {
        method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name }),
      });
      await readJson(response, parseWatchlist);
    } catch (error) {
      queryClient.setQueryData(QUERY_KEY, previous);
      setWatchlistError(error instanceof Error ? error.message : "Could not rename watchlist.");
    }
  };

  const duplicateList = async () => {
    if (!active) return;
    try {
      const response = await fetch("/api/watchlists", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sourceId: active.id }),
      });
      const created = await readJson(response, parseWatchlist);
      await invalidate();
      setActiveId(created.id);
    } catch (error) { setWatchlistError(error instanceof Error ? error.message : "Could not duplicate list."); }
  };

  const deleteList = async () => {
    if (!active || !window.confirm(`Delete "${active.name}"?`)) return;
    try {
      const response = await fetch(`/api/watchlists/${active.id}`, { method: "DELETE" });
      if (!response.ok) throw new Error("Could not delete watchlist.");
      const remaining = lists.filter((list) => list.id !== active.id);
      setLists(() => remaining);
      setActiveId(remaining[0]?.id ?? "");
    } catch (error) { setWatchlistError(error instanceof Error ? error.message : "Could not delete watchlist."); }
  };

  const onDragEnd = (event: DragEndEvent) => {
    if (!active || !event.over || event.active.id === event.over.id) return;
    const oldIndex = sortedItems.findIndex((item) => item.id === event.active.id);
    const newIndex = sortedItems.findIndex((item) => item.id === event.over?.id);
    if (oldIndex < 0 || newIndex < 0) return;
    const ordered = arrayMove(sortedItems, oldIndex, newIndex);
    const previous = lists;
    setLists((current) => current.map((list) => list.id === active.id
      ? { ...list, items: ordered.map((item, position) => ({ ...item, position })) }
      : list));
    setPreferences((current) => ({ ...current, sort: undefined }));
    reorder.mutate(ordered.map((item) => item.id), {
      onError: () => queryClient.setQueryData(QUERY_KEY, previous),
    });
  };

  const sortBy = (column: WatchlistColumn) => {
    const direction = preferences.sort?.column === column && preferences.sort.direction === "asc" ? "desc" : "asc";
    setPreferences((current) => ({ ...current, sort: { column, direction } }));
  };
  const sortedItems = useMemo(() => {
    if (!active || !preferences.sort) return active?.items ?? [];
    const { column, direction } = preferences.sort;
    const multiplier = direction === "asc" ? 1 : -1;
    return [...active.items].sort((left, right) => {
      const lq = quoteStore.get(left.symbol)?.quote;
      const rq = quoteStore.get(right.symbol)?.quote;
      const leftValue: string | number = column === "symbol" ? left.symbol :
        column === "name" ? lq?.name ?? left.symbol :
          column === "last" ? lq?.last ?? 0 :
            column === "change" ? lq?.change ?? 0 :
              column === "changePercent" ? lq?.changePercent ?? 0 :
                column === "bid" ? lq?.bid ?? 0 :
                  column === "ask" ? lq?.ask ?? 0 :
                    column === "volume" ? lq?.volume ?? 0 : left.symbol;
      const rightValue: string | number = column === "symbol" ? right.symbol :
        column === "name" ? rq?.name ?? right.symbol :
          column === "last" ? rq?.last ?? 0 :
            column === "change" ? rq?.change ?? 0 :
              column === "changePercent" ? rq?.changePercent ?? 0 :
                column === "bid" ? rq?.bid ?? 0 :
                  column === "ask" ? rq?.ask ?? 0 :
                    column === "volume" ? rq?.volume ?? 0 : right.symbol;
      return (typeof leftValue === "string" ? leftValue.localeCompare(String(rightValue)) : leftValue - Number(rightValue)) * multiplier;
    });
  }, [active, preferences.sort]);
  const itemIds = useMemo(() => sortedItems.map((item) => item.id), [sortedItems]);
  // TanStack Virtual owns mutable scroll observers; its hook result must stay un-memoized.
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: sortedItems.length > 50 ? sortedItems.length : 0,
    getScrollElement: () => scrollParent.current,
    estimateSize: () => 48,
    overscan: 8,
  });
  const virtualItems = sortedItems.length > 50
    ? virtualizer.getVirtualItems().map((entry) => ({ ...entry, item: sortedItems[entry.index]! }))
    : sortedItems.map((item, index) => ({
        index,
        start: index * 48,
        size: 48,
        end: (index + 1) * 48,
        key: item.id,
        item,
      }));

  const onPreferenceChange = (change: (current: WatchlistPreferences) => WatchlistPreferences) => {
    setPreferences((current) => {
      const next = change(current);
      return watchlistPreferencesSchema.parse(next);
    });
  };

  const toggleColumn = (column: WatchlistColumn) => onPreferenceChange((current) => ({
    ...current,
    visible: current.visible.includes(column)
      ? current.visible.filter((entry) => entry !== column)
      : current.order.filter((entry) => entry === column || current.visible.includes(entry)),
  }));

  if (listQuery.isPending) {
    return <main className="min-h-screen bg-[var(--background)] p-8 text-sm text-slate-500">Loading watchlists…</main>;
  }
  if (listQuery.isError) {
    return <main className="min-h-screen bg-[var(--background)] p-8 text-sm text-rose-300">Could not load watchlists: {listQuery.error.message}</main>;
  }

  return (
    <main className="min-h-screen bg-[var(--background)]">
      <header className="flex h-14 items-center justify-between border-b border-[var(--border)] px-5">
        <Link href="/" className="flex items-center gap-2 font-semibold text-white">
          <span className="grid size-7 place-items-center rounded bg-emerald-400 text-black"><Activity size={16} /></span>
          VANTAGE <span className="text-[10px] font-normal tracking-[.18em] text-slate-500">TERMINAL</span>
        </Link>
        <nav className="flex h-full items-center gap-1">
          <Link href="/" className="px-3 py-2 text-xs text-slate-500 hover:text-white">Overview</Link>
          <Link href="/watchlists" className="border-b-2 border-emerald-400 px-3 py-2 text-xs text-white">Watchlists</Link>
          <Link href={`/chart/${encodeURIComponent(active?.items.find((item) => item.id === selectedItemId)?.symbol ?? "AAPL")}`} className="px-3 py-2 text-xs text-slate-500 hover:text-white">Charts</Link>
        </nav>
        <div className="flex items-center gap-3 text-[10px] text-slate-500">
          <StreamStatusBadge />
          <ThemeToggle />
          <button onClick={() => setSearchOpen(true)} className="flex items-center gap-1 rounded border border-[var(--border)] px-2 py-1 text-slate-300"><Search size={12} />⌘K</button>
        </div>
      </header>
      <div
        className="mx-auto grid max-w-[1800px] grid-cols-1 xl:grid-cols-[minmax(0,var(--watchlist-left))_6px_minmax(420px,var(--watchlist-right))]"
        style={{
          "--watchlist-left": `${splitPercent}fr`,
          "--watchlist-right": `${100 - splitPercent}fr`,
        } as React.CSSProperties}
      >
        <section className="min-w-0 border-r border-[var(--border)]">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
            <div>
              <div className="mb-1 flex items-center gap-2 text-[10px] uppercase tracking-[.16em] text-slate-500"><LayoutGrid size={12} /> Personal workspace</div>
              <h1 className="text-lg font-medium">Watchlists</h1>
            </div>
            <button onClick={() => setSearchOpen(true)} className="flex h-8 items-center gap-2 rounded border border-[var(--border)] bg-[var(--panel)] px-3 text-xs text-slate-300"><Plus size={13} /> Add symbol <span className="text-[10px] text-slate-600">⌘K</span></button>
          </div>
          <div className="flex items-center gap-1 border-b border-[var(--border)] px-4 py-2">
            {lists.map((list) => (
              <button key={list.id} onClick={() => { setActiveId(list.id); setSelectedItemId(""); }} className={cn("rounded px-3 py-1.5 text-xs", (active?.id === list.id) ? "bg-slate-800 text-white" : "text-slate-500 hover:text-white")}>
                {list.name}<span className="ml-2 text-[10px] text-slate-600">{list.items.length}</span>
              </button>
            ))}
            <button aria-label="Create watchlist" onClick={() => void createList()} className="grid size-7 place-items-center rounded text-slate-500 hover:bg-slate-800 hover:text-white"><Plus size={14} /></button>
            <div className="relative ml-auto">
              <button aria-label="Watchlist actions" onClick={() => setListMenuOpen(!listMenuOpen)} className="grid size-7 place-items-center rounded text-slate-500 hover:bg-slate-800 hover:text-white"><ChevronDown size={14} /></button>
              {listMenuOpen && active && <div className="absolute right-0 top-8 z-20 w-40 rounded border border-[var(--border)] bg-[#12161d] p-1 shadow-xl">
                <button onClick={() => { void renameList(); setListMenuOpen(false); }} className="block w-full rounded px-2 py-1.5 text-left text-xs hover:bg-white/5">Rename</button>
                <button onClick={() => { void duplicateList(); setListMenuOpen(false); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-white/5"><Copy size={12} /> Duplicate</button>
                <button onClick={() => { void deleteList(); setListMenuOpen(false); }} className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs text-rose-300 hover:bg-white/5"><Trash2 size={12} /> Delete</button>
              </div>}
            </div>
          </div>
          <div className="flex items-center justify-between border-b border-[var(--border)] bg-[#0b0e12] px-4 py-2 text-[10px] text-slate-500">
            <div className="flex gap-3"><span>{active?.items.length ?? 0} symbols</span><span>{active?.name ?? "No watchlist selected"}</span></div>
            <button aria-label="Configure columns" onClick={() => setSettingsOpen(!settingsOpen)} className="flex items-center gap-1 hover:text-white"><Settings2 size={12} /> Columns</button>
          </div>
          {settingsOpen && <div className="flex flex-wrap gap-x-4 gap-y-2 border-b border-[var(--border)] px-4 py-3 text-[10px]">
            {preferences.order.map((column, index) => <div key={column} className="flex items-center gap-1.5 text-slate-400">
              <input type="checkbox" checked={preferences.visible.includes(column)} onChange={() => toggleColumn(column)} />
              <span>{column}</span>
              <button aria-label={`Move ${column} column left`} disabled={index === 0} onClick={() => onPreferenceChange((current) => {
                const order = [...current.order];
                [order[index - 1], order[index]] = [order[index]!, order[index - 1]!];
                return { ...current, order };
              })} className="text-slate-600 disabled:opacity-30">←</button>
              <button aria-label={`Move ${column} column right`} disabled={index === preferences.order.length - 1} onClick={() => onPreferenceChange((current) => {
                const order = [...current.order];
                [order[index], order[index + 1]] = [order[index + 1]!, order[index]!];
                return { ...current, order };
              })} className="text-slate-600 disabled:opacity-30">→</button>
            </div>)}
          </div>}
          {watchlistError && <div role="alert" className="border-b border-rose-500/20 bg-rose-500/5 px-4 py-2 text-xs text-rose-300">{watchlistError}<button className="ml-2 underline" onClick={() => setWatchlistError("")}>Dismiss</button></div>}
          {!active?.items.length ? <div className="grid min-h-72 place-items-center text-center">
            <div><BarChart3 className="mx-auto mb-3 text-slate-600" size={24} /><p className="text-sm text-slate-300">This watchlist is empty</p><p className="mt-1 text-xs text-slate-600">Search and add an instrument to get started.</p></div>
          </div> : <div ref={scrollParent} className="max-h-[calc(100vh-230px)] overflow-auto">
            <DndContext sensors={sensors} collisionDetection={closestCenter} onDragEnd={onDragEnd}>
              <table className="w-full min-w-max border-collapse">
                <thead className="sticky top-0 bg-[var(--panel)]">
                  <tr className="h-9 border-b border-[var(--border)] text-[10px] uppercase tracking-wider text-slate-600">
                    <th className="w-7" />
                    {columns.map((column) => <th key={column} className={cn("px-2 text-left font-medium", ["last", "change", "changePercent", "bid", "ask", "volume"].includes(column) && "text-right")}>
                      <button onClick={() => sortBy(column)} className="hover:text-slate-300">{column === "changePercent" ? "% chg" : column === "dayRange" ? "Day range" : column === "weekRange" ? "52w range" : column}</button>
                    </th>)}
                    <th className="w-9" />
                  </tr>
                </thead>
                <tbody style={sortedItems.length > 50 ? { height: virtualizer.getTotalSize(), position: "relative" } : undefined}>
                  <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
                    {sortedItems.length > 50 && virtualItems[0]?.start ? <tr aria-hidden="true"><td colSpan={columns.length + 2} style={{ height: virtualItems[0].start }} /></tr> : null}
                    {virtualItems.map(({ item, start }) => <SortableWatchlistRow
                      key={item.id}
                      item={item}
                      columns={columns}
                      selected={item.id === selectedItemId}
                      selectedListId={active.id}
                      watchlists={watchlistNames}
                      onSelect={() => setSelectedItemId(item.id)}
                      onRemove={() => removeItem.mutate({ itemId: item.id, listId: item.watchlistId })}
                      onNote={(note) => updateItem.mutate({ itemId: item.id, listId: item.watchlistId, patch: { note } })}
                      onMove={(watchlistId) => updateItem.mutate({ itemId: item.id, listId: item.watchlistId, patch: { watchlistId } })}
                      virtualStart={sortedItems.length > 50 ? start : undefined}
                    />)}
                    {sortedItems.length > 50 && virtualItems.at(-1) && virtualItems.at(-1)!.end < virtualizer.getTotalSize() &&
                      <tr aria-hidden="true"><td colSpan={columns.length + 2} style={{ height: virtualizer.getTotalSize() - virtualItems.at(-1)!.end }} /></tr>}
                  </SortableContext>
                </tbody>
              </table>
            </DndContext>
          </div>}
          {active?.items.length === 0 && <button onClick={() => setSearchOpen(true)} className="mx-5 mb-5 flex items-center gap-2 rounded border border-dashed border-slate-700 px-3 py-2 text-xs text-slate-400 hover:text-white"><Plus size={13} /> Add your first symbol</button>}
          <div className="flex gap-4 border-t border-[var(--border)] px-4 py-2 text-[10px] text-slate-600"><span>J/K Navigate</span><span>Enter Open chart</span><span>⌘K Search</span><span>Delete Remove</span></div>
        </section>
        <div
          role="separator"
          aria-label="Resize watchlist and chart panels"
          aria-orientation="vertical"
          tabIndex={0}
          className="hidden cursor-col-resize bg-[var(--border)] hover:bg-emerald-400/50 xl:block"
          onPointerDown={(event) => event.currentTarget.setPointerCapture(event.pointerId)}
          onPointerMove={(event) => {
            if (event.buttons !== 1) return;
            const bounds = event.currentTarget.parentElement?.getBoundingClientRect();
            if (!bounds || bounds.width <= 0) return;
            setSplitPercent(Math.max(45, Math.min(75, ((event.clientX - bounds.left) / bounds.width) * 100)));
          }}
          onKeyDown={(event) => {
            if (event.key === "ArrowLeft") setSplitPercent((current) => Math.max(45, current - 2));
            if (event.key === "ArrowRight") setSplitPercent((current) => Math.min(75, current + 2));
          }}
        />
        <aside className="min-h-[560px] bg-[#0b0e12]">
          {(() => {
            const item = selectedItem;
            const quote = item ? quoteStore.get(item.symbol)?.quote : undefined;
            return item ? <div className="flex h-full min-h-[560px] flex-col">
              <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
                <div><div className="text-[10px] uppercase tracking-wider text-slate-500">Selected instrument</div><div className="mt-1 text-sm font-semibold">{item.symbol} <span className="font-normal text-slate-500">{quote?.name}</span></div></div>
                <Link href={`/chart/${encodeURIComponent(item.symbol)}`} className="rounded border border-[var(--border)] px-2.5 py-1.5 text-[10px] text-slate-300 hover:text-white">Open full chart</Link>
              </div>
              {quote && <div className="flex items-end gap-3 px-4 pt-4"><span className="font-mono text-2xl">{formatPrice(quote.last, item.symbol, item.assetClass)}</span><span className={cn("font-mono text-xs", quote.change >= 0 ? "text-emerald-400" : "text-rose-400")}>{quote.change >= 0 ? "+" : ""}{quote.change.toFixed(2)} ({quote.changePercent.toFixed(2)}%)</span></div>}
              <div className="flex-1">
                <InlinePriceChart
                  key={item.symbol}
                  config={chartConfig?.symbol === item.symbol ? chartConfig : {
                    symbol: item.symbol,
                    timeframe: "1m",
                    range: "1D",
                    type: "candlestick",
                    indicators: [],
                  }}
                  onChange={(next) => setChartConfig(next)}
                  paneIndex={0}
                  paneCount={1}
                  syncCrosshair={false}
                  syncTimeRange={false}
                />
              </div>
            </div> : <div className="grid min-h-[560px] place-items-center text-sm text-slate-600">Select a symbol to preview</div>;
          })()}
        </aside>
      </div>
      <footer className="border-t border-[var(--border)] px-5 py-4 text-[10px] text-slate-600">Market data is for informational purposes only, not financial advice.</footer>

      {searchOpen && <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/65 px-4 pt-[14vh]" onMouseDown={(event) => { if (event.target === event.currentTarget) setSearchOpen(false); }}>
        <div role="dialog" aria-modal="true" aria-label="Search symbols" className="w-full max-w-xl overflow-hidden rounded-xl border border-[var(--border)] bg-[#10141a] shadow-2xl">
          <div className="flex items-center gap-3 border-b border-[var(--border)] px-4">
            <Search size={16} className="text-slate-500" />
            <input ref={searchInput} aria-label="Search symbols" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} onKeyDown={(event) => {
              if (event.key === "Escape") setSearchOpen(false);
              if (event.key === "Enter" && searchResults[0]) addItem.mutate(searchResults[0]);
            }} placeholder="Search stocks, ETFs, futures, indices…" className="h-12 flex-1 bg-transparent text-sm outline-none placeholder:text-slate-600" />
            <kbd className="rounded border border-[var(--border)] px-1.5 py-0.5 text-[10px] text-slate-600"><Command size={10} /></kbd>
          </div>
          <div className="max-h-80 overflow-auto p-2">
            {searchError && <p role="alert" className="px-3 py-2 text-xs text-rose-300">{searchError}</p>}
            {!searchQuery && <p className="px-3 py-3 text-xs text-slate-600">Type to search the mock directory and available market-data instruments.</p>}
            {searchQuery && !searchResults.length && !searchError && <p className="px-3 py-3 text-xs text-slate-600">Searching instruments…</p>}
            {searchResults.map((instrument) => <button key={`${instrument.conId}:${instrument.exchange}:${instrument.currency}`} onClick={() => addItem.mutate(instrument)} className="flex w-full items-center justify-between rounded px-3 py-2.5 text-left hover:bg-white/[.05]">
              <span><span className="font-mono text-sm font-semibold">{instrument.symbol}</span><span className="ml-3 text-xs text-slate-400">{instrument.name}</span></span>
              <span className="text-[10px] text-slate-600">{instrument.exchange} · {instrument.currency}</span>
            </button>)}
            {addItem.isPending && <p className="px-3 py-2 text-xs text-slate-500">Adding symbol…</p>}
          </div>
          <div className="border-t border-[var(--border)] px-4 py-2 text-[10px] text-slate-600">↑↓ Navigate · Enter Add · Esc Close</div>
        </div>
      </div>}
    </main>
  );
}
