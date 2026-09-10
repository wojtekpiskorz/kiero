/**
 * Calendar sync decision cores (G3 pure): the reconciliation decision
 * table over G2's desired state, the unknown-outcome state machine of the
 * remote ledger, and the observation followups.
 *
 * No I/O, no Convex, no clock reads (instants arrive as arguments). Every
 * function is total over small row views so tests/g3 prove the boundaries
 * the issue's acceptance criteria name:
 *
 * - a retry only ever follows a DEFINITE observation of absence
 *   ("timeout-after-success does not justify duplicate publication");
 * - an unknown outcome stays first-class until an observation resolves it
 *   (never assumed success, never blind recreation);
 * - a converged state produces `none` — repeated passes make zero external
 *   calls and zero rows ("retries and concurrent changes converge without
 *   duplicate managed events");
 * - updates carry MANAGED FIELDS ONLY (summary, description, start, end):
 *   reminders and transparency are never re-sent, so personally captured
 *   Google settings survive every Kiero correction.
 */

import type { DesiredGoogleEvent } from "@kiero/domain";

// ---------------------------------------------------------------------------
// Vocabulary.
// ---------------------------------------------------------------------------

/** The remote-ledger outcome (G2's schema literal union; pinned by use). */
export type RemoteOutcome = "confirmed" | "absent" | "unknown";

/** How a hide was learned ("Ukrycie kopii kalendarzowej", G2's vocabulary). */
export type HideOrigin = "user_request" | "deleted_in_google" | "moved_in_google";

/** The bounded retry limits per (copy, semantic id, leg kind). */
export const MAX_CREATE_ATTEMPTS = 5;
export const MAX_UPDATE_ATTEMPTS = 8;
export const MAX_DELETE_ATTEMPTS = 5;

/**
 * How long a cached observation of a confirmed copy stays trusted before a
 * pass re-observes it (manual Google edits are caught at this cadence).
 */
export const OBSERVATION_REFRESH_MS = 60 * 60 * 1000;

/**
 * How long an OPEN attempt (outcome `unknown`, never completed) blocks a
 * concurrent prepare for the same copy: comfortably above one leg's worst
 * bound (a 4s deadline per call, at most two calls for the disambiguating
 * observe, plus the token refresh), so only a genuinely crashed attempt
 * outlives the window — and a crashed attempt then falls back to the
 * observe-before-retry doctrine like any other stale unknown.
 */
export const ATTEMPT_IN_FLIGHT_WINDOW_MS = 60_000;

/** The private extended property key marking Kiero-managed events. */
export const KIERO_SEMANTIC_PROPERTY = "kiero.semanticId";

// ---------------------------------------------------------------------------
// Row views the decisions consume (server-resolved only).
// ---------------------------------------------------------------------------

/** One copy's view: G2's desired state plus G3's remote ledger. */
export interface CopySyncView {
  readonly copyId: string;
  readonly semanticId: string;
  readonly desiredState: "projected" | "withdrawn";
  readonly hidden: boolean;
  readonly payload: DesiredGoogleEvent | null;
  readonly googleEventId: string | null;
  readonly remoteOutcome: RemoteOutcome;
}

/** The connection facts every leg re-checks (per attempt, not per pass). */
export interface ConnectionSyncView {
  readonly state: "pending_authorization" | "connected" | "disconnected" | "error";
  readonly googleCalendarId: string | null;
}

/** The attempt counters of one copy for its CURRENT semantic id. */
export interface AttemptStats {
  readonly creates: number;
  readonly updates: number;
  readonly deletes: number;
}

/** The cached observation of one copy (the newest successful observe leg). */
export interface ObservedEvent {
  readonly eventId: string;
  /** Google's event status: a `cancelled` remnant is the move signature. */
  readonly status: "confirmed" | "cancelled";
  readonly managed: ManagedFields;
  readonly observedAtMs: number;
}

/** The connection recheck outcome that stops all legs for one copy. */
export type SyncSuspensionReason =
  | "connection_not_connected"
  | "membership_or_firm_changed"
  | "no_dedicated_calendar"
  | "create_attempts_exhausted"
  | "update_attempts_exhausted"
  | "delete_attempts_exhausted"
  | "payload_missing";

