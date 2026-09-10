/**
 * Web Push wire protocol (F3): RFC 8291 "aes128gcm" payload encryption and
 * RFC 8292 VAPID server identification, implemented over WebCrypto so the
 * SAME code runs in a Convex action (the transport's home), in Node
 * (tests; Node >= 22 exposes the same WebCrypto globals) and in the
 * browser. Pure module: no Convex imports, no clock, no environment; the
 * only randomness is the per-message record salt, injected as an argument
 * so the RFC 8291 Appendix A vector runs deterministically.
 *
 * Why no `web-push` dependency: the pinned dependency graph is a
 * coordinated shared change, and this protocol is two small, fully
 * specified constructions. Correctness is pinned by the RFC 8291
 * Appendix A intermediate values (tests/f3/protocol.test.ts asserts every
 * stage against the RFC's own numbers) and by the live-proof listener,
 * which decrypts the real POST body with independent Node crypto
 * primitives (createECDH + hkdfSync + createDecipheriv), never with this
 * module's code.
 *
 * Uncertainty semantics (the echo/G3 discipline): a POST that produces a
 * clean status is definite; a deadline hit is `unknown` with the distinct
 * `timeout` cause (the platform's blind-retry block reads that word); any
 * other non-answer (5xx, dropped connection, unreadable body) is
 * causeless `unknown`. A 404/410 is the terminal "subscription gone"
 * answer that disables the subscription.
 */

/** Bounded HTTP deadline for one push leg (echo/G3: 2-4s class). */
export const PUSH_HTTP_TIMEOUT_MS = 4_000;

/** Push services are not required to accept more than 4096 octets total. */
export const MAX_PLAINTEXT_BYTES = 3_993 - 16 - 1;

/** The aes128gcm record size announced in the header (RFC 8291 section 4). */
const RECORD_SIZE = 4_096;

// ---------------------------------------------------------------------------
// base64url helpers (RFC 4648 section 5, no padding - the wire form both
// RFCs and the Push API use).
// ---------------------------------------------------------------------------

/** Decodes unpadded base64url to bytes; accepts padded input leniently. */
export function base64UrlDecode(value: string): Uint8Array {
  const normalized = value.replace(/=+$/, "").replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(normalized);
  const out = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    out[index] = binary.charCodeAt(index);
  }
  return out;
}

