/*
 * Kiero PWA service worker (F3: web push).
 *
 * Scope: ONLY notification presentation and click-through. This worker
 * deliberately installs NO fetch handler and NO cache: protected data
 * reaches the app exclusively through live authorized queries, so no
 * cached copy can ever bypass current authentication or company access
 * (the hard rule in apps/web/src/app/pwa/composition.ts). Update
 * behavior belongs to I7.
 *
 * Push messages arrive RFC 8030/8291-encrypted; the browser decrypts and
 * hands this worker the JSON payload the Kiero server composed:
 *   { v: 1, kind, title, body, data: { sourceIds?, clarificationIds? } }
 *
 * notificationclick never marks anything read ("Nieprzeczytany wpis"
 * changes only when the person sees the original in the app) and never
 * opens an absolute URL from the payload: it focuses an existing window
 * or opens the worker's OWN scope, so an old notification can only ever
 * land the user inside the current app, which resolves current data and
 * live access checks.
 */

const FALLBACK_TITLE = "Kiero";
const FALLBACK_BODY = "Nowe powiadomienie";

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch (error) {
    payload = {};
  }
  const title =
    typeof payload.title === "string" && payload.title.length > 0
      ? payload.title
      : FALLBACK_TITLE;
  const body =
    typeof payload.body === "string" && payload.body.length > 0
      ? payload.body
      : FALLBACK_BODY;
  const data =
    payload.data !== null && typeof payload.data === "object" ? payload.data : {};
  event.waitUntil(
    self.registration.showNotification(title, {
      body,
      lang: "pl",
      data,
    }),
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const windowClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windowClients) {
        if (client.url.startsWith(self.registration.scope)) {
          return client.focus();
        }
      }
      return self.clients.openWindow(self.registration.scope);
    })(),
  );
});
