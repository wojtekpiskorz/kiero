/**
 * Google OAuth / Calendar API protocol (G1): pure URL construction, PKCE
 * material, token-exchange request/response classification and calendar
 * find-or-create requests for the REAL Google endpoints' protocol.
 *
 * This module contains NO Convex imports and performs NO I/O decisions on
 * its own: every function is either a pure builder/parser or a thin
 * bounded-fetch executor with an explicit AbortController deadline, so the
 * whole protocol is testable without Google credentials (focused tests run
 * it against a clearly-labeled fake endpoint, tests/g1/exchange.test.ts).
 *
 * Scope minimum (docs/research/google-calendar-integration-facts.md):
 * - `openid`, `email`: the connected Google account's `sub`/`email` (the
 *   account is displayed, never linked to Kiero identity);
 * - `https://www.googleapis.com/auth/calendar.app.created`: create the
 *   dedicated calendar and manage events on app-created calendars ONLY.
 *   `calendarList.list` is NOT granted by this scope, so recovery uses the
 *   stored calendar id (docs/research/google-calendar-reconnect-facts.md).
 *
 * Uncertainty semantics (the A3 echo template): a 2xx answer is a
 * confirmation; a 4xx answer from the token endpoint is a DEFINITE failure;
 * a 5xx answer, a deadline hit or an ambiguous body is UNCERTAIN — the
 * external system may have performed its effect (a consumed authorization
 * code, a rotated refresh token, a created calendar) before the clean
 * answer was lost. Uncertain outcomes never retry blindly; they surface as
 * `unknown` for reconciliation or an explicit user decision.
 */

// ---------------------------------------------------------------------------
// Constants (the real Google endpoints' protocol).
// ---------------------------------------------------------------------------

/** Google's human authorization endpoint (OAuth 2.0 for Web Servers). */
export const GOOGLE_AUTHORIZATION_ENDPOINT =
  "https://accounts.google.com/o/oauth2/v2/auth";

/** Google's token endpoint (exchange and refresh). */
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";

/** Google Calendar API v3 base (create: POST {base}/calendars). */
export const GOOGLE_CALENDAR_API_BASE = "https://www.googleapis.com/calendar/v3";

/**
 * The least required scope set. `calendar.app.created` is the dedicated-
 * calendar scope; the identity scopes are the minimum that still yields
 * `sub` (account identity) and `email` (display) in the id_token.
 */
export const REQUIRED_CALENDAR_SCOPES: readonly string[] = [
  "openid",
  "email",
  "https://www.googleapis.com/auth/calendar.app.created",
];

/** Upper bound of a dedicated calendar summary (Google field limit). */
export const MAX_CALENDAR_SUMMARY_LENGTH = 100;

/** Bounded HTTP deadlines for the external legs (echo: 2s class). */
export const TOKEN_HTTP_TIMEOUT_MS = 4_000;
export const CALENDAR_HTTP_TIMEOUT_MS = 4_000;

// ---------------------------------------------------------------------------
// base64url helpers (Web Crypto compatible, no Node dependency).
// ---------------------------------------------------------------------------

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** SHA-256 hex digest (the correlation-hash path, like B3 code hashes). */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

// ---------------------------------------------------------------------------
// PKCE + state material.
// ---------------------------------------------------------------------------

/** One authorization flow's server-owned secrets (never client-visible). */
export interface AuthorizationChallenge {
  /** One-time state value sent to Google and returned by the callback. */
  readonly state: string;
  /** SHA-256 hex of `state` (what the row stores for correlation). */
  readonly stateHash: string;
  /** PKCE code_verifier (RFC 7636; stays server-side until the exchange). */
  readonly verifier: string;
  /** base64url(SHA-256(verifier)) — the S256 code_challenge. */
  readonly codeChallenge: string;
}

function randomBase64Url(byteLength: number): string {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

/**
 * Derives the S256 code_challenge for one verifier (RFC 7636):
 * base64url(SHA-256(verifier)) without padding.
 */
export async function deriveCodeChallenge(verifier: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier));
  return bytesToBase64Url(new Uint8Array(digest));
}

/**
 * Generates the single-use state and the PKCE verifier/challenge with Web
 * Crypto only (32 bytes each: 43 base64url characters, like B1/B3 codes).
 */
export async function generateAuthorizationChallenge(): Promise<AuthorizationChallenge> {
  const state = randomBase64Url(32);
  const verifier = randomBase64Url(32);
  return {
    state,
    stateHash: await sha256Hex(state),
    verifier,
    codeChallenge: await deriveCodeChallenge(verifier),
  };
}

// ---------------------------------------------------------------------------
// Authorization URL construction.
// ---------------------------------------------------------------------------

export interface AuthorizationUrlInput {
  readonly clientId: string;
  readonly redirectUri: string;
  readonly state: string;
  readonly codeChallenge: string;
  /** `consent` forces a fresh refresh_token on reconnects (Google docs). */
  readonly prompt?: "consent" | "select_account";
}