/** Encodes bytes as unpadded base64url. */
export function base64UrlEncode(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** True when the string is nonempty unpadded-or-padded base64url. */
export function isBase64Url(value: string): boolean {
  return value.length > 0 && /^[A-Za-z0-9_=-]+$/.test(value);
}

function concat(...parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function textBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

/** The WebCrypto surface this module needs (injected by Convex/Node/browsers). */
type Subtle = Pick<
  typeof crypto.subtle,
  "importKey" | "generateKey" | "deriveBits" | "encrypt" | "sign" | "exportKey"
>;

/** Structural crypto handle so unit tests can pass Node's webcrypto explicitly. */
export interface ProtocolCrypto {
  readonly subtle: Subtle;
  /** RFC 8291's random 16-byte record salt, as an injectable seam. */
  randomSalt(): Uint8Array;
}

/** The runtime crypto (WebCrypto is global in Convex actions and Node >= 22). */
export function runtimeCrypto(): ProtocolCrypto {
  return {
    subtle: crypto.subtle,
    randomSalt: () => crypto.getRandomValues(new Uint8Array(16)),
  };
}

// ---------------------------------------------------------------------------
// RFC 8291: aes128gcm payload encryption.
// ---------------------------------------------------------------------------

/**
 * The HKDF key-combining step of RFC 8291 section 3:
 *
 *   PRK_key = HKDF-Extract(salt=auth_secret, IKM=ecdh_secret)
 *   key_info = "WebPush: info" || 0x00 || ua_public || as_public
 *   IKM = HKDF-Expand(PRK_key, key_info, 32)
 *
 * One WebCrypto deriveBits call performs Extract+Expand with the given
 * salt and info, so this is exact.
 */
async function webPushIkm(
  pc: ProtocolCrypto,
  ecdhSecret: Uint8Array,
  authSecret: Uint8Array,
  uaPublic: Uint8Array,
  asPublic: Uint8Array,
): Promise<Uint8Array> {
  const secretKey = await pc.subtle.importKey("raw", ecdhSecret as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const info = concat(textBytes("WebPush: info"), new Uint8Array([0]), uaPublic, asPublic);
  const bits = await pc.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: authSecret as BufferSource, info: info as BufferSource },
    secretKey,
    256,
  );
  return new Uint8Array(bits);
}

/**
 * Encrypts one push payload per RFC 8291 into a single-record aes128gcm
 * body: salt(16) || rs(4, big endian 4096) || idlen(1 = 65) || keyid(65
 * byte raw ephemeral public key) || AES-128-GCM(plaintext || 0x02).
 * Returns the body plus the ephemeral public key (the RFC vector test
 * pins both against the appendix values).
 */
export async function encryptPushPayload(
  pc: ProtocolCrypto,
  input: {
    readonly plaintext: Uint8Array;
    readonly p256dhBase64Url: string;
    readonly authBase64Url: string;
    /** The ephemeral application-server key pair; generated when absent. */
    readonly ephemeral?: { readonly privateKey: Uint8Array; readonly publicKey: Uint8Array };
  },
): Promise<{ readonly body: Uint8Array; readonly ephemeralPublicKey: Uint8Array }> {
  if (input.plaintext.length > MAX_PLAINTEXT_BYTES) {
    throw new Error(`push payload too large: ${input.plaintext.length} > ${MAX_PLAINTEXT_BYTES}`);
  }
  const uaPublic = base64UrlDecode(input.p256dhBase64Url);
  const authSecret = base64UrlDecode(input.authBase64Url);

  // The ephemeral ECDH pair (P-256). The RFC vector injects its raw keys;
  // production generates a fresh pair per message.
  let ephPrivate: Uint8Array;
  let asPublic: Uint8Array;
  if (input.ephemeral === undefined) {
    const pair = await pc.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, [
      "deriveBits",
    ]);
    asPublic = new Uint8Array(await pc.subtle.exportKey("raw", pair.publicKey));
    const privateJwk = (await pc.subtle.exportKey("jwk", pair.privateKey)) as {
      d?: string;
    };
    if (typeof privateJwk.d !== "string") {
      throw new Error("push protocol: generated key exported no private scalar");
    }
    ephPrivate = base64UrlDecode(privateJwk.d);
  } else {
    ephPrivate = input.ephemeral.privateKey;
    asPublic = input.ephemeral.publicKey;
  }

  // ECDH(as_private, ua_public) -> 32-octet shared x coordinate.
  const importedPrivate = await pc.subtle.importKey(
    "jwk",
    {
      kty: "EC",
      crv: "P-256",
      d: base64UrlEncode(ephPrivate),
      x: base64UrlEncode(asPublic.subarray(1, 33)),
      y: base64UrlEncode(asPublic.subarray(33, 65)),
    },
    { name: "ECDH", namedCurve: "P-256" },
    false,
    ["deriveBits"],
  );
  const importedUa = await pc.subtle.importKey(
    "raw",
    uaPublic as BufferSource,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const ecdhSecret = new Uint8Array(
    await pc.subtle.deriveBits({ name: "ECDH", public: importedUa }, importedPrivate, 256),
  );

  const ikm = await webPushIkm(pc, ecdhSecret, authSecret, uaPublic, asPublic);
  const salt = pc.randomSalt();
  const ikmKey = await pc.subtle.importKey("raw", ikm as BufferSource, "HKDF", false, [
    "deriveBits",
  ]);
  const cek = new Uint8Array(
    await pc.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: salt as BufferSource,
        info: concat(textBytes("Content-Encoding: aes128gcm"), new Uint8Array([0])) as BufferSource,
      },
      ikmKey,
      128,
    ),
  );
  const nonce = new Uint8Array(
    await pc.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt: salt as BufferSource,
        info: concat(textBytes("Content-Encoding: nonce"), new Uint8Array([0])) as BufferSource,
      },
      ikmKey,
      96,
    ),
  );

  const cekKey = await pc.subtle.importKey("raw", cek as BufferSource, "AES-GCM", false, [
    "encrypt",
  ]);
  const sealed = new Uint8Array(
    await pc.subtle.encrypt(
      { name: "AES-GCM", iv: nonce as BufferSource, tagLength: 128 },
      cekKey,
      concat(input.plaintext, new Uint8Array([0x02])) as BufferSource,
    ),
  );

  const header = new Uint8Array(86);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE, false);
  header[20] = 65; // idlen: the raw ephemeral public key
  header.set(asPublic, 21);
  return { body: concat(header, sealed), ephemeralPublicKey: asPublic };
}

