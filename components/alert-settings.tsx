"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

type Channel = { type: "in-app" | "email" | "push" | "webhook"; enabled: boolean; label: string; configured: boolean };
type ChannelData = { channels: Channel[] };

async function saveChannel(body: unknown): Promise<Channel> {
  const response = await fetch("/api/alerts/channels", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(errorMessage(data));
  return data as Channel;
}

async function toggleChannel(body: unknown): Promise<Channel> {
  const response = await fetch("/api/alerts/channels", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data: unknown = await response.json();
  if (!response.ok) throw new Error(errorMessage(data));
  return data as Channel;
}

export function AlertSettings() {
  const client = useQueryClient();
  const [email, setEmail] = useState("");
  const [webhookUrl, setWebhookUrl] = useState("");
  const [webhookSecret, setWebhookSecret] = useState("");
  const [localError, setLocalError] = useState("");
  const query = useQuery({
    queryKey: ["alert-channels"],
    queryFn: async () => {
      const response = await fetch("/api/alerts/channels", { cache: "no-store" });
      const data: unknown = await response.json();
      if (!response.ok) throw new Error(errorMessage(data));
      return data as ChannelData;
    },
  });
  const mutation = useMutation({
    mutationFn: saveChannel,
    onSuccess: async () => {
      setLocalError("");
      await Promise.all([
        client.invalidateQueries({ queryKey: ["alert-channels"] }),
        client.invalidateQueries({ queryKey: ["alerts"] }),
      ]);
    },
  });
  const toggleMutation = useMutation({
    mutationFn: toggleChannel,
    onSuccess: async () => {
      setLocalError("");
      await client.invalidateQueries({ queryKey: ["alert-channels"] });
    },
  });
  const channels = query.data?.channels ?? [];
  const getChannel = (type: Channel["type"]) => channels.find((channel) => channel.type === type);

  async function enablePush() {
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      throw new Error("Web Push is not supported by this browser.");
    }
    const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
    if (permission !== "granted") throw new Error("Notification permission was not granted.");
    const keyResponse = await fetch("/api/alerts/push-key", { cache: "no-store" });
    const keyData: unknown = await keyResponse.json();
    if (!keyResponse.ok || typeof keyData !== "object" || keyData === null || !("publicKey" in keyData) || typeof keyData.publicKey !== "string") {
      throw new Error(errorMessage(keyData));
    }
    const registration = await navigator.serviceWorker.register("/alerts-sw.js");
    const existing = await registration.pushManager.getSubscription();
    const subscription = existing ?? await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToBytes(keyData.publicKey),
    });
    const response = await fetch("/api/alerts/push-subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription.toJSON()),
    });
    const data: unknown = await response.json();
    if (!response.ok) throw new Error(errorMessage(data));
    await toggleMutation.mutateAsync({ type: "push", enabled: true });
  }

  async function disablePush() {
    const registration = await navigator.serviceWorker.getRegistration("/alerts-sw.js");
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) {
      const response = await fetch("/api/alerts/push-subscriptions", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
      const data: unknown = await response.json();
      if (!response.ok) throw new Error(errorMessage(data));
      await subscription.unsubscribe();
    }
    await toggleMutation.mutateAsync({ type: "push", enabled: false });
  }

  if (query.isPending) return <main className="mx-auto max-w-4xl px-5 py-10 text-xs text-slate-500">Loading notification settings…</main>;
  if (query.isError) return <main className="mx-auto max-w-4xl px-5 py-10"><ErrorMessage message={query.error.message} /></main>;

  return <main className="mx-auto min-h-[calc(100vh-104px)] max-w-4xl px-5 py-6">
    <header className="mb-5"><p className="mb-1 text-[10px] font-medium uppercase tracking-[0.16em] text-slate-500">Account</p><h1 className="text-xl font-medium text-slate-100">Notification settings</h1><p className="mt-1 text-xs text-slate-500">Choose where server-side alerts are delivered.</p></header>
    {mutation.isError && <ErrorMessage message={mutation.error.message} />}
    {toggleMutation.isError && <ErrorMessage message={toggleMutation.error.message} />}
    {localError && <ErrorMessage message={localError} />}
    <section className="space-y-3">
      <article className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
        <div className="flex items-start justify-between gap-4"><div><h2 className="text-sm font-medium">In-app notifications</h2><p className="mt-1 text-[10px] text-slate-500">Unread alert bell, trigger history, and live event updates.</p></div>
          <Toggle checked={getChannel("in-app")?.enabled ?? true} onChange={(enabled) => toggleMutation.mutate({ type: "in-app", enabled })} />
        </div>
      </article>
      <article className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
        <div className="mb-3 flex items-start justify-between gap-4"><div><h2 className="text-sm font-medium">Email</h2><p className="mt-1 text-[10px] text-slate-500">Email is sent through Resend. The recipient is encrypted at rest.</p></div><span className="text-[10px] text-slate-500">{getChannel("email")?.label || "Not configured"}</span></div>
        <div className="flex flex-wrap gap-2"><input className="terminal-input min-w-60 flex-1" type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} placeholder="you@example.com" /><button className="terminal-button terminal-button-primary" disabled={mutation.isPending || !email} onClick={() => mutation.mutate({ type: "email", enabled: true, email })}>Save and enable</button>{getChannel("email")?.configured && <button className="terminal-button" disabled={toggleMutation.isPending} onClick={() => toggleMutation.mutate({ type: "email", enabled: !getChannel("email")?.enabled })}>{getChannel("email")?.enabled ? "Disable" : "Enable"}</button>}</div>
      </article>
      <article className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
        <div className="mb-3 flex items-start justify-between gap-4"><div><h2 className="text-sm font-medium">Web Push</h2><p className="mt-1 text-[10px] text-slate-500">Requires HTTPS (localhost is supported), browser permission, and VAPID keys.</p></div><span className="text-[10px] text-slate-500">{getChannel("push")?.enabled ? "Enabled" : "Disabled"}</span></div>
        <div className="flex gap-2"><button className="terminal-button terminal-button-primary" disabled={mutation.isPending || toggleMutation.isPending} onClick={() => void enablePush().catch((error: unknown) => setLocalError(errorMessage(error)))}>Enable push notifications</button><button className="terminal-button" disabled={mutation.isPending || toggleMutation.isPending} onClick={() => void disablePush().catch((error: unknown) => setLocalError(errorMessage(error)))}>Disable</button></div>
      </article>
      <article className="rounded-lg border border-[var(--border)] bg-[var(--panel)] p-4">
        <div className="mb-3 flex items-start justify-between gap-4"><div><h2 className="text-sm font-medium">Signed webhook</h2><p className="mt-1 text-[10px] text-slate-500">HTTPS only, public DNS destinations only, redirects disabled; requests use HMAC-SHA256 signatures.</p></div><span className="text-[10px] text-slate-500">{getChannel("webhook")?.label || "Not configured"}</span></div>
        <div className="grid gap-2 md:grid-cols-2"><input className="terminal-input" type="url" value={webhookUrl} onChange={(event) => setWebhookUrl(event.target.value)} placeholder="https://hooks.example.com/alerts" /><input className="terminal-input" type="password" autoComplete="new-password" value={webhookSecret} onChange={(event) => setWebhookSecret(event.target.value)} placeholder="Signing secret (32+ characters)" /></div>
        <div className="mt-2 flex gap-2"><button className="terminal-button terminal-button-primary" disabled={mutation.isPending || !webhookUrl || webhookSecret.length < 32} onClick={() => mutation.mutate({ type: "webhook", enabled: true, url: webhookUrl, secret: webhookSecret }, { onSuccess: () => setWebhookSecret("") })}>Save and enable</button>{getChannel("webhook")?.configured && <button className="terminal-button" disabled={toggleMutation.isPending} onClick={() => toggleMutation.mutate({ type: "webhook", enabled: !getChannel("webhook")?.enabled })}>{getChannel("webhook")?.enabled ? "Disable" : "Enable"}</button>}</div>
      </article>
    </section>
    <p className="mt-4 text-[10px] text-slate-600">Sensitive channel configurations and push subscriptions are encrypted with AES-256-GCM. Configure <code>ALERTS_ENCRYPTION_KEY</code> before saving email or webhook settings.</p>
  </main>;
}

function Toggle({ checked, onChange }: { checked: boolean; onChange: (checked: boolean) => void }) {
  return <button type="button" aria-pressed={checked} aria-label={checked ? "Disable channel" : "Enable channel"} className={`rounded border px-2 py-1 text-[10px] ${checked ? "border-emerald-500/30 text-emerald-300" : "border-[var(--border)] text-slate-500"}`} onClick={() => onChange(!checked)}>{checked ? "Enabled" : "Disabled"}</button>;
}

function ErrorMessage({ message }: { message: string }) {
  return <div role="alert" className="mb-3 rounded border border-rose-500/30 bg-rose-500/5 px-3 py-2 text-xs text-rose-300">{message}</div>;
}

function errorMessage(value: unknown): string {
  return typeof value === "object" && value !== null && "error" in value && typeof value.error === "string"
    ? value.error
    : value instanceof Error ? value.message : "Notification request failed.";
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");
  const bytes = Uint8Array.from(atob(padded), (char) => char.charCodeAt(0));
  return bytes as Uint8Array<ArrayBuffer>;
}
