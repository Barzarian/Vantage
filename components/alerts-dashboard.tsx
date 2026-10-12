"use client";

import Link from "next/link";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  alertSchema,
  type Alert,
  type AlertAssetClass,
  type AlertComparison,
  type AlertCondition,
  type AlertEvent,
  type AlertInput,
  type AlertLeafCondition,
  type AlertTriggerMode,
} from "@/lib/alerts/model";
import { cn } from "@/lib/utils";

type Channel = { type: string; enabled: boolean; label: string; configured: boolean };
type DashboardData = { alerts: Alert[]; events: AlertEvent[]; channels: Channel[]; unreadCount: number };
type ConditionKind = AlertLeafCondition["type"];
type Draft = {
  id: string | null;
  name: string;
  symbol: string;
  assetClass: AlertAssetClass;
  conditionKind: ConditionKind;
  comparison: AlertComparison;
  thresholds: number[];
  source: "last" | "mid" | "bid" | "ask";
  windowMinutes: number;
  lookbackMinutes: number;
  indicator: "rsi" | "sma" | "ema" | "macd" | "vwap";
  period: number;
  intrabar: boolean;
  optionMetric: "mid" | "impliedVolatility" | "delta" | "gamma" | "theta" | "vega" | "volume" | "openInterest";
  futureMetric: "price" | "spread" | "basis" | "daysToExpiry" | "daysToRoll";
  portfolioMetric: "dayPnl" | "unrealizedPnl" | "netDelta" | "grossExposure" | "concentration";
  and: boolean;
  triggerMode: AlertTriggerMode;
  cooldownSeconds: number;
  onlyRegularHours: boolean;
  maxJumpPercent: number;
  active: boolean;
};

const defaultDraft = (): Draft => ({
  id: null,
  name: "",
  symbol: "",
  assetClass: "equity",
  conditionKind: "price",
  comparison: "crosses-above",
  thresholds: [100],
  source: "mid",
  windowMinutes: 1,
  lookbackMinutes: 30,
  indicator: "rsi",
  period: 14,
  intrabar: false,
  optionMetric: "mid",
  futureMetric: "price",
  portfolioMetric: "dayPnl",
  and: false,
  triggerMode: "every-cross",
  cooldownSeconds: 300,
  onlyRegularHours: false,
  maxJumpPercent: 20,
  active: true,
});

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
    cache: "no-store",
  });
  const data: unknown = response.status === 204 ? null : await response.json();
  if (!response.ok) {
    const message = typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
      ? data.error
      : "Alert request failed.";
    throw new Error(message);
  }
  return data as T;
}

