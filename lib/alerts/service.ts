import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { and, desc, eq, gte, lte, sql } from "drizzle-orm";
import { getDatabase } from "@/db/client";
import { alertEvents, alerts, notificationChannels, pushSubscriptions } from "@/db/schema";
import {
  alertConditionSchema,
  alertEventSchema,
  alertEvaluationStateSchema,
  alertInputSchema,
  alertSchema,
  notificationChannelInputSchema,
  notificationChannelToggleSchema,
  notificationChannelTypeSchema,
  pushSubscriptionSchema,
  type Alert,
  type AlertEvent,
  type AlertInput,
  type AlertEvaluationState,
  type NotificationChannelType,
  type PushSubscriptionInput,
} from "./model";
import {
  alertSummary,
  emptyAlertEvaluationState,
  evaluateAlert,
  type AlertMetrics,
} from "./evaluator";

type ChannelSummary = {
  type: NotificationChannelType;
  enabled: boolean;
  label: string;
  configured: boolean;
};

type MemoryUserData = {
  alerts: Alert[];
  events: AlertEvent[];
  channels: Array<ChannelSummary & { encryptedConfig: string | null }>;
  pushSubscriptions: Map<string, string>;
};

declare global {
  var alertMemoryByUser: Map<string, MemoryUserData> | undefined;
}

export class AlertServiceError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "AlertServiceError";
  }
}

export function getAlertMemory(userId: string): MemoryUserData {
  globalThis.alertMemoryByUser ??= new Map();
  let data = globalThis.alertMemoryByUser.get(userId);
  if (!data) {
    data = { alerts: [], events: [], channels: [], pushSubscriptions: new Map() };
    globalThis.alertMemoryByUser.set(userId, data);
  }
  return data;
}

export async function listAlerts(userId: string): Promise<Alert[]> {
  const database = getDatabase();
  if (!database) return structuredClone(getAlertMemory(userId).alerts);
  const rows = await database.db.select().from(alerts).where(eq(alerts.userId, userId)).orderBy(desc(alerts.updatedAt));
  return rows.map(mapAlertRow);
}

export async function listActiveAlertsForWorker(): Promise<Alert[]> {
  const database = getDatabase();
  if (database) {
    const rows = await database.db.select().from(alerts).where(eq(alerts.active, true));
    return rows.map(mapAlertRow);
  }
  return [...(globalThis.alertMemoryByUser?.values() ?? [])]
    .flatMap((data) => data.alerts.filter((alert) => alert.active));
}

export async function listRecentAlertEventsForWorker(): Promise<AlertEvent[]> {
  const database = getDatabase();
  if (!database) {
    return [...(globalThis.alertMemoryByUser?.entries() ?? [])]
      .flatMap(([userId, data]) => data.events.map((event) => ({ userId, event })))
      .sort((left, right) => right.event.triggeredAt.localeCompare(left.event.triggeredAt))
      .slice(0, 1000)
      .map(({ event }) => structuredClone(event));
  }
  const rows = await database.db.select().from(alertEvents)
    .where(gte(alertEvents.triggeredAt, new Date(Date.now() - 7 * 86_400_000)))
    .orderBy(desc(alertEvents.triggeredAt)).limit(1000);
  return rows.map(mapEventRow);
}

