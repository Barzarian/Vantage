import { createHmac } from "node:crypto";
import { lookup as dnsLookup } from "node:dns/promises";
import { isIP } from "node:net";
import https from "node:https";
import webPush from "web-push";
import { env } from "@/lib/market-data/env";
import type { AlertEvent } from "./model";
import {
  getEnabledChannelConfigs,
  listPushSubscriptions,
  removePushSubscription,
  updateAlertEventDelivery,
} from "./service";

type DeliveryResult = AlertEvent["deliveryResults"][string];

export type AlertEmailMessage = {
  to: string;
  subject: string;
  text: string;
  idempotencyKey: string;
};
export type AlertEmailAdapter = (message: AlertEmailMessage) => Promise<void>;

let emailAdapter: AlertEmailAdapter = sendWithResend;

export function registerAlertEmailAdapter(adapter: AlertEmailAdapter): void {
  emailAdapter = adapter;
}

export async function deliverAlertEvent(userId: string, event: AlertEvent): Promise<AlertEvent["deliveryResults"]> {
  const results: AlertEvent["deliveryResults"] = { ...event.deliveryResults };
  const channels = await getEnabledChannelConfigs(userId);
  for (const channel of channels) {
    if (channel.type === "in-app") continue;
    const previousResult = results[channel.type];
    if (previousResult?.status === "delivered" || previousResult?.status === "skipped") continue;
    if (previousResult?.status === "failed" && Date.now() - Date.parse(previousResult.attemptedAt) < 60_000) continue;
    const attemptedAt = new Date().toISOString();
    try {
      if (channel.type === "email") {
        await sendEmail(event, channel.config?.email);
        results.email = { status: "delivered", attemptedAt };
      } else if (channel.type === "webhook") {
        await sendWebhook(event, channel.config?.url, channel.config?.secret);
        results.webhook = { status: "delivered", attemptedAt };
      } else if (channel.type === "push") {
        results.push = await sendPush(userId, event, attemptedAt);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Delivery failed.";
      results[channel.type] = { status: "failed", message, attemptedAt };
      console.error(`[alerts:delivery] ${channel.type} delivery failed for event ${event.id}: ${message}`);
    }
    await updateAlertEventDelivery(userId, event.id, results);
  }
  return results;
}

async function sendEmail(event: AlertEvent, email: string | undefined): Promise<void> {
  if (!email) throw new Error("No email recipient is configured.");
  await emailAdapter({
    to: email,
    subject: `Market alert: ${event.summary}`,
    text: `${event.summary}\nTriggered at ${event.triggeredAt}.`,
    idempotencyKey: event.id,
  });
}

async function sendWithResend(message: AlertEmailMessage): Promise<void> {
  if (!env.RESEND_API_KEY || !env.ALERTS_EMAIL_FROM) {
    throw new Error("Email delivery requires RESEND_API_KEY and ALERTS_EMAIL_FROM.");
  }
  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.RESEND_API_KEY}`,
      "Content-Type": "application/json",
      "Idempotency-Key": message.idempotencyKey,
    },
    body: JSON.stringify({
      from: env.ALERTS_EMAIL_FROM,
      to: [message.to],
      subject: message.subject,
      text: message.text,
    }),
    redirect: "error",
    signal: AbortSignal.timeout(8_000),
  });
  if (!response.ok) throw new Error(`Email provider returned HTTP ${response.status}.`);
}

async function sendWebhook(event: AlertEvent, endpoint: string | undefined, secret: string | undefined): Promise<void> {
  if (!endpoint || !secret) throw new Error("Webhook URL and signing secret are not configured.");
  const url = new URL(endpoint);
  if (url.protocol !== "https:" || url.username || url.password || url.port && url.port !== "443") {
    throw new Error("Webhook URL must use HTTPS on the default port and cannot include credentials.");
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await resolvePublicAddresses(hostname);
  const address = addresses[0]!;
  const body = JSON.stringify({
    id: event.id,
    alertId: event.alertId,
    summary: event.summary,
    value: event.triggerValue,
    triggeredAt: event.triggeredAt,
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
  await new Promise<void>((resolve, reject) => {
    const request = https.request({
      protocol: "https:",
      hostname,
      port: 443,
      path: `${url.pathname}${url.search}`,
      method: "POST",
      servername: isIP(hostname) ? undefined : hostname,
      lookup: (_hostname, _options, callback) => callback(null, address.address, address.family),
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
        "X-Vantage-Timestamp": timestamp,
        "X-Vantage-Signature": `sha256=${signature}`,
        "X-Vantage-Event-Id": event.id,
      },
    }, (response) => {
      response.resume();
      response.once("end", () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) resolve();
        else reject(new Error(`Webhook returned HTTP ${response.statusCode ?? "unknown"}.`));
      });
    });
    request.setTimeout(5_000, () => request.destroy(new Error("Webhook timed out.")));
    request.once("error", reject);
    request.end(body);
  });
}

async function sendPush(userId: string, event: AlertEvent, attemptedAt: string): Promise<DeliveryResult> {
  const subscriptions = await listPushSubscriptions(userId);
  if (!subscriptions.length) {
    return { status: "skipped", message: "No push subscriptions are registered.", attemptedAt };
  }
  if (!env.ALERTS_VAPID_PUBLIC_KEY || !env.ALERTS_VAPID_PRIVATE_KEY || !env.ALERTS_VAPID_SUBJECT) {
    throw new Error("Web Push delivery requires VAPID public key, private key, and subject.");
  }
  webPush.setVapidDetails(
    env.ALERTS_VAPID_SUBJECT,
    env.ALERTS_VAPID_PUBLIC_KEY,
    env.ALERTS_VAPID_PRIVATE_KEY,
  );
  const payload = JSON.stringify({ title: "Vantage market alert", body: event.summary, url: "/alerts", eventId: event.id });
  const outcomes = await Promise.allSettled(subscriptions.map(async (subscription) => {
    if (!isAllowedPushEndpoint(subscription.endpoint)) throw new Error("Unsupported push endpoint.");
    const endpointUrl = new URL(subscription.endpoint);
    await resolvePublicAddresses(endpointUrl.hostname);
    try {
      await webPush.sendNotification(subscription, payload, { TTL: 60 * 60 });
    } catch (error) {
      const statusCode = typeof error === "object" && error !== null && "statusCode" in error
        ? Number(error.statusCode) : null;
      if (statusCode === 404 || statusCode === 410) {
        await removePushSubscription(userId, subscription.endpoint);
      }
      throw error;
    }
  }));
  const delivered = outcomes.filter((outcome) => outcome.status === "fulfilled").length;
  const failed = outcomes.length - delivered;
  if (delivered > 0) {
    return {
      status: "delivered",
      ...(failed ? { message: `${failed} push subscription(s) failed.` } : {}),
      attemptedAt,
    };
  }
  return { status: "failed", message: "All push subscriptions failed.", attemptedAt };
}

function isAllowedPushEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    const hostname = url.hostname.toLowerCase();
    return url.protocol === "https:" && (!url.port || url.port === "443") &&
      ((hostname === "fcm.googleapis.com" && url.pathname.startsWith("/fcm/send/")) ||
        (hostname === "updates.push.services.mozilla.com" && url.pathname.startsWith("/wpush/v2/")) ||
        (hostname === "web.push.apple.com" && url.pathname.startsWith("/")) ||
        (/^[a-z0-9-]+\.notify\.windows\.com$/.test(hostname) && url.pathname.startsWith("/")));
  } catch {
    return false;
  }
}

async function resolvePublicAddresses(hostname: string): Promise<Array<{ address: string; family: number }>> {
  const normalized = hostname.replace(/^\[|\]$/g, "");
  const literalFamily = isIP(normalized);
  const addresses = literalFamily
    ? [{ address: normalized, family: literalFamily }]
    : await dnsLookup(normalized, { all: true, verbatim: true });
  if (!addresses.length || addresses.some(({ address }) => !isGloballyRoutable(address))) {
    throw new Error("Webhook hostname resolves to a private or reserved address.");
  }
  return addresses;
}

function isGloballyRoutable(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const octets = address.split(".").map(Number);
    const [a, b, c] = octets;
    if (octets.length !== 4 || octets.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
    return !(
      a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b! >= 64 && b! <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b! >= 16 && b! <= 31) ||
      (a === 192 && (b === 0 || b === 168)) ||
      (a === 192 && b === 0 && c === 2) ||
      (a === 198 && (b === 18 || b === 19 || b === 51 && c === 100)) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (family !== 6) return false;
  const value = address.toLowerCase();
  if (value === "::" || value === "::1" || value.startsWith("fe") &&
      ["fe8", "fe9", "fea", "feb"].some((prefix) => value.startsWith(prefix))) return false;
  if (value.startsWith("fc") || value.startsWith("fd") || value.startsWith("ff") ||
      value.startsWith("::ffff:") || value.startsWith("2001:db8:")) return false;
  return /^2[0-9a-f]{3}:|^3[0-9a-f]{3}:/.test(value);
}