// ---------------------------------------------------------------------------
// RFC 8292: the VAPID ES256 JWT and Authorization header.
// ---------------------------------------------------------------------------

/** The pinned private-key form this lane's environment variables carry. */
export interface VapidKeyMaterial {
  /** base64url of the 65-octet raw uncompressed P-256 public point. */
  readonly publicKeyBase64Url: string;
  /** base64url of the PKCS#8 DER encoding of the P-256 private key. */
  readonly privateKeyBase64Url: string;
  /** Contact URI (mailto:) the push service may reach the operator at. */
  readonly subject: string;
}

/** Parses and shape-checks the key material; null when malformed. */
export function vapidKeysOf(
  publicKey: string | undefined,
  privateKey: string | undefined,
  subject: string | undefined,
): VapidKeyMaterial | null {
  if (
    typeof publicKey !== "string" ||
    typeof privateKey !== "string" ||
    typeof subject !== "string"
  ) {
    return null;
  }
  if (!isBase64Url(publicKey) || !isBase64Url(privateKey)) {
    return null;
  }
  let publicBytes: Uint8Array;
  try {
    publicBytes = base64UrlDecode(publicKey);
  } catch {
    return null;
  }
  if (publicBytes.length !== 65 || publicBytes[0] !== 0x04) {
    return null;
  }
  if (!subject.startsWith("mailto:") && !subject.startsWith("https:")) {
    return null;
  }
  return { publicKeyBase64Url: publicKey, privateKeyBase64Url: privateKey, subject };
}

/** The origin (scheme://host[:port]) of a URL, for the JWT "aud" claim. */
export function originOf(endpoint: string): string | null {
  try {
    return new URL(endpoint).origin;
  } catch {
    return null;
  }
}

/**
 * Builds the RFC 8292 `Authorization: vapid t=..., k=...` header value.
 * The JWT carries {"aud": endpoint origin, "exp": nowMs + 12h, "sub":
 * subject}, signed ES256 (JWS raw r||s signature - exactly what
 * WebCrypto's ECDSA emits).
 */
export async function vapidAuthorization(
  pc: ProtocolCrypto,
  keys: VapidKeyMaterial,
  endpoint: string,
  nowMs: number,
): Promise<string> {
  const audience = originOf(endpoint);
  if (audience === null) {
    throw new Error(`vapid: endpoint is not a URL: ${endpoint}`);
  }
  const header = { typ: "JWT", alg: "ES256" };
  const claims = {
    aud: audience,
    exp: Math.floor(nowMs / 1000) + 12 * 60 * 60,
    sub: keys.subject,
  };
  const encodedHeader = base64UrlEncode(textBytes(JSON.stringify(header)));
  const encodedClaims = base64UrlEncode(textBytes(JSON.stringify(claims)));
  const signingInput = `${encodedHeader}.${encodedClaims}`;
  const privateKey = await pc.subtle.importKey(
    "pkcs8",
    base64UrlDecode(keys.privateKeyBase64Url) as BufferSource,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = await pc.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    textBytes(signingInput) as BufferSource,
  );
  return `vapid t=${signingInput}.${base64UrlEncode(new Uint8Array(signature))}, k=${keys.publicKeyBase64Url}`;
}

// ---------------------------------------------------------------------------
// The one bounded POST leg (the echo/G3 fetch discipline).
// ---------------------------------------------------------------------------

