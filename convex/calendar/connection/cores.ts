/**
 * Calendar connection domain cores (G1): the pure decision halves of the
 * connection lifecycle, as total functions over small row views.
 *
 * Every rule issue #45 names lives here so tests/g1 prove the boundaries
 * without a deployment (the B3 pattern): the checked start decision, the
 * single-use callback correlation, the disconnect-during-pending race, the
 * uncertainty semantics for token exchange/refresh, and above all the
 * no-blind-duplicate-calendar rule for unknown create/read outcomes.
 *
 * Vocabulary ("Kalendarz Kiero w Google", CONTEXT.md): the connection is
 * PERSONAL and OPTIONAL, it is not a sign-in method, and Kiero stays the
 * authority — the dedicated calendar only receives projections. Google
 * identity recorded here is display + correlation material; it never links
 * to the Kiero account.
 */

import type {
  CalendarReadOutcome,
  CalendarCreateOutcome,
  TokenFailureKind,
  TokenGrant,
} from "./protocol";

/** A pending authorization expires after ten minutes. */
export const AUTHORIZATION_TTL_MS = 10 * 60 * 1000;

/** Machine reasons recorded while `state === "error"`. */
export const RECONNECT_REASONS = [
  "authorization_denied",
  "authorization_expired",
  "exchange_failed",
  "exchange_unknown",
  "scopes_missing",
  "creation_failed",
  "creation_unknown",
  "calendar_read_unknown",
  "calendar_access_lost",
  "refresh_failed",
  "membership_lost",
] as const;
export type ReconnectReason = (typeof RECONNECT_REASONS)[number];

/** Why the user starts an authorization (drives the calendar step). */
export type AuthorizationMode = "connect" | "switch" | "recreate";

/** The row view every decision consumes (server-resolved only). */
export interface ConnectionRowView {
  readonly state: "pending_authorization" | "connected" | "disconnected" | "error";
  readonly authorizationMode: AuthorizationMode | null;
  readonly authorizationExpiresAtMs: number | null;
  readonly googleCalendarId: string | null;
  readonly googleAccountSubject: string | null;
  readonly reconnectReason: ReconnectReason | null;
}

/** What the actor asked for when starting an authorization. */
export interface StartAuthorizationInput {
  readonly mode: AuthorizationMode;
  /**
   * The explicit acknowledgement required after an unknown creation
   * outcome: the user accepts that a calendar may already exist before
   * Kiero attempts another creation (never a blind duplicate).
   */
  readonly acknowledgeUnknownCreation: boolean;
}

export type StartDecision =
  | { readonly kind: "start" }
  | { readonly kind: "refuse"; readonly code: "authorization_already_pending" | "already_connected" | "creation_unresolved" | "recreate_required" | "switch_required" };

/**
 * The checked start decision.
 *
 * - no row / disconnected: a fresh `connect` may start;
 * - a live pending flow refuses a second one (one flow per user; the UI
 *   cancels with disconnect or waits for the 10-minute expiry);
 * - `connected` admits only `switch` (the old binding survives until the
 *   new authorization actually completes);
 * - `error` admits recovery per reason: plain reconnect after terminal
 *   token/consent failures, an acknowledged recreate after an unknown
 *   creation, and an explicit `recreate` (Odtwórz) after an ambiguous
 *   calendar loss.
 */
export function decideStartAuthorization(
  row: ConnectionRowView | null,
  input: StartAuthorizationInput,
  nowMs: number,
): StartDecision {
  if (row === null) {
    return input.mode === "connect" ? { kind: "start" } : { kind: "refuse", code: "switch_required" };
  }
  switch (row.state) {
    case "pending_authorization": {
      const live = row.authorizationExpiresAtMs !== null && nowMs <= row.authorizationExpiresAtMs;
      return live
        ? { kind: "refuse", code: "authorization_already_pending" }
        : { kind: "start" };
    }
    case "connected":
      return input.mode === "switch"
        ? { kind: "start" }
        : { kind: "refuse", code: "already_connected" };
    case "disconnected":
      return { kind: "start" };
    case "error": {
      const reason = row.reconnectReason ?? "exchange_failed";
      if (reason === "creation_unknown") {
        return input.acknowledgeUnknownCreation
          ? { kind: "start" }
          : { kind: "refuse", code: "creation_unresolved" };
      }
      if (reason === "calendar_access_lost" && input.mode === "recreate") {
        return { kind: "start" };
      }
      // Every other error recovers with a plain reconnect (the calendar
      // step may still verify a known id instead of creating one).
      return { kind: "start" };
    }
  }
}

/** The correlation decision for one callback's `state`. */
export type CorrelationDecision =
  | { readonly kind: "matched" }
  | { readonly kind: "invalid_state" } // unknown or already consumed: no leak
  | { readonly kind: "expired" };

/**
 * Checks the single-use state correlation: the row must BE a pending flow,
 * must still be inside its expiry, and is consumed by the prepare step
 * (a replay finds no `oauthStateHash` and fails `invalid_state`).
 */
