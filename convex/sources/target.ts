/**
 * The canonical relative target of one source record: the Convex half of
 * R5's wire contract (issue #130).
 *
 * The app-side authority is the source-detail feature's serializer/parser
 * (`apps/web/src/features/source-detail/source-route`). The Convex backend
 * must not import browser feature code, so this module is the ONE
 * runtime-neutral half every server-side consumer addresses a source
 * through — attention push summaries (R3) and export archive records
 * (I3) re-export or call `sourceTargetOf` instead of keeping private
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
  return `${SOURCE_ROUTE_PATH}?${SOURCE_PARAM}=${encodeURIComponent(sourceId)}`;
}