// ---------------------------------------------------------------------------
// The managed-fields contract (updates NEVER re-send personal settings).
// ---------------------------------------------------------------------------

/** The fields Kiero owns on a Google event copy. */
export interface ManagedFields {
  readonly summary: string;
  readonly description: string;
  readonly start: { readonly date?: string | undefined; readonly dateTime?: string | undefined };
  readonly end: { readonly date?: string | undefined; readonly dateTime?: string | undefined };
}

/** The managed subset of one desired payload. */
export function managedFieldsOf(payload: DesiredGoogleEvent): ManagedFields {
  return {
    summary: payload.summary,
    description: payload.description,
    start: payload.start,
    end: payload.end,
  };
}

/** Canonical JSON: sorted keys, no whitespace (G2's diff helper shape). */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (typeof value === "object" && value !== null) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Whether Google's observed managed fields equal the desired ones. */
export function managedFieldsMatch(observed: ManagedFields, desired: ManagedFields): boolean {
  return canonicalJson(observed) === canonicalJson(desired);
}

/**
 * The create body: managed fields PLUS the first-write personal defaults
 * G2's payload carries (transparency + no reminders) and the private
 * extended property that makes a stray create OBSERVABLE later
 * (Events.list `privateExtendedProperty` filter, Google-documented).
 */
export function createEventBody(
  payload: DesiredGoogleEvent,
  semanticId: string,
): Record<string, unknown> {
  return {
    ...managedFieldsOf(payload),
    transparency: payload.transparency,
    reminders: payload.reminders,
    extendedProperties: { private: { [KIERO_SEMANTIC_PROPERTY]: semanticId } },
  };
}

/**
 * The update body: MANAGED FIELDS ONLY. Reminders and transparency are
 * deliberately absent — a merge on Google's side keeps whatever personal
 * settings the boss captured on the copy ("przy zachowaniu osobistych
 * ustawień").
 */
export function updateEventBody(payload: DesiredGoogleEvent): Record<string, unknown> {
  return { ...managedFieldsOf(payload) };
}

// ---------------------------------------------------------------------------
// The attempt claim (concurrent-prepare serialization, round-2 finding 1).
// ---------------------------------------------------------------------------

/**
 * The claim one prepare derives before minting the attempt's dedup key:
 * the sequence comes from the PERSISTED copy-row counter (bumped in the
 * same transaction that inserts the attempt row), never from a
 * read-then-used row count — two racing prepares that both read `creates:
 * 0` could mint the same key, and Convex has no unique secondary index to
 * reject the twin insert. The sequence starts above the copy's recorded
 * row count so keys minted before the counter existed (count-derived)
 * can never collide with counter-minted ones.
 */
export function nextAttemptClaim(
  storedSeq: number | null,
  recordedAttempts: number,
): { readonly seq: number; readonly nextSeq: number } {
  const seq = Math.max(storedSeq ?? 0, recordedAttempts);
  return { seq, nextSeq: seq + 1 };
}

/** The liveness columns of one attempt row the in-flight check reads. */
export interface AttemptLiveness {
  readonly outcome: string;
  readonly completedAtMs?: number | undefined;
  readonly startedAtMs: number;
}

/**
 * Whether one attempt row is still OPEN: it left with outcome `unknown`
 * and never completed, freshly enough that its action may still be
 * running the leg. A COMPLETED uncertain attempt (unknown/timeout with
 * `completedAtMs` set) is not in flight — the observe-before-retry
 * doctrine owns it. While any attempt of a copy is open, every concurrent
 * prepare declines: a racing observe-list could otherwise read the
 * winner's unwritten create as a definite absence (a false personal-hide
 * detection), which is worse than waiting one window.
 */
export function attemptInFlight(attempt: AttemptLiveness, nowMs: number): boolean {
  return (
    attempt.outcome === "unknown" &&
    attempt.completedAtMs === undefined &&
    nowMs - attempt.startedAtMs <= ATTEMPT_IN_FLIGHT_WINDOW_MS
  );
}