export function AlertsDashboard() {
  const client = useQueryClient();
  const [draft, setDraft] = useState<Draft | null>(() => initialDraftFromLocation());
  const [filterSymbol, setFilterSymbol] = useState("");
  const [filterFrom, setFilterFrom] = useState("");
  const [filterTo, setFilterTo] = useState("");
  const [notice, setNotice] = useState("");
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("create") === "1") {
      window.history.replaceState(null, "", "/alerts");
    }
  }, []);
  const query = useQuery({
    queryKey: ["alerts"],
    queryFn: () => requestJson<DashboardData>("/api/alerts"),
    refetchInterval: 20_000,
  });
  const mutation = useMutation({
    mutationFn: async (input: { method: "POST" | "PATCH" | "DELETE"; id?: string; body?: unknown }) =>
      requestJson<unknown>(input.id ? `/api/alerts/${encodeURIComponent(input.id)}` : "/api/alerts", {
        method: input.method,
        ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
      }),
    onSuccess: async () => {
      setDraft(null);
      setNotice("Alert saved.");
      await client.invalidateQueries({ queryKey: ["alerts"] });
    },
  });
  const readMutation = useMutation({
    mutationFn: (eventId: string) => requestJson("/api/alerts/events", {
      method: "POST",
      body: JSON.stringify({ eventId }),
    }),
    onSuccess: () => client.invalidateQueries({ queryKey: ["alerts"] }),
  });
  const data = query.data;
  const visibleEvents = useMemo(() => (data?.events ?? []).filter((event) => {
    const alert = data?.alerts.find((item) => item.id === event.alertId);
    if (filterSymbol && !alert?.symbol.includes(filterSymbol.trim().toUpperCase())) return false;
    if (filterFrom && Date.parse(event.triggeredAt) < new Date(`${filterFrom}T00:00:00`).getTime()) return false;
    if (filterTo && Date.parse(event.triggeredAt) > new Date(`${filterTo}T23:59:59`).getTime()) return false;
    return true;
  }), [data?.alerts, data?.events, filterFrom, filterSymbol, filterTo]);

  function saveDraft() {
    if (!draft) return;
    const conditions = draft.thresholds.map((threshold) => buildCondition(draft, threshold));
    const condition: AlertCondition = draft.and && conditions.length > 1
      ? { type: "and", conditions }
      : conditions[0]!;
    const input: AlertInput = {
      name: draft.name,
      symbol: draft.assetClass === "portfolio" ? "PORTFOLIO" : draft.symbol,
      assetClass: draft.assetClass,
      condition,
      triggerMode: draft.triggerMode,
      cooldownSeconds: draft.cooldownSeconds,
      active: draft.active,
      onlyRegularHours: draft.onlyRegularHours,
      maxJumpPercent: draft.maxJumpPercent,
    };
    const validated = alertSchema.pick({
      name: true, symbol: true, assetClass: true, condition: true, triggerMode: true,
      cooldownSeconds: true, active: true, onlyRegularHours: true, maxJumpPercent: true,
    }).parse(input);
    mutation.mutate({
      method: draft.id ? "PATCH" : "POST",
      ...(draft.id ? { id: draft.id } : {}),
      body: validated,
    });
  }

  function startEdit(alert: Alert) {
    const leaves = alert.condition.type === "and" ? alert.condition.conditions : [alert.condition];
    const first = leaves[0]!;
    const editable = {
      ...defaultDraft(),
      id: alert.id,
      name: alert.name,
      symbol: alert.symbol,
      assetClass: alert.assetClass,
      comparison: first.comparison,
      thresholds: leaves.map((leaf) => leaf.threshold),
      and: leaves.length > 1,
      triggerMode: alert.triggerMode,
      cooldownSeconds: alert.cooldownSeconds,
      onlyRegularHours: alert.onlyRegularHours,
      maxJumpPercent: alert.maxJumpPercent,
      active: alert.active,
      conditionKind: first.type,
      ...(first.type === "price" ? { source: first.source } : {}),
      ...(first.type === "percent-change" ? { windowMinutes: first.windowMinutes } : {}),
      ...(first.type === "volume-spike" ? { lookbackMinutes: first.lookbackMinutes } : {}),
      ...(first.type === "indicator" ? { indicator: first.indicator, period: first.period, intrabar: first.intrabar } : {}),
      ...(first.type === "option" ? { optionMetric: first.metric } : {}),
      ...(first.type === "futures" ? { futureMetric: first.metric } : {}),
      ...(first.type === "portfolio" ? { portfolioMetric: first.metric } : {}),
    } satisfies Draft;
    setDraft(editable);
  }

  function toggleAlert(alert: Alert) {
    mutation.mutate({ method: "PATCH", id: alert.id, body: { active: !alert.active } });
  }

  function removeAlert(alert: Alert) {
    if (window.confirm(`Delete "${alert.name}" and its event history?`)) {
      mutation.mutate({ method: "DELETE", id: alert.id });
    }
  }

  function exportHistory() {
    const rows = [
      ["time", "symbol", "alert", "value", "summary", "read"],
      ...visibleEvents.map((event) => [
        event.triggeredAt,
        data?.alerts.find((alert) => alert.id === event.alertId)?.symbol ?? "",
        data?.alerts.find((alert) => alert.id === event.alertId)?.name ?? "",
        event.triggerValue ?? "",
        event.summary,
        event.readAt ? "yes" : "no",
      ]),
    ];
    const csv = rows.map((row) => row.map((value) => `"${String(value).replaceAll('"', '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = "alert-events.csv";
    anchor.click();
    URL.revokeObjectURL(url);
  }

  if (query.isPending) return <main className="mx-auto max-w-7xl px-5 py-10 text-xs text-slate-500">Loading alerts…</main>;
  if (query.isError) return <main className="mx-auto max-w-7xl px-5 py-10"><ErrorMessage message={query.error.message} /></main>;

  return (
    <main className="mx-auto min-h-[calc(100vh-104px)] max-w-[1600px] px-5 py-6">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-slate-500">Monitoring · {data?.unreadCount ?? 0} unread</p>
          <h1 className="text-xl font-medium text-slate-100">Alerts</h1>
          <p className="mt-1 text-xs text-slate-500">Server-evaluated market conditions with persisted trigger state and delivery history.</p>
        </div>
        <div className="flex gap-2">
          <Link className="terminal-button" href="/settings">Notification settings</Link>
          <button className="terminal-button terminal-button-primary" onClick={() => setDraft(defaultDraft())}>Create alert</button>
        </div>
      </header>

      {notice && <div role="status" className="mb-3 rounded border border-emerald-500/20 bg-emerald-500/5 px-3 py-2 text-xs text-emerald-200">{notice}</div>}
      {mutation.isError && <ErrorMessage message={mutation.error.message} />}

      {draft && <AlertEditor
        draft={draft}
        busy={mutation.isPending}
        onChange={setDraft}
        onCancel={() => setDraft(null)}
        onSave={saveDraft}
      />}

      <section className="mb-6 overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)]">
        <div className="flex items-center justify-between border-b border-[var(--border)] px-4 py-3">
          <div><h2 className="text-sm font-medium">Alert rules</h2><p className="mt-1 text-[10px] text-slate-500">{data?.alerts.filter((alert) => alert.active).length ?? 0} active of {data?.alerts.length ?? 0}</p></div>
          <Link className="text-[10px] text-emerald-300 hover:text-emerald-200" href="/positions">Portfolio warnings →</Link>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[850px] text-left text-xs">
            <thead className="bg-[var(--panel-raised)] text-[10px] uppercase tracking-wider text-slate-500">
              <tr><th className="px-4 py-2.5">Rule / symbol</th><th className="px-4 py-2.5">Condition</th><th className="px-4 py-2.5">Mode</th><th className="px-4 py-2.5">Last fired</th><th className="px-4 py-2.5">Status</th><th className="px-4 py-2.5 text-right">Actions</th></tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]/70">
              {data?.alerts.map((alert) => <tr key={alert.id} className="hover:bg-white/[0.015]">
                <td className="px-4 py-3"><div className="font-medium text-slate-200">{alert.name}</div><div className="mt-1 font-mono text-[10px] text-slate-500">{alert.symbol} · {alert.assetClass}</div></td>
                <td className="max-w-[360px] truncate px-4 py-3 text-slate-400">{conditionLabel(alert.condition)}</td>
                <td className="px-4 py-3 text-slate-400">{alert.triggerMode === "cooldown" ? `Cooldown ${alert.cooldownSeconds}s` : alert.triggerMode}</td>
                <td className="px-4 py-3 font-mono text-[10px] text-slate-500">{alert.lastTriggeredAt ? new Date(alert.lastTriggeredAt).toLocaleString() : "—"}</td>
                <td className="px-4 py-3"><span className={cn("rounded px-1.5 py-0.5 text-[9px] uppercase", alert.active ? "bg-emerald-500/10 text-emerald-300" : "bg-slate-700/50 text-slate-400")}>{alert.active ? "active" : "paused"}</span></td>
                <td className="space-x-3 whitespace-nowrap px-4 py-3 text-right text-[10px]">
                  <button className="text-slate-400 hover:text-white" onClick={() => startEdit(alert)}>Edit</button>
                  <button className="text-slate-400 hover:text-white" onClick={() => toggleAlert(alert)}>{alert.active ? "Pause" : "Resume"}</button>
                  <button className="text-rose-300 hover:text-rose-200" onClick={() => removeAlert(alert)}>Delete</button>
                </td>
              </tr>)}
              {!data?.alerts.length && <tr><td colSpan={6} className="px-4 py-12 text-center text-xs text-slate-500">No alert rules yet. Create one to start monitoring.</td></tr>}
            </tbody>
          </table>
        </div>
      </section>

      <section className="overflow-hidden rounded-lg border border-[var(--border)] bg-[var(--panel)]">
        <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
          <div><h2 className="text-sm font-medium">Trigger history</h2><p className="mt-1 text-[10px] text-slate-500">Most recent 500 events. Delivery outcomes are shown per channel.</p></div>
          <button className="terminal-button" onClick={exportHistory} disabled={!visibleEvents.length}>Export CSV</button>
        </div>
        <div className="flex flex-wrap gap-2 border-b border-[var(--border)] px-4 py-3">
          <input className="terminal-input w-36 py-1 text-[10px]" placeholder="Filter symbol" value={filterSymbol} onChange={(event) => setFilterSymbol(event.target.value)} />
          <label className="text-[10px] text-slate-500">From <input className="terminal-input ml-1 py-1 text-[10px]" type="date" value={filterFrom} onChange={(event) => setFilterFrom(event.target.value)} /></label>
          <label className="text-[10px] text-slate-500">To <input className="terminal-input ml-1 py-1 text-[10px]" type="date" value={filterTo} onChange={(event) => setFilterTo(event.target.value)} /></label>
        </div>
        <div className="divide-y divide-[var(--border)]/70">
          {visibleEvents.map((event) => {
            const alert = data?.alerts.find((item) => item.id === event.alertId);
            return <article key={event.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2"><span className={cn("h-1.5 w-1.5 rounded-full", event.readAt ? "bg-slate-600" : "bg-emerald-400")} /><span className="truncate text-xs text-slate-200">{event.summary}</span></div>
                <div className="mt-1 flex flex-wrap gap-x-3 text-[10px] text-slate-500">
                  <time>{new Date(event.triggeredAt).toLocaleString()}</time>
                  {alert && <span>{alert.symbol} · {alert.name}</span>}
                  {Object.entries(event.deliveryResults).map(([channel, result]) => <span key={channel} className={cn(result.status === "failed" ? "text-rose-300" : result.status === "delivered" ? "text-emerald-300" : "")}>{channel}: {result.status}{result.message ? ` (${result.message})` : ""}</span>)}
                </div>
              </div>
              {!event.readAt && <button className="text-[10px] text-slate-500 hover:text-slate-200" onClick={() => readMutation.mutate(event.id)}>Mark read</button>}
            </article>;
          })}
          {!visibleEvents.length && <p className="px-4 py-10 text-center text-xs text-slate-500">No matching alert events.</p>}
        </div>
      </section>
      <p className="mt-4 text-[10px] text-slate-600">Alerts use available market-data provider quotes and can be delayed or simulated. They are informational only and are not trading instructions.</p>
    </main>
  );
}

function initialDraftFromLocation(): Draft | null {
  if (typeof window === "undefined") return null;
  const params = new URLSearchParams(window.location.search);
  if (params.get("create") !== "1") return null;
  const symbol = params.get("symbol")?.trim().toUpperCase() ?? "";
  const rawAssetClass = params.get("assetClass");
  const assetClass: AlertAssetClass = rawAssetClass === "option" || rawAssetClass === "future" || rawAssetClass === "portfolio"
    ? rawAssetClass
    : "equity";
  return {
    ...defaultDraft(),
    name: symbol ? `${symbol} alert` : "",
    symbol: assetClass === "portfolio" ? "PORTFOLIO" : symbol,
    assetClass,
    conditionKind: assetClass === "option" ? "option" : assetClass === "future" ? "futures" : assetClass === "portfolio" ? "portfolio" : "price",
  };
}

function AlertEditor({
  draft, busy, onChange, onCancel, onSave,
}: {
  draft: Draft;
  busy: boolean;
  onChange: (draft: Draft) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const patch = (values: Partial<Draft>) => onChange({ ...draft, ...values });
  const setType = (assetClass: AlertAssetClass) => patch({
    assetClass,
    symbol: assetClass === "portfolio" ? "PORTFOLIO" : draft.symbol === "PORTFOLIO" ? "" : draft.symbol,
    conditionKind: assetClass === "portfolio" ? "portfolio" : assetClass === "option" ? "option" : assetClass === "future" ? "futures" : "price",
    and: false,
    thresholds: [draft.thresholds[0] ?? 100],
  });
  const setCondition = (conditionKind: ConditionKind) => patch({
    conditionKind,
    thresholds: [draft.thresholds[0] ?? 100],
  });
  const patchThreshold = (index: number, value: number) => {
    const thresholds = [...draft.thresholds];
    thresholds[index] = value;
    patch({ thresholds });
  };
  return (
    <section className="mb-5 rounded-lg border border-emerald-500/20 bg-[var(--panel)] p-4">
      <div className="mb-4 flex items-center justify-between"><h2 className="text-sm font-medium">{draft.id ? "Edit alert" : "Create alert"}</h2><button className="text-xs text-slate-500" onClick={onCancel}>Cancel</button></div>
      <div className="grid gap-3 md:grid-cols-3">
        <Field label="Rule name"><input className="terminal-input w-full" value={draft.name} maxLength={80} onChange={(event) => patch({ name: event.target.value })} placeholder="AAPL crosses above 200" /></Field>
        <Field label="Asset class"><select className="terminal-input w-full" value={draft.assetClass} onChange={(event) => setType(event.target.value as AlertAssetClass)}>
          <option value="equity">Equity / index</option><option value="option">Option</option><option value="future">Future</option><option value="portfolio">Portfolio</option>
        </select></Field>
        <Field label="Symbol"><input className="terminal-input w-full uppercase" value={draft.assetClass === "portfolio" ? "PORTFOLIO" : draft.symbol} disabled={draft.assetClass === "portfolio"} maxLength={32} onChange={(event) => patch({ symbol: event.target.value.toUpperCase() })} placeholder={draft.assetClass === "option" ? "OCC option symbol" : "AAPL or ESM6"} /></Field>
        <Field label="Condition type"><select className="terminal-input w-full" value={draft.conditionKind} onChange={(event) => setCondition(event.target.value as ConditionKind)}>
          <option value="price">Price</option><option value="percent-change">Percent change</option><option value="volume-spike">Volume spike</option><option value="indicator">Indicator</option><option value="option" disabled={draft.assetClass !== "option"}>Option metric</option><option value="futures" disabled={draft.assetClass !== "future"}>Futures metric</option><option value="portfolio" disabled={draft.assetClass !== "portfolio"}>Portfolio metric</option>
        </select></Field>
        <Field label="Comparison"><select className="terminal-input w-full" value={draft.comparison} onChange={(event) => patch({ comparison: event.target.value as AlertComparison })}>
          <option value="above">At or above</option><option value="below">At or below</option><option value="crosses-above">Crosses above</option><option value="crosses-below">Crosses below</option>
        </select></Field>
        <Field label="Trigger mode"><select className="terminal-input w-full" value={draft.triggerMode} onChange={(event) => patch({ triggerMode: event.target.value as AlertTriggerMode })}>
          <option value="every-cross">Once per crossing</option><option value="once">Once, then pause</option><option value="cooldown">Repeat after cooldown</option>
        </select></Field>
        {draft.triggerMode === "cooldown" && <Field label="Cooldown (seconds)"><input className="terminal-input w-full" type="number" min={30} max={604800} value={draft.cooldownSeconds} onChange={(event) => patch({ cooldownSeconds: Number(event.target.value) })} /></Field>}
        {draft.conditionKind === "price" && <Field label="Price source"><select className="terminal-input w-full" value={draft.source} onChange={(event) => patch({ source: event.target.value as Draft["source"] })}><option value="mid">Mid / mark</option><option value="last">Last</option><option value="bid">Bid</option><option value="ask">Ask</option></select></Field>}
        {draft.conditionKind === "percent-change" && <Field label="Lookback (minutes)"><input className="terminal-input w-full" type="number" min={1} max={1440} value={draft.windowMinutes} onChange={(event) => patch({ windowMinutes: Number(event.target.value) })} /></Field>}
        {draft.conditionKind === "volume-spike" && <Field label="Volume lookback (minutes)"><input className="terminal-input w-full" type="number" min={5} max={1440} value={draft.lookbackMinutes} onChange={(event) => patch({ lookbackMinutes: Number(event.target.value) })} /></Field>}
        {draft.conditionKind === "indicator" && <>
          <Field label="Indicator"><select className="terminal-input w-full" value={draft.indicator} onChange={(event) => patch({ indicator: event.target.value as Draft["indicator"] })}><option value="rsi">RSI</option><option value="sma">SMA</option><option value="ema">EMA</option><option value="macd">MACD</option><option value="vwap">Session VWAP</option></select></Field>
          <Field label="Period"><input className="terminal-input w-full" type="number" min={2} max={250} value={draft.period} onChange={(event) => patch({ period: Number(event.target.value) })} /></Field>
          <label className="flex items-center gap-2 self-end pb-2 text-[10px] text-slate-400"><input type="checkbox" checked={draft.intrabar} onChange={(event) => patch({ intrabar: event.target.checked })} /> Evaluate intrabar</label>
        </>}
        {draft.conditionKind === "option" && <Field label="Option metric"><select className="terminal-input w-full" value={draft.optionMetric} onChange={(event) => patch({ optionMetric: event.target.value as Draft["optionMetric"] })}>{["mid", "impliedVolatility", "delta", "gamma", "theta", "vega", "volume", "openInterest"].map((metric) => <option value={metric} key={metric}>{metric}</option>)}</select></Field>}
        {draft.conditionKind === "futures" && <Field label="Futures metric"><select className="terminal-input w-full" value={draft.futureMetric} onChange={(event) => patch({ futureMetric: event.target.value as Draft["futureMetric"] })}>{["price", "spread", "basis", "daysToExpiry", "daysToRoll"].map((metric) => <option value={metric} key={metric}>{metric}</option>)}</select></Field>}
        {draft.conditionKind === "portfolio" && <Field label="Portfolio metric"><select className="terminal-input w-full" value={draft.portfolioMetric} onChange={(event) => patch({ portfolioMetric: event.target.value as Draft["portfolioMetric"] })}>{["dayPnl", "unrealizedPnl", "netDelta", "grossExposure", "concentration"].map((metric) => <option value={metric} key={metric}>{metric}</option>)}</select></Field>}
      </div>

      <div className="mt-4 rounded border border-[var(--border)] p-3">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <div className="text-[10px] uppercase tracking-wider text-slate-500">{draft.and ? "All thresholds must match (AND)" : "Threshold"}</div>
          <label className="flex items-center gap-2 text-[10px] text-slate-400"><input type="checkbox" checked={draft.and} onChange={(event) => patch({ and: event.target.checked, thresholds: event.target.checked && draft.thresholds.length < 2 ? [...draft.thresholds, draft.thresholds[0] ?? 100] : draft.thresholds.slice(0, event.target.checked ? 3 : 1) })} /> Combine conditions</label>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {draft.thresholds.map((threshold, index) => <div className="flex items-center gap-1" key={index}>
            <span className="text-[10px] text-slate-500">{draft.and ? `#${index + 1}` : "Value"}</span>
            <input className="terminal-input w-28 py-1" type="number" step="any" value={threshold} onChange={(event) => patchThreshold(index, Number(event.target.value))} />
            {draft.and && draft.thresholds.length > 2 && <button className="text-[10px] text-rose-300" onClick={() => patch({ thresholds: draft.thresholds.filter((_, row) => row !== index) })}>Remove</button>}
          </div>)}
          {draft.and && draft.thresholds.length < 3 && <button className="terminal-button" onClick={() => patch({ thresholds: [...draft.thresholds, draft.thresholds.at(-1) ?? 100] })}>Add AND condition</button>}
        </div>
        {draft.conditionKind === "percent-change" && <p className="mt-2 text-[9px] text-slate-600">Threshold is percent over the selected bar lookback.</p>}
        {draft.conditionKind === "volume-spike" && <p className="mt-2 text-[9px] text-slate-600">Threshold is the current one-minute volume divided by the average one-minute volume.</p>}
        {draft.conditionKind === "portfolio" && draft.portfolioMetric === "concentration" && <p className="mt-2 text-[9px] text-slate-600">Concentration threshold is entered as a percent of gross portfolio exposure.</p>}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2">
        <label className="flex items-center gap-2 text-[10px] text-slate-400"><input type="checkbox" checked={draft.onlyRegularHours} onChange={(event) => patch({ onlyRegularHours: event.target.checked })} /> US regular session only</label>
        <label className="flex items-center gap-2 text-[10px] text-slate-400">Max tick jump <input className="terminal-input w-20 py-1" type="number" min={0.1} max={1000} value={draft.maxJumpPercent} onChange={(event) => patch({ maxJumpPercent: Number(event.target.value) })} /> %</label>
        <span className="ml-auto text-[9px] text-slate-600">Alerts do not place orders. Validate market data before acting.</span>
      </div>
      <div className="mt-4 flex justify-end gap-2"><button className="terminal-button" onClick={onCancel}>Cancel</button><button className="terminal-button terminal-button-primary" disabled={busy || !draft.name.trim() || (draft.assetClass !== "portfolio" && !draft.symbol.trim())} onClick={onSave}>{busy ? "Saving…" : draft.id ? "Save changes" : "Create alert"}</button></div>
    </section>
  );
}

