"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { buildFuturesContracts, daysToExpiry, parseFuturesSymbol } from "@/lib/futures/contracts";
import { getFuturesRoot } from "@/lib/futures/specs";
import {
  instrumentSearchResultSchema,
  type InstrumentSearchResult,
  type OptionQuote,
  type Quote,
} from "@/lib/market-data/schemas";
import { quoteStore, useOptionQuote, useQuote, useQuoteConnection } from "@/lib/market-data/quote-store";
import { foldTransactions } from "@/lib/positions/ledger";
import {
  inferAssetClass,
  parseGenericCsv,
  toCsv,
  transactionDedupeHash,
} from "@/lib/positions/csv";
import {
  transactionInputSchema,
  type PositionAccount,
  type PortfolioSnapshot,
  type PositionsPreferences,
  type PositionTransaction,
  type PositionTransactionInput,
} from "@/lib/positions/model";
import { optionQuoteMark, quoteMark, valuePosition, type ValuedPosition } from "@/lib/positions/valuation";
import { cn } from "@/lib/utils";

type PositionData = {
  account: PositionAccount;
  transactions: PositionTransaction[];
  audit: Array<{
    id: string;
    transactionId: string;
    action: string;
    before: PositionTransaction | null;
    after: PositionTransaction | null;
    createdAt: string;
  }>;
  snapshots: PortfolioSnapshot[];
  preferences: PositionsPreferences;
};
type View = "positions" | "transactions" | "performance" | "alerts";
type Grouping = "flat" | "underlying" | "assetClass";
type EntryValues = {
  kind: "trade";
  accountId: string;
  symbol: string;
  assetClass: "equity" | "option" | "future";
  side: "buy" | "sell";
  quantity: number;
  price: number;
  fees: number;
  currency: string;
  executedAt: string;
  notes: string;
};
type ActionValues = {
  kind: "split" | "dividend";
  accountId: string;
  symbol: string;
  executedAt: string;
  notes: string;
  ratioNumerator: number;
  ratioDenominator: number;
  amountPerShare: number;
  currency: string;
};

const defaultEntry = (accountId: string): EntryValues => ({
  kind: "trade",
  accountId,
  symbol: "",
  assetClass: "equity",
  side: "buy",
  quantity: 1,
  price: 0,
  fees: 0,
  currency: "USD",
  executedAt: new Date().toISOString().slice(0, 16),
  notes: "",
});
const columnLabels = {
  symbol: "Symbol",
  assetClass: "Type",
  quantity: "Qty",
  averageCost: "Avg cost",
  mark: "Mark",
  marketValue: "Market value",
  dayPnl: "Day P&L",
  unrealizedPnl: "Unrealized P&L",
  delta: "Delta",
  portfolioWeight: "% portfolio",
  daysToExpiry: "Days to expiry",
} as const;
type PositionColumn = keyof typeof columnLabels;
const emptyTransactions: PositionTransaction[] = [];
const emptyFxRates: Record<string, number> = {};
const defaultColumns: PositionColumn[] = [
  "symbol", "assetClass", "quantity", "averageCost", "mark", "marketValue",
  "dayPnl", "unrealizedPnl", "delta", "portfolioWeight", "daysToExpiry",
];

