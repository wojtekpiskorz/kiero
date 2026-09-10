/**
 * The gateway media-read protocol: the access-channel input schema, the
 * served-content vocabulary and the PURE HTTP read decisions (RFC 9110
 * ranges and conditional requests) of the authorized retained-media stream
 * (D3).
 *
 * PATH NOTE (flagged to the coordinator): the issue's owned namespace
 * `convex/sources/media-access/**` ships as `convex/sources/media_access`
 * because Convex validates module path components as alphanumeric,
 * underscore or period only — a hyphenated module cannot be pushed. The
 * lane's exclusivity is unchanged.
 *
 * Division of labor (the D2 seam, mirrored for reads): the Worker
 * (apps/gateway/src/media) owns the R2 read and the byte stream; Convex
 * (this lane's access.ts) owns the CURRENT authorization decision and the
 * representation resolution. EVERY request — full or ranged — resolves the
 * caller through the per-user channel (the browser's Convex Auth credential
 * forwarded verbatim) and re-decides access BEFORE any R2 byte is read, so
 * a session or membership revoked between two range requests refuses the
 * fresh request; the already-delivered bytes of an in-flight response are
 * the explicit physical limit.
 *
 * RANGE POLICY (decided and documented honestly, RFC 9110 §14):
 *
 * - exactly ONE byte range is authoritative (`bytes=first-last`,
 *   `bytes=first-`, `bytes=-suffix`). A multi-range request is IGNORED as a
 *   whole (served 200 full) — a server MAY ignore any Range header, and
 *   `multipart/byteranges` assembly would re-buffer content this lane
 *   exists to stream un-buffered. No browser audio seeking needs it.
 * - an unknown range unit or a syntactically invalid specifier is ignored
 *   (200 full), the RFC-mandated behavior for MUST-ignore cases;
 * - a syntactically valid but unsatisfiable range (first byte beyond the
 *   last byte, or a zero-length suffix) answers 416 with the
 *   asterisk-form Content-Range ("bytes" + slash + total length);
 * - an overlong end position is capped to the last byte (RFC allows it);
 * - a suffix longer than the representation serves the whole file.
 *
 * CONDITIONAL REQUESTS (implemented; both are cheap and honest):
 *
 * - `If-None-Match` is evaluated FIRST (RFC 9110 §13.1.2, weak
 *   comparison incl. `*`): a match answers 304 without any R2 read;
 * - `If-Range` with the EXACT strong etag honors the Range; anything else
 *   (a different etag, an entity-tag we cannot compare, or an HTTP-date —
 *   this lane serves no Last-Modified) makes the Range be ignored (200
 *   full), never a partial answer for changed bytes.
 *
 * SHARED-HOME DECISION (D2's ruling, applied identically): this file is
 * the ONE definition of the media-read channel's vocabulary on BOTH sides
 * of the deployment boundary — the Convex boundary and the gateway Worker
 * import it directly. It stays out of @kiero/contracts because the channel
 * schema is the gateway lane's vocabulary, not the certified client
 * surface; mirrors of the range decisions or the content-type vocabulary
 * anywhere else are hazards, not copies.
 */

import { Schema } from "effect";
import { MediaKind } from "@kiero/contracts";

// ---------------------------------------------------------------------------
// The access channel's input (gateway -> Convex; NOT the certified client
// surface: the client command surface stays `sources.readSource`-shaped).
// ---------------------------------------------------------------------------

/**
 * A key that must be ABSENT for this union member to match: optional Never
 * accepts the key's absence and rejects any value, which is what makes
 * both-present a decode failure rather than a silently-ignored extra key
 * (Effect strips unknown excess keys by default; the forbidden-twin field
 * is not unknown, it is named and forbidden).
 */
const Forbidden = () => Schema.optional(Schema.Never);

/**
 * What the Worker asks access for: exactly one of the attachment id (the
 * canonical read: the SERVER resolves which representation serves the
 * bytes) or a specific representation id (the exact-version read E4's
 * media anchors and I3/I5's export/backup readers address). Object keys are
 * never accepted from the caller — keys travel ONLY inside the grant, the
 * authorized answer. The UNION is the exactly-one-id invariant: both,
 * neither or malformed references fail the decode itself, in this ONE
 * shared definition (the boundary and the resolver both decode it, so
 * neither re-implements the check).
 */
export const MediaAccessInput = Schema.Union([
  Schema.Struct({
    attachmentId: Schema.NonEmptyString,
    representationId: Forbidden(),
  }),
  Schema.Struct({
    attachmentId: Forbidden(),
    representationId: Schema.NonEmptyString,
  }),
]);
export type MediaAccessInput = Schema.Schema.Type<typeof MediaAccessInput>;