/** What one push leg definitively reported. */
export type PushLegReport =
  | { readonly kind: "delivered" }
  /** 404/410: the subscription no longer exists at the push service. */
  | { readonly kind: "gone" }
  /** 400: the request itself is invalid (oversized/malformed payload). */
  | { readonly kind: "rejected" }
  /** 401/403: the push service refused the application server identity. */
  | { readonly kind: "unauthorized" }
  /** 429: the push service asked to slow down; safe to re-attempt later. */
  | { readonly kind: "retry_later" }
  /**
   * Uncertain: the message may have been delivered. `cause: "timeout"`
   * names the bounded-deadline hit; every other non-answer (5xx, dropped
   * connection, unreadable body) stays causeless. Both words block blind
   * re-sends identically (the platform's uncertain-outcome contract).
   */
  | { readonly kind: "unknown"; readonly cause?: "timeout" };

/** Why a bounded fetch did not produce a clean answer (internal only). */
type FetchFailure = "unknown_timeout" | "unknown_network";

/** One bounded fetch; never throws (the G3 boundedFetch shape). */
async function boundedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; failure?: FetchFailure }> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (cause) {
    clearTimeout(deadline);
    if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
      return { status: 0, failure: "unknown_timeout" };
    }
    return { status: 0, failure: "unknown_network" };
  }
  clearTimeout(deadline);
  return { status: response.status };
}

/** Maps one push-service status to the leg vocabulary (pure). */
export function classifyPushStatus(status: number): PushLegReport {
  if (status >= 200 && status < 300) {
    return { kind: "delivered" };
  }
  if (status === 404 || status === 410) {
    return { kind: "gone" };
  }
  if (status === 400) {
    return { kind: "rejected" };
  }
  if (status === 401 || status === 403) {
    return { kind: "unauthorized" };
  }
  if (status === 429) {
    return { kind: "retry_later" };
  }
  return { kind: "unknown" };
}

/** The injected transport seam; production is boundedFetch over fetch. */
export type PushTransport = (
  endpoint: string,
  headers: Record<string, string>,
  body: Uint8Array,
  timeoutMs: number,
) => Promise<{ status: number; failure?: FetchFailure }>;

/** The default transport: the real bounded fetch POST. */
export const httpPushTransport: PushTransport = (endpoint, headers, body, timeoutMs) =>
  boundedFetch(endpoint, { method: "POST", headers, body: body as BufferSource }, timeoutMs);

/**
 * Runs ONE complete push leg: encrypt the payload (RFC 8291), build the
 * VAPID Authorization header (RFC 8292) and POST it with the TTL. Pure
 * decision over the transport's answer; never throws.
 */
export async function deliverOneWebPush(
  pc: ProtocolCrypto,
  input: {
    readonly endpoint: string;
    readonly p256dhBase64Url: string;
    readonly authBase64Url: string;
    readonly payloadJson: string;
    readonly ttlSeconds: number;
    readonly keys: VapidKeyMaterial;
    readonly nowMs: number;
    readonly timeoutMs?: number;
    readonly transport?: PushTransport;
  },
): Promise<PushLegReport> {
  let body: Uint8Array;
  let authorization: string;
  try {
    const encrypted = await encryptPushPayload(pc, {
      plaintext: textBytes(input.payloadJson),
      p256dhBase64Url: input.p256dhBase64Url,
      authBase64Url: input.authBase64Url,
    });
    body = encrypted.body;
    authorization = await vapidAuthorization(pc, input.keys, input.endpoint, input.nowMs);
  } catch {
    // Local construction failure (malformed keys, oversized payload): the
    // request never left, so this is definite - the caller records it as a
    // terminal leg failure, never a retryable one.
    return { kind: "rejected" };
  }
  const answer = await (input.transport ?? httpPushTransport)(
    input.endpoint,
    {
      TTL: String(Math.max(0, Math.round(input.ttlSeconds))),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      Authorization: authorization,
    },
    body,
    input.timeoutMs ?? PUSH_HTTP_TIMEOUT_MS,
  );
  if (answer.failure === "unknown_timeout") {
    return { kind: "unknown", cause: "timeout" };
  }
  if (answer.failure === "unknown_network") {
    return { kind: "unknown" };
  }
  return classifyPushStatus(answer.status);
}