// ---------------------------------------------------------------------------
// The decision table: one copy -> ONE bounded leg (or none/suspend).
// ---------------------------------------------------------------------------

/** The one external leg an attempt may run. */
export type SyncLeg =
  | {
      readonly leg: "create";
      readonly calendarId: string;
      readonly semanticId: string;
      readonly body: Record<string, unknown>;
    }
  | {
      readonly leg: "update";
      readonly calendarId: string;
      readonly eventId: string;
      readonly body: Record<string, unknown>;
    }
  | { readonly leg: "delete"; readonly calendarId: string; readonly eventId: string }
  | { readonly leg: "observe_get"; readonly calendarId: string; readonly eventId: string }
  | {
      readonly leg: "observe_list";
      readonly calendarId: string;
      readonly semanticId: string;
    };

/** What the decision table decided for one copy. */
export type SyncDecision =
  | { readonly action: "none"; readonly reason: string }
  | { readonly action: "leg"; readonly leg: SyncLeg; readonly reason: string }
  | { readonly action: "suspend"; readonly reason: SyncSuspensionReason };

/** Whether the copy must NOT exist in Google (withdrawn, or hidden). */
export function mustBeAbsent(copy: CopySyncView): boolean {
  return copy.desiredState === "withdrawn" || copy.hidden;
}

/**
 * THE decision table (the G2 integration contract, mechanically applied):
 *
 * - projected && !hidden: no remote id -> create (first attempt only;
 *   every later attempt MUST observe first); remote id -> update when the
 *   cached observation drifted from the desired payload, re-observe when
 *   the cache is stale, else converged.
 * - projected && hidden: ensure ABSENT (delete the managed copy; the hide
 *   itself is never touched here).
 * - withdrawn: delete (a Kiero deletion is NOT a user hide; the hide
 *   fields stay as they are).
 * - unknown outcomes gate every mutation behind an observation leg.
 *
 * `forceObservation` is the explicit-reconcile lever
 * (`calendar.reconcileCopy`): a converged answer is upgraded to ONE
 * observation leg — a read cannot duplicate an effect, and the boss
 * asking "check this copy now" is exactly the signal to look at reality
 * instead of the cache (the user-deletion/move detection path).
 */