/** The roles that can serve bytes (thumbnail/processing never do). */
export const ServableRole = Schema.Literals(["received", "retained"]);
export type ServableRole = Schema.Schema.Type<typeof ServableRole>;

/**
 * The authorized read grant — a SCHEMA beside the input (the type is
 * derived; there is no hand-written twin to drift): the Convex resolution
 * constructs and decodes its grant against this definition before
 * answering, and the gateway route decodes the answer through the same
 * one. The object key, etag and byte length are the LEDGER's recorded
 * values — the CHOSEN representation's own records (D5's rows carry
 * bytes/mimeType when verified), with the D2 attachment receipt
 * (receivedBytes/r2ObjectEtag) as the received-role fallback — never
 * caller-supplied and never probed from R2 to decide authorization.
 */
export const MediaAccessGrant = Schema.Struct({
  attachmentId: Schema.NonEmptyString,
  sourceId: Schema.NonEmptyString,
  representationId: Schema.NonEmptyString,
  /** Which recorded representation serves the bytes. */
  role: ServableRole,
  /** The attachment's kind (the contracts vocabulary, pinned by typecheck). */
  kind: MediaKind,
  /** Server-resolved; the Worker's R2 read uses this and nothing else. */
  objectKey: Schema.NonEmptyString,
  /** The ledger-recorded representation etag (unquoted; served quoted). */
  etag: Schema.NonEmptyString,
  /** The chosen representation's ledger-recorded verified byte length. */
  bytes: Schema.Number.pipe(Schema.check(Schema.isGreaterThan(0))),
  contentType: Schema.NonEmptyString,
  transformVersion: Schema.NonEmptyString,
  /** Representation metadata E4's anchors and H3's UI will address. */
  width: Schema.optional(Schema.Number),
  height: Schema.optional(Schema.Number),
  durationMs: Schema.optional(Schema.Number),
});
export type MediaAccessGrant = Schema.Schema.Type<typeof MediaAccessGrant>;

// ---------------------------------------------------------------------------
// The served-content vocabulary.
// ---------------------------------------------------------------------------

/**
 * The FALLBACK media-type mapping, pinned to the ONE place it is recorded
 * today: D2's `createMultipartSessions` writes exactly these as the R2
 * objects' httpMetadata content types (audio/webm, image/jpeg — the alpha
 * browser recording and the received image format). The chosen
 * representation's OWN recorded mimeType takes precedence when present
 * (D5's rows carry it); the kind column is the fallback authority.
 */
export function contentTypeForKind(kind: MediaKind): string {
  return kind === "audio" ? "audio/webm" : "image/jpeg";
}

/** Served ETag form: a strong opaque entity-tag (RFC 9110 §8.8.3). */
export function quotedEtag(etag: string): string {
  return `"${etag}"`;
}

/**
 * The cache policy of every media response: `no-store` forbids shared AND
 * private caching — no cache may serve these bytes without re-running the
 * authorization this lane performs per request.
 */
export const MEDIA_CACHE_CONTROL = "no-store" as const;

// ---------------------------------------------------------------------------
// Range parsing (RFC 9110 §14.1.1 byte-range specs; pure).
// ---------------------------------------------------------------------------

/** What to do with the request's Range header. */
export type RangeDecision =
  | { readonly decision: "full" }
  | { readonly decision: "range"; readonly first: number; readonly last: number }
  | { readonly decision: "unsatisfiable"; readonly totalBytes: number };

/** One byte-range-spec's two possible syntactic forms. */
type RangeSpec = { readonly first: number; readonly last: number | undefined } | {
  readonly suffix: number;
};

const INT_RANGE = /^(\d+)-(\d*)$/;
const SUFFIX_RANGE = /^-(\d+)$/;

/** Parses one trimmed range-spec; null when it is not syntactically valid. */
function parseRangeSpec(spec: string): RangeSpec | null {
  const intMatch = INT_RANGE.exec(spec);
  if (intMatch !== null) {
    return {
      first: Number(intMatch[1]),
      last: intMatch[2] === "" ? undefined : Number(intMatch[2]),
    };
  }
  const suffixMatch = SUFFIX_RANGE.exec(spec);
  if (suffixMatch !== null) {
    return { suffix: Number(suffixMatch[1]) };
  }
  return null;
}

/**
 * Decides the range read for one Range header value against the
 * representation's byte length. Multi-range values and syntactically
 * invalid or unknown-unit headers are ignored (full-body 200), per the
 * range policy in the module docstring.
 */
