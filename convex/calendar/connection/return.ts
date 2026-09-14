/**
 * The configured application return origin for the Calendar OAuth
 * callback pages (R10 definition, R12 shared home).
 *
 * A PURE module (no Convex imports), the same shared-home ruling as
 * ./answers.ts: BOTH callback surfaces — the direct Convex page
 * (./http.ts) and the gateway Worker page
 * (apps/gateway/src/calendar-oauth/routes.ts) — resolve their
 * "Wróć do Kiero" target through this ONE definition, so the resolver
 * lives where both can import it without dragging each other's runtime
 * type graphs across the boundary. Mirrors are hazards, not copies.
 */

/** The deployment variable holding the PWA origin the callback returns to. */
export const CALENDAR_APP_BASE_URL_ENV = "KIERO_CALENDAR_APP_BASE_URL";

/**
 * Resolves the callback page's "Wróć do Kiero" target from SERVER-SIDE
 * configuration only: `KIERO_CALENDAR_APP_BASE_URL`, the application
 * origin (optionally with a subpath) this deployment is paired with. The
 * page is served from a host that is NOT the application (the Convex
 * HTTP Actions host or the gateway Worker), so a relative href would
 * lead back to the serving deployment, not the application — and nothing
 * a caller sends (query, body, headers) may influence the destination.
 *
 * Returns the normalized absolute href, or null when the configuration is
 * absent or invalid (not a URL, a non-web scheme, `http:` outside dev,
 * embedded userinfo, query or fragment). Null means the honest safe
 * behavior: the page renders WITHOUT a link and says so in Polish —
 * never a fallback to "/" or any guessed origin.
 */
export function calendarAppReturnHref(env: {
  [CALENDAR_APP_BASE_URL_ENV]?: string;
  KIERO_ENVIRONMENT?: string;
}): string | null {
  const configured = env[CALENDAR_APP_BASE_URL_ENV];
  if (typeof configured !== "string" || configured.length === 0) {
    return null;
  }
  let url: URL;
  try {
    url = new URL(configured);
  } catch {
    return null;
  }
  // The deployment's environment self-description, read the same way as
  // the telemetry cron and the backups boundary: one closed label set,
  // an unknown or absent label honestly means dev. Only dev may return
  // over plain http (a local PWA); every labeled environment requires
  // https for a link the browser will navigate to.
  const rawEnvironment = env.KIERO_ENVIRONMENT ?? "dev";
  const environment = /^(dev|staging|alpha-production)$/.test(rawEnvironment) ? rawEnvironment : "dev";
  const schemeAllowed =
    url.protocol === "https:" || (url.protocol === "http:" && environment === "dev");
  const wellFormed =
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.hostname.length > 0 &&
    url.search.length === 0 &&
    url.hash.length === 0;
  if (!schemeAllowed || !wellFormed) {
    return null;
  }
  // Normalize to origin + path with trailing slashes stripped, so
  // "https://host", "https://host/" and "https://host/app/" all target the
  // same application entry. Components come from URL parsing, never from
  // string concatenation of the raw configuration.
  return `${url.origin}${url.pathname}`.replace(/\/+$/, "");
}
