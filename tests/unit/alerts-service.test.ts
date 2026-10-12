import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deleteAlert,
  evaluateAndRecordAlert,
  listAlertEvents,
  listAlerts,
  markAlertEventRead,
  saveAlert,
  saveNotificationChannel,
  getEnabledChannelConfigs,
  listNotificationChannels,
  setNotificationChannelEnabled,
  setAlertActive,
} from "@/lib/alerts/service";

const input = {
  name: "AAPL breakout",
  symbol: "aapl",
  assetClass: "equity",
  condition: {
    type: "price",
    source: "last",
    comparison: "above",
    threshold: 200,
  },
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("alert persistence service", () => {
  it("isolates alert CRUD, evaluation, and history by user", async () => {
    const owner = `alert-owner-${crypto.randomUUID()}`;
    const stranger = `alert-stranger-${crypto.randomUUID()}`;
    const created = await saveAlert(owner, input);
    expect(created.symbol).toBe("AAPL");
    expect(await listAlerts(stranger)).toEqual([]);

    await expect(setAlertActive(stranger, created.id, false)).rejects.toMatchObject({ status: 404 });
    await expect(deleteAlert(stranger, created.id)).rejects.toMatchObject({ status: 404 });
    const evaluation = await evaluateAndRecordAlert(owner, created.id, { "price.last": 205 });
    expect(evaluation.event?.summary).toContain("AAPL");
    expect((await listAlertEvents(owner)).map((event) => event.id)).toContain(evaluation.event?.id);
    expect(await listAlertEvents(stranger)).toEqual([]);

    await markAlertEventRead(owner, evaluation.event!.id);
    expect((await listAlertEvents(owner))[0]?.readAt).not.toBeNull();
  });

  it("rejects non-portfolio alerts using the reserved portfolio symbol", async () => {
    const userId = `alert-input-${crypto.randomUUID()}`;
    await expect(saveAlert(userId, { ...input, symbol: "PORTFOLIO" }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("re-arms a one-shot alert when resumed and retains both trigger events", async () => {
    const userId = `alert-once-${crypto.randomUUID()}`;
    const created = await saveAlert(userId, { ...input, triggerMode: "once" });
    const first = await evaluateAndRecordAlert(userId, created.id, { "price.last": 205 }, new Date("2025-01-01T00:00:00Z"));
    expect(first.event).not.toBeNull();
    await setAlertActive(userId, created.id, true);
    const second = await evaluateAndRecordAlert(userId, created.id, { "price.last": 205 }, new Date("2025-01-01T00:01:00Z"));
    expect(second.event).not.toBeNull();
    expect(await listAlertEvents(userId)).toHaveLength(2);
  });

  it("encrypts channel credentials and rejects insecure webhook targets", async () => {
    vi.stubEnv("ALERTS_ENCRYPTION_KEY", Buffer.alloc(32, 7).toString("base64"));
    const userId = `alert-channel-${crypto.randomUUID()}`;
    const saved = await saveNotificationChannel(userId, {
      type: "webhook",
      enabled: true,
      url: "https://hooks.example.com/alert",
      secret: "a".repeat(32),
    });
    expect(saved).toMatchObject({ type: "webhook", configured: true });
    expect(JSON.stringify(saved)).not.toContain("a".repeat(32));
    await expect(saveNotificationChannel(userId, {
      type: "webhook",
      enabled: true,
      url: "http://127.0.0.1/private",
      secret: "b".repeat(32),
    })).rejects.toMatchObject({ status: 400 });
  });

  it("fails explicitly rather than storing channel secrets without an encryption key", async () => {
    const userId = `alert-channel-key-${crypto.randomUUID()}`;
    await expect(saveNotificationChannel(userId, {
      type: "email",
      enabled: true,
      email: "trader@example.com",
    })).rejects.toMatchObject({ status: 503 });
  });

  it("toggles configured channels without replacing their encrypted credentials", async () => {
    vi.stubEnv("ALERTS_ENCRYPTION_KEY", Buffer.alloc(32, 8).toString("base64"));
    const userId = `alert-channel-toggle-${crypto.randomUUID()}`;
    await saveNotificationChannel(userId, {
      type: "email",
      enabled: true,
      email: "trader@example.com",
    });
    await setNotificationChannelEnabled(userId, { type: "email", enabled: false });
    expect(await getEnabledChannelConfigs(userId)).toEqual([]);
    expect(await listNotificationChannels(userId)).toContainEqual(expect.objectContaining({
      type: "email",
      enabled: false,
      configured: true,
    }));
    await setNotificationChannelEnabled(userId, { type: "email", enabled: true });
    expect(await getEnabledChannelConfigs(userId)).toContainEqual({
      type: "email",
      config: { email: "trader@example.com" },
    });
  });

  it("requires notification credentials before enabling an unconfigured channel", async () => {
    const userId = `alert-channel-unconfigured-${crypto.randomUUID()}`;
    await expect(setNotificationChannelEnabled(userId, { type: "webhook", enabled: true }))
      .rejects.toMatchObject({ status: 409 });
    await expect(setNotificationChannelEnabled(userId, { type: "push", enabled: true }))
      .rejects.toMatchObject({ status: 409 });
  });
});