/**
 * Builds the Google authorization URL exactly per the Web-Server flow:
 * response_type=code, S256 PKCE, access_type=offline (server-side refresh),
 * the least required scope set, and the inclusion params that make the
 * granted scopes visible in the token response.
 */
export function buildAuthorizationUrl(input: AuthorizationUrlInput): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    scope: REQUIRED_CALENDAR_SCOPES.join(" "),
    state: input.state,
    code_challenge: input.codeChallenge,
    code_challenge_method: "S256",
    access_type: "offline",
    include_granted_scopes: "true",
    prompt: input.prompt ?? "consent",
  });
  return `${GOOGLE_AUTHORIZATION_ENDPOINT}?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Token endpoint: exchange and refresh.
// ---------------------------------------------------------------------------

/** The decoded payload of a successful token response. */
export interface TokenGrant {
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly expiresInSeconds: number;
  /** Space-separated granted scopes exactly as Google reported them. */
  readonly grantedScope: string;
  /** Present on the Web-Server flow; carries the account `sub`/`email`. */
  readonly idToken: string | null;
}

/** Why a token leg did not produce a grant (machine kinds only). */
export type TokenFailureKind =
  | "definite_invalid_request" // 400/401: the code/grant is refused
  | "definite_network" // connection failed before anything was sent
  | "unknown_status" // 5xx or unusual status: effect may have happened
  | "unknown_timeout" // deadline hit: effect may have happened
  | "unknown_body"; // unparseable/empty success body

export type TokenLegOutcome =
  | { readonly kind: "granted"; readonly grant: TokenGrant }
  | { readonly kind: "failed"; readonly failure: TokenFailureKind };

/** Splits a space-separated scope string into tokens (empty -> []). */
export function splitScopes(scope: string): string[] {
  return scope.split(/\s+/).filter((token) => token.length > 0);
}

/** Whether every required scope appears in the granted set. */
export function scopesSatisfied(granted: readonly string[]): boolean {
  const set = new Set(granted);
  return REQUIRED_CALENDAR_SCOPES.every((scope) => set.has(scope));
}

/** Parses a token-endpoint response body into the closed outcome union. */
export function parseTokenResponseBody(status: number, body: unknown): TokenLegOutcome {
  if (status === 200) {
    if (typeof body !== "object" || body === null) {
      return { kind: "failed", failure: "unknown_body" };
    }
    const record = body as Record<string, unknown>;
    const accessToken = record.access_token;
    const scope = record.scope;
    const expiresIn = record.expires_in;
    if (
      typeof accessToken !== "string" ||
      accessToken.length === 0 ||
      typeof scope !== "string" ||
      typeof expiresIn !== "number"
    ) {
      return { kind: "failed", failure: "unknown_body" };
    }
    return {
      kind: "granted",
      grant: {
        accessToken,
        refreshToken: typeof record.refresh_token === "string" ? record.refresh_token : null,
        expiresInSeconds: expiresIn,
        grantedScope: scope,
        idToken: typeof record.id_token === "string" ? record.id_token : null,
      },
    };
  }
  if (status === 400 || status === 401) {
    // Google answers invalid_grant/invalid_client here: DEFINITE refusal.
    return { kind: "failed", failure: "definite_invalid_request" };
  }
  // 5xx and anything unusual: the request may have been processed.
  return { kind: "failed", failure: "unknown_status" };
}

/** The id_token claims the connection records (payload decode only). */
export interface GoogleAccountClaims {
  readonly subject: string;
  readonly email: string | null;
}

/**
 * Decodes the id_token payload (NOT a signature verification).
 *
 * Trusted only because the id_token arrives in the SAME response as the
 * access token from Google's token endpoint over TLS: the transport, not a
 * local signature check, is the integrity guarantee (Google's Web-Server
 * flow documents exactly this posture for server-side consumers).
 */
export function decodeIdTokenClaims(idToken: string): GoogleAccountClaims | null {
  const segments = idToken.split(".");
  if (segments.length !== 3) {
    return null;
  }
  try {
    const payload = new TextDecoder().decode(base64UrlToBytes(segments[1] ?? ""));
    const parsed: unknown = JSON.parse(payload);
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (typeof record.sub !== "string" || record.sub.length === 0) {
      return null;
    }
    return {
      subject: record.sub,
      email: typeof record.email === "string" ? record.email : null,
    };
  } catch {
    return null;
  }
}

/** One bounded POST to the token endpoint with the echo outcome mapping. */
export async function postTokenEndpoint(
  endpoint: string,
  form: Record<string, string>,
  timeoutMs: number,
): Promise<TokenLegOutcome> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(form).toString(),
      signal: controller.signal,
    });
  } catch (cause) {
    clearTimeout(deadline);
    if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
      return { kind: "failed", failure: "unknown_timeout" };
    }
    // Nothing was delivered (connection-level failure): definite.
    return { kind: "failed", failure: "definite_network" };
  }
  clearTimeout(deadline);
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return parseTokenResponseBody(response.status, body);
}

/** Builds and executes the authorization-code exchange (PKCE + secret). */
export function exchangeCodeForTokens(input: {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly code: string;
  readonly redirectUri: string;
  readonly verifier: string;
}): Promise<TokenLegOutcome> {
  return postTokenEndpoint(
    input.tokenEndpoint,
    {
      grant_type: "authorization_code",
      code: input.code,
      client_id: input.clientId,
      client_secret: input.clientSecret,
      redirect_uri: input.redirectUri,
      code_verifier: input.verifier,
    },
    TOKEN_HTTP_TIMEOUT_MS,
  );
}

/** Builds and executes the refresh-token grant. */
export function refreshAccessToken(input: {
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly refreshToken: string;
}): Promise<TokenLegOutcome> {
  return postTokenEndpoint(
    input.tokenEndpoint,
    {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      client_secret: input.clientSecret,
    },
    TOKEN_HTTP_TIMEOUT_MS,
  );
}

// ---------------------------------------------------------------------------
// Calendar API: find-or-create protocol.
// ---------------------------------------------------------------------------

/** The dedicated calendar's summary, named for the company. */
export function dedicatedCalendarSummary(companyName: string): string {
  const trimmed = companyName.trim();
  const base = trimmed.length === 0 ? "Kiero" : `Kiero — ${trimmed}`;
  return base.length > MAX_CALENDAR_SUMMARY_LENGTH
    ? `${base.slice(0, MAX_CALENDAR_SUMMARY_LENGTH - 1)}…`
    : base;
}

/** One calendar-API leg outcome (same uncertainty vocabulary). */
export type CalendarReadOutcome =
  | { readonly kind: "reachable" }
  | { readonly kind: "ambiguous_gone" } // 401/403/404: deleted OR inaccessible
  | { readonly kind: "unknown"; readonly failure: TokenFailureKind };

export type CalendarCreateOutcome =
  | { readonly kind: "created"; readonly calendarId: string }
  | { readonly kind: "definitely_failed"; readonly failure: TokenFailureKind }
  | { readonly kind: "unknown"; readonly failure: TokenFailureKind };

/**
 * Verifies the known dedicated calendar by id (`calendarList.list` is NOT
 * available under `calendar.app.created`, so the stored id IS the recovery
 * path — docs/research/google-calendar-reconnect-facts.md).
 */
export async function readKnownCalendar(input: {
  readonly apiBase: string;
  readonly accessToken: string;
  readonly calendarId: string;
}): Promise<CalendarReadOutcome> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), CALENDAR_HTTP_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(
      `${input.apiBase.replace(/\/$/, "")}/calendars/${encodeURIComponent(input.calendarId)}`,
      {
        method: "GET",
        headers: { authorization: `Bearer ${input.accessToken}` },
        signal: controller.signal,
      },
    );
  } catch (cause) {
    clearTimeout(deadline);
    if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
      return { kind: "unknown", failure: "unknown_timeout" };
    }
    return { kind: "unknown", failure: "definite_network" };
  }
  clearTimeout(deadline);
  // Google documents 404 for a nonexistent calendar AND for one the user
  // can no longer access; 401/403 are the revoked-token shapes. All three
  // are ambiguous about DELETION (the explicit Odtwórz precondition).
  if (response.status === 200) {
    return { kind: "reachable" };
  }
  if (response.status === 401 || response.status === 403 || response.status === 404) {
    return { kind: "ambiguous_gone" };
  }
  return { kind: "unknown", failure: "unknown_status" };
}

/** Creates the dedicated calendar (POST {apiBase}/calendars). */
export async function createDedicatedCalendar(input: {
  readonly apiBase: string;
  readonly accessToken: string;
  readonly summary: string;
}): Promise<CalendarCreateOutcome> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), CALENDAR_HTTP_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(`${input.apiBase.replace(/\/$/, "")}/calendars`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ summary: input.summary }),
      signal: controller.signal,
    });
  } catch (cause) {
    clearTimeout(deadline);
    if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
      // The POST may have created the calendar before the deadline hit:
      // uncertain, and the id is unknown — reconcile-never-blind-retry.
      return { kind: "unknown", failure: "unknown_timeout" };
    }
    return { kind: "unknown", failure: "definite_network" };
  }
  clearTimeout(deadline);
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  if (response.status === 200 || response.status === 201) {
    const id =
      typeof body === "object" && body !== null
        ? (body as Record<string, unknown>).id
        : undefined;
    if (typeof id !== "string" || id.length === 0) {
      // Created but no readable id: treat as unknown, never re-POST blind.
      return { kind: "unknown", failure: "unknown_body" };
    }
    return { kind: "created", calendarId: id };
  }
  if (response.status === 400 || response.status === 401 || response.status === 403) {
    return { kind: "definitely_failed", failure: "definite_invalid_request" };
  }
  return { kind: "unknown", failure: "unknown_status" };
}
