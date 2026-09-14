/**
 * Calendar OAuth gateway routes (G1, issue #45).
 *
 * The Worker's authorization-gateway half of the Calendar connection
 * lifecycle ("apps/gateway: Cloudflare authorization gateway and streamed
 * media/upload/OAuth routes", execution charter):
 *
 * - `GET /platform/calendar/oauth/start`: the start-authorization redirect.
 *   The PWA calls it with the user's Convex access token (Authorization
 *   header, redirect: "manual") and follows the returned Location to
 *   Google; the URL is constructed CONVEX-side from the server-owned OAuth
 *   client names, with state + S256 PKCE material that never leaves the
 *   server. Without a token or a configured backend the route answers the
 *   sanitized closed error with Polish copy, never a fake URL.
 * - `GET /platform/calendar/oauth/callback`: Google's redirect target on
 *   the Worker. It forwards the single-use state and the code to the
 *   deployment's verified bridge completion route (service credential ->
 *   the A3 bridge check; the callback itself re-checks membership), then
 *   renders a minimal Polish HTML status page. No token, code or state
 *   value is ever echoed, logged or put into the page. The page's
 *   "Wróć do Kiero" footer targets the CONFIGURED application origin
 *   (R12: `KIERO_CALENDAR_APP_BASE_URL` on this Worker), resolved by the
 *   SAME R10 resolver the direct Convex callback uses — never "/" on the
 *   Worker host and never anything the caller supplied.
 *
 * Paths live under the existing `/platform/` route prefix the Worker
 * serves, so registration is the documented imports-only append in
 * ../composition/registry.ts (the shared fetch handler stays untouched;
 * see the G1 evidence for the composition note).
 */

import { calendarComplete, calendarStart, type CalendarBridgeEnv } from "./client";
import { answerOrNull } from "../../../../convex/calendar/connection/answers";
// The R10 return resolver from its PURE shared home (the same ruling as
// `answerOrNull` above): ONE definition of where the callback page's
// link leads, shared by the direct Convex callback and this Worker page.
import {
  CALENDAR_APP_BASE_URL_ENV,
  calendarAppReturnHref,
} from "../../../../convex/calendar/connection/return";
// Canonical HTML escape (the exports protocol helper), the same one the
// Convex status page routes the href through.
import { escapeHtml } from "../../../../convex/operations/exports/protocol";
import type { GatewayRoute } from "../platform/routes";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/**
 * Resolves the page's return target through the R10 resolver from THIS
 * Worker's bindings only. The adapter maps the gateway's own variable
 * names onto the resolver's input: the PWA origin passes through under
 * the same deployment variable name, and the Worker's `ENVIRONMENT`
 * label (the same closed dev/staging/alpha-production set the telemetry
 * surface reads) stands in for the resolver's `KIERO_ENVIRONMENT`, so
 * plain http stays a dev-only allowance here too. Nothing caller-supplied
 * participates.
 */
function gatewayReturnHref(env: CalendarBridgeEnv): string | null {
  const configured = env[CALENDAR_APP_BASE_URL_ENV];
  const resolverInput: Parameters<typeof calendarAppReturnHref>[0] = {
    KIERO_ENVIRONMENT: env.ENVIRONMENT ?? "dev",
  };
  if (configured !== undefined) {
    resolverInput[CALENDAR_APP_BASE_URL_ENV] = configured;
  }
  return calendarAppReturnHref(resolverInput);
}

/**
 * Minimal Polish status page (barebones: semantic HTML, no styling). The
 * footer link targets the configured application origin (R12); with no
 * valid configuration the page honestly states the return is unavailable
 * instead of linking anywhere (never "/" on the Worker host).
 */
function polishStatusPage(
  title: string,
  detail: string,
  status: number,
  returnHref: string | null,
): Response {
  const footer =
    returnHref === null
      ? `<p>Powrót do Kiero jest niedostępny. Otwórz aplikację bezpośrednio.</p>`
      : `<p><a href="${escapeHtml(returnHref)}">Wróć do Kiero</a></p>`;
  const html = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>Kiero — Kalendarz</title></head><body><section aria-labelledby="k"><h1 id="k">Kalendarz Kiero w Google</h1><p role="status">${title}</p><p>${detail}</p>${footer}</section></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

/** The G1 Calendar OAuth route provider. */
export const calendarOAuthRoutes: readonly GatewayRoute[] = [
  {
    method: "GET",
    path: "/platform/calendar/oauth/start",
    handle: async (request, env: CalendarBridgeEnv) => {
      const outcome = await calendarStart(env, request.headers.get("authorization"));
      if (!outcome.ok) {
        // Errors here are already closed and sanitized; the status keeps
        // the envelope's honest shape (400 for business refusals, 503 for
        // the unavailable backend).
        const tag = outcome.result._tag;
        const status =
          tag === "error" && outcome.result.error._tag === "unavailable" ? 503 : 400;
        return jsonResponse(status, outcome.result);
      }
      // The redirect leg: the browser follows Location to Google consent.
      return new Response(null, {
        status: 302,
        headers: { location: outcome.start.authorizationUrl, "cache-control": "no-store" },
      });
    },
  },
  {
    method: "GET",
    path: "/platform/calendar/oauth/callback",
    handle: async (request, env: CalendarBridgeEnv) => {
      const url = new URL(request.url);
      const state = url.searchParams.get("state") ?? "";
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      // Server-side configuration only (R12): the request itself (host,
      // query, headers) never influences where the page's link leads.
      const returnHref = gatewayReturnHref(env);
      if (state.length === 0) {
        return polishStatusPage(
          "Nieprawidłowe połączenie.",
          "Ten link jest niekompletny. Zacznij połączenie od nowa w Kiero.",
          400,
          returnHref,
        );
      }
      const outcome = await calendarComplete(env, { state, code, error });
      if (!outcome.ok) {
        return jsonResponse(503, outcome.result);
      }
      const result = outcome.result;
      if (result._tag === "error") {
        return polishStatusPage(
          "Połączenie kalendarza nie zostało ukończone.",
          "Wróć do Kiero i sprawdź stan połączenia kalendarza.",
          400,
          returnHref,
        );
      }
      const value =
        typeof result.value === "object" && result.value !== null
          ? (result.value as Record<string, unknown>)
          : {};
      if (value.connected === true) {
        return polishStatusPage(
          "Kalendarz Kiero jest połączony.",
          "Możesz wrócić do Kiero i korzystać z terminów w swoim kalendarzu Google.",
          200,
          returnHref,
        );
      }
      // The same typed reason the direct Convex callback page renders (the
      // shared answer vocabulary); an unknown code gets the honest generic.
      const answer = typeof value.code === "string" ? answerOrNull(value.code) : null;
      if (answer === null) {
        return polishStatusPage(
          "Połączenie kalendarza nie zostało ukończone.",
          "Wróć do Kiero i sprawdź stan połączenia kalendarza.",
          400,
          returnHref,
        );
      }
      return polishStatusPage(answer.polishTitle, answer.polishDetail, answer.status, returnHref);
    },
  },
];

/** The provider registration object (composed by ../composition/registry). */
export const calendarOAuthProvider = {
  providerId: "calendar-oauth",
  routes: calendarOAuthRoutes,
} as const;
