/**
 * The Calendar OAuth callback status page (shared renderer).
 *
 * A PURE module (no Convex imports), the same shared-home ruling as
 * ./answers.ts and ./return.ts: BOTH callback surfaces — the direct
 * Convex page (./http.ts) and the gateway Worker page
 * (apps/gateway/src/calendar-oauth/routes.ts) — render the SAME minimal
 * Polish page, so the renderer and its product copy live once, here.
 * Mirrors are hazards, not copies.
 *
 * Its only dependency is the canonical HTML escape
 * (../../operations/exports/protocol.ts, an import-free module), which
 * keeps it safe for both sides' isolated type graphs.
 */

import { escapeHtml } from "../../operations/exports/protocol";

/**
 * Minimal Polish status page (barebones: semantic HTML, no styling). The
 * footer link targets the resolved application origin (see ./return.ts);
 * a null target renders the honest note that the return is unavailable
 * instead of linking anywhere (never "/" on the serving host).
 */
export function polishStatusPage(
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