export function decideCallbackCorrelation(
  row: { readonly state: ConnectionRowView["state"]; readonly oauthStateHash: string | null; readonly authorizationExpiresAtMs: number | null } | null,
  nowMs: number,
): CorrelationDecision {
  if (
    row === null ||
    row.state !== "pending_authorization" ||
    row.oauthStateHash === null ||
    row.oauthStateHash.length === 0
  ) {
    return { kind: "invalid_state" };
  }
  if (row.authorizationExpiresAtMs === null || nowMs > row.authorizationExpiresAtMs) {
    return { kind: "expired" };
  }
  return { kind: "matched" };
}

/** Membership is re-checked at the callback over the canonical rule. */
export function decideMembershipAtCallback(activeCompanyId: string | null, rowCompanyId: string): boolean {
  return activeCompanyId !== null && activeCompanyId === rowCompanyId;
}

/** Which calendar step the completion may take. */
export type CalendarStep =
  | { readonly kind: "verify_known"; readonly calendarId: string }
  | { readonly kind: "create" }
  | { readonly kind: "refuse"; readonly code: "recreate_required" };

/**
 * The find-or-create decision. The same Google account with a known
 * dedicated calendar id is RECOVERED by verification (the stored id is the
 * only recovery path under `calendar.app.created`); a different account
 * (a switch) or no known id authorizes one creation. The acknowledge gate
 * for prior unknown creations is enforced at start (decideStartAuthorization).
 */
export function decideCalendarStep(row: {
  readonly googleCalendarId: string | null;
  readonly googleAccountSubject: string | null;
  readonly verifiedGoogleSubject: string;
}): CalendarStep {
  if (
    row.googleCalendarId !== null &&
    row.googleAccountSubject !== null &&
    row.googleAccountSubject === row.verifiedGoogleSubject
  ) {
    return { kind: "verify_known", calendarId: row.googleCalendarId };
  }
  return { kind: "create" };
}

/** The terminal outcome of one completion attempt. */
export type CompletionOutcome =
  | {
      readonly kind: "connected";
      readonly calendarId: string;
      readonly googleAccountSubject: string;
      readonly googleAccountEmail: string | null;
      readonly grantedScopes: readonly string[];
    }
  | { readonly kind: "error"; readonly reason: ReconnectReason };

/** Maps a token-exchange leg onto the lifecycle (carrying the grant). */
export function decideExchangeOutcome(
  outcome:
    | { readonly kind: "granted"; readonly grant: TokenGrant; readonly scopesSatisfied: boolean }
    | { readonly kind: "failed"; readonly failure: TokenFailureKind },
): { readonly proceed: true; readonly grant: TokenGrant } | { readonly proceed: false; readonly outcome: CompletionOutcome } {
  if (outcome.kind === "granted") {
    if (!outcome.scopesSatisfied) {
      // Least-scope enforcement: a grant without the dedicated-calendar
      // scope is never a connection (Google may drop declined scopes).
      return { proceed: false, outcome: { kind: "error", reason: "scopes_missing" } };
    }
    return { proceed: true, grant: outcome.grant };
  }
  switch (outcome.failure) {
    case "definite_invalid_request":
      return { proceed: false, outcome: { kind: "error", reason: "exchange_failed" } };
    case "definite_network":
      return { proceed: false, outcome: { kind: "error", reason: "exchange_failed" } };
    default:
      // 5xx/timeout/unreadable body: the code may be consumed — uncertain,
      // never retried by the system (the user restarts explicitly).
      return { proceed: false, outcome: { kind: "error", reason: "exchange_unknown" } };
  }
}

/** The recovery-read decision: reuse, create (explicit Odtwórz only), or error. */
export type CalendarReadDecision =
  | { readonly kind: "reuse" }
  | { readonly kind: "create" }
  | { readonly kind: "error"; readonly reason: "calendar_access_lost" | "calendar_read_unknown" };

/** Maps the calendar verification (recovery) leg onto the lifecycle. */
export function decideCalendarReadOutcome(
  outcome: CalendarReadOutcome,
  mode: AuthorizationMode,
): CalendarReadDecision {
  if (outcome.kind === "reachable") {
    return { kind: "reuse" };
  }
  if (outcome.kind === "ambiguous_gone") {
    // 401/403/404 never proves deletion (deleted and inaccessible answer
    // alike): only the explicit Odtwórz (`recreate`) may create again.
    return mode === "recreate" ? { kind: "create" } : { kind: "error", reason: "calendar_access_lost" };
  }
  return { kind: "error", reason: "calendar_read_unknown" };
}

/** The creation decision: one confirmed id, or a reason. */
export type CalendarCreateDecision =
  | { readonly kind: "created"; readonly calendarId: string }
  | { readonly kind: "error"; readonly reason: "creation_failed" | "creation_unknown" };

/** Maps the calendar creation leg onto the lifecycle. */
export function decideCalendarCreateOutcome(
  outcome: CalendarCreateOutcome,
): CalendarCreateDecision {
  if (outcome.kind === "created") {
    return { kind: "created", calendarId: outcome.calendarId };
  }
  if (outcome.kind === "definitely_failed") {
    return { kind: "error", reason: "creation_failed" };
  }
  // Unknown creation (deadline after the POST, 5xx, unreadable id): the
  // calendar may exist with an id we never learned. NEVER create again
  // without the explicit acknowledgement; there is no list scope to
  // reconcile with (docs/research/google-calendar-reconnect-facts.md).
  return { kind: "error", reason: "creation_unknown" };
}