export async function saveAlert(userId: string, input: unknown, id?: string): Promise<Alert> {
  const parsed = alertInputSchema.parse(input);
  if (parsed.assetClass === "portfolio" && parsed.symbol !== "PORTFOLIO") {
    throw new AlertServiceError("Portfolio alerts must use the PORTFOLIO symbol.", 400);
  }
  if (parsed.assetClass !== "portfolio" && parsed.symbol === "PORTFOLIO") {
    throw new AlertServiceError("PORTFOLIO is only valid for portfolio alerts.", 400);
  }
  const now = new Date();
  const database = getDatabase();
  if (!database) {
    const data = getAlertMemory(userId);
    if (id) {
      const index = data.alerts.findIndex((alert) => alert.id === id);
      if (index < 0) throw new AlertServiceError("Alert not found.", 404);
      const updated = alertSchema.parse({
        ...parsed,
        id,
        userId,
        evaluationState: emptyAlertEvaluationState(),
        lastTriggeredAt: null,
        lastEvaluatedAt: null,
        createdAt: data.alerts[index]!.createdAt,
        updatedAt: now.toISOString(),
      });
      data.alerts[index] = updated;
      return structuredClone(updated);
    }
    if (data.alerts.length >= 100) throw new AlertServiceError("A maximum of 100 alerts is allowed per user.", 429);
    const created = alertSchema.parse({
      ...parsed,
      id: randomBytes(16).toString("hex"),
      userId,
      evaluationState: emptyAlertEvaluationState(),
      lastTriggeredAt: null,
      lastEvaluatedAt: null,
      createdAt: now.toISOString(),
      updatedAt: now.toISOString(),
    });
    data.alerts.unshift(created);
    return structuredClone(created);
  }

  if (id) {
    const [updated] = await database.db.update(alerts).set({
      ...toAlertValues(parsed),
      evaluationState: {},
      lastTriggeredAt: null,
      lastEvaluatedAt: null,
      updatedAt: now,
    }).where(and(eq(alerts.id, id), eq(alerts.userId, userId))).returning();
    if (!updated) throw new AlertServiceError("Alert not found.", 404);
    return mapAlertRow(updated);
  }

  const ownedRows = await database.db.select({ id: alerts.id }).from(alerts).where(eq(alerts.userId, userId)).limit(100);
  if (ownedRows.length >= 100) throw new AlertServiceError("A maximum of 100 alerts is allowed per user.", 429);
  const [created] = await database.db.insert(alerts).values({
    id: randomBytes(16).toString("hex"),
    userId,
    ...toAlertValues(parsed),
  }).returning();
  if (!created) throw new Error("Could not create alert.");
  return mapAlertRow(created);
}

export async function setAlertActive(userId: string, id: string, active: boolean): Promise<Alert> {
  const database = getDatabase();
  if (!database) {
    const alert = getAlertMemory(userId).alerts.find((item) => item.id === id);
    if (!alert) throw new AlertServiceError("Alert not found.", 404);
    alert.active = active;
    if (active) {
      alert.evaluationState = emptyAlertEvaluationState();
      alert.lastTriggeredAt = null;
      alert.lastEvaluatedAt = null;
    }
    alert.updatedAt = new Date().toISOString();
    return structuredClone(alert);
  }
  const [updated] = await database.db.update(alerts)
    .set({
      active,
      ...(active ? { evaluationState: emptyAlertEvaluationState(), lastTriggeredAt: null, lastEvaluatedAt: null } : {}),
      updatedAt: new Date(),
    })
    .where(and(eq(alerts.id, id), eq(alerts.userId, userId)))
    .returning();
  if (!updated) throw new AlertServiceError("Alert not found.", 404);
  return mapAlertRow(updated);
}

export async function deleteAlert(userId: string, id: string): Promise<void> {
  const database = getDatabase();
  if (!database) {
    const data = getAlertMemory(userId);
    const index = data.alerts.findIndex((item) => item.id === id);
    if (index < 0) throw new AlertServiceError("Alert not found.", 404);
    data.alerts.splice(index, 1);
    data.events = data.events.filter((event) => event.alertId !== id);
    return;
  }
  const deleted = await database.db.delete(alerts).where(and(eq(alerts.id, id), eq(alerts.userId, userId))).returning({ id: alerts.id });
  if (!deleted.length) throw new AlertServiceError("Alert not found.", 404);
}

