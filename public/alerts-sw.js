self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { body: event.data ? event.data.text() : "An alert was triggered." };
  }
  event.waitUntil(self.registration.showNotification(payload.title || "Vantage alert", {
    body: payload.body || "An alert was triggered.",
    data: { url: payload.url || "/alerts" },
    tag: payload.eventId || "vantage-alert",
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || "/alerts", self.location.origin);
  if (target.origin !== self.location.origin) return;
  event.waitUntil(self.clients.openWindow(target.href));
});
