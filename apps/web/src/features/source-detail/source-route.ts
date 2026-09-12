/**
 * The canonical source-reference route contract (R5, issue #130).
 *
 * ONE serializer/parser owns the stable in-app link to a "Wiadomość
 * źródłowa": `/zrodlo?zrodlo=<encoded-id>` — the dossier route the host
 * registers for the source-detail feature — with
 *
 * - an optional `fragment` param: the matched "Fragment źródła" whose
 *   anchor the dossier highlights;
 * - an optional `projekt` param: NAVIGATION CONTEXT ONLY. It can never
 *   grant access: the dossier's own backend reads stay the authority on
 *   tenancy and lifecycle (B3), and a malformed or foreign value is
 *   dropped, never honored.
 *
 * The form is relative (no host): the same string serves in-app anchors,
 * the conversation route's legacy redirect and the export archive's
 * source records (the backend half is a runtime-neutral twin pinned to
 * this contract by tests/i3 — convex must not import browser feature
 * code).
 *
 * Determinism rules the parser enforces:
 *
 * - `parse(serialize(x))` recovers `x` exactly for every reference shape
 *   (param order is fixed: zrodlo, fragment, projekt);
 * - id values must be non-empty and stay inside the closed URL-safe
 *   charset below, so nothing that could break the path (`/`), query
 *   (`?`, `&`, `=`) or fragment (`#`) structure of the URL can be
 *   smuggled through a deep link;
 * - ONE repeated identical value is idempotent; CONFLICTING repeated
 *   values are an ambiguous deep link and refuse the whole parse;
 * - the source id is strict (a malformed target refuses), while an
 *   unusable fragment falls back truthfully to the whole source
 *   (CONTEXT.md: gdy nie da się wiarygodnie wskazać fragmentu, podstawą
 *   pozostaje cały materiał) and an unusable projekt is dropped.
 *
 * The legacy conversation deep link (`/?zrodlo=<id>` on "/") is not
 * parsed here beyond reuse: the conversation surface redirects it to the
 * canonical target (see `inspectSourceSearch`), because the inline detail
 * renders only inside the feed's loaded rows and the feed's growth is
 * capped — the dossier must open a source older than the cap.
 */

import { PROJECT_PARAM, SOURCE_PARAM } from "../company/route-params";

/** The dossier route path (the source-detail host entry's routePath). */
export const SOURCE_ROUTE_PATH = "/zrodlo";

/** The matched-fragment param key (the anchor a search hit pins). */
export const FRAGMENT_PARAM = "fragment";

/**
 * The closed id charset every reference component must satisfy: Convex
 * table ids are URL-safe base62-style strings; refusing everything else
 * (spaces, percent leftovers, path/query/fragment breakers) keeps the
 * serialized URL structurally intact however the value arrived.
 */
const ID_PATTERN = /^[0-9A-Za-z_-]{1,64}$/;

/** One parsed canonical source reference. */
export interface SourceReference {
  /** The sources-table id of the referenced "Wiadomość źródłowa". */
  readonly sourceId: string;
  /** The matched fragment's id, or null for the whole source. */
  readonly fragmentId: string | null;
  /** Navigation context only — never an access grant. */
  readonly projectId: string | null;
}

/**
 * Serializes one reference into the canonical relative link. This is the
 * ONLY sanctioned way an in-app consumer builds a source URL; the export
 * archive carries a runtime-neutral twin of this exact form.
 */
export function serializeSourceReference(reference: SourceReference): string {
  const params = new URLSearchParams();
  params.set(SOURCE_PARAM, reference.sourceId);
  if (reference.fragmentId !== null) {
    params.set(FRAGMENT_PARAM, reference.fragmentId);
  }
  if (reference.projectId !== null) {
    params.set(PROJECT_PARAM, reference.projectId);
  }
  return `${SOURCE_ROUTE_PATH}?${params.toString()}`;
}

/**
 * Reads one known key's single value: null when absent, the shared value
 * when every occurrence agrees, and `undefined` when occurrences CONFLICT
 * (an ambiguous deep link refuses the whole parse).
 */
function singleValueOf(params: URLSearchParams, key: string): string | null | undefined {
  const values = params.getAll(key);
  if (values.length === 0) {
    return null;
  }
  return values.every((value) => value === values[0]) ? values[0] : undefined;
}

/**
 * Reduces a full href or a bare search string to its params: everything
 * after the first `?` when one exists; a leading-`/` path without one has
 * no params; otherwise the whole string IS the search (with or without a
 * leading `?`).
 */
function searchOf(input: string): string {
  const question = input.indexOf("?");
  if (question >= 0) {
    return input.slice(question + 1);
  }
  return input.startsWith("/") ? "" : input;
}

/**
 * Parses a canonical link — a full href (`/zrodlo?zrodlo=<id>…`) or a
 * bare search string (with or without the leading `?`) — into one
 * reference. Returns null when the source id is missing, malformed, or
 * made ambiguous by conflicting duplicates.
 */
export function parseSourceReference(search: string): SourceReference | null {
  const params = new URLSearchParams(searchOf(search));
  const sourceId = singleValueOf(params, SOURCE_PARAM);
  const fragmentId = singleValueOf(params, FRAGMENT_PARAM);
  const projectId = singleValueOf(params, PROJECT_PARAM);
  // Conflicting duplicates of ANY known key are an ambiguous deep link:
  // the whole reference refuses.
  if (sourceId === undefined || fragmentId === undefined || projectId === undefined) {
    return null;
  }
  if (sourceId === null || !ID_PATTERN.test(sourceId)) {
    return null;
  }
  return {
    sourceId,
    // An unusable fragment falls back to the whole source; an unusable
    // navigation context is dropped. Neither can smuggle structure into
    // the URL the serializer emits.
    fragmentId: fragmentId !== null && ID_PATTERN.test(fragmentId) ? fragmentId : null,
    projectId: projectId !== null && ID_PATTERN.test(projectId) ? projectId : null,
  };
}

/**
 * What a route should do with the source params it found in a search
 * string: nothing (absent), refuse honestly (malformed), or open the
 * parsed reference. The conversation surface's legacy redirect and the
 * dossier's own mount are the two consumers of this discrimination.
 */
export type SourceSearchInspection =
  | { readonly kind: "absent" }
  | { readonly kind: "malformed" }
  | { readonly kind: "reference"; readonly reference: SourceReference };

/** Discriminates a search string's source params for routing decisions. */
export function inspectSourceSearch(search: string): SourceSearchInspection {
  if (!new URLSearchParams(searchOf(search)).has(SOURCE_PARAM)) {
    return { kind: "absent" };
  }
  const reference = parseSourceReference(search);
  return reference === null ? { kind: "malformed" } : { kind: "reference", reference };
}
