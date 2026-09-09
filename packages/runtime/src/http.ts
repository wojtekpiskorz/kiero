/**
 * The single envelope-to-HTTP-status mapping for transport boundaries.
 *
 * Every boundary that answers a `ResultEnvelope` over HTTP — the Convex
 * bridge endpoints and the gateway routes — maps statuses through THIS
 * definition (the repo's mirror-is-a-hazard ruling; a second copy already
 * drifted once). Pure: no Convex, no Worker types.
 */

import type { ResultEnvelope } from "@kiero/contracts";

/** The HTTP status one closed-error envelope maps to (ok maps to 200). */
export function envelopeHttpStatus(envelope: ResultEnvelope): number {
  if (envelope._tag === "ok") {
    return 200;
  }
  switch (envelope.error._tag) {
    case "unauthenticated":
      return 401;
    case "forbidden":
      return 403;
    case "not_found":
      return 404;
    case "unsupported":
      return 501;
    case "unavailable":
      return 503;
    default:
      return 400;
  }
}