export async function listAlertEvents(userId: string, filters: { alertId?: string; symbol?: string; from?: string; to?: string } = {}): Promise<AlertEvent[]> {
  const database = getDatabase();
  if (!database) {
    return structuredClone(getAlertMemory(userId).events
      .filter((event) => !filters.alertId || event.alertId === filters.alertId)
      .filter((event) => !filters.from || event.triggeredAt >= filters.from)
      .filter((event) => !filters.to || event.triggeredAt <= filters.to)
      .filter((event) => {
        if (!filters.symbol) return true;
        return getAlertMemory(userId).alerts.some((alert) => alert.id === event.alertId && alert.symbol === filters.symbol!.toUpperCase());
      })
      .sort((a, b) => b.triggeredAt.localeCompare(a.triggeredAt))
      .slice(0, 500));
  }
  const conditions = [eq(alertEvents.userId, userId)];
  if (filters.alertId) conditions.push(eq(alertEvents.alertId, filters.alertId));
  if (filters.from) conditions.push(gte(alertEvents.triggeredAt, new Date(filters.from)));
  if (filters.to) conditions.push(lte(alertEvents.triggeredAt, new Date(filters.to)));
  const rows = await database.db.select().from(alertEvents)
    .where(and(...conditions)).orderBy(desc(alertEvents.triggeredAt)).limit(500);
  const events = rows.map(mapEventRow);
  if (!filters.symbol) return events;
  const symbol = filters.symbol.trim().toUpperCase();
  const userAlerts = await database.db.select({ id: alerts.id }).from(alerts)
    .where(and(eq(alerts.userId, userId), eq(alerts.symbol, symbol)));
  const ids = new Set(userAlerts.map((item) => item.id));
  return events.filter((event) => ids.has(event.alertId));
}

export async function getUnreadAlertCount(userId: string): Promise<number> {
  const database = getDatabase();
  if (!database) return getAlertMemory(userId).events.filter((event) => event.readAt === null).length;
  const [row] = await database.db.select({ count: sql<number>`count(*)::int` }).from(alertEvents)
    .where(and(eq(alertEvents.userId, userId), sql`${alertEvents.readAt} IS NULL`));
  return row?.count ?? 0;
}

export async function markAlertEventRead(userId: string, id: string): Promise<void> {
  const now = new Date();
  const database = getDatabase();
  if (!database) {
    const event = getAlertMemory(userId).events.find((item) => item.id === id);
    if (!event) throw new AlertServiceError("Alert event not found.", 404);
    event.readAt = now.toISOString();
    return;
  }
  const [updated] = await database.db.update(alertEvents).set({ readAt: now })
    .where(and(eq(alertEvents.id, id), eq(alertEvents.userId, userId))).returning({ id: alertEvents.id });
  if (!updated) throw new AlertServiceError("Alert event not found.", 404);
}

export async function listNotificationChannels(userId: string): Promise<ChannelSummary[]> {
  const database = getDatabase();
  if (!database) {
    const channels = getAlertMemory(userId).channels;
    const hasPushSubscription = getAlertMemory(userId).pushSubscriptions.size > 0;
    return ["in-app", "email", "push", "webhook"].map((type) => {
      const item = channels.find((channel) => channel.type === type);
      return item
        ? { type: item.type, enabled: item.enabled, label: item.label, configured: type === "push" ? hasPushSubscription : item.configured }
        : { type: notificationChannelTypeSchema.parse(type), enabled: type === "in-app", label: "", configured: type === "in-app" || type === "push" && hasPushSubscription };
    });
  }
  const rows = await database.db.select().from(notificationChannels).where(eq(notificationChannels.userId, userId));
  const pushRows = await database.db.select({ id: pushSubscriptions.id }).from(pushSubscriptions)
    .where(eq(pushSubscriptions.userId, userId)).limit(1);
  return ["in-app", "email", "push", "webhook"].map((type) => {
    const item = rows.find((row) => row.type === type);
    return {
      type: notificationChannelTypeSchema.parse(type),
      enabled: item?.enabled ?? type === "in-app",
      label: item?.label ?? "",
      configured: type === "in-app" || type === "push" ? type === "in-app" || pushRows.length > 0 : Boolean(item?.encryptedConfig),
    };
  });
}