export function PositionsDashboard({ initialView = "positions" }: { initialView?: View }) {
  const queryClient = useQueryClient();
  const [view, setView] = useState<View>(initialView);
  const [grouping, setGrouping] = useState<Grouping>("flat");
  const [preferencesOverride, setPreferencesOverride] = useState<PositionsPreferences | null>(null);
  const [columnsOpen, setColumnsOpen] = useState(false);
  const [entry, setEntry] = useState<EntryValues | null>(null);
  const [actionEntry, setActionEntry] = useState<ActionValues | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const [searchQuery, setSearchQuery] = useState("");
  const [searchResults, setSearchResults] = useState<InstrumentSearchResult[]>([]);
  const [searchError, setSearchError] = useState("");
  const [fxRatesOverride, setFxRatesOverride] = useState<Record<string, number> | null>(null);
  const [tickVersion, setTickVersion] = useState(0);
  const [importFile, setImportFile] = useState<{
    headers: string[];
    rows: string[][];
    mapping: Record<string, number>;
    rowErrors: string[];
    parsed: PositionTransactionInput[];
  } | null>(null);
  const [dryRun, setDryRun] = useState(true);

  const query = useQuery({
    queryKey: ["positions"],
    queryFn: async (): Promise<PositionData> => {
      const response = await fetch("/api/positions", { cache: "no-store" });
      const data: unknown = await response.json();
      if (!response.ok) throw new Error(getErrorMessage(data, "Could not load positions."));
      return data as PositionData;
    },
  });
  const data = query.data;
  const transactions = data?.transactions ?? emptyTransactions;
  const account = data?.account;
  const columns = preferencesOverride?.columns ?? data?.preferences.columns ?? defaultColumns;
  const sortBy = preferencesOverride?.sortBy ?? data?.preferences.sortBy ?? "symbol";
  const fxRates = fxRatesOverride ?? account?.fxRates ?? emptyFxRates;
  const folded = useMemo(
    () => foldTransactions(transactions, account?.lotMethod ?? "fifo"),
    [transactions, account?.lotMethod],
  );
  const connection = useQuoteConnection();
  const symbolsKey = useMemo(() => JSON.stringify({
    symbols: [...new Set(folded.positions.flatMap((position) =>
      position.assetClass === "option" ? [position.underlying] : [position.symbol],
    ))],
    options: folded.positions.filter((position) => position.assetClass === "option").map((position) => position.symbol),
  }), [folded.positions]);

  useEffect(() => {
    const symbols = JSON.parse(symbolsKey) as { symbols: string[]; options: string[] };
    if (!symbols.symbols.length && !symbols.options.length) return;
    const params = new URLSearchParams();
    symbols.symbols.forEach((symbol) => params.append("symbol", symbol));
    symbols.options.forEach((symbol) => params.append("optionSymbol", symbol));
    quoteStore.setConnectionState("connecting");
    const source = new EventSource(`/api/stream?${params.toString()}`);
    source.onopen = () => quoteStore.setConnectionState("live");
    source.onerror = () => quoteStore.setConnectionState("disconnected");
    source.addEventListener("tick", (event) => {
      const quote = JSON.parse((event as MessageEvent<string>).data) as Quote;
      quoteStore.update(quote);
      setTickVersion((value) => value + 1);
    });
    source.addEventListener("optionTick", (event) => {
      const option = JSON.parse((event as MessageEvent<string>).data) as OptionQuote;
      quoteStore.updateOptions([option]);
      setTickVersion((value) => value + 1);
    });
    source.addEventListener("status", (event) => {
      const status = JSON.parse((event as MessageEvent<string>).data) as { state?: "connecting" | "live" | "stale" | "disconnected" };
      if (status.state) quoteStore.setConnectionState(status.state);
    });
    return () => source.close();
  }, [symbolsKey]);

  useEffect(() => {
    const unsubscribe: Array<() => void> = [];
    const instruments = JSON.parse(symbolsKey) as { symbols: string[]; options: string[] };
    for (const symbol of instruments.symbols) unsubscribe.push(quoteStore.subscribe(symbol, () => setTickVersion((n) => n + 1)));
    for (const symbol of instruments.options) unsubscribe.push(quoteStore.subscribeOption(symbol, () => setTickVersion((n) => n + 1)));
    return () => unsubscribe.forEach((stop) => stop());
  }, [symbolsKey]);

  useEffect(() => {
    if (!searchQuery.trim()) return;
    const controller = new AbortController();
    const timeout = setTimeout(async () => {
      try {
        const response = await fetch(`/api/search?q=${encodeURIComponent(searchQuery.trim())}`, { signal: controller.signal });
        const result: unknown = await response.json();
        if (!response.ok) throw new Error(getErrorMessage(result, "Symbol search failed."));
        setSearchResults(instrumentSearchResultSchema.array().parse(result));
        setSearchError("");
      } catch (error) {
        if (!controller.signal.aborted) {
          setSearchResults([]);
          setSearchError(error instanceof Error ? error.message : "Symbol search failed.");
        }
      }
    }, 180);
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [searchQuery]);

  const writeMutation = useMutation({
    mutationFn: async (action: { type: "create" | "update" | "delete"; transaction?: PositionTransactionInput; id?: string }) => {
      const response = await fetch(action.type === "create" ? "/api/positions" : `/api/positions/${encodeURIComponent(action.id!)}`, {
        method: action.type === "create" ? "POST" : action.type === "update" ? "PATCH" : "DELETE",
        headers: action.type === "delete" ? undefined : { "Content-Type": "application/json" },
        body: action.type === "delete" ? undefined : JSON.stringify(action.transaction),
      });
      if (!response.ok) {
        const result: unknown = await response.json();
        throw new Error(getErrorMessage(result, "Could not save transaction."));
      }
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["positions"] });
      setEntry(null);
      setActionEntry(null);
      setEditingId(null);
      setNotice("Transaction saved.");
    },
  });
  const accountMutation = useMutation({
    mutationFn: async (settings: Partial<Pick<PositionAccount, "lotMethod" | "baseCurrency" | "fxRates" | "cashBalance" | "expiryWarningDays" | "concentrationThreshold">>) => {
      const response = await fetch("/api/positions/account", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(settings),
      });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(getErrorMessage(result, "Could not update account settings."));
    },
    onSuccess: async () => {
      setFxRatesOverride(null);
      await queryClient.invalidateQueries({ queryKey: ["positions"] });
    },
  });
  const preferenceMutation = useMutation({
    mutationFn: async (preferences: PositionsPreferences) => {
      const response = await fetch("/api/positions/preferences", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(preferences),
      });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(getErrorMessage(result, "Could not save table preferences."));
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["positions"] }),
  });
  const snapshotMutation = useMutation({
    mutationFn: async () => {
      const response = await fetch("/api/positions/snapshot", { method: "POST" });
      const result: unknown = await response.json();
      if (!response.ok) throw new Error(getErrorMessage(result, "Could not capture the daily snapshot."));
    },
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ["positions"] });
      setNotice("End-of-day portfolio snapshot saved.");
    },
  });

  const valued = useMemo(() => folded.positions.map((position) => {
    const sourceRevision = tickVersion;
    const quoteSnapshot = quoteStore.get(position.assetClass === "option" ? position.underlying : position.symbol);
    const optionSnapshot = position.assetClass === "option" ? quoteStore.getOption(position.symbol) : undefined;
    const quote = quoteSnapshot?.quote;
    const option = optionSnapshot?.quote;
    const optionMark = option ? optionQuoteMark(option) : null;
    const mark = position.assetClass === "option" ? optionMark : quote ? quoteMark(quote) : null;
    const previousClose = position.assetClass === "future"
      ? quote?.prevSettle ?? quote?.prevClose ?? null
      : position.assetClass === "option"
        ? null
        : quote?.prevClose ?? null;
    let futureDaysToExpiry: number | null = null;
    if (position.assetClass === "future") {
      const asOf = new Date();
      const target = parseFuturesSymbol(position.symbol, asOf);
      const contract = buildFuturesContracts(getFuturesRoot(position.underlying), asOf, 24)
        .find((item) => item.monthCode === target.monthCode && item.year === target.year);
      futureDaysToExpiry = contract ? daysToExpiry(contract, asOf) : null;
    }
    let underlyingMark: number | null = null;
    if (position.assetClass === "option" && quote) underlyingMark = quoteMark(quote);
    const fxRate = position.currency === account?.baseCurrency ? 1 : (account?.fxRates[position.currency] ?? fxRates[position.currency] ?? 1);
    return {
      ...valuePosition(position, {
        mark,
        previousClose,
        underlyingMark,
        optionQuote: option,
        futureDaysToExpiry,
        fxRate,
      }),
      stale: position.assetClass === "option" ? (optionSnapshot?.stale ?? true) || (quoteSnapshot?.stale ?? true) : quoteSnapshot?.stale ?? true,
      connected: connection.state === "live",
      sourceRevision,
    };
  }), [account?.baseCurrency, account?.fxRates, folded.positions, fxRates, tickVersion, connection.state]);
  const openValued = useMemo(() => valued.filter((position) => position.quantity !== 0), [valued]);
  const portfolio = useMemo(() => {
    const marked = valued.filter((position) => position.baseMarketValue !== null);
    const absoluteValue = marked.reduce((total, position) => total + Math.abs(position.baseMarketValue!), 0);
    const longExposure = marked.reduce((total, position) => total + Math.max(0, position.baseMarketValue!), 0);
    const shortExposure = marked.reduce((total, position) => total + Math.min(0, position.baseMarketValue!), 0);
    const toBase = (position: ValuedPosition, amount: number | null) => amount === null
      ? null
      : amount * (position.currency === account?.baseCurrency ? 1 : fxRates[position.currency] ?? 1);
    return {
      totalMarketValue: marked.length === valued.length ? marked.reduce((total, position) => total + position.baseMarketValue!, 0) : null,
      cashAdjustedExposure: marked.length === valued.length
        ? marked.reduce((total, position) => total + position.baseMarketValue!, 0) + (account?.cashBalance ?? 0)
        : null,
      absoluteValue,
      longExposure,
      shortExposure,
      dayPnl: sumKnown(valued.map((position) => toBase(position, position.dayPnl))),
      unrealizedPnl: sumKnown(valued.map((position) => toBase(position, position.unrealizedPnl))),
      realizedPnl: valued.reduce((total, position) => total + (toBase(position, position.realizedPnl) ?? 0), 0),
      delta: sumKnown(valued.filter((position) => position.assetClass === "option").map((position) => position.delta)),
      gamma: sumKnown(valued.filter((position) => position.assetClass === "option").map((position) => position.gamma)),
      theta: sumKnown(valued.filter((position) => position.assetClass === "option").map((position) => toBase(position, position.theta))),
      vega: sumKnown(valued.filter((position) => position.assetClass === "option").map((position) => toBase(position, position.vega))),
      margin: valued.reduce((total, position) => total + (toBase(position, position.marginEstimate) ?? 0), 0),
    };
  }, [account?.baseCurrency, account?.cashBalance, fxRates, valued]);

  const warnings = useMemo(() => buildWarnings(openValued, portfolio.absoluteValue, account), [account, openValued, portfolio.absoluteValue]);
  const groupedRows = useMemo(() => {
    const sorted = [...openValued].sort((a, b) => {
      if (sortBy === "symbol") return a.symbol.localeCompare(b.symbol);
      return (b[sortBy] ?? Number.NEGATIVE_INFINITY) - (a[sortBy] ?? Number.NEGATIVE_INFINITY);
    });
    if (grouping === "flat") return [{ label: "", rows: sorted }];
    const groups = new Map<string, typeof sorted>();
    for (const position of sorted) {
      const label = grouping === "underlying" ? position.underlying : position.assetClass;
      groups.set(label, [...(groups.get(label) ?? []), position]);
    }
    return [...groups].map(([label, rows]) => ({ label, rows }));
  }, [grouping, openValued, sortBy]);

  const saveTransaction = (values: EntryValues) => {
    const parsed = transactionInputSchema.safeParse({
      ...values,
      executedAt: new Date(values.executedAt).toISOString(),
      symbol: values.symbol.trim(),
    });
    if (!parsed.success) {
      setNotice(parsed.error.issues.map((issue) => issue.message).join(" "));
      return;
    }
    writeMutation.mutate({
      type: editingId ? "update" : "create",
      id: editingId ?? undefined,
      transaction: parsed.data,
    });
  };

  const saveAction = (values: ActionValues) => {
    const common = {
      accountId: values.accountId,
      symbol: values.symbol.trim(),
      assetClass: "equity" as const,
      executedAt: new Date(values.executedAt).toISOString(),
      notes: values.notes,
    };
    const input = values.kind === "split"
      ? { ...common, kind: "split" as const, ratioNumerator: values.ratioNumerator, ratioDenominator: values.ratioDenominator }
      : { ...common, kind: "dividend" as const, amountPerShare: values.amountPerShare, currency: values.currency };
    const parsed = transactionInputSchema.safeParse(input);
    if (!parsed.success) {
      setNotice(parsed.error.issues.map((issue) => issue.message).join(" "));
      return;
    }
    writeMutation.mutate({
      type: editingId ? "update" : "create",
      id: editingId ?? undefined,
      transaction: parsed.data,
    });
  };

  const startEdit = (transaction: PositionTransaction) => {
    setEditingId(transaction.id);
    if (transaction.kind === "trade") {
      setActionEntry(null);
      setEntry({ ...transaction, executedAt: new Date(transaction.executedAt).toISOString().slice(0, 16) });
    } else if (transaction.kind === "split") {
      setEntry(null);
      setActionEntry({
        kind: "split", accountId: transaction.accountId, symbol: transaction.symbol,
        executedAt: new Date(transaction.executedAt).toISOString().slice(0, 16), notes: transaction.notes,
        ratioNumerator: transaction.ratioNumerator, ratioDenominator: transaction.ratioDenominator,
        amountPerShare: 0, currency: "USD",
      });
    } else if (transaction.kind === "dividend") {
      setEntry(null);
      setActionEntry({
        kind: "dividend", accountId: transaction.accountId, symbol: transaction.symbol,
        executedAt: new Date(transaction.executedAt).toISOString().slice(0, 16), notes: transaction.notes,
        ratioNumerator: 2, ratioDenominator: 1, amountPerShare: transaction.amountPerShare, currency: transaction.currency,
      });
    } else {
      setNotice("Use the position row to edit an option-outcome status.");
      setEditingId(null);
      return;
    }
    setView("transactions");
  };

  const closePosition = (position: ValuedPosition) => {
    if (!account) return;
    setEditingId(null);
    setActionEntry(null);
    setEntry({
      ...defaultEntry(account.id),
      symbol: position.symbol,
      assetClass: position.assetClass,
      side: position.quantity > 0 ? "sell" : "buy",
      quantity: Math.abs(position.quantity),
      price: position.mark ?? position.averageCost,
      currency: position.currency,
      executedAt: new Date().toISOString().slice(0, 16),
    });
    setView("transactions");
  };

  const exportRows = view === "transactions"
    ? transactions.map((item) => ({
        symbol: item.symbol,
        assetClass: item.assetClass,
        kind: item.kind,
        side: item.kind === "trade" ? item.side : "",
        quantity: item.kind === "trade" ? item.quantity : "",
        price: item.kind === "trade" ? item.price : "",
        fees: item.kind === "trade" ? item.fees : "",
        currency: item.kind === "trade" || item.kind === "dividend" ? item.currency : "",
        executedAt: item.executedAt,
        notes: item.notes,
      }))
    : openValued.map((position) => ({
        symbol: position.symbol,
        assetClass: position.assetClass,
        quantity: position.quantity,
        averageCost: position.averageCost,
        mark: position.mark,
        marketValue: position.marketValue,
        dayPnl: position.dayPnl,
        unrealizedPnl: position.unrealizedPnl,
        realizedPnl: position.realizedPnl,
        currency: position.currency,
      }));

  if (query.isPending) return <div className="p-8 text-sm text-slate-400">Loading positions…</div>;
  if (query.isError) return <div className="p-8 text-sm text-rose-300">Could not load positions: {query.error.message}</div>;
  if (!data || !account) return null;

  const realizedPerformance = folded.realizedEvents.reduce<Array<{ date: string; realized: number }>>((result, event) => {
    const last = result[result.length - 1];
    const realized = (last?.realized ?? 0) + event.amount;
    result.push({ date: new Date(event.executedAt).toLocaleDateString(), realized });
    return result;
  }, []);
  const bySymbol = [...valued].map((position) => ({ symbol: position.symbol, pnl: position.totalPnl }))
    .sort((a, b) => b.pnl - a.pnl);
  const completed = folded.realizedEvents.map((event) => event.amount);
  const wins = completed.filter((amount) => amount > 0);
  const losses = completed.filter((amount) => amount < 0);
  const assetAllocation = summarize(openValued, (position) => position.assetClass);
  const underlyingAllocation = summarize(openValued, (position) => position.underlying);
  const deltaByUnderlying = summarize(openValued, (position) => position.underlying, "deltaAdjustedNotional");

  return (
    <main className="mx-auto min-h-[calc(100vh-104px)] max-w-[1600px] px-5 py-6">
      <div className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-slate-500">Portfolio · {account.name}</p>
          <h1 className="text-xl font-medium text-slate-100">{initialView === "alerts" ? "Alerts" : "Positions & P&L"}</h1>
          <p className="mt-1 text-xs text-slate-500">Transaction-sourced ledger · {account.lotMethod.toUpperCase()} lots · amounts in {account.baseCurrency}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className={cn("rounded border px-2 py-1 text-[10px]", connection.state === "live" ? "border-emerald-500/30 text-emerald-300" : "border-amber-500/30 text-amber-300")}>
            {connection.state === "live" ? "STREAM LIVE" : connection.state.toUpperCase()}
          </span>
          <button className="terminal-button" onClick={() => downloadCsv(exportRows, view === "transactions" ? "transactions.csv" : "positions.csv")}>Export CSV</button>
          <label className="terminal-button cursor-pointer">
            Import CSV
            <input type="file" accept=".csv,text/csv" className="hidden" onChange={(event) => void loadImport(event.currentTarget.files?.[0], account.id, transactions, setImportFile, setNotice)} />
          </label>
          <button className="terminal-button" onClick={() => {
            setEditingId(null);
            setEntry(null);
            setActionEntry({ kind: "split", accountId: account.id, symbol: "", executedAt: new Date().toISOString().slice(0, 16), notes: "", ratioNumerator: 2, ratioDenominator: 1, amountPerShare: 0, currency: "USD" });
            setView("transactions");
          }}>Corporate action</button>
          <button className="terminal-button terminal-button-primary" onClick={() => { setEditingId(null); setActionEntry(null); setEntry(defaultEntry(account.id)); setView("transactions"); }}>New transaction</button>
        </div>
      </div>

      {notice && <div role="status" className="mb-4 flex justify-between rounded border border-slate-700 bg-slate-900 px-3 py-2 text-xs text-slate-300">{notice}<button onClick={() => setNotice("")}>Dismiss</button></div>}
      {writeMutation.isError && <div role="alert" className="mb-4 rounded border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">{writeMutation.error.message}</div>}
      {accountMutation.isError && <div role="alert" className="mb-4 rounded border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">{accountMutation.error.message}</div>}
      {snapshotMutation.isError && <div role="alert" className="mb-4 rounded border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">{snapshotMutation.error.message}</div>}
      {preferenceMutation.isError && <div role="alert" className="mb-4 rounded border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">{preferenceMutation.error.message}</div>}

      <section className="mb-4 flex flex-wrap items-center gap-3 rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-2">
        <span className="text-[10px] uppercase tracking-wider text-slate-500">Account settings</span>
        <label className="flex items-center gap-2 text-[10px] text-slate-400">Lot method<select className="terminal-input py-1" value={account.lotMethod} disabled={accountMutation.isPending}
          onChange={(event) => accountMutation.mutate({ lotMethod: event.target.value as PositionAccount["lotMethod"] })}>
          <option value="fifo">FIFO</option><option value="lifo">LIFO</option><option value="average">Average cost</option>
        </select></label>
        <label className="flex items-center gap-2 text-[10px] text-slate-400">Base currency<input key={account.baseCurrency} className="terminal-input w-16 py-1 uppercase" maxLength={3} defaultValue={account.baseCurrency} disabled={accountMutation.isPending}
          onBlur={(event) => {
            const baseCurrency = event.currentTarget.value.trim().toUpperCase();
            if (baseCurrency.length === 3 && baseCurrency !== account.baseCurrency) accountMutation.mutate({ baseCurrency });
          }} /></label>
        <label className="flex items-center gap-2 text-[10px] text-slate-400">Cash balance<input key={account.cashBalance} className="terminal-input w-24 py-1" type="number" step="0.01" defaultValue={account.cashBalance} disabled={accountMutation.isPending}
          onBlur={(event) => {
            const cashBalance = Number(event.currentTarget.value);
            if (Number.isFinite(cashBalance) && cashBalance !== account.cashBalance) accountMutation.mutate({ cashBalance });
          }} /></label>
        <label className="flex items-center gap-2 text-[10px] text-slate-400">Expiry warning<input key={account.expiryWarningDays} className="terminal-input w-14 py-1" type="number" min="0" max="365" defaultValue={account.expiryWarningDays} disabled={accountMutation.isPending}
          onBlur={(event) => {
            const expiryWarningDays = Number(event.currentTarget.value);
            if (Number.isInteger(expiryWarningDays) && expiryWarningDays !== account.expiryWarningDays) accountMutation.mutate({ expiryWarningDays });
          }} /></label>
        <label className="flex items-center gap-2 text-[10px] text-slate-400">Concentration %<input key={account.concentrationThreshold} className="terminal-input w-16 py-1" type="number" min="1" max="100" defaultValue={account.concentrationThreshold * 100} disabled={accountMutation.isPending}
          onBlur={(event) => {
            const concentrationThreshold = Number(event.currentTarget.value) / 100;
            if (concentrationThreshold > 0 && concentrationThreshold <= 1 && concentrationThreshold !== account.concentrationThreshold) accountMutation.mutate({ concentrationThreshold });
          }} /></label>
      </section>

      <section className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-5">
        <Metric label="Total market value" value={money(portfolio.totalMarketValue, account.baseCurrency)} />
        <Metric label="Cash-adjusted exposure" value={money(portfolio.cashAdjustedExposure, account.baseCurrency)} />
        <Metric label="Day P&L" value={money(portfolio.dayPnl, account.baseCurrency)} tone={portfolio.dayPnl} />
        <Metric label="Unrealized P&L" value={money(portfolio.unrealizedPnl, account.baseCurrency)} tone={portfolio.unrealizedPnl} />
        <Metric label="Realized P&L" value={money(portfolio.realizedPnl, account.baseCurrency)} tone={portfolio.realizedPnl} />
        <Metric label="Net delta" value={formatNumber(portfolio.delta)} />
        <Metric label="Net gamma" value={formatNumber(portfolio.gamma)} />
        <Metric label="Theta / day" value={money(portfolio.theta, account.baseCurrency)} tone={portfolio.theta} />
        <Metric label="Net vega" value={money(portfolio.vega, account.baseCurrency)} tone={portfolio.vega} />
        <Metric label="Margin estimate" value={`${money(portfolio.margin, account.baseCurrency)} est.`} />
      </section>

      {openValued.some((position) => position.currency !== account.baseCurrency) && (
        <section className="mb-5 flex flex-wrap items-center gap-3 rounded-lg border border-amber-500/20 bg-amber-500/[0.04] px-3 py-2">
          <span className="text-[11px] text-amber-200">Approximate FX conversion</span>
          {[...new Set(openValued.map((position) => position.currency).filter((currency) => currency !== account.baseCurrency))].map((currency) => (
            <label key={currency} className="flex items-center gap-2 text-[11px] text-slate-400">
              {currency} → {account.baseCurrency}
              <input aria-label={`${currency} exchange rate`} type="number" min="0.000001" step="0.0001" value={fxRates[currency] ?? 1} className="terminal-input w-24"
                onChange={(event) => {
                  const next = { ...fxRates, [currency]: Number(event.target.value) };
                  setFxRatesOverride(next);
                }} onBlur={() => accountMutation.mutate({ fxRates })} />
            </label>
          ))}
        </section>
      )}

      <nav className="mb-4 flex border-b border-[var(--border)]">
        {(["positions", "transactions", "performance"] as const).map((tab) => (
          <button key={tab} className={cn("border-b-2 px-4 py-2 text-xs capitalize", view === tab ? "border-emerald-400 text-slate-100" : "border-transparent text-slate-500")}
            onClick={() => setView(tab)}>{tab}</button>
        ))}
        <Link className="ml-auto self-center text-xs text-slate-500 hover:text-slate-200" href="/alerts">Alerts ({warnings.length})</Link>
      </nav>

      {view === "positions" && (
        <>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-2">
              <label className="text-[11px] text-slate-500">Group</label>
              <select className="terminal-input py-1" value={grouping} onChange={(event) => setGrouping(event.target.value as Grouping)}>
                <option value="flat">Flat</option><option value="underlying">By underlying</option><option value="assetClass">By asset class</option>
              </select>
              <label className="ml-2 text-[11px] text-slate-500">Sort</label>
              <select className="terminal-input py-1" value={sortBy} onChange={(event) => {
                const nextSort = event.target.value as typeof sortBy;
                setPreferencesOverride({ columns, sortBy: nextSort });
                preferenceMutation.mutate({ columns, sortBy: nextSort });
              }}>
                <option value="symbol">Symbol</option><option value="marketValue">Market value</option><option value="dayPnl">Day P&L</option><option value="unrealizedPnl">Unrealized P&L</option>
              </select>
            </div>
            <div className="relative">
              <button className="terminal-button" onClick={() => setColumnsOpen((open) => !open)}>Columns</button>
              {columnsOpen && <div className="absolute right-0 z-20 mt-1 w-48 rounded border border-slate-700 bg-slate-950 p-2 shadow-xl">
                {Object.entries(columnLabels).map(([key, label]) => (
                  <label key={key} className="flex items-center gap-2 px-2 py-1 text-[11px] text-slate-300">
                    <input type="checkbox" checked={columns.includes(key as PositionColumn)} onChange={(event) => {
                      const next = event.target.checked ? [...columns, key as PositionColumn] : columns.filter((column) => column !== key);
                      if (next.length === 0) return;
                      setPreferencesOverride({ columns: next, sortBy });
                      preferenceMutation.mutate({ columns: next, sortBy });
                    }} />{label}
                  </label>
                ))}
              </div>}
            </div>
          </div>
          <div className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--panel)]">
            <table className="w-full min-w-[980px] border-collapse text-left">
              <thead><tr className="border-b border-[var(--border)] text-[10px] uppercase tracking-wider text-slate-500">
                {columns.map((column) => <th key={column} className={cn("px-3 py-2.5 font-medium", column !== "symbol" && "text-right")}>{columnLabels[column]}</th>)}
                <th className="px-3 py-2.5 text-right font-medium">Actions</th>
              </tr></thead>
              <tbody>
                {groupedRows.flatMap((group) => [
                  ...(group.label ? [<tr key={`group-${group.label}`} className="bg-white/[0.025]"><th colSpan={columns.length + 1} className="px-3 py-2 text-left text-[10px] uppercase tracking-wider text-slate-400">{group.label}</th></tr>] : []),
                  ...group.rows.map((position) => <PositionRow key={`${position.assetClass}:${position.symbol}`} position={position} columns={columns} portfolioValue={portfolio.absoluteValue}
                    onClose={() => closePosition(position)} onEditDisposition={(disposition) => {
                      const payload = {
                        kind: "option-outcome" as const,
                        accountId: position.accountId,
                        symbol: position.symbol,
                        assetClass: "option" as const,
                        executedAt: new Date().toISOString(),
                        disposition,
                        notes: "Option outcome updated",
                      };
                      writeMutation.mutate({ type: "create", transaction: payload });
                    }} />),
                ])}
                {openValued.length === 0 && <tr><td colSpan={columns.length + 1} className="px-4 py-10 text-center text-xs text-slate-500">No open positions yet. Add a trade or import a CSV to start your ledger.</td></tr>}
              </tbody>
            </table>
          </div>
          <div className="mt-5 grid gap-4 lg:grid-cols-3">
            <AllocationChart title="Allocation by asset class" rows={assetAllocation} />
            <AllocationChart title="Allocation by underlying" rows={underlyingAllocation} />
            <AllocationChart title="Delta-adjusted notional by underlying" rows={deltaByUnderlying} />
          </div>
          <div className="mt-5 grid gap-4 lg:grid-cols-2">
            <ExposureSummary label="Net long exposure" value={money(portfolio.longExposure, account.baseCurrency)} />
            <ExposureSummary label="Net short exposure" value={money(portfolio.shortExposure, account.baseCurrency)} />
          </div>
        </>
      )}

      {view === "transactions" && (
        <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_380px]">
          <section className="overflow-x-auto rounded-lg border border-[var(--border)] bg-[var(--panel)]">
            <table className="w-full min-w-[760px] text-left">
              <thead><tr className="border-b border-[var(--border)] text-[10px] uppercase tracking-wider text-slate-500">
                {["Executed", "Symbol", "Type", "Side / Action", "Quantity", "Price / Value", "Fees", "Actions"].map((label) => <th key={label} className="px-3 py-2.5 font-medium">{label}</th>)}
              </tr></thead>
              <tbody>{[...transactions].reverse().map((transaction) => <TransactionRow key={transaction.id} transaction={transaction} onEdit={() => startEdit(transaction)}
                onDelete={() => writeMutation.mutate({ type: "delete", id: transaction.id })} />)}
                {transactions.length === 0 && <tr><td colSpan={8} className="px-4 py-10 text-center text-xs text-slate-500">No transactions yet.</td></tr>}
              </tbody>
            </table>
          </section>
          <div className="space-y-4">
            {entry && <TransactionForm entry={entry} searchQuery={searchQuery} searchResults={searchResults} searchError={searchError} busy={writeMutation.isPending}
              onChange={setEntry} onSearch={(value) => {
                setSearchQuery(value);
                if (!value.trim()) {
                  setSearchResults([]);
                  setSearchError("");
                }
              }} onSelectInstrument={(instrument) => {
                const assetClass = instrument.secType === "FUT" ? "future" : "equity";
                setEntry((current) => current ? { ...current, symbol: instrument.localSymbol ?? instrument.symbol, assetClass, currency: instrument.currency } : null);
                setSearchQuery("");
              }} onSubmit={saveTransaction} onCancel={() => { setEntry(null); setEditingId(null); }} editing={Boolean(editingId)} />}
            {actionEntry && <CorporateActionForm entry={actionEntry} busy={writeMutation.isPending} editing={Boolean(editingId)}
              onChange={setActionEntry} onSubmit={saveAction} onCancel={() => { setActionEntry(null); setEditingId(null); }} />}
            <AuditTrail events={data.audit} />
          </div>
        </div>
      )}

      {view === "performance" && (
        <div className="space-y-4">
          <div className="flex justify-end">
            <button className="terminal-button" disabled={snapshotMutation.isPending} onClick={() => snapshotMutation.mutate()}>
              {snapshotMutation.isPending ? "Capturing…" : "Capture EOD snapshot"}
            </button>
          </div>
          <section className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <Metric label="Win rate" value={completed.length ? `${(wins.length / completed.length * 100).toFixed(1)}%` : "—"} />
            <Metric label="Average win" value={wins.length ? money(wins.reduce((a, b) => a + b, 0) / wins.length, account.baseCurrency) : "—"} tone={wins.length ? 1 : undefined} />
            <Metric label="Average loss" value={losses.length ? money(losses.reduce((a, b) => a + b, 0) / losses.length, account.baseCurrency) : "—"} tone={losses.length ? -1 : undefined} />
            <Metric label="Closed trade events" value={String(completed.length)} />
          </section>
          <div className="grid gap-4 xl:grid-cols-2">
            <ChartPanel title="Cumulative realized P&L">
              <ResponsiveContainer width="100%" height="100%"><LineChart data={realizedPerformance}><CartesianGrid stroke="#202832" strokeDasharray="3 3" /><XAxis dataKey="date" tick={{ fill: "#718096", fontSize: 10 }} /><YAxis tick={{ fill: "#718096", fontSize: 10 }} /><Tooltip contentStyle={tooltipStyle} /><Line type="monotone" dataKey="realized" stroke="#42c88a" dot={false} /></LineChart></ResponsiveContainer>
            </ChartPanel>
            <ChartPanel title="P&L by symbol">
              <ResponsiveContainer width="100%" height="100%"><BarChart data={bySymbol}><CartesianGrid stroke="#202832" strokeDasharray="3 3" /><XAxis dataKey="symbol" tick={{ fill: "#718096", fontSize: 10 }} /><YAxis tick={{ fill: "#718096", fontSize: 10 }} /><Tooltip contentStyle={tooltipStyle} /><Bar dataKey="pnl" fill="#42c88a" /></BarChart></ResponsiveContainer>
            </ChartPanel>
          </div>
          <ChartPanel title="Daily portfolio value (end-of-day snapshots)">
            <ResponsiveContainer width="100%" height="100%"><LineChart data={data.snapshots}>
              <CartesianGrid stroke="#202832" strokeDasharray="3 3" />
              <XAxis dataKey="snapshotDate" tick={{ fill: "#718096", fontSize: 10 }} />
              <YAxis tick={{ fill: "#718096", fontSize: 10 }} />
              <Tooltip contentStyle={tooltipStyle} />
              <Line type="monotone" dataKey="marketValue" stroke="#60a5fa" dot={false} />
            </LineChart></ResponsiveContainer>
          </ChartPanel>
          <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
            <h2 className="mb-3 text-xs font-medium text-slate-200">Largest winners and losers</h2>
            <div className="grid gap-4 sm:grid-cols-2">
              <div><p className="mb-2 text-[10px] uppercase text-emerald-300">Winners</p>{[...bySymbol].filter((item) => item.pnl > 0).slice(0, 5).map((item) => <p key={item.symbol} className="flex justify-between py-1 text-xs"><span>{item.symbol}</span><span className="text-emerald-300">{money(item.pnl, account.baseCurrency)}</span></p>)}</div>
              <div><p className="mb-2 text-[10px] uppercase text-rose-300">Losers</p>{[...bySymbol].filter((item) => item.pnl < 0).reverse().slice(0, 5).map((item) => <p key={item.symbol} className="flex justify-between py-1 text-xs"><span>{item.symbol}</span><span className="text-rose-300">{money(item.pnl, account.baseCurrency)}</span></p>)}</div>
            </div>
          </section>
          <p className="text-[10px] text-slate-600">Schedule POST /api/positions/snapshot after the trading session to persist one end-of-day portfolio snapshot per day. This is a manual capture for the current session.</p>
        </div>
      )}

      {view === "alerts" && <AlertsPanel warnings={warnings} />}

      {importFile && <ImportDialog value={importFile} dryRun={dryRun} busy={writeMutation.isPending}
        onDryRun={setDryRun} onChange={setImportFile} onClose={() => setImportFile(null)}
        onImport={(rows) => {
          for (const transaction of rows) writeMutation.mutate({ type: "create", transaction });
          setImportFile(null);
          setNotice(`Import submitted for ${rows.length} row(s).`);
        }} />}
    </main>
  );
}