export function decideCopyLeg(
  copy: CopySyncView,
  connection: ConnectionSyncView,
  stats: AttemptStats,
  lastObservation: ObservedEvent | null,
  nowMs: number,
  forceObservation = false,
): SyncDecision {
  if (connection.state !== "connected") {
    return { action: "suspend", reason: "connection_not_connected" };
  }
  if (connection.googleCalendarId === null) {
    return { action: "suspend", reason: "no_dedicated_calendar" };
  }
  const calendarId = connection.googleCalendarId;

  if (mustBeAbsent(copy)) {
    if (copy.googleEventId === null) {
      // Nothing was ever confirmed created — unless a create attempt with
      // an unknown outcome may have landed: observe the strays first.
      if (copy.remoteOutcome === "unknown" && stats.creates > 0) {
        return {
          action: "leg",
          leg: { leg: "observe_list", calendarId, semanticId: copy.semanticId },
          reason: "unknown_create_stray_check",
        };
      }
      return { action: "none", reason: "already_absent" };
    }
    switch (copy.remoteOutcome) {
      case "unknown":
        return {
          action: "leg",
          leg: { leg: "observe_get", calendarId, eventId: copy.googleEventId },
          reason: "unknown_outcome_observe",
        };
      case "confirmed":
        if (stats.deletes >= MAX_DELETE_ATTEMPTS) {
          return { action: "suspend", reason: "delete_attempts_exhausted" };
        }
        return {
          action: "leg",
          leg: { leg: "delete", calendarId, eventId: copy.googleEventId },
          reason: copy.hidden ? "hidden_ensure_absent" : "withdrawn_delete",
        };
      case "absent":
        return { action: "none", reason: "already_absent" };
    }
  }

  // projected && !hidden from here on.
  if (copy.payload === null) {
    // G2's construction makes this unreachable (a projected desire always
    // carries a payload); the honest defense is a loud suspension, never
    // a guess.
    return { action: "suspend", reason: "payload_missing" };
  }
  if (copy.googleEventId === null) {
    switch (copy.remoteOutcome) {
      case "unknown":
        if (stats.creates === 0) {
          return {
            action: "leg",
            leg: {
              leg: "create",
              calendarId,
              semanticId: copy.semanticId,
              body: createEventBody(copy.payload, copy.semanticId),
            },
            reason: "projected_create",
          };
        }
        // A create already left with an unknown outcome: OBSERVE before
        // any retry. Only a DEFINITE observation of absence re-arms the
        // create (the absent arm below).
        return {
          action: "leg",
          leg: { leg: "observe_list", calendarId, semanticId: copy.semanticId },
          reason: "unknown_create_observe_before_retry",
        };
      case "absent":
        if (stats.creates >= MAX_CREATE_ATTEMPTS) {
          return { action: "suspend", reason: "create_attempts_exhausted" };
        }
        return {
          action: "leg",
          leg: {
            leg: "create",
            calendarId,
            semanticId: copy.semanticId,
            body: createEventBody(copy.payload, copy.semanticId),
          },
          reason: "observed_absent_recreate",
        };
      case "confirmed":
        // A confirmed outcome without a remote id is a ledger wound: heal
        // it by observation, never by a blind create.
        return {
          action: "leg",
          leg: { leg: "observe_list", calendarId, semanticId: copy.semanticId },
          reason: "ledger_wound_heal",
        };
    }
  }
  const eventId = copy.googleEventId;
  switch (copy.remoteOutcome) {
    case "unknown":
      return {
        action: "leg",
        leg: { leg: "observe_get", calendarId, eventId },
        reason: "unknown_outcome_observe",
      };
    case "absent":
      // The stored id was observed gone but the copy is projected again:
      // re-find the copy (a healed id) before any create.
      return {
        action: "leg",
        leg: { leg: "observe_list", calendarId, semanticId: copy.semanticId },
        reason: "stale_id_refind",
      };
    case "confirmed": {
      if (
        lastObservation === null ||
        lastObservation.eventId !== eventId ||
        lastObservation.status === "cancelled"
      ) {
        return {
          action: "leg",
          leg: { leg: "observe_get", calendarId, eventId },
          reason: lastObservation === null ? "never_observed" : "observation_mismatch",
        };
      }
      if (!managedFieldsMatch(lastObservation.managed, managedFieldsOf(copy.payload))) {
        if (stats.updates >= MAX_UPDATE_ATTEMPTS) {
          return { action: "suspend", reason: "update_attempts_exhausted" };
        }
        return {
          action: "leg",
          leg: {
            leg: "update",
            calendarId,
            eventId,
            body: updateEventBody(copy.payload),
          },
          reason: "managed_fields_drift",
        };
      }
      if (nowMs - lastObservation.observedAtMs > OBSERVATION_REFRESH_MS) {
        return {
          action: "leg",
          leg: { leg: "observe_get", calendarId, eventId },
          reason: "observation_refresh",
        };
      }
      if (forceObservation) {
        return {
          action: "leg",
          leg: { leg: "observe_get", calendarId, eventId },
          reason: "explicit_reconcile_observe",
        };
      }
      return { action: "none", reason: "converged" };
    }
  }
}

// ---------------------------------------------------------------------------
// Observation results and their followups (the state machine's read side).
// ---------------------------------------------------------------------------

/** What an observation leg definitely learned (unknown stays `null`). */
export type ObservationResult =
  | {
      readonly kind: "present";
      readonly eventId: string;
      readonly status: "confirmed" | "cancelled";
      readonly managed: ManagedFields;
    }
  | { readonly kind: "empty" }
  | { readonly kind: "calendar_gone" }
  | { readonly kind: "unknown"; readonly cause?: "timeout" };