export async function saveNotificationChannel(userId: string, input: unknown): Promise<ChannelSummary> {
  const parsed = notificationChannelInputSchema.parse(input);
  const encryptedConfig = parsed.type === "email" || parsed.type === "webhook"
    ? encryptConfig(channelSecret(parsed))
    : null;
  const label = parsed.type === "email" ? maskEmail(parsed.email)
    : parsed.type === "webhook" ? safeHostLabel(parsed.url)
    : parsed.type === "push" ? "Web Push" : "In-app notifications";
  const database = getDatabase();
  if (!database) {
    const data = getAlertMemory(userId);
    const item = { type: parsed.type, enabled: parsed.enabled, label, configured: Boolean(encryptedConfig), encryptedConfig };
    const index = data.channels.findIndex((channel) => channel.type === parsed.type);
    if (index < 0) data.channels.push(item);
    else data.channels[index] = item;
    return { type: item.type, enabled: item.enabled, label: item.label, configured: item.configured };
  }
  const [saved] = await database.db.insert(notificationChannels).values({
    id: randomBytes(16).toString("hex"),
    userId,
    type: parsed.type,
    enabled: parsed.enabled,
    encryptedConfig,
    label,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [notificationChannels.userId, notificationChannels.type],
    set: { enabled: parsed.enabled, encryptedConfig, label, updatedAt: new Date() },
  }).returning();
  if (!saved) throw new Error("Could not save notification channel.");
  return { type: parsed.type, enabled: saved.enabled, label: saved.label, configured: Boolean(saved.encryptedConfig) };
}

export async function setNotificationChannelEnabled(userId: string, input: unknown): Promise<ChannelSummary> {
  const parsed = notificationChannelToggleSchema.parse(input);
  const database = getDatabase();
  const data = getAlertMemory(userId);
  let pushConfigured = false;
  if (parsed.type === "push") {
    pushConfigured = database
      ? (await database.db.select({ id: pushSubscriptions.id }).from(pushSubscriptions)
        .where(eq(pushSubscriptions.userId, userId)).limit(1)).length > 0
      : data.pushSubscriptions.size > 0;
    if (parsed.enabled && !pushConfigured) {
      throw new AlertServiceError("Register a push subscription before enabling Web Push.", 409);
    }
  }

  if (!database) {
    let channel = data.channels.find((item) => item.type === parsed.type);
    if (parsed.enabled && (parsed.type === "email" || parsed.type === "webhook") &&
        (!channel?.configured || !channel.encryptedConfig)) {
      throw new AlertServiceError(`Configure ${parsed.type} before enabling it.`, 409);
    }
    if (!channel) {
      channel = {
        type: parsed.type,
        enabled: parsed.enabled,
        label: parsed.type === "push" ? "Web Push" : parsed.type === "in-app" ? "In-app notifications" : "",
        configured: parsed.type === "in-app",
        encryptedConfig: null,
      };
      data.channels.push(channel);
    } else {
      channel.enabled = parsed.enabled;
    }
    return { type: channel.type, enabled: channel.enabled, label: channel.label, configured: channel.configured };
  }

  const existing = await database.db.select().from(notificationChannels)
    .where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.type, parsed.type))).limit(1);
  const current = existing[0];
  if (parsed.enabled && (parsed.type === "email" || parsed.type === "webhook") && !current?.encryptedConfig) {
    throw new AlertServiceError(`Configure ${parsed.type} before enabling it.`, 409);
  }
  const label = current?.label ?? (parsed.type === "push" ? "Web Push" : "In-app notifications");
  const [saved] = await database.db.insert(notificationChannels).values({
    id: randomBytes(16).toString("hex"),
    userId,
    type: parsed.type,
    enabled: parsed.enabled,
    encryptedConfig: current?.encryptedConfig ?? null,
    label,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [notificationChannels.userId, notificationChannels.type],
    set: { enabled: parsed.enabled, updatedAt: new Date() },
  }).returning();
  if (!saved) throw new Error("Could not update notification channel.");
  return {
    type: parsed.type,
    enabled: saved.enabled,
    label: saved.label,
    configured: parsed.type === "in-app" || parsed.type === "push" ? parsed.type === "in-app" || pushConfigured : Boolean(saved.encryptedConfig),
  };
}