/** The disconnect decision (also the cancel-pending and stop paths). */
export type DisconnectDecision =
  | { readonly kind: "disconnect"; readonly recordCleanup: boolean }
  | { readonly kind: "cancel_switch" }
  | { readonly kind: "noop" };

/**
 * Disconnect is allowed from EVERY state and never touches identity:
 *
 * - during a plain `pending_authorization` it cancels the flow (a later
 *   callback for its state fails `invalid_state` — the disconnect wins
 *   the race);
 * - during a pending SWITCH it cancels the switch and restores the still
 *   working previous binding (a half-finished account change never
 *   destroys a live connection);
 * - from `connected` it stops future publishing structurally (credentials
 *   are cleared) and records UNCONFIRMED cleanup for the user: Kiero
 *   attempts to remove managed copies, but Google-side confirmation is a
 *   G3 reconciliation outcome, never an assumption;
 * - from `error`/`disconnected` it is an idempotent no-op keeping the
 *   original timestamps.
 */
export function decideDisconnect(row: ConnectionRowView | null): DisconnectDecision {
  if (row === null) {
    return { kind: "noop" };
  }
  switch (row.state) {
    case "pending_authorization":
      return row.authorizationMode === "switch" && row.googleCalendarId !== null
        ? { kind: "cancel_switch" }
        : { kind: "disconnect", recordCleanup: false };
    case "connected":
      return { kind: "disconnect", recordCleanup: true };
    case "error":
      return { kind: "disconnect", recordCleanup: false };
    case "disconnected":
      return { kind: "noop" };
  }
}

/** What a FAILED completion does to a pending flow. */
export type CompletionFailureTransition =
  | { readonly kind: "error"; readonly reason: ReconnectReason }
  | { readonly kind: "restore_connected" };

/**
 * A failed/denied switch-flow restores the previous binding instead of
 * erroring it: the old connection kept its credentials and calendar while
 * the switch was in flight, so a denied consent or failed exchange takes
 * the user back to the working connection.
 */
export function decideCompletionFailure(row: ConnectionRowView, reason: ReconnectReason): CompletionFailureTransition {
  if (row.authorizationMode === "switch" && row.googleCalendarId !== null) {
    return { kind: "restore_connected" };
  }
  return { kind: "error", reason };
}

/** One refresh leg's lifecycle effect. */
export type RefreshDecision =
  | { readonly kind: "refreshed" }
  | { readonly kind: "definitely_lost" } // invalid_grant: reconnect required
  | { readonly kind: "unknown" }; // no retry; reconciliation owns the next move

/**
 * The refresh decision (echo template): success refreshes the stored
 * credential; a definite refusal (invalid_grant/invalid_client) marks the
 * connection `error/refresh_failed` (the documented 7-day Testing-mode
 * expiry is exactly this shape); anything uncertain leaves the connection
 * CONNECTED with no credential release and no automatic retry — the next
 * attempt is an explicit reconciliation or user action, never a loop.
 */
export function decideRefreshOutcome(
  outcome:
    | { readonly kind: "granted"; readonly scopesSatisfied: boolean }
    | { readonly kind: "failed"; readonly failure: TokenFailureKind },
): RefreshDecision {
  if (outcome.kind === "granted") {
    return outcome.scopesSatisfied ? { kind: "refreshed" } : { kind: "definitely_lost" };
  }
  switch (outcome.failure) {
    case "definite_invalid_request":
      return { kind: "definitely_lost" };
    case "definite_network":
      // Nothing reached Google: not lost, but also not refreshed. A later
      // explicit attempt is safe; this one reports unknown to the caller.
      return { kind: "unknown" };
    default:
      return { kind: "unknown" };
  }
}

/** The typed action surface the barebones Polish screen consumes. */
export type ConnectionAction = "connect" | "reconnect" | "switch" | "recreate" | "disconnect";

/**
 * Which lifecycle operations the current state honestly offers. The UI
 * renders these as its Polish controls ("Połącz", "Połącz ponownie",
 * "Zmień konto Google", "Odtwórz kalendarz", "Odłącz"); nothing here
 * changes Kiero identity or membership.
 */
export function availableActions(
  row: ConnectionRowView | null,
): readonly ConnectionAction[] {
  if (row === null) {
    return ["connect"];
  }
  switch (row.state) {
    case "pending_authorization":
      return ["disconnect"];
    case "connected":
      return ["disconnect", "switch"];
    case "disconnected":
      return ["connect"];
    case "error": {
      const reason = row.reconnectReason ?? "exchange_failed";
      if (reason === "creation_unknown") {
        return ["reconnect", "disconnect"];
      }
      if (reason === "calendar_access_lost") {
        return ["reconnect", "recreate", "disconnect"];
      }
      return ["reconnect", "disconnect"];
    }
  }
}
