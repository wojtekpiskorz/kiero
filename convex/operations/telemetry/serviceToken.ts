/**
 * Service-credential verification (shared, I2 round-1 repair).
 *
 * ONE definition of the bearer check used by BOTH HTTP boundaries (the
 * platform bridge and the telemetry ingest/heartbeat endpoints). A mirror
 * of credential-comparison code is a hazard: the copies drift silently and
 * one of them becomes the weak path. This module is deliberately free of
 * convex/server imports so any runtime (Convex actions, Workers) can use it.
 *
 * The presented and expected tokens are compared as SHA-256 digests so the
 * secret is never handled in the clear; the comparison stays constant-shape
 * regardless of length differences. Neither side is ever logged or echoed.
 */

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Digest-compared bearer check for the shared service credential.
 * `expected` is the deployment/Worker-side configured value; returns false
 * for a missing configuration, a missing header, or any mismatch.
 */
export async function verifyServiceBearerToken(
  authorizationHeader: string | null,
  expected: string | undefined,
): Promise<boolean> {
  if (expected === undefined || expected === "") {
    return false;
  }
  if (authorizationHeader === null || !authorizationHeader.startsWith("Bearer ")) {
    return false;
  }
  const presented = authorizationHeader.slice("Bearer ".length);
  const [presentedHash, expectedHash] = await Promise.all([sha256Hex(presented), sha256Hex(expected)]);
  let equal = presentedHash.length === expectedHash.length;
  for (let index = 0; index < presentedHash.length; index += 1) {
    equal = presentedHash[index] === expectedHash[index] && equal;
  }
  return equal;
}