export async function getEnabledChannelConfigs(userId: string): Promise<Array<{
  type: NotificationChannelType;
  config: Record<string, string> | null;
}>> {
  const database = getDatabase();
  const rows = database
    ? await database.db.select().from(notificationChannels)
      .where(and(eq(notificationChannels.userId, userId), eq(notificationChannels.enabled, true)))
    : getAlertMemory(userId).channels.filter((channel) => channel.enabled).map((channel) => ({
      type: channel.type,
      encryptedConfig: channel.encryptedConfig,
    }));
  return rows.map((row) => ({
    type: notificationChannelTypeSchema.parse(row.type),
    config: row.encryptedConfig ? decryptConfig(row.encryptedConfig) : null,
  }));
}

export async function savePushSubscription(userId: string, input: unknown): Promise<void> {
  const parsed = pushSubscriptionSchema.parse(input);
  assertPushEndpoint(parsed.endpoint);
  const endpointHash = createHash("sha256").update(parsed.endpoint).digest("hex");
  const encryptedSubscription = encryptConfig(parsed);
  const database = getDatabase();
  if (!database) {
    getAlertMemory(userId).pushSubscriptions.set(endpointHash, encryptedSubscription);
    return;
  }
  await database.db.insert(pushSubscriptions).values({
    id: randomBytes(16).toString("hex"),
    userId,
    endpointHash,
    encryptedSubscription,
    updatedAt: new Date(),
  }).onConflictDoUpdate({
    target: [pushSubscriptions.userId, pushSubscriptions.endpointHash],
    set: { encryptedSubscription, updatedAt: new Date() },
  });
}

export async function removePushSubscription(userId: string, endpoint: string): Promise<void> {
  const endpointHash = createHash("sha256").update(endpoint).digest("hex");
  const database = getDatabase();
  if (!database) {
    getAlertMemory(userId).pushSubscriptions.delete(endpointHash);
    return;
  }
  await database.db.delete(pushSubscriptions)
    .where(and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpointHash, endpointHash)));
}

export async function listPushSubscriptions(userId: string): Promise<PushSubscriptionInput[]> {
  const database = getDatabase();
  if (!database) {
    return [...getAlertMemory(userId).pushSubscriptions.values()].map((value) =>
      pushSubscriptionSchema.parse(decryptConfig(value)),
    );
  }
  const rows = await database.db.select().from(pushSubscriptions).where(eq(pushSubscriptions.userId, userId));
  return rows.map((row) => pushSubscriptionSchema.parse(decryptConfig(row.encryptedSubscription)));
}

