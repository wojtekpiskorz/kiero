/**
 * Guarded G1 proof fixtures (dev deployment only).
 *
 * Same pattern as B1's probe (convex/access/identity/probe.ts): queries and
 * mutations cannot read deployment variables, so every fixture entry is an
 * HTTP action guarded by `KIERO_G1_PROOF_ENABLED === "1"`; on any other
 * deployment the variable is absent and every fixture fails closed.
 *
 * Why these exist (honest scope): the owner has not supplied Google OAuth
 * client credentials (the same owner action B1 recorded), so no proof can
 * walk the real accounts.google.com consent. The fixtures let the evidence
 * script exercise the REAL protocol halves — authorization URL
 * construction, single-use state consumption, PKCE exchange, scope
 * enforcement, calendar find-or-create with uncertain outcomes — against a
 * clearly-labeled fake Google served by the deployment itself (the A3 echo
 * pattern: the stand-in records its effects in `externalEffects` BEFORE
 * answering, so no-duplicate proofs count rows). The live Google legs stay
 * explicitly BLOCKED-owner-action.
 *
 * Fixture values are constants, never secrets.
 */

/** The fixture OAuth client (clearly labeled; never a real credential). */
export const PROOF_FIXTURE_CLIENT_ID = "kiero-g1-proof-fixture.apps.googleusercontent.com";
export const PROOF_FIXTURE_CLIENT_SECRET = "kiero-g1-proof-fixture-secret";

/** The fixture client calendarOAuthConfig falls back to in proof mode. */
export function proofFixtureClient(): { clientId: string; clientSecret: string } {
  return { clientId: PROOF_FIXTURE_CLIENT_ID, clientSecret: PROOF_FIXTURE_CLIENT_SECRET };
}

/** The one fixture calendar id the fake Calendar API serves. */
export const PROOF_CALENDAR_ID = "kiero-proof-calendar";

/** Whether proof fixtures are enabled on this deployment. */
export function proofEnabled(env: { KIERO_G1_PROOF_ENABLED?: string }): boolean {
  return env.KIERO_G1_PROOF_ENABLED === "1";
}

// ---------------------------------------------------------------------------
// The fake endpoints' behavior selection (carried by the proof code).
// ---------------------------------------------------------------------------

/** Token-endpoint behaviors the proof can select. */
export type ProofTokenBehavior = "ok" | "missing_scope" | "invalid_grant" | "timeout" | "crash";

/** Calendar-create behaviors the proof can select. */
export type ProofCalendarBehavior = "ok" | "create_timeout" | "create_rejected" | "ambiguous404" | "read_timeout";

/**
 * Everything the fake endpoints derive from one proof code: the account
 * number (`proof-code-2` -> Google account 2) plus optional `!`-separated
 * behavior selectors for the token leg (`t-…`), the calendar leg (`c-…`)
 * and the later refresh leg (`r-…`). Example:
 * `proof-code-6!t-ok!c-create_timeout` connects account 6 whose dedicated
 * calendar creation stalls past the caller deadline.
 */
export interface ParsedProofCode {
  readonly base: string;
  readonly account: number;
  readonly tokenBehavior: ProofTokenBehavior;
  readonly calendarBehavior: ProofCalendarBehavior;
  readonly refreshBehavior: "ok" | "invalid_grant" | "timeout";
}

/** Parses one proof code (or the access/refresh token derived from it). */
export function parseProofCode(value: string): ParsedProofCode {
  const segments = value.split("!");
  const base = segments[0] ?? value;
  const digits = /(\d+)$/.exec(base);
  let tokenBehavior: ProofTokenBehavior = "ok";
  let calendarBehavior: ProofCalendarBehavior = "ok";
  let refreshBehavior: ParsedProofCode["refreshBehavior"] = "ok";
  for (const segment of segments.slice(1)) {
    switch (segment) {
      case "t-missing_scope":
        tokenBehavior = "missing_scope";
        break;
      case "t-invalid_grant":
        tokenBehavior = "invalid_grant";
        break;
      case "t-timeout":
        tokenBehavior = "timeout";
        break;
      case "t-crash":
        tokenBehavior = "crash";
        break;
      case "c-create_timeout":
        calendarBehavior = "create_timeout";
        break;
      case "c-create_rejected":
        calendarBehavior = "create_rejected";
        break;
      case "c-ambiguous404":
        calendarBehavior = "ambiguous404";
        break;
      case "c-read_timeout":
        calendarBehavior = "read_timeout";
        break;
      case "r-invalid_grant":
        refreshBehavior = "invalid_grant";
        break;
      case "r-timeout":
        refreshBehavior = "timeout";
        break;
    }
  }
  return {
    base,
    account: digits === null ? 1 : Number(digits[1]),
    tokenBehavior,
    calendarBehavior,
    refreshBehavior,
  };
}

/**
 * Derives the fixture Google account from a proof code BASE (no behavior
 * selectors): proof codes carry their account number (`proof-code-2` ->
 * account 2), so the live proof can connect, then SWITCH to a different
 * Google account.
 */
export function proofAccountForCode(codeBase: string): { subject: string; email: string } {
  const match = /(\d+)$/.exec(codeBase);
  const n = match === null ? 1 : Number(match[1]);
  return {
    subject: `proof-google-subject-${n}`,
    email: `g1-google-${n}@kiero.invalid`,
  };
}

/** Minimal HS256-less fixture JWT (header.payload.signature, all dummy). */
function fixtureIdToken(subject: string, email: string): string {
  const encode = (value: unknown): string =>
    btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return [
    encode({ alg: "none", typ: "JWT" }),
    encode({ sub: subject, email }),
    "kiero-g1-proof-fixture-signature",
  ].join(".");
}

/** The fake token endpoint's response for one behavior + code. */
export function proofTokenResponse(
  behavior: ProofTokenBehavior,
  code: string,
  codeVerifier: string,
): { status: number; body: unknown } {
  const parsed = parseProofCode(code);
  const account = proofAccountForCode(parsed.base);
  switch (behavior) {
    case "missing_scope":
      return {
        status: 200,
        body: {
          access_token: `proof-access-${code}`,
          refresh_token: `proof-refresh-${code}`,
          expires_in: 3600,
          // The calendar scope declined: the completion must refuse.
          scope: "openid email",
          id_token: fixtureIdToken(account.subject, account.email),
        },
      };
    case "invalid_grant":
      return { status: 400, body: { error: "invalid_grant" } };
    case "crash":
      return { status: 500, body: { error: "server_error" } };
    case "ok":
    default:
      return {
        status: 200,
        body: {
          access_token: `proof-access-${code}`,
          refresh_token: `proof-refresh-${code}`,
          expires_in: 3600,
          scope:
            "openid email https://www.googleapis.com/auth/calendar.app.created",
          id_token: fixtureIdToken(account.subject, account.email),
          // Echoed so the no-double-exchange proof can assert PKCE use.
          received_code_verifier: codeVerifier,
        },
      };
  }
}

/** How long the fixture stalls for timeout behaviors (caller deadline 4s). */
export const PROOF_TIMEOUT_DELAY_MS = 9_000;

/** Effect-ledger dedup keys (one row per logical external effect). */
export function proofTokenEffectKey(code: string): string {
  return `g1-proof-token:${code}`;
}

export function proofCalendarCreateEffectKey(subject: string): string {
  return `g1-proof-calendar-create:${subject}`;
}