function PositionRow({ position, columns, portfolioValue, onClose, onEditDisposition }: {
  position: ValuedPosition & { stale: boolean; connected: boolean; sourceRevision: number };
  columns: PositionColumn[];
  portfolioValue: number;
  onClose: () => void;
  onEditDisposition: (disposition: "active" | "expired" | "assigned" | "exercised") => void;
}) {
  const marketSymbol = position.assetClass === "option" ? position.underlying : position.symbol;
  const market = useQuote(marketSymbol);
  const optionSnapshot = useOptionQuote(position.assetClass === "option" ? position.symbol : "__not-an-option__");
  const rowRef = useRef<HTMLTableRowElement>(null);
  const flash = position.assetClass === "option" ? optionSnapshot?.flash : market?.flash;
  const revision = position.assetClass === "option" ? optionSnapshot?.revision : market?.revision;
  useEffect(() => {
    if (!flash || !rowRef.current || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const animation = rowRef.current.animate([
      { backgroundColor: flash === "up" ? "rgb(52 211 153 / 15%)" : "rgb(251 113 133 / 15%)" },
      { backgroundColor: "transparent" },
    ], { duration: 400, easing: "ease-out" });
    return () => animation.cancel();
  }, [flash, revision]);
  const markMissing = position.mark === null || (position.assetClass === "option" && !optionSnapshot);
  const cell = (column: PositionColumn) => {
    switch (column) {
      case "symbol": return <td key={column} className="px-3 py-3"><div className="font-medium text-slate-200">{position.symbol}</div><div className="mt-1 flex items-center gap-1.5 text-[9px] text-slate-500"><span>{position.underlying}</span>{position.stale && <span className="text-amber-300">STALE</span>}{!position.connected && <span className="text-rose-300">DISCONNECTED</span>}</div></td>;
      case "assetClass": return <td key={column} className="px-3 py-3 text-right text-[10px] uppercase text-slate-500">{position.assetClass}{position.assetClass === "option" && <select aria-label={`${position.symbol} disposition`} value={position.disposition ?? "active"} className="ml-1 bg-transparent text-[9px]" onChange={(event) => onEditDisposition(event.target.value as "active" | "expired" | "assigned" | "exercised")}><option value="active">Active</option><option value="expired">Expired</option><option value="assigned">Assigned</option><option value="exercised">Exercised</option></select>}</td>;
      case "quantity": return <td key={column} className="px-3 py-3 text-right font-mono">{formatNumber(position.quantity)}</td>;
      case "averageCost": return <td key={column} className="px-3 py-3 text-right font-mono text-slate-400">{money(position.averageCost, position.currency)}</td>;
      case "mark": return <td key={column} className="px-3 py-3 text-right font-mono">{position.mark === null || markMissing ? "—" : money(position.mark, position.currency)}</td>;
      case "marketValue": return <td key={column} className="px-3 py-3 text-right font-mono">{position.marketValue === null ? "—" : money(position.marketValue, position.currency)}</td>;
      case "dayPnl": return <td key={column} className={cn("px-3 py-3 text-right font-mono", toneClass(position.dayPnl))}>{position.dayPnl === null ? "—" : money(position.dayPnl, position.currency)}</td>;
      case "unrealizedPnl": return <td key={column} className={cn("px-3 py-3 text-right font-mono", toneClass(position.unrealizedPnl))}>{position.unrealizedPnl === null ? "—" : <>{money(position.unrealizedPnl, position.currency)} <small className="text-slate-500">{position.unrealizedPercent?.toFixed(1)}%</small></>}</td>;
      case "delta": return <td key={column} className="px-3 py-3 text-right font-mono">{position.delta === null ? "—" : formatNumber(position.delta)}</td>;
      case "portfolioWeight": return <td key={column} className="px-3 py-3 text-right font-mono">{position.baseMarketValue === null || portfolioValue === 0 ? "—" : `${(Math.abs(position.baseMarketValue) / portfolioValue * 100).toFixed(1)}%`}</td>;
      case "daysToExpiry": return <td key={column} className="px-3 py-3 text-right font-mono">{position.daysToExpiry === null ? "—" : position.daysToExpiry}</td>;
    }
  };
  return (
    <tr ref={rowRef} data-tick-revision={position.sourceRevision} className="border-b border-[var(--border)]/70 hover:bg-white/[0.025]">
      {columns.map(cell)}
      <td className="px-3 py-3 text-right whitespace-nowrap">
        <Link href={`/chart/${encodeURIComponent(position.underlying)}`} className="mr-2 text-[10px] text-slate-500 hover:text-slate-200">Chart</Link>
        {position.assetClass === "option" && <Link href={`/options/${encodeURIComponent(position.underlying)}`} className="mr-2 text-[10px] text-slate-500 hover:text-slate-200">Chain</Link>}
        <button className="text-[10px] text-emerald-300 hover:text-emerald-200" onClick={onClose}>Close</button>
      </td>
    </tr>
  );
}

function TransactionRow({ transaction, onEdit, onDelete }: { transaction: PositionTransaction; onEdit: () => void; onDelete: () => void }) {
  const action = transaction.kind === "trade"
    ? transaction.side
    : transaction.kind === "split" ? "split" : transaction.kind === "dividend" ? "dividend" : transaction.disposition;
  const quantity = transaction.kind === "trade" ? transaction.quantity : transaction.kind === "split" ? `${transaction.ratioNumerator}:${transaction.ratioDenominator}` : "—";
  const price = transaction.kind === "trade" ? money(transaction.price, transaction.currency) : transaction.kind === "dividend" ? money(transaction.amountPerShare, transaction.currency) : "—";
  return <tr className="border-b border-[var(--border)]/70 text-xs">
    <td className="px-3 py-2.5 text-slate-400">{new Date(transaction.executedAt).toLocaleString()}</td>
    <td className="px-3 py-2.5 font-medium">{transaction.symbol}</td>
    <td className="px-3 py-2.5 uppercase text-slate-500">{transaction.assetClass}</td>
    <td className="px-3 py-2.5 capitalize">{action}</td>
    <td className="px-3 py-2.5 font-mono">{quantity}</td>
    <td className="px-3 py-2.5 font-mono">{price}</td>
    <td className="px-3 py-2.5 font-mono">{transaction.kind === "trade" ? money(transaction.fees, transaction.currency) : "—"}</td>
    <td className="px-3 py-2.5 text-right"><button onClick={onEdit} className="mr-2 text-slate-400 hover:text-white">Edit</button><button onClick={onDelete} className="text-rose-300 hover:text-rose-200">Delete</button></td>
  </tr>;
}

function TransactionForm({ entry, searchQuery, searchResults, searchError, busy, onChange, onSearch, onSelectInstrument, onSubmit, onCancel, editing }: {
  entry: EntryValues;
  searchQuery: string;
  searchResults: InstrumentSearchResult[];
  searchError: string;
  busy: boolean;
  onChange: (entry: EntryValues) => void;
  onSearch: (query: string) => void;
  onSelectInstrument: (instrument: InstrumentSearchResult) => void;
  onSubmit: (entry: EntryValues) => void;
  onCancel: () => void;
  editing: boolean;
}) {
  const update = (changes: Partial<EntryValues>) => onChange({ ...entry, ...changes });
  return <form className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4" onSubmit={(event) => { event.preventDefault(); onSubmit(entry); }}>
    <div className="mb-3 flex items-center justify-between"><h2 className="text-sm font-medium">{editing ? "Edit transaction" : "Add transaction"}</h2><button type="button" className="text-slate-500" onClick={onCancel}>×</button></div>
    <label className="mb-3 block text-[10px] text-slate-500">Search instrument<input value={searchQuery} onChange={(event) => onSearch(event.target.value)} className="terminal-input mt-1 w-full" placeholder="Search equity or futures" /></label>
    {searchError && <p className="mb-2 text-[10px] text-rose-300">{searchError}</p>}
    {searchResults.length > 0 && <div className="mb-3 max-h-36 overflow-auto rounded border border-slate-700">{searchResults.map((instrument) => <button type="button" key={`${instrument.conId}-${instrument.symbol}-${instrument.exchange}`} onClick={() => onSelectInstrument(instrument)} className="flex w-full justify-between px-2 py-2 text-left text-[10px] hover:bg-white/5"><span>{instrument.symbol} · {instrument.name}</span><span className="text-slate-500">{instrument.secType} · {instrument.currency}</span></button>)}</div>}
    <label className="mb-3 block text-[10px] text-slate-500">Symbol<input required value={entry.symbol} onChange={(event) => {
      const symbol = event.target.value.toUpperCase();
      let assetClass = entry.assetClass;
      try { assetClass = inferAssetClass(symbol); } catch { /* The schema reports invalid contract symbols on submit. */ }
      update({ symbol, assetClass });
    }} className="terminal-input mt-1 w-full" placeholder="AAPL, ESZ6, or OCC symbol" /></label>
    <div className="mb-3 grid grid-cols-2 gap-2">
      <label className="text-[10px] text-slate-500">Asset class<select value={entry.assetClass} onChange={(event) => update({ assetClass: event.target.value as EntryValues["assetClass"] })} className="terminal-input mt-1 w-full"><option value="equity">Equity</option><option value="option">Option</option><option value="future">Future</option></select></label>
      <label className="text-[10px] text-slate-500">Side<select value={entry.side} onChange={(event) => update({ side: event.target.value as EntryValues["side"] })} className="terminal-input mt-1 w-full"><option value="buy">Buy</option><option value="sell">Sell</option></select></label>
    </div>
    <div className="mb-3 grid grid-cols-2 gap-2">
      <label className="text-[10px] text-slate-500">Quantity<input required type="number" min="0.00000001" step="any" value={entry.quantity} onChange={(event) => update({ quantity: Number(event.target.value) })} className="terminal-input mt-1 w-full" /></label>
      <label className="text-[10px] text-slate-500">Price<input required type="number" min="0" step="any" value={entry.price} onChange={(event) => update({ price: Number(event.target.value) })} className="terminal-input mt-1 w-full" /></label>
      <label className="text-[10px] text-slate-500">Fees<input type="number" min="0" step="any" value={entry.fees} onChange={(event) => update({ fees: Number(event.target.value) })} className="terminal-input mt-1 w-full" /></label>
      <label className="text-[10px] text-slate-500">Currency<input required maxLength={3} value={entry.currency} onChange={(event) => update({ currency: event.target.value.toUpperCase() })} className="terminal-input mt-1 w-full" /></label>
    </div>
    <label className="mb-3 block text-[10px] text-slate-500">Execution time<input required type="datetime-local" value={entry.executedAt} onChange={(event) => update({ executedAt: event.target.value })} className="terminal-input mt-1 w-full" /></label>
    <label className="mb-4 block text-[10px] text-slate-500">Notes<textarea maxLength={2_000} value={entry.notes} onChange={(event) => update({ notes: event.target.value })} className="terminal-input mt-1 min-h-16 w-full" /></label>
    <div className="flex justify-end gap-2"><button type="button" className="terminal-button" onClick={onCancel}>Cancel</button><button disabled={busy} className="terminal-button terminal-button-primary">{busy ? "Saving…" : editing ? "Save changes" : "Add transaction"}</button></div>
  </form>;
}

function CorporateActionForm({ entry, busy, editing, onChange, onSubmit, onCancel }: {
  entry: ActionValues;
  busy: boolean;
  editing: boolean;
  onChange: (entry: ActionValues) => void;
  onSubmit: (entry: ActionValues) => void;
  onCancel: () => void;
}) {
  const update = (changes: Partial<ActionValues>) => onChange({ ...entry, ...changes });
  return <form className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4" onSubmit={(event) => { event.preventDefault(); onSubmit(entry); }}>
    <h2 className="mb-3 text-sm font-medium">{editing ? "Edit corporate action" : "Add corporate action"}</h2>
    <label className="mb-3 block text-[10px] text-slate-500">Action<select className="terminal-input mt-1 w-full" value={entry.kind} onChange={(event) => update({ kind: event.target.value as ActionValues["kind"] })}><option value="split">Stock split</option><option value="dividend">Cash dividend</option></select></label>
    <label className="mb-3 block text-[10px] text-slate-500">Equity symbol<input required className="terminal-input mt-1 w-full" value={entry.symbol} onChange={(event) => update({ symbol: event.target.value.toUpperCase() })} /></label>
    {entry.kind === "split"
      ? <div className="mb-3 grid grid-cols-2 gap-2">
        <label className="text-[10px] text-slate-500">New shares<input className="terminal-input mt-1 w-full" type="number" min="0.000001" step="any" value={entry.ratioNumerator} onChange={(event) => update({ ratioNumerator: Number(event.target.value) })} /></label>
        <label className="text-[10px] text-slate-500">Old shares<input className="terminal-input mt-1 w-full" type="number" min="0.000001" step="any" value={entry.ratioDenominator} onChange={(event) => update({ ratioDenominator: Number(event.target.value) })} /></label>
      </div>
      : <div className="mb-3 grid grid-cols-2 gap-2">
        <label className="text-[10px] text-slate-500">Amount / share<input className="terminal-input mt-1 w-full" type="number" step="any" value={entry.amountPerShare} onChange={(event) => update({ amountPerShare: Number(event.target.value) })} /></label>
        <label className="text-[10px] text-slate-500">Currency<input className="terminal-input mt-1 w-full" maxLength={3} value={entry.currency} onChange={(event) => update({ currency: event.target.value.toUpperCase() })} /></label>
      </div>}
    <label className="mb-3 block text-[10px] text-slate-500">Effective time<input required className="terminal-input mt-1 w-full" type="datetime-local" value={entry.executedAt} onChange={(event) => update({ executedAt: event.target.value })} /></label>
    <label className="mb-4 block text-[10px] text-slate-500">Notes<textarea className="terminal-input mt-1 min-h-16 w-full" maxLength={2_000} value={entry.notes} onChange={(event) => update({ notes: event.target.value })} /></label>
    <div className="flex justify-end gap-2"><button type="button" className="terminal-button" onClick={onCancel}>Cancel</button><button disabled={busy} className="terminal-button terminal-button-primary">{busy ? "Saving…" : editing ? "Save changes" : "Add action"}</button></div>
  </form>;
}

function ImportDialog({ value, dryRun, busy, onDryRun, onChange, onClose, onImport }: {
  value: NonNullable<PositionsDashboardState["importFile"]>;
  dryRun: boolean;
  busy: boolean;
  onDryRun: (dryRun: boolean) => void;
  onChange: (value: NonNullable<PositionsDashboardState["importFile"]>) => void;
  onClose: () => void;
  onImport: (rows: PositionTransactionInput[]) => void;
}) {
  const duplicateCount = value.rowErrors.filter((error) => error.includes("Duplicate")).length;
  return <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4">
    <section role="dialog" aria-modal="true" aria-label="Import transactions" className="max-h-[90vh] w-full max-w-5xl overflow-auto rounded-lg border border-slate-700 bg-[#11151b] p-5">
      <div className="mb-4 flex items-center justify-between"><h2 className="text-base font-medium">Import transactions from CSV</h2><button onClick={onClose}>Close</button></div>
      <p className="mb-3 text-xs text-slate-500">Generic CSV parser · map the columns below. OCC and futures month-code symbols are recognized automatically. {duplicateCount} duplicate row(s).</p>
      <div className="mb-4 grid gap-2 sm:grid-cols-3">
        {Object.entries(value.mapping).map(([field, index]) => <label key={field} className="text-[10px] capitalize text-slate-500">{field}<select value={index} onChange={(event) => onChange({ ...value, mapping: { ...value.mapping, [field]: Number(event.target.value) } })} className="terminal-input mt-1 w-full">{value.headers.map((header, optionIndex) => <option key={`${header}-${optionIndex}`} value={optionIndex}>{header || `Column ${optionIndex + 1}`}</option>)}</select></label>)}
      </div>
      <label className="mb-3 flex items-center gap-2 text-xs text-slate-400"><input type="checkbox" checked={dryRun} onChange={(event) => onDryRun(event.target.checked)} />Dry run only (no transactions will be saved)</label>
      <div className="max-h-72 overflow-auto rounded border border-slate-800">
        <table className="w-full text-left text-[10px]"><thead><tr>{["Row", "Symbol", "Qty", "Price", "Result"].map((item) => <th key={item} className="sticky top-0 bg-slate-900 px-2 py-2">{item}</th>)}</tr></thead>
          <tbody>{value.rows.map((row, index) => <tr key={index} className="border-t border-slate-800"><td className="px-2 py-1.5">{index + 2}</td><td className="px-2 py-1.5">{row[value.mapping.symbol]}</td><td className="px-2 py-1.5">{row[value.mapping.quantity]}</td><td className="px-2 py-1.5">{row[value.mapping.price]}</td><td className={cn("px-2 py-1.5", value.rowErrors[index] ? "text-rose-300" : "text-emerald-300")}>{value.rowErrors[index] ?? "Ready"}</td></tr>)}</tbody>
        </table>
      </div>
      <div className="mt-4 flex justify-end gap-2"><button className="terminal-button" onClick={onClose}>Cancel</button><button disabled={busy || dryRun || value.parsed.length === 0} className="terminal-button terminal-button-primary" onClick={() => onImport(value.parsed)}>{dryRun ? "Dry run complete" : `Import ${value.parsed.length} valid row(s)`}</button></div>
    </section>
  </div>;
}

type PositionsDashboardState = { importFile: {
  headers: string[];
  rows: string[][];
  mapping: Record<string, number>;
  rowErrors: string[];
  parsed: PositionTransactionInput[];
} | null };

async function loadImport(file: File | undefined, accountId: string, existing: PositionTransaction[], setValue: (value: NonNullable<PositionsDashboardState["importFile"]> | null) => void, setNotice: (notice: string) => void) {
  if (!file) return;
  try {
    const { headers, rows } = parseGenericCsv(await file.text());
    const normalized = headers.map((header) => header.toLowerCase().replace(/[^a-z]/g, ""));
    const find = (...names: string[]) => normalized.findIndex((header) => names.includes(header));
    const mapping = {
      symbol: Math.max(0, find("symbol", "ticker", "contract")),
      executedAt: Math.max(0, find("executedat", "date", "datetime", "timestamp")),
      side: Math.max(0, find("side", "action")),
      quantity: Math.max(0, find("quantity", "qty", "shares")),
      price: Math.max(0, find("price", "fillprice", "averageprice")),
      fees: Math.max(0, find("fees", "commission")),
      assetClass: Math.max(0, find("assetclass", "type")),
      currency: Math.max(0, find("currency", "ccy")),
    };
    const existingHashes = new Set<string>();
    for (const item of existing) {
      if (item.kind === "trade") existingHashes.add(await transactionDedupeHash({
        accountId: item.accountId,
        symbol: item.symbol,
        executedAt: item.executedAt,
        quantity: item.quantity,
        price: item.price,
      }));
    }
    const seen = new Set<string>();
    const parsed: PositionTransactionInput[] = [];
    const rowErrors: string[] = [];
    for (const row of rows) {
      const symbol = row[mapping.symbol]?.trim().toUpperCase() ?? "";
      const timeInput = row[mapping.executedAt]?.trim() ?? "";
      const side = row[mapping.side]?.trim().toLowerCase();
      const quantity = Number(row[mapping.quantity]);
      const price = Number(row[mapping.price]);
      const fees = Number(row[mapping.fees] || 0);
      const executed = new Date(timeInput);
      const rawClass = row[mapping.assetClass]?.trim().toLowerCase();
      const kind = rawClass
        ? rawClass === "stock" || rawClass === "stk" ? "equity"
          : rawClass === "fut" ? "future" : rawClass
        : inferAssetClass(symbol);
      const input = {
        kind: "trade" as const,
        accountId,
        symbol,
        assetClass: kind,
        side: side === "sell" || side === "s" || side === "sold" ? "sell" : side === "buy" || side === "b" || side === "bought" ? "buy" : "",
        quantity,
        price,
        fees,
        currency: row[mapping.currency]?.trim().toUpperCase() || "USD",
        executedAt: Number.isNaN(executed.getTime()) ? "" : executed.toISOString(),
        notes: `Imported from ${file.name}`,
      };
      const result = transactionInputSchema.safeParse(input);
      if (!result.success) {
        rowErrors.push(result.error.issues.map((issue) => issue.message).join("; "));
        continue;
      }
      const hash = await transactionDedupeHash({
        accountId,
        symbol,
        executedAt: result.data.executedAt,
        quantity,
        price,
      });
      if (existingHashes.has(hash) || seen.has(hash)) {
        rowErrors.push("Duplicate transaction.");
        continue;
      }
      seen.add(hash);
      parsed.push(result.data);
      rowErrors.push("");
    }
    setValue({ headers, rows, mapping, rowErrors, parsed });
  } catch (error) {
    setNotice(error instanceof Error ? error.message : "CSV import failed.");
  }
}

function AuditTrail({ events }: { events: PositionData["audit"] }) {
  return <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
    <h2 className="mb-3 text-xs font-medium">Recent audit trail</h2>
    <div className="max-h-64 space-y-2 overflow-auto">
      {events.slice(0, 20).map((event) => <div key={event.id} className="border-b border-[var(--border)] pb-2 text-[10px] text-slate-500">
        <div className="flex justify-between"><span className="uppercase text-slate-300">{event.action}</span><time>{new Date(event.createdAt).toLocaleString()}</time></div>
        <span>{event.after?.symbol ?? event.before?.symbol ?? "Transaction"} · {event.transactionId.slice(0, 8)}</span>
      </div>)}
      {events.length === 0 && <p className="text-[10px] text-slate-600">Edits and deletions are retained here.</p>}
    </div>
  </section>;
}

function AlertsPanel({ warnings }: { warnings: Array<{ key: string; severity: "warning" | "critical"; message: string; symbol: string }> }) {
  return <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)]">
    <div className="border-b border-[var(--border)] px-4 py-3"><h2 className="text-sm font-medium">Portfolio alerts</h2><p className="mt-1 text-[10px] text-slate-500">Expiry, roll, concentration, mark freshness, and stream status checks.</p></div>
    {warnings.length ? warnings.map((warning) => <div key={warning.key} className="flex items-center justify-between border-b border-[var(--border)]/70 px-4 py-3">
      <div><span className={cn("mr-2 rounded px-1.5 py-0.5 text-[9px] uppercase", warning.severity === "critical" ? "bg-rose-500/10 text-rose-300" : "bg-amber-500/10 text-amber-300")}>{warning.severity}</span><span className="text-xs text-slate-200">{warning.message}</span></div>
      <span className="font-mono text-[10px] text-slate-500">{warning.symbol}</span>
    </div>) : <p className="px-4 py-10 text-center text-xs text-slate-500">No portfolio warnings right now.</p>}
  </section>;
}