export async function evaluateAndRecordAlert(
  userId: string,
  alertId: string,
  metrics: AlertMetrics,
  now = new Date(),
): Promise<{ alert: Alert; event: AlertEvent | null }> {
  const database = getDatabase();
  if (!database) {
    const data = getAlertMemory(userId);
    const alert = data.alerts.find((item) => item.id === alertId && item.userId === userId);
    if (!alert || !alert.active) throw new AlertServiceError("Active alert not found.", 404);
    const result = evaluateAlert(
      alert.condition,
      metrics,
      parseEvaluationState(alert),
      alert.triggerMode,
      alert.cooldownSeconds,
      now,
    );
    alert.lastEvaluatedAt = now.toISOString();
    alert.evaluationState = result.state;
    alert.updatedAt = now.toISOString();
    if (!result.shouldTrigger) return { alert: structuredClone(alert), event: null };
    alert.lastTriggeredAt = now.toISOString();
    if (alert.triggerMode === "once") alert.active = false;
    const idempotencyKey = createIdempotencyKey(alert, now);
    if (data.events.some((event) => event.alertId === alertId && event.idempotencyKey === idempotencyKey)) {
      return { alert: structuredClone(alert), event: null };
    }
    const event = alertEventSchema.parse({
      id: randomBytes(16).toString("hex"),
      alertId,
      userId,
      idempotencyKey,
      triggerValue: result.value,
      summary: alertSummary(alert, result.value),
      deliveryResults: { "in-app": { status: "delivered", attemptedAt: now.toISOString() } },
      readAt: null,
      triggeredAt: now.toISOString(),
    });
    data.events.unshift(event);
    return { alert: structuredClone(alert), event: structuredClone(event) };
  }

  return database.db.transaction(async (tx) => {
    const [row] = await tx.select().from(alerts)
      .where(and(eq(alerts.id, alertId), eq(alerts.userId, userId), eq(alerts.active, true)))
      .for("update");
    if (!row) throw new AlertServiceError("Active alert not found.", 404);
    const alert = mapAlertRow(row);
    const result = evaluateAlert(
      alert.condition,
      metrics,
      parseEvaluationState(alert),
      alert.triggerMode,
      alert.cooldownSeconds,
      now,
    );
    const updates = {
      evaluationState: result.state,
      lastEvaluatedAt: now,
      updatedAt: now,
      ...(result.shouldTrigger ? {
        lastTriggeredAt: now,
        active: alert.triggerMode === "once" ? false : true,
      } : {}),
    };
    const [updatedRow] = await tx.update(alerts).set(updates)
      .where(and(eq(alerts.id, alert.id), eq(alerts.userId, userId))).returning();
    if (!updatedRow) throw new Error("Could not save alert evaluation state.");
    let event: AlertEvent | null = null;
    if (result.shouldTrigger) {
      const idempotencyKey = createIdempotencyKey(alert, now);
      const [createdEvent] = await tx.insert(alertEvents).values({
        id: randomBytes(16).toString("hex"),
        alertId,
        userId,
        idempotencyKey,
        triggerValue: result.value === null ? null : String(result.value),
        summary: alertSummary(alert, result.value),
        deliveryResults: { "in-app": { status: "delivered", attemptedAt: now.toISOString() } },
        triggeredAt: now,
      }).onConflictDoNothing({
        target: [alertEvents.alertId, alertEvents.idempotencyKey],
      }).returning();
      if (createdEvent) event = mapEventRow(createdEvent);
    }
    return { alert: mapAlertRow(updatedRow), event };
  });
}

export async function updateAlertEventDelivery(userId: string, eventId: string, results: AlertEvent["deliveryResults"]): Promise<void> {
  const database = getDatabase();
  if (!database) {
    const event = getAlertMemory(userId).events.find((item) => item.id === eventId);
    if (!event) throw new AlertServiceError("Alert event not found.", 404);
    event.deliveryResults = results;
    return;
  }
  const updated = await database.db.update(alertEvents).set({ deliveryResults: results })
    .where(and(eq(alertEvents.id, eventId), eq(alertEvents.userId, userId))).returning({ id: alertEvents.id });
  if (!updated.length) throw new AlertServiceError("Alert event not found.", 404);
}

function mapAlertRow(row: typeof alerts.$inferSelect): Alert {
  return alertSchema.parse({
    id: row.id,
    userId: row.userId,
    name: row.name,
    symbol: row.symbol,
    assetClass: row.assetClass,
    condition: alertConditionSchema.parse(row.condition),
    triggerMode: row.triggerMode,
    cooldownSeconds: row.cooldownSeconds,
    active: row.active,
    onlyRegularHours: row.onlyRegularHours,
    maxJumpPercent: Number(row.maxJumpPercent),
    lastTriggeredAt: row.lastTriggeredAt?.toISOString() ?? null,
    lastEvaluatedAt: row.lastEvaluatedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    evaluationState: alertEvaluationStateSchema.parse(row.evaluationState),
  });
}