/** The ledger transition an observation implies (pure; the mutation applies). */
export interface ObservationTransition {
  /** The remote id after the observation (null clears it). */
  readonly googleEventId: string | null;
  readonly remoteOutcome: RemoteOutcome;
  /** A detected personal hide, when the observation proved one. */
  readonly detectedHide: HideOrigin | null;
  /** The observation to cache (absent when nothing usable was seen). */
  readonly observation: ObservedEvent | null;
}

/**
 * What the attempt ledger says about this copy's PRESENCE history for the
 * current semantic id: the two facts an `empty` observation is judged
 * against (a false `deleted_in_google` is worse than no detection).
 */
export interface AbsenceContext {
  /**
   * Kiero's own delete is the LAST presence-ending event (no successful
   * create or observation re-established the copy since): the absence is
   * ours, never a user hide.
   */
  readonly authoredByKiero: boolean;
  /**
   * The event was EVER confirmed to exist for this semantic id (a
   * successful create or a present observation). An absence without prior
   * presence — a create that never landed — proves nothing about the
   * user and records no hide.
   */
  readonly everConfirmed: boolean;
}

/**
 * Applies one observation to the remote ledger. The vocabulary follows the
 * research facts (docs/research/google-calendar-reconnect-facts.md):
 *
 * - an event that matches nothing on a REACHABLE calendar was deleted by
 *   the user (`deleted_in_google`) — only when the event was previously
 *   CONFIRMED to exist and the absence was not authored by Kiero's own
 *   later delete (a Kiero deletion is never a user hide; a create that
 *   never landed proves nothing about the user);
 * - a `cancelled` remnant that still carries our marker is the documented
 *   move signature (`moved_in_google`) — the boss moved the copy outside
 *   the dedicated calendar;
 * - both become a PERSONAL HIDE of this one copy; neither cancels the
 *   subject, and neither ever touches another boss's copy.
 */
export function decideObservationTransition(
  observation: ObservationResult,
  copy: CopySyncView,
  observedAtMs: number,
  absence: AbsenceContext,
): ObservationTransition {
  if (observation.kind === "unknown" || observation.kind === "calendar_gone") {
    // Unknown stays unknown; a gone calendar is the connection-level stop
    // (the caller records calendar_access_lost), never a copy transition.
    return {
      googleEventId: copy.googleEventId,
      remoteOutcome: observation.kind === "unknown" ? "unknown" : copy.remoteOutcome,
      detectedHide: null,
      observation: null,
    };
  }
  if (observation.kind === "empty") {
    if (mustBeAbsent(copy)) {
      return { googleEventId: null, remoteOutcome: "absent", detectedHide: null, observation: null };
    }
    if (absence.authoredByKiero || !absence.everConfirmed) {
      // Either Kiero deleted this copy itself (withdrawal or hide) — the
      // empty list is OUR OWN effect — or the event was never confirmed
      // to exist (a create that never landed): neither is a personal
      // hide, and neither ever cancels being re-created.
      return {
        googleEventId: null,
        remoteOutcome: "absent",
        detectedHide: null,
        observation: null,
      };
    }
    // Definite absence of a previously confirmed event: the user deleted
    // our copy without a visible remnant — a personal hide, unless one
    // already covers it (an explicit user hide stays `user_request`).
    return {
      googleEventId: null,
      remoteOutcome: "absent",
      detectedHide: copy.hidden ? null : "deleted_in_google",
      observation: null,
    };
  }
  // present
  const cached: ObservedEvent = {
    eventId: observation.eventId,
    status: observation.status,
    managed: observation.managed,
    observedAtMs,
  };
  if (observation.status === "cancelled") {
    // The cancelled remnant IS the move signature. For a copy that must
    // stay present, this is a personal hide; for one that must be absent,
    // the remnant is simply ours to clean (next pass deletes it).
    return {
      googleEventId: observation.eventId,
      remoteOutcome: "confirmed",
      detectedHide: copy.hidden || mustBeAbsent(copy) ? null : "moved_in_google",
      observation: cached,
    };
  }
  return {
    googleEventId: observation.eventId,
    remoteOutcome: "confirmed",
    detectedHide: null,
    observation: cached,
  };
}