function buildWarnings(positions: Array<ValuedPosition & { stale: boolean; connected: boolean }>, absoluteValue: number, account?: PositionAccount) {
  const warnings: Array<{ key: string; severity: "warning" | "critical"; message: string; symbol: string }> = [];
  const underlyingExposure = new Map<string, number>();
  for (const position of positions) {
    if (position.assetClass === "option" && position.daysToExpiry !== null && position.daysToExpiry <= (account?.expiryWarningDays ?? 7)) {
      warnings.push({ key: `${position.symbol}:expiry`, severity: position.daysToExpiry <= 1 ? "critical" : "warning", message: position.daysToExpiry < 0 ? "Option is expired; underlying mark is needed to auto-close at intrinsic." : `Option expires in ${position.daysToExpiry} day(s).`, symbol: position.symbol });
    }
    if (position.assetClass === "future" && position.daysToExpiry !== null && position.daysToExpiry <= getFuturesRoot(position.underlying).rollDays) {
      warnings.push({ key: `${position.symbol}:roll`, severity: "warning", message: `Future is within ${getFuturesRoot(position.underlying).rollDays} days of last trade.`, symbol: position.symbol });
    }
    if (position.baseMarketValue !== null) underlyingExposure.set(position.underlying, (underlyingExposure.get(position.underlying) ?? 0) + Math.abs(position.baseMarketValue));
    if (position.mark === null) warnings.push({ key: `${position.symbol}:missing`, severity: "critical", message: "Market mark is unavailable.", symbol: position.symbol });
    else if (position.stale) warnings.push({ key: `${position.symbol}:stale`, severity: "warning", message: "Market mark is stale.", symbol: position.symbol });
  }
  for (const [underlying, exposure] of underlyingExposure) {
    const share = absoluteValue > 0 ? exposure / absoluteValue : 0;
    if (share >= (account?.concentrationThreshold ?? 0.25)) {
      warnings.push({ key: `${underlying}:concentration`, severity: "warning", message: `Underlying exposure is ${(share * 100).toFixed(1)}% of gross portfolio exposure.`, symbol: underlying });
    }
  }
  if (positions.length > 0 && positions.some((position) => !position.connected)) {
    warnings.push({ key: "stream:disconnected", severity: "critical", message: "Market data stream is disconnected.", symbol: "PORTFOLIO" });
  }
  return warnings;
}