export function decideRange(rangeHeader: string, totalBytes: number): RangeDecision {
  const equals = /^\s*bytes\s*=\s*(.*)$/i.exec(rangeHeader.trim());
  if (equals === null) {
    // Unknown (or malformed) range unit: MUST ignore the whole header.
    return { decision: "full" };
  }
  const specs = equals[1]!.split(",").map((part) => part.trim());
  if (specs.length !== 1) {
    // Multi-range: ignored whole (documented policy, see module docstring).
    return { decision: "full" };
  }
  const spec = parseRangeSpec(specs[0]!);
  if (spec === null) {
    // Syntactically invalid specifier: ignore the header.
    return { decision: "full" };
  }
  if (totalBytes <= 0) {
    // A zero-length representation satisfies no byte range at all.
    return { decision: "unsatisfiable", totalBytes };
  }
  if ("suffix" in spec) {
    if (spec.suffix === 0) {
      return { decision: "unsatisfiable", totalBytes };
    }
    const first = Math.max(0, totalBytes - spec.suffix);
    return { decision: "range", first, last: totalBytes - 1 };
  }
  if (spec.last !== undefined && spec.last < spec.first) {
    // last-byte-pos < first-byte-pos: invalid, ignore the header.
    return { decision: "full" };
  }
  if (spec.first >= totalBytes) {
    return { decision: "unsatisfiable", totalBytes };
  }
  return {
    decision: "range",
    first: spec.first,
    // An absent or overlong end caps to the last byte.
    last: Math.min(spec.last ?? totalBytes - 1, totalBytes - 1),
  };
}

// ---------------------------------------------------------------------------
// Conditional request decisions (RFC 9110 §13; pure).
// ---------------------------------------------------------------------------

/** Unquotes one entity-tag and strips any weakness prefix (weak form). */
function entityTagOpaque(value: string): string {
  const trimmed = value.trim();
  const withoutWeakness = trimmed.startsWith("W/") ? trimmed.slice(2) : trimmed;
  return withoutWeakness.startsWith('"') && withoutWeakness.endsWith('"') && withoutWeakness.length >= 2
    ? withoutWeakness.slice(1, -1)
    : withoutWeakness;
}

/**
 * True when If-None-Match matches the served representation (weak
 * comparison, per RFC 9110 §13.1.2: `*` matches any, a list matches when
 * any listed tag does).
 */
export function ifNoneMatchMatches(header: string, etag: string): boolean {
  const trimmed = header.trim();
  if (trimmed === "*") {
    return true;
  }
  return trimmed
    .split(",")
    .map((candidate) => entityTagOpaque(candidate))
    .some((candidate) => candidate === etag);
}

/**
 * True when If-Range permits serving the Range (RFC 9110 §13.1.5): only an
 * EXACT STRONG entity-tag match does — a weak validator (`W/"..."`) never
 * permits, and the comparison is never weak. An HTTP-date never matches
 * (this lane serves no Last-Modified), so a date-valued If-Range makes the
 * Range be ignored — the full 200 body is the safe answer for a possibly
 * changed representation.
 */
export function ifRangePermits(header: string, etag: string): boolean {
  const trimmed = header.trim();
  if (trimmed.startsWith("W/")) {
    return false;
  }
  return entityTagOpaque(trimmed) === etag;
}

// ---------------------------------------------------------------------------
// The one read plan (conditional requests + ranges, evaluated in order).
// ---------------------------------------------------------------------------

/** The headers the read decision needs. */
export interface MediaReadHeaders {
  readonly range?: string | undefined;
  readonly ifNoneMatch?: string | undefined;
  readonly ifRange?: string | undefined;
}

/** The complete read plan for one authorized media request. */
export type MediaReadPlan =
  | { readonly status: 200 }
  | { readonly status: 304 }
  | { readonly status: 416; readonly totalBytes: number }
  | { readonly status: 206; readonly first: number; readonly last: number };

/**
 * The single decision the gateway route follows: If-None-Match first (304
 * needs no Range and no R2 read), then Range under If-Range. Every outcome
 * is exact — the route never re-derives HTTP semantics.
 */
export function decideMediaRead(headers: MediaReadHeaders, etag: string, totalBytes: number): MediaReadPlan {
  if (headers.ifNoneMatch !== undefined && ifNoneMatchMatches(headers.ifNoneMatch, etag)) {
    return { status: 304 };
  }
  if (headers.range === undefined || headers.range.trim() === "") {
    return { status: 200 };
  }
  if (headers.ifRange !== undefined && !ifRangePermits(headers.ifRange, etag)) {
    // Changed (or unverifiable) representation: ignore the Range entirely.
    return { status: 200 };
  }
  const range = decideRange(headers.range, totalBytes);
  if (range.decision === "full") {
    return { status: 200 };
  }
  if (range.decision === "unsatisfiable") {
    return { status: 416, totalBytes: range.totalBytes };
  }
  return { status: 206, first: range.first, last: range.last };
}

