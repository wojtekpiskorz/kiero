/*
 * Kiero PWA service worker (web push).
 *
 * Scope: ONLY notification presentation and click-through. This worker
 * deliberately installs NO fetch handler and NO cache: protected data
 * reaches the app exclusively through live authorized queries, so no
 * cached copy can ever bypass current authentication or company access
 * (the hard rule in apps/web/src/app/pwa/composition.ts). Update
 * behavior lives in apps/web/src/pwa/update.
 *
 * Push messages arrive RFC 8030/8291-encrypted; the browser decrypts and
 * hands this worker the JSON payload the Kiero server composed:
 *   { v: 1, kind, title, body, data: { sourceIds?, clarificationIds?,
 *     taskIds?, target } }
 *
 * notificationclick never marks anything read ("Nieprzeczytany wpis"
 * changes only when the person sees the original in the app) and never
 * performs any server call. The click navigates only to
 * a VALIDATED relative same-origin target - the payload's canonical
 * source dossier, task record or Co teraz route - and it rejects
 * absolute, protocol-relative, cross-origin and unknown routes outright
 * (the scope fallback opens instead). An existing app window is focused
 * and navigated; otherwise the target opens as a new window. The app
 * resolves current data and live access after the click, so an old
 * notification can never steer the user outside the current app.
 */

const FALLBACK_TITLE = "Kiero";
const FALLBACK_BODY = "Nowe powiadomienie";

/** The only routes a notification may open (the canonical record routes). */
const ALLOWED_ROUTE_PATHS = ["/zrodlo", "/praca", "/co-teraz"];

/**
 * Validates the payload's routing target: a RELATIVE path inside the
 * worker's OWN origin whose pathname is one of the allowed record routes.
 * Everything else (absolute URLs, protocol-relative URLs, foreign
 * origins, unknown paths, non-strings) refuses to null, and the click
 * falls back to the worker's own scope.
 */
function notificationTarget(routing) {
  if (routing === null || typeof routing !== "object") {
    return null;
  }
  const raw = routing.target;
  if (typeof raw !== "string" || raw.length === 0) {
    return null;
  }
  if (raw.charCodeAt(0) !== 47) {
    return null; // must be relative: no scheme, no host
  }
  if (raw.charCodeAt(1) === 47) {
    return null; // protocol-relative is a foreign origin in disguise
  }
  let scopeUrl;
  let resolved;
  try {
    scopeUrl = new URL(self.registration.scope);
    resolved = new URL(raw, scopeUrl);
  } catch (error) {
    return null;
  }
  if (resolved.origin !== scopeUrl.origin) {
    return null; // cross-origin
  }
  if (!ALLOWED_ROUTE_PATHS.includes(resolved.pathname)) {
    return null; // unknown route
  }
  return resolved.pathname + resolved.search;
}

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
      const target = notificationTarget(event.notification.data);
      const windowClients = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of windowClients) {
        if (client.url.startsWith(self.registration.scope)) {
          const focused = await client.focus();
          if (target !== null) {
            try {
              await client.navigate(target);
            } catch (error) {
              // Navigation refused (for example a cross-origin frame):
              // stay on the focused window, which reloads current state.
            }
          }
          return focused;
        }
      }
      if (target !== null) {
        return self.clients.openWindow(target);
      }
      return self.clients.openWindow(self.registration.scope);
    })(),
  );
});