function AllocationChart({ title, rows, suffix = "" }: { title: string; rows: Array<{ key: string; value: number }>; suffix?: string }) {
  return <ChartPanel title={title}><ResponsiveContainer width="100%" height="100%"><BarChart data={rows}><CartesianGrid stroke="#202832" strokeDasharray="3 3" /><XAxis dataKey="key" tick={{ fill: "#718096", fontSize: 9 }} /><YAxis tick={{ fill: "#718096", fontSize: 9 }} /><Tooltip contentStyle={tooltipStyle} formatter={(value) => [`${formatNumber(Number(value))}${suffix}`, ""]} /><Bar dataKey="value" fill="#42c88a" /></BarChart></ResponsiveContainer></ChartPanel>;
}

function ChartPanel({ title, children }: { title: string; children: React.ReactNode }) {
  return <section className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4"><h2 className="mb-3 text-xs font-medium text-slate-300">{title}</h2><div className="h-56">{children}</div></section>;
}

function summarize(positions: ValuedPosition[], keyFor: (position: ValuedPosition) => string, metric: "baseMarketValue" | "delta" | "deltaAdjustedNotional" = "baseMarketValue") {
  const values = new Map<string, number>();
  for (const position of positions) {
    const value = position[metric];
    if (value !== null) values.set(keyFor(position), (values.get(keyFor(position)) ?? 0) + (metric === "baseMarketValue" ? Math.abs(value) : value));
  }
  return [...values].map(([key, value]) => ({ key, value })).sort((a, b) => b.value - a.value).slice(0, 12);
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: number | null }) {
  return <article className="rounded-lg border border-[var(--border)] bg-[var(--panel)] px-3 py-3"><p className="text-[10px] text-slate-500">{label}</p><p className={cn("mt-2 font-mono text-sm", toneClass(tone))}>{value}</p></article>;
}
function ExposureSummary({ label, value }: { label: string; value: string }) {
  return <div className="rounded border border-[var(--border)] bg-[var(--panel)] px-3 py-2"><span className="mr-3 text-[10px] text-slate-500">{label}</span><span className="font-mono text-xs text-slate-300">{value}</span></div>;
}

function money(value: number | null, currency: string) {
  if (value === null || !Number.isFinite(value)) return "—";
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
}
function formatNumber(value: number | null) {
  return value === null || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US", { maximumFractionDigits: 3 });
}
function toneClass(value: number | null | undefined) {
  return value === undefined || value === null ? "text-slate-200" : value >= 0 ? "text-emerald-300" : "text-rose-300";
}
function sumKnown(values: Array<number | null>) {
  if (values.length === 0) return 0;
  return values.some((value) => value === null) ? null : values.reduce<number>((total, value) => total + value!, 0);
}
function getErrorMessage(value: unknown, fallback: string): string {
  return typeof value === "object" && value !== null && "error" in value && typeof value.error === "string"
    ? value.error
    : fallback;
}
function downloadCsv(rows: Array<Record<string, string | number | null>>, name: string) {
  const blob = new Blob([toCsv(rows)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
const tooltipStyle = { background: "#11151b", border: "1px solid #26313d", borderRadius: 6, fontSize: 11 };