// ---------------------------------------------------------------------------
// The mutation-outcome state machine (the write side).
// ---------------------------------------------------------------------------

/** What one mutation leg definitely reported. */
export type MutationReport =
  | { readonly kind: "applied"; readonly eventId?: string }
  | { readonly kind: "gone" } // 404 on the target: event or calendar, ambiguous
  | { readonly kind: "calendar_gone" } // 401/403, or 404 at the calendar scope
  | { readonly kind: "definitely_failed" }
  /**
   * Uncertain: the effect may have happened. `cause: "timeout"` names a
   * bounded-deadline hit (the protocol's `unknown_timeout`) so the attempt
   * rows and the job's externalOutcome can carry the A3 word; every other
   * uncertainty (5xx, unreadable body) stays causeless `unknown`.
   */
  | { readonly kind: "unknown"; readonly cause?: "timeout" };

/** The ledger transition a mutation implies (pure; the mutation applies). */
export interface MutationTransition {
  readonly googleEventId: string | null;
  readonly remoteOutcome: RemoteOutcome;
  /** The observation a successful mutation implies (we authored it). */
  readonly observation: ObservedEvent | null;
  /** Whether the connection must stop (calendar_access_lost). */
  readonly accessLost: boolean;
}

/**
 * Applies one mutation report to the remote ledger. The load-bearing rule:
 * a `create` that timed out leaves the outcome UNKNOWN with NO remote id —
 * it is never assumed absent (a blind second create could duplicate the
 * publication); only `observe_list` may resolve it. Symmetrically for
 * update/delete: `unknown` until observed.
 */
export function decideMutationTransition(
  legKind: "create" | "update" | "delete",
  report: MutationReport,
  copy: CopySyncView,
): MutationTransition {
  switch (legKind) {
    case "create":
      switch (report.kind) {
        case "applied":
          return {
            googleEventId: report.eventId ?? null,
            remoteOutcome: report.eventId === undefined ? "unknown" : "confirmed",
            observation: null,
            accessLost: false,
          };
        case "gone":
        case "calendar_gone":
          // The POST never happened (a refusal, not a loss): the copy is
          // still definitely absent, and the connection-level stop is the
          // calendar_gone shape only.
          return {
            googleEventId: null,
            remoteOutcome: "absent",
            observation: null,
            accessLost: report.kind === "calendar_gone",
          };
        case "definitely_failed":
          return {
            googleEventId: null,
            remoteOutcome: "absent",
            observation: null,
            accessLost: false,
          };
        case "unknown":
          // THE case the whole module exists for: the create may have
          // landed; the id is unknown. Unknown, no id — observe before any
          // retry, never a second blind create.
          return {
            googleEventId: null,
            remoteOutcome: "unknown",
            observation: null,
            accessLost: false,
          };
      }
      break;
    case "update":
      switch (report.kind) {
        case "applied":
          return {
            googleEventId: copy.googleEventId,
            remoteOutcome: "confirmed",
            observation: null,
            accessLost: false,
          };
        case "gone":
          // The PATCH was refused (no effect), but the event's fate is
          // ambiguous: unknown until observed.
          return {
            googleEventId: copy.googleEventId,
            remoteOutcome: "unknown",
            observation: null,
            accessLost: false,
          };
        case "calendar_gone":
          return {
            googleEventId: copy.googleEventId,
            remoteOutcome: "unknown",
            observation: null,
            accessLost: true,
          };
        case "definitely_failed":
          return {
            googleEventId: copy.googleEventId,
            remoteOutcome: "confirmed",
            observation: null,
            accessLost: false,
          };
        case "unknown":
          return {
            googleEventId: copy.googleEventId,
            remoteOutcome: "unknown",
            observation: null,
            accessLost: false,
          };
      }
      break;
    case "delete":
      switch (report.kind) {
        case "applied":
        case "gone":
          // Deleted, or already gone (the idempotent 404): absent either way.
          return {
            googleEventId: copy.googleEventId,
            remoteOutcome: "absent",
            observation: null,
            accessLost: false,
          };
        case "calendar_gone":
          return {
            googleEventId: copy.googleEventId,
            remoteOutcome: "unknown",
            observation: null,
            accessLost: true,
          };
        case "definitely_failed":
          return {
            googleEventId: copy.googleEventId,
            remoteOutcome: copy.remoteOutcome,
            observation: null,
            accessLost: false,
          };
        case "unknown":
          return {
            googleEventId: copy.googleEventId,
            remoteOutcome: "unknown",
            observation: null,
            accessLost: false,
          };
      }
      break;
  }
}

