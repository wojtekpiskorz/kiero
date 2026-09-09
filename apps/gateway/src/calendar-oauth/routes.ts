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
 *   value is ever echoed, logged or put into the page.
 *
 * Paths live under the existing `/platform/` route prefix the Worker
 * serves, so registration is the documented imports-only append in
 * ../composition/registry.ts (the shared fetch handler stays untouched;
 * see the G1 evidence for the composition note).
 */

import { calendarComplete, calendarStart, type CalendarBridgeEnv } from "./client";
import { answerOrNull } from "../../../../convex/calendar/connection/answers";
import type { GatewayRoute } from "../platform/routes";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Minimal Polish status page (barebones: semantic HTML, no styling). */
function polishStatusPage(title: string, detail: string, status: number): Response {
  const html = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>Kiero — Kalendarz</title></head><body><section aria-labelledby="k"><h1 id="k">Kalendarz Kiero w Google</h1><p role="status">${title}</p><p>${detail}</p><p><a href="/">Wróć do Kiero</a></p></section></body></html>`;
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
      if (state.length === 0) {
        return polishStatusPage(
          "Nieprawidłowe połączenie.",
          "Ten link jest niekompletny. Zacznij połączenie od nowa w Kiero.",
          400,
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
        );
      }
      return polishStatusPage(answer.polishTitle, answer.polishDetail, answer.status);
    },
  },
];

/** The provider registration object (composed by ../composition/registry). */
export const calendarOAuthProvider = {
  providerId: "calendar-oauth",
  routes: calendarOAuthRoutes,
} as const;
