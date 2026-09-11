/**
 * The authorized media loader (H3): the one client-side path to D3's media
 * channel.
 *
 * Media never gets a public URL: every load is a FRESH authenticated
 * request to the gateway (`Authorization: Bearer <Convex id token>`), the
 * gateway re-runs the whole per-request authorization chain on Convex
 * (live session -> membership -> tenant scope -> lifecycle -> verified
 * representation) before any byte, and the answers carry `no-store` — so a
 * revoked session or membership refuses the NEXT request, and nothing is
 * cacheable without re-authorizing. The loaded bytes become a short-lived
 * in-memory object URL for the `<audio controls>`/`<img>` element; closing
 * the view revokes it.
 *
 * Two read paths, exactly D3's routes:
 * - `/media/attachments/<id>` — the canonical read (the SERVER picks the
 *   current retained/received representation; this side never predicts it);
 * - `/media/representations/<id>` — the exact-version read media anchors
 *   resolve against (an image highlight renders over the very
 *   representation whose pixel space the anchor's coordinates are in).
 *
 * `probeAuthorizedRange` issues one authorized RANGE request (the same
 * request shape a streaming seek produces) and reports the raw status:
 * the browser-facing evidence that every range re-authorizes.
 */

/** The fetch implementation this module runs with (injectable for tests). */
export type MediaFetch = (input: string, init: RequestInit) => Promise<Response>;

/** One authorized load outcome (closed vocabulary, no error detail leaks). */
export type MediaLoadOutcome =
  | { readonly state: "loaded"; readonly objectUrl: string; readonly bytes: number }
  | { readonly state: "denied" }
  | { readonly state: "unavailable" };

/** One authorized range probe outcome. */
export type RangeProbeOutcome =
  | { readonly state: "satisfied"; readonly contentRange: string | null }
  | { readonly state: "denied" }
  | { readonly state: "unavailable" };

/** The bearer header value for one Convex id token. */
export function bearerOf(token: string): string {
  return `Bearer ${token}`;
}

/** Builds the canonical attachment read URL (the server picks the bytes). */
export function attachmentMediaUrl(gatewayUrl: string, attachmentId: string): string {
  return `${gatewayUrl}/media/attachments/${encodeURIComponent(attachmentId)}`;
}

/** Builds the exact-representation read URL media anchors resolve against. */
export function representationMediaUrl(gatewayUrl: string, representationId: string): string {
  return `${gatewayUrl}/media/representations/${encodeURIComponent(representationId)}`;
}

const DENIED_STATUSES = new Set([401, 403, 404]);

async function authorizedGet(
  fetchImpl: MediaFetch,
  url: string,
  token: string,
  headers: Record<string, string>,
): Promise<Response | null> {
  try {
    return await fetchImpl(url, { headers: { authorization: bearerOf(token), ...headers } });
  } catch {
    return null; // network-level failure: no channel at all
  }
}

/**
 * Loads one media object through the authorized channel and returns an
 * in-memory object URL for the element (the caller owns revoking it).
 */
export async function loadAuthorizedMedia(
  fetchImpl: MediaFetch,
  url: string,
  token: string | null,
): Promise<MediaLoadOutcome> {
  if (token === null || token.length === 0) {
    return { state: "denied" };
  }
  const response = await authorizedGet(fetchImpl, url, token, {});
  if (response === null) {
    return { state: "unavailable" };
  }
  if (!response.ok) {
    return DENIED_STATUSES.has(response.status) ? { state: "denied" } : { state: "unavailable" };
  }
  const blob = await response.blob();
  return { state: "loaded", objectUrl: URL.createObjectURL(blob), bytes: blob.size };
}

/**
 * Issues ONE authorized range request (the streaming-seek shape) and
 * reports whether the channel satisfied it — with the content-range the
 * gateway answered, or the closed refusal.
 */
export async function probeAuthorizedRange(
  fetchImpl: MediaFetch,
  url: string,
  token: string | null,
  range: string,
): Promise<RangeProbeOutcome> {
  if (token === null || token.length === 0) {
    return { state: "denied" };
  }
  const response = await authorizedGet(fetchImpl, url, token, { range });
  if (response === null) {
    return { state: "unavailable" };
  }
  if (!response.ok) {
    return DENIED_STATUSES.has(response.status) ? { state: "denied" } : { state: "unavailable" };
  }
  // The body belongs to nobody: consume it so the connection closes clean.
  await response.arrayBuffer().catch(() => undefined);
  return { state: "satisfied", contentRange: response.headers.get("content-range") };
}

/**
 * The highlight box geometry for one image-region anchor against its
 * representation's own pixel space (E4's coordinate rule): percentage
 * offsets so the box lands on the same content whatever the rendered
 * size. Null when the space is unknown (the honest no-overlay case).
 */
export function regionBoxStyle(
  region: { readonly x: number; readonly y: number; readonly width: number; readonly height: number },
  space: { readonly width: number | null; readonly height: number | null },
): { left: string; top: string; width: string; height: string } | null {
  if (
    space.width === null ||
    space.height === null ||
    space.width <= 0 ||
    space.height <= 0 ||
    region.width <= 0 ||
    region.height <= 0
  ) {
    return null;
  }
  const pct = (value: number, whole: number): string => `${(value / whole) * 100}%`;
  return {
    left: pct(region.x, space.width),
    top: pct(region.y, space.height),
    width: pct(region.width, space.width),
    height: pct(region.height, space.height),
  };
}

/** Formats one original-time anchor bound as a media timestamp. */
export function mediaTimestamp(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}