/**
 * The observation a SUCCESSFUL mutation implies: the managed fields Google
 * now holds are the ones we just sent (update), so the cache trusts the
 * sent body — the basis of convergence (a replayed pass reads `converged`
 * and issues no second call).
 */
export function observationFromMutation(
  copy: CopySyncView,
  eventId: string,
  atMs: number,
): ObservedEvent | null {
  if (copy.payload === null) {
    return null;
  }
  return {
    eventId,
    status: "confirmed",
    managed: managedFieldsOf(copy.payload),
    observedAtMs: atMs,
  };
}

// ---------------------------------------------------------------------------
// Attempt-outcome words (exhaustive mappings over the report families).
// ---------------------------------------------------------------------------

/**
 * The attempt-outcome word one MUTATION report implies (the A3
 * `ExternalOutcome` vocabulary: a definite answer — applied, or the
 * idempotent 404 — is a completed leg; a refused or access-lost shape is
 * a failure; `unknown` is uncertain, and a bounded-deadline hit carries
 * the distinct `timeout` word). Exhaustive by construction: a new report
 * kind fails this switch at compile time.
 */
export function attemptOutcomeOfMutation(
  report: MutationReport,
): "succeeded" | "failed" | "timeout" | "unknown" {
  switch (report.kind) {
    case "applied":
    case "gone":
      return "succeeded";
    case "definitely_failed":
    case "calendar_gone":
      return "failed";
    case "unknown":
      return report.cause === "timeout" ? "timeout" : "unknown";
  }
}

/** The attempt-outcome word one OBSERVATION result implies. */
export function attemptOutcomeOfObservation(
  observation: ObservationResult,
): "succeeded" | "failed" | "timeout" | "unknown" {
  switch (observation.kind) {
    case "present":
    case "empty":
      return "succeeded";
    case "calendar_gone":
      return "failed";
    case "unknown":
      return observation.cause === "timeout" ? "timeout" : "unknown";
  }
}

// ---------------------------------------------------------------------------
// The stale-attempt guard (acceptance side).
// ---------------------------------------------------------------------------

/** The basis snapshot one attempt derived from (captured at prepare). */
export interface AttemptBasis {
  readonly semanticId: string;
  readonly desiredRevisionId: string;
  readonly desiredState: "projected" | "withdrawn";
  readonly hidden: boolean;
  readonly payloadHash: string | null;
}

/** The current view the completion re-reads. */
export interface CompletionView {
  readonly semanticId: string;
  readonly desiredRevisionId: string;
  readonly desiredState: "projected" | "withdrawn";
  readonly hidden: boolean;
  readonly payloadHash: string | null;
}

/**
 * Whether the copy still wants this attempt's result. A stale job (a newer
 * correction, a withdrawal, a hide or an explicit restore arrived while
 * the external call was in flight) must never overwrite a newer due date
 * or restore an ineligible item: the LEDGER FACTS (remote id, outcome,
 * observations — facts about Google, not about desire) are still recorded
 * by the caller, but desire-derived effects (hide detection, convergence)
 * are refused until the next pass re-decides.
 */
export function attemptStillWanted(basis: AttemptBasis, current: CompletionView): boolean {
  return (
    basis.semanticId === current.semanticId &&
    basis.desiredRevisionId === current.desiredRevisionId &&
    basis.desiredState === current.desiredState &&
    basis.hidden === current.hidden &&
    basis.payloadHash === current.payloadHash
  );
}
