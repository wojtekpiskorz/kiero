/**
 * The canonical relative target of one source record: the Convex half of
 * the wire contract.
 *
 * The app-side authority is the source-detail feature's serializer/parser
 * (`apps/web/src/features/source-detail/source-route`). The Convex backend
 * must not import browser feature code, so this module is the ONE
 * runtime-neutral half every server-side consumer addresses a source
 * through — attention push summaries and export archive records
 *  re-export or call `sourceTargetOf` instead of keeping private
 * twins. tests/i3 pin the wire form equal to the app serializer against
 * one corpus and pin both consumers' exports to THIS function.
 *
 * The target stays RELATIVE: no scheme, host or fragment ever enters a
 * push payload or an export record.
 */

/** The dossier route path of one "Wiadomość źródłowa". */
export const SOURCE_ROUTE_PATH = "/zrodlo";

/** The query-param source deep-link key (the app's shared route param). */
export const SOURCE_PARAM = "zrodlo";

/** The canonical relative dossier target of one source record. */
export function sourceTargetOf(sourceId: string): string {
  // encodeURIComponent and the app serializer's URLSearchParams.toString()
  // agree on every character a Convex table id can contain (the app's
  // closed [0-9A-Za-z_-] id charset), so the corpus pin in tests/i3 is
  // structurally exhaustive for real ids.
  return `${SOURCE_ROUTE_PATH}?${SOURCE_PARAM}=${encodeURIComponent(sourceId)}`;
}