function mapEventRow(row: typeof alertEvents.$inferSelect): AlertEvent {
  return alertEventSchema.parse({
    id: row.id,
    alertId: row.alertId,
    userId: row.userId,
    idempotencyKey: row.idempotencyKey,
    triggerValue: row.triggerValue === null ? null : Number(row.triggerValue),
    summary: row.summary,
    deliveryResults: row.deliveryResults,
    readAt: row.readAt?.toISOString() ?? null,
    triggeredAt: row.triggeredAt.toISOString(),
  });
}

function toAlertValues(input: AlertInput) {
  return {
    name: input.name,
    symbol: input.symbol,
    assetClass: input.assetClass,
    condition: input.condition,
    triggerMode: input.triggerMode,
    cooldownSeconds: input.cooldownSeconds,
    active: input.active,
    onlyRegularHours: input.onlyRegularHours,
    maxJumpPercent: String(input.maxJumpPercent),
  };
}

function parseEvaluationState(alert: Alert): AlertEvaluationState {
  return {
    ...alert.evaluationState,
    previousValues: { ...alert.evaluationState.previousValues },
    lastTriggeredAt: alert.evaluationState.lastTriggeredAt ?? alert.lastTriggeredAt,
    fired: alert.evaluationState.fired,
  };
}

function createIdempotencyKey(alert: Alert, now: Date): string {
  return `${alert.triggerMode}:${now.getTime()}`;
}

function channelSecret(input: Exclude<ReturnType<typeof notificationChannelInputSchema.parse>, { type: "in-app" }>) {
  if (input.type === "email") return { email: input.email };
  if (input.type === "push") return {};
  return { url: input.url, secret: input.secret };
}

function encryptionKey(): Buffer {
  const encoded = process.env.ALERTS_ENCRYPTION_KEY;
  if (!encoded) throw new AlertServiceError("ALERTS_ENCRYPTION_KEY must be configured to save this channel.", 503);
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32) throw new AlertServiceError("ALERTS_ENCRYPTION_KEY must be a base64-encoded 32-byte key.", 503);
  return key;
}

function encryptConfig(value: unknown): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
  return [iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), ciphertext.toString("base64url")].join(".");
}

function decryptConfig(value: string): Record<string, string> {
  const [ivText, tagText, ciphertextText, extra] = value.split(".");
  if (!ivText || !tagText || !ciphertextText || extra !== undefined) throw new Error("Stored notification configuration is malformed.");
  const decipher = createDecipheriv("aes-256-gcm", encryptionKey(), Buffer.from(ivText, "base64url"));
  decipher.setAuthTag(Buffer.from(tagText, "base64url"));
  const cleartext = Buffer.concat([
    decipher.update(Buffer.from(ciphertextText, "base64url")),
    decipher.final(),
  ]).toString("utf8");
  const parsed: unknown = JSON.parse(cleartext);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("Stored notification configuration is invalid.");
  }
  return parsed as Record<string, string>;
}

function maskEmail(email: string): string {
  const [name, domain] = email.split("@");
  return `${name?.slice(0, 1) ?? ""}***@${domain ?? ""}`;
}

function safeHostLabel(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || isPrivateHostname(url.hostname)) {
    throw new AlertServiceError("Webhook URLs must use HTTPS and a public hostname.", 400);
  }
  return url.hostname;
}

function isPrivateHostname(hostname: string): boolean {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return normalized === "localhost" || normalized.endsWith(".localhost") ||
    normalized === "127.0.0.1" || normalized === "::1" || normalized.endsWith(".local");
}

function assertPushEndpoint(value: string): void {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const allowed = (hostname === "fcm.googleapis.com" && url.pathname.startsWith("/fcm/send/")) ||
    (hostname === "updates.push.services.mozilla.com" && url.pathname.startsWith("/wpush/v2/")) ||
    (hostname === "web.push.apple.com" && url.pathname.startsWith("/")) ||
    (/^[a-z0-9-]+\.notify\.windows\.com$/.test(hostname) && url.pathname.startsWith("/"));
  if (url.protocol !== "https:" || url.port && url.port !== "443" || !allowed || url.username || url.password) {
    throw new AlertServiceError("Push endpoint is not a supported HTTPS push service.", 400);
  }
}