function buildCondition(draft: Draft, threshold: number): AlertLeafCondition {
  switch (draft.conditionKind) {
    case "price": return { type: "price", source: draft.source, comparison: draft.comparison, threshold };
    case "percent-change": return { type: "percent-change", windowMinutes: draft.windowMinutes, comparison: draft.comparison, threshold };
    case "volume-spike": return { type: "volume-spike", lookbackMinutes: draft.lookbackMinutes, comparison: draft.comparison, threshold };
    case "indicator": return { type: "indicator", indicator: draft.indicator, period: draft.period, comparison: draft.comparison, threshold, intrabar: draft.intrabar };
    case "option": return { type: "option", metric: draft.optionMetric, comparison: draft.comparison, threshold };
    case "futures": return { type: "futures", metric: draft.futureMetric, comparison: draft.comparison, threshold };
    case "portfolio": return { type: "portfolio", metric: draft.portfolioMetric, comparison: draft.comparison, threshold };
  }
}

function conditionLabel(condition: AlertCondition): string {
  const leaves = condition.type === "and" ? condition.conditions : [condition];
  return leaves.map((leaf) => `${leaf.type} ${leaf.comparison.replaceAll("-", " ")} ${leaf.threshold}`).join(" AND ");
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <label className="block text-[10px] text-slate-500">{label}<span className="mt-1 block">{children}</span></label>;
}

function ErrorMessage({ message }: { message: string }) {
  return <div role="alert" className="mb-3 rounded border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">{message}</div>;
}
