"use client";

import Link from "next/link";
import { Bell } from "lucide-react";
import { useEffect, useState } from "react";

export function AlertsUnreadBell() {
  const [unread, setUnread] = useState(0);
  const [latest, setLatest] = useState("");
  const [error, setError] = useState("");

  useEffect(() => {
    let source: EventSource | undefined;
    const controller = new AbortController();
    void fetch("/api/alerts", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data: unknown = await response.json();
        if (!response.ok) throw new Error(readError(data));
        const unreadCount = typeof data === "object" && data !== null && "unreadCount" in data
          ? Number(data.unreadCount) : 0;
        setUnread(Number.isFinite(unreadCount) ? unreadCount : 0);
        source = new EventSource(`/api/alerts/stream?after=${encodeURIComponent(new Date().toISOString())}`);
        source.addEventListener("count", (event) => {
          const payload: unknown = JSON.parse((event as MessageEvent<string>).data);
          if (typeof payload === "object" && payload !== null && "unreadCount" in payload) {
            const count = Number(payload.unreadCount);
            if (Number.isFinite(count)) setUnread(count);
          }
        });
        source.addEventListener("alerts", (event) => {
          const payload: unknown = JSON.parse((event as MessageEvent<string>).data);
          if (typeof payload !== "object" || payload === null) return;
          if ("unreadCount" in payload && Number.isFinite(Number(payload.unreadCount))) setUnread(Number(payload.unreadCount));
          if ("events" in payload && Array.isArray(payload.events) && payload.events.length) {
            const first = payload.events[0];
            if (typeof first === "object" && first !== null && "summary" in first && typeof first.summary === "string") {
              setLatest(first.summary);
              setTimeout(() => setLatest(""), 6000);
            }
          }
        });
        source.addEventListener("error", () => setError("Alert event stream disconnected; reconnecting."));
        source.onopen = () => setError("");
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(cause instanceof Error ? cause.message : "Could not load alerts.");
      });
    return () => {
      controller.abort();
      source?.close();
    };
  }, []);

  return <div className="fixed bottom-4 right-4 z-50 flex max-w-[min(420px,calc(100vw-2rem))] flex-col items-end gap-2">
    {latest && <Link href="/alerts" role="status" className="max-w-full rounded-lg border border-emerald-500/30 bg-slate-950 px-3 py-2 text-xs text-emerald-100 shadow-xl">{latest}</Link>}
    <Link href="/alerts" aria-label={`${unread} unread alerts`} title={error || `${unread} unread alerts`} className="relative flex h-10 w-10 items-center justify-center rounded-full border border-[var(--border)] bg-slate-950 text-slate-300 shadow-lg hover:text-white">
      <Bell size={16} aria-hidden="true" />
      {unread > 0 && <span className="absolute -right-1 -top-1 min-w-4 rounded-full bg-rose-500 px-1 text-center text-[9px] leading-4 text-white">{unread > 99 ? "99+" : unread}</span>}
      <span className="sr-only">{error || `${unread} unread alert notifications`}</span>
    </Link>
  </div>;
}

function readError(data: unknown): string {
  return typeof data === "object" && data !== null && "error" in data && typeof data.error === "string"
    ? data.error
    : "Could not load alerts.";
}
