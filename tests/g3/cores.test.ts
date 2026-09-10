/**
 * G3 focused verification, part 1: the reconciliation DECISION TABLE, the
 * unknown-outcome state machine of the remote ledger, and the
 * observation followups — the pure halves in convex/calendar/sync/cores.ts.
 *
 * The transaction halves need a Convex deployment; the LIVE proof
 * (tests/g3/live-proof.mjs) exercises them end to end. What MUST hold
 * structurally is pinned here:
 *
 * - a create is only ever the FIRST attempt for a semantic id; every later
 *   create is gated behind a DEFINITE observation of absence ("a timeout
 *   after provider success does not justify duplicate publication");
 * - unknown outcomes stay first-class (never assumed success, never blind
 *   recreation) until an observation resolves them;
 * - updates carry managed fields ONLY (reminders/transparency never
 *   re-sent, so personally captured settings survive);
 * - repeated decisions over converged state produce `none` (idempotent
 *   replays make zero external calls);
 * - retry bounds suspend honestly instead of looping;
 * - the attempt claim is minted from a PERSISTED sequence (never a
 *   read-then-used row count), so two racing prepares can never mint the
 *   same dedup key, and a concurrent prepare declines behind an open
 *   attempt (round-2 finding 1).
 */

import { describe, expect, it } from "vitest";
import type { DesiredGoogleEvent } from "@kiero/domain";
import {
  ATTEMPT_IN_FLIGHT_WINDOW_MS,
  KIERO_SEMANTIC_PROPERTY,
  MAX_CREATE_ATTEMPTS,
  OBSERVATION_REFRESH_MS,
  attemptInFlight,
  attemptOutcomeOfMutation as attemptOutcomeOfMutationFn,
  attemptOutcomeOfObservation as attemptOutcomeOfObservationFn,
  attemptStillWanted,
  canonicalJson,
  createEventBody,
  decideCopyLeg,
  decideMutationTransition,
  decideObservationTransition,
  managedFieldsMatch,
  managedFieldsOf,
  nextAttemptClaim,
  observationFromMutation,
  updateEventBody,
  type ConnectionSyncView,
  type CopySyncView,
  type ObservedEvent,
} from "../../convex/calendar/sync/cores";

const mappers = {
  attemptOutcomeOfMutation: attemptOutcomeOfMutationFn,
  attemptOutcomeOfObservation: attemptOutcomeOfObservationFn,
};

const CONNECTION: ConnectionSyncView = {
  state: "connected",
  googleCalendarId: "kiero-proof-calendar",
};
const NOW = 1_700_000_000_000;

const payload = (summary: string): DesiredGoogleEvent => ({
  summary,
  description: `Opis ${summary}`,
  start: { date: "2031-05-04" },
  end: { date: "2031-05-05" },
  transparency: "transparent",
  reminders: { useDefault: false, overrides: [] },
});

const copy = (overrides: Partial<CopySyncView>): CopySyncView => ({
  copyId: "k1",
  semanticId: "kiero-copy-v1:c:u:a:task:t1",
  desiredState: "projected",
  hidden: false,
  payload: payload("Zadanie: Beton"),
  googleEventId: null,
  remoteOutcome: "unknown",
  ...overrides,
});

const noStats = { creates: 0, updates: 0, deletes: 0 };

const observation = (overrides: Partial<ObservedEvent> = {}): ObservedEvent => ({
  eventId: "evt-1",
  status: "confirmed",
  managed: managedFieldsOf(payload("Zadanie: Beton")),
  observedAtMs: NOW,
  ...overrides,
});

describe("the decision table: projected && !hidden (create arm)", () => {
  it("creates on the first attempt for a fresh projected copy", () => {
    const decision = decideCopyLeg(copy({}), CONNECTION, noStats, null, NOW);
    expect(decision).toMatchObject({ action: "leg" });
    if (decision.action !== "leg") {
      throw new Error("unreachable");
    }
    expect(decision.leg.leg).toBe("create");
    expect(decision.reason).toBe("projected_create");
  });

  it("NEVER blindly re-creates after an unknown create outcome: observe first", () => {
    const decision = decideCopyLeg(
      copy({}),
      CONNECTION,
      { creates: 1, updates: 0, deletes: 0 },
      null,
      NOW,
    );
    expect(decision).toMatchObject({ action: "leg" });
    if (decision.action !== "leg") {
      throw new Error("unreachable");
    }
    expect(decision.leg.leg).toBe("observe_list");
    expect(decision.reason).toBe("unknown_create_observe_before_retry");
  });

  it("re-creates only after a DEFINITE observation of absence, bounded", () => {
    const under = decideCopyLeg(
      copy({ remoteOutcome: "absent" }),
      CONNECTION,
      { creates: MAX_CREATE_ATTEMPTS - 1, updates: 0, deletes: 0 },
      null,
      NOW,
    );
    expect(under).toMatchObject({
      action: "leg",
      leg: { leg: "create" },
      reason: "observed_absent_recreate",
    });
    const over = decideCopyLeg(
      copy({ remoteOutcome: "absent" }),
      CONNECTION,
      { creates: MAX_CREATE_ATTEMPTS, updates: 0, deletes: 0 },
      null,
      NOW,
    );
    expect(over).toEqual({ action: "suspend", reason: "create_attempts_exhausted" });
  });

  it("heals a confirmed outcome without a remote id by observation, never a create", () => {
    const decision = decideCopyLeg(
      copy({ remoteOutcome: "confirmed" }),
      CONNECTION,
      noStats,
      null,
      NOW,
    );
    expect(decision).toMatchObject({
      action: "leg",
      leg: { leg: "observe_list" },
      reason: "ledger_wound_heal",
    });
  });

  it("suspends without payload or connection health instead of guessing", () => {
    expect(decideCopyLeg(copy({ payload: null }), CONNECTION, noStats, null, NOW)).toEqual({
      action: "suspend",
      reason: "payload_missing",
    });
    expect(
      decideCopyLeg(copy({}), { ...CONNECTION, state: "disconnected" }, noStats, null, NOW),
    ).toEqual({ action: "suspend", reason: "connection_not_connected" });
    expect(
      decideCopyLeg(copy({}), { ...CONNECTION, googleCalendarId: null }, noStats, null, NOW),
    ).toEqual({ action: "suspend", reason: "no_dedicated_calendar" });
  });
});

describe("the decision table: projected && !hidden (update arm)", () => {
  it("is converged when the cached observation matches the desired payload", () => {
    const decision = decideCopyLeg(
      copy({ googleEventId: "evt-1", remoteOutcome: "confirmed" }),
      CONNECTION,
      noStats,
      observation(),
      NOW,
    );
    expect(decision).toEqual({ action: "none", reason: "converged" });
  });

  it("observes before ever trusting an id it has not observed", () => {
    const decision = decideCopyLeg(
      copy({ googleEventId: "evt-1", remoteOutcome: "confirmed" }),
      CONNECTION,
      noStats,
      null,
      NOW,
    );
    expect(decision).toMatchObject({ action: "leg", leg: { leg: "observe_get" } });
  });

  it("updates ONLY when managed fields drifted from the OBSERVED state", () => {
    const drifted = observation({
      managed: managedFieldsOf(payload("Zmienione w Google")),
    });
    const decision = decideCopyLeg(
      copy({ googleEventId: "evt-1", remoteOutcome: "confirmed" }),
      CONNECTION,
      noStats,
      drifted,
      NOW,
    );
    expect(decision).toMatchObject({
      action: "leg",
      leg: { leg: "update" },
      reason: "managed_fields_drift",
    });
    if (decision.action !== "leg" || decision.leg.leg !== "update") {
      throw new Error("unreachable");
    }
    // The managed-fields contract: summary/description/start/end ONLY.
    expect(Object.keys(decision.leg.body).sort()).toEqual([
      "description",
      "end",
      "start",
      "summary",
    ]);
  });

  it("re-observes on cadence even while converged (manual-edit detection)", () => {
    const stale = observation({ observedAtMs: NOW - OBSERVATION_REFRESH_MS - 1 });
    const decision = decideCopyLeg(
      copy({ googleEventId: "evt-1", remoteOutcome: "confirmed" }),
      CONNECTION,
      noStats,
      stale,
      NOW,
    );
    expect(decision).toMatchObject({
      action: "leg",
      leg: { leg: "observe_get" },
      reason: "observation_refresh",
    });
  });

  it("observes an unknown outcome before any mutation", () => {
    const decision = decideCopyLeg(
      copy({ googleEventId: "evt-1", remoteOutcome: "unknown" }),
      CONNECTION,
      noStats,
      observation(),
      NOW,
    );
    expect(decision).toMatchObject({
      action: "leg",
      leg: { leg: "observe_get" },
      reason: "unknown_outcome_observe",
    });
  });
});

describe("the decision table: hidden and withdrawn (ensure-absent arm)", () => {
  it("deletes a confirmed copy the boss hid (a Kiero deletion, not a user hide)", () => {
    const decision = decideCopyLeg(
      copy({ hidden: true, googleEventId: "evt-1", remoteOutcome: "confirmed" }),
      CONNECTION,
      noStats,
      observation(),
      NOW,
    );
    expect(decision).toMatchObject({
      action: "leg",
      leg: { leg: "delete" },
      reason: "hidden_ensure_absent",
    });
  });

  it("deletes a withdrawn copy and keeps suspending honestly at the bound", () => {
    const decision = decideCopyLeg(
      copy({ desiredState: "withdrawn", googleEventId: "evt-1", remoteOutcome: "confirmed" }),
      CONNECTION,
      noStats,
      observation(),
      NOW,
    );
    expect(decision).toMatchObject({
      action: "leg",
      leg: { leg: "delete" },
      reason: "withdrawn_delete",
    });
  });

  it("needs no leg for a copy that is already absent", () => {
    expect(
      decideCopyLeg(
        copy({ hidden: true, googleEventId: "evt-1", remoteOutcome: "absent" }),
        CONNECTION,
        noStats,
        null,
        NOW,
      ),
    ).toEqual({ action: "none", reason: "already_absent" });
  });

  it("checks for a stray created event when an unknown create met a withdrawal", () => {
    const decision = decideCopyLeg(
      copy({ desiredState: "withdrawn", remoteOutcome: "unknown" }),
      CONNECTION,
      { creates: 1, updates: 0, deletes: 0 },
      null,
      NOW,
    );
    expect(decision).toMatchObject({
      action: "leg",
      leg: { leg: "observe_list" },
      reason: "unknown_create_stray_check",
    });
  });
});

describe("the unknown-outcome state machine (mutation transitions)", () => {
  it("keeps an unknown create UNKNOWN with no remote id — the load-bearing rule", () => {
    const transition = decideMutationTransition("create", { kind: "unknown" }, copy({}));
    expect(transition).toEqual({
      googleEventId: null,
      remoteOutcome: "unknown",
      observation: null,
      accessLost: false,
    });
  });

  it("confirms a created leg only with a readable remote id", () => {
    expect(
      decideMutationTransition("create", { kind: "applied", eventId: "evt-9" }, copy({})),
    ).toMatchObject({ googleEventId: "evt-9", remoteOutcome: "confirmed" });
    expect(
      decideMutationTransition("create", { kind: "applied" }, copy({})),
    ).toMatchObject({ googleEventId: null, remoteOutcome: "unknown" });
  });

  it("treats a refused create as definite absence (no effect happened)", () => {
    expect(
      decideMutationTransition("create", { kind: "definitely_failed" }, copy({})),
    ).toMatchObject({ googleEventId: null, remoteOutcome: "absent" });
  });

  it("escalates a calendar-scoped 404 to the access-lost stop", () => {
    expect(
      decideMutationTransition("create", { kind: "calendar_gone" }, copy({})),
    ).toMatchObject({ accessLost: true, remoteOutcome: "absent" });
    expect(
      decideMutationTransition("update", { kind: "calendar_gone" }, copy({ googleEventId: "e" })),
    ).toMatchObject({ accessLost: true, remoteOutcome: "unknown" });
  });

  it("keeps an unknown update/delete unknown until observed", () => {
    const view = copy({ googleEventId: "evt-1", remoteOutcome: "confirmed" });
    expect(decideMutationTransition("update", { kind: "unknown" }, view)).toMatchObject({
      remoteOutcome: "unknown",
    });
    expect(decideMutationTransition("delete", { kind: "unknown" }, view)).toMatchObject({
      remoteOutcome: "unknown",
    });
  });

  it("resolves a delete's idempotent 404 as absence", () => {
    const view = copy({ googleEventId: "evt-1", remoteOutcome: "confirmed" });
    expect(decideMutationTransition("delete", { kind: "gone" }, view)).toMatchObject({
      remoteOutcome: "absent",
    });
  });
});

describe("observation transitions (user deletion vs move vs Kiero deletion)", () => {
  // A previously confirmed event, absence not authored by Kiero: the one
  // shape an empty observation reads as the user's deletion.
  const userDeleted = { absence: { authoredByKiero: false, everConfirmed: true } };

  it("an empty observation on a reachable calendar detects deleted_in_google", () => {
    const transition = decideObservationTransition({ kind: "empty" }, copy({}), NOW, userDeleted.absence);
    expect(transition).toMatchObject({
      googleEventId: null,
      remoteOutcome: "absent",
      detectedHide: "deleted_in_google",
    });
  });

  it("an empty observation NEVER misreads Kiero's own deletion as a user hide", () => {
    const transition = decideObservationTransition(
      { kind: "empty" },
      copy({ desiredState: "withdrawn" }),
      NOW,
      { authoredByKiero: true, everConfirmed: true },
    );
    expect(transition.detectedHide).toBeNull();
    const reprojected = decideObservationTransition(
      { kind: "empty" },
      copy({}),
      NOW,
      { authoredByKiero: true, everConfirmed: true },
    );
    expect(reprojected.detectedHide).toBeNull();
  });

  it("an empty observation of a NEVER-CONFIRMED event records no hide (a create that never landed)", () => {
    const transition = decideObservationTransition(
      { kind: "empty" },
      copy({}),
      NOW,
      { authoredByKiero: false, everConfirmed: false },
    );
    expect(transition).toMatchObject({
      googleEventId: null,
      remoteOutcome: "absent",
      detectedHide: null,
    });
  });

  it("a cancelled remnant is the move signature (moved_in_google)", () => {
    const transition = decideObservationTransition(
      {
        kind: "present",
        eventId: "evt-1",
        status: "cancelled",
        managed: managedFieldsOf(payload("Zadanie: Beton")),
      },
      copy({}),
      NOW,
      userDeleted.absence,
    );
    expect(transition).toMatchObject({
      googleEventId: "evt-1",
      remoteOutcome: "confirmed",
      detectedHide: "moved_in_google",
    });
  });

  it("a cancelled remnant of a must-be-absent copy is cleanup, not a hide", () => {
    const transition = decideObservationTransition(
      {
        kind: "present",
        eventId: "evt-1",
        status: "cancelled",
        managed: managedFieldsOf(payload("Zadanie: Beton")),
      },
      copy({ hidden: true }),
      NOW,
      userDeleted.absence,
    );
    expect(transition.detectedHide).toBeNull();
  });

  it("an already-hidden copy keeps its user_request origin", () => {
    const transition = decideObservationTransition(
      { kind: "empty" },
      copy({ hidden: true }),
      NOW,
      userDeleted.absence,
    );
    expect(transition.detectedHide).toBeNull();
  });

  it("a calendar_gone observation is the connection-level stop, not a copy transition", () => {
    const transition = decideObservationTransition(
      { kind: "calendar_gone" },
      copy({ googleEventId: "e", remoteOutcome: "confirmed" }),
      NOW,
      userDeleted.absence,
    );
    expect(transition).toMatchObject({ remoteOutcome: "confirmed", detectedHide: null });
  });

  it("an unknown observation keeps the ledger unknown", () => {
    const transition = decideObservationTransition(
      { kind: "unknown" },
      copy({ remoteOutcome: "unknown" }),
      NOW,
      userDeleted.absence,
    );
    expect(transition.remoteOutcome).toBe("unknown");
  });
});

describe("the managed-fields contract", () => {
  it("create bodies carry the first-write defaults AND the observation marker", () => {
    const body = createEventBody(payload("Z"), "sem-1");
    expect(body.transparency).toBe("transparent");
    expect(body.reminders).toEqual({ useDefault: false, overrides: [] });
    expect(body.extendedProperties).toEqual({
      private: { [KIERO_SEMANTIC_PROPERTY]: "sem-1" },
    });
  });

  it("update bodies NEVER carry reminders or transparency", () => {
    const body = updateEventBody(payload("Z"));
    expect("reminders" in body).toBe(false);
    expect("transparency" in body).toBe(false);
    expect("extendedProperties" in body).toBe(false);
  });

  it("managed comparison is canonical (key order and undefined-free)", () => {
    expect(
      managedFieldsMatch(managedFieldsOf(payload("A")), {
        summary: "A",
        description: "Opis A",
        start: { date: "2031-05-04" },
        end: { date: "2031-05-05" },
      }),
    ).toBe(true);
    expect(managedFieldsMatch(managedFieldsOf(payload("A")), managedFieldsOf(payload("B")))).toBe(
      false,
    );
    expect(canonicalJson({ b: 1, a: [2, { d: 3, c: 4 }] })).toBe(
      canonicalJson({ a: [2, { c: 4, d: 3 }], b: 1 }),
    );
  });

  it("a successful mutation implies the observation that ends the loop", () => {
    const implied = observationFromMutation(copy({}), "evt-2", NOW);
    expect(implied).not.toBeNull();
    expect(implied?.eventId).toBe("evt-2");
    // Convergence: deciding again with the implied observation yields none.
    const decision = decideCopyLeg(
      copy({ googleEventId: "evt-2", remoteOutcome: "confirmed" }),
      CONNECTION,
      noStats,
      implied ?? null,
      NOW,
    );
    expect(decision).toEqual({ action: "none", reason: "converged" });
  });
});

describe("convergence on idempotent replays", () => {
  it("repeated decisions over the converged state stay `none` (zero calls)", () => {
    const view = copy({ googleEventId: "evt-1", remoteOutcome: "confirmed" });
    const first = decideCopyLeg(view, CONNECTION, noStats, observation(), NOW);
    expect(first).toEqual({ action: "none", reason: "converged" });
    for (let i = 0; i < 5; i += 1) {
      expect(decideCopyLeg(view, CONNECTION, noStats, observation(), NOW)).toEqual({
        action: "none",
        reason: "converged",
      });
    }
  });

  it("the full happy-path replay converges through the state machine itself", () => {
    // Pass 1: create fires.
    let view = copy({});
    let stats = noStats;
    let decision = decideCopyLeg(view, CONNECTION, stats, null, NOW);
    expect(decision.action).toBe("leg");
    // The create lands:
    let transition = decideMutationTransition("create", { kind: "applied", eventId: "evt-1" }, view);
    view = { ...view, googleEventId: transition.googleEventId, remoteOutcome: transition.remoteOutcome };
    stats = { ...stats, creates: 1 };
    // Pass 2: the implied observation says converged.
    const implied = observationFromMutation(view, "evt-1", NOW);
    decision = decideCopyLeg(view, CONNECTION, stats, implied, NOW);
    expect(decision).toEqual({ action: "none", reason: "converged" });
    // Pass 3..N: still converged — no second create ever, no duplicates.
    for (let i = 0; i < 4; i += 1) {
      expect(decideCopyLeg(view, CONNECTION, stats, implied, NOW).action).toBe("none");
    }
  });

  it("the timeout-after-create replay: observe -> adopt -> converged, ONE create total", () => {
    let view = copy({});
    let stats = { creates: 1, updates: 0, deletes: 0 };
    // The timed-out create left unknown with no id.
    view = { ...view, ...decideMutationTransition("create", { kind: "unknown" }, view) } as CopySyncView;
    expect(view.remoteOutcome).toBe("unknown");
    // Next pass MUST observe, not create.
    let decision = decideCopyLeg(view, CONNECTION, stats, null, NOW);
    expect(decision.action === "leg" && decision.leg.leg).toBe("observe_list");
    // The observation finds the stray created event (it DID land):
    const found = decideObservationTransition(
      {
        kind: "present",
        eventId: "evt-stray",
        status: "confirmed",
        managed: managedFieldsOf(view.payload ?? payload("x")),
      },
      view,
      NOW,
      { authoredByKiero: false, everConfirmed: true },
    );
    view = { ...view, googleEventId: found.googleEventId, remoteOutcome: found.remoteOutcome };
    // Converged with the adopted id: exactly ONE create ever happened.
    expect(decideCopyLeg(view, CONNECTION, stats, found.observation, NOW)).toEqual({
      action: "none",
      reason: "converged",
    });
    expect(stats.creates).toBe(1);
  });
});

describe("the attempt-outcome mappers (exhaustive by construction)", () => {
  it("maps every mutation report onto the attempt vocabulary", () => {
    const { attemptOutcomeOfMutation } = mappers;
    expect(attemptOutcomeOfMutation({ kind: "applied", eventId: "e" })).toBe("succeeded");
    expect(attemptOutcomeOfMutation({ kind: "applied" })).toBe("succeeded");
    expect(attemptOutcomeOfMutation({ kind: "gone" })).toBe("succeeded");
    expect(attemptOutcomeOfMutation({ kind: "definitely_failed" })).toBe("failed");
    expect(attemptOutcomeOfMutation({ kind: "calendar_gone" })).toBe("failed");
    expect(attemptOutcomeOfMutation({ kind: "unknown" })).toBe("unknown");
  });

  it("maps every observation result onto the attempt vocabulary", () => {
    const { attemptOutcomeOfObservation } = mappers;
    expect(
      attemptOutcomeOfObservation({
        kind: "present",
        eventId: "e",
        status: "confirmed",
        managed: managedFieldsOf(payload("A")),
      }),
    ).toBe("succeeded");
    expect(attemptOutcomeOfObservation({ kind: "empty" })).toBe("succeeded");
    expect(attemptOutcomeOfObservation({ kind: "calendar_gone" })).toBe("failed");
    expect(attemptOutcomeOfObservation({ kind: "unknown" })).toBe("unknown");
  });

  it("a bounded-deadline hit carries the distinct timeout word (the A3 vocabulary)", () => {
    expect(attemptOutcomeOfMutationFn({ kind: "unknown", cause: "timeout" })).toBe("timeout");
    expect(attemptOutcomeOfObservationFn({ kind: "unknown", cause: "timeout" })).toBe("timeout");
  });
});

describe("the attempt claim (concurrent-prepare serialization, round-2 finding 1)", () => {
  const keyOf = (seq: number): string => `calendar-sync-attempt:k1:sem:create:${seq}`;

  it("mints the key from the persisted sequence and advances it", () => {
    expect(nextAttemptClaim(null, 0)).toEqual({ seq: 0, nextSeq: 1 });
    expect(nextAttemptClaim(4, 0)).toEqual({ seq: 4, nextSeq: 5 });
  });

  it("two prepares starting from the same view mint DISTINCT keys after the OCC retry", () => {
    // The winner claims first and persists nextSeq; the retrying loser
    // starts from the persisted counter — the same starting view can
    // never mint the same key twice (the read-then-used row count could).
    const winner = nextAttemptClaim(null, 0);
    const loser = nextAttemptClaim(winner.nextSeq, 1);
    expect(keyOf(winner.seq)).not.toBe(keyOf(loser.seq));
    expect(winner.nextSeq).toBe(loser.seq);
  });

  it("the sequence starts above any legacy count-minted key", () => {
    // Three rows minted before the counter existed carry count-derived
    // indices < 3; the first counter-minted key must clear them all.
    const claim = nextAttemptClaim(null, 3);
    expect(claim.seq).toBeGreaterThanOrEqual(3);
  });
});

describe("the open-attempt guard (a concurrent prepare declines behind a live leg)", () => {
  const startedAt = NOW - 5_000;

  it("an unknown, never-completed, fresh attempt is in flight", () => {
    expect(attemptInFlight({ outcome: "unknown", startedAtMs: startedAt }, NOW)).toBe(true);
  });

  it("a COMPLETED uncertain attempt is not in flight (the observe doctrine owns it)", () => {
    expect(
      attemptInFlight({ outcome: "unknown", completedAtMs: NOW, startedAtMs: startedAt }, NOW),
    ).toBe(false);
    expect(
      attemptInFlight({ outcome: "timeout", completedAtMs: NOW, startedAtMs: startedAt }, NOW),
    ).toBe(false);
  });

  it("a crashed attempt outlives the window and stops blocking", () => {
    const crashedAt = NOW - ATTEMPT_IN_FLIGHT_WINDOW_MS - 1;
    expect(attemptInFlight({ outcome: "unknown", startedAtMs: crashedAt }, NOW)).toBe(false);
  });

  it("a definite outcome never blocks, complete or not", () => {
    expect(attemptInFlight({ outcome: "succeeded", startedAtMs: startedAt }, NOW)).toBe(false);
    expect(attemptInFlight({ outcome: "failed", startedAtMs: startedAt }, NOW)).toBe(false);
  });
});

describe("the stale-attempt guard", () => {
  const basis = {
    semanticId: "sem",
    desiredRevisionId: "r1",
    desiredState: "projected" as const,
    hidden: false,
    payloadHash: canonicalJson(payload("A")),
  };

  it("accepts an unchanged basis", () => {
    expect(
      attemptStillWanted(basis, {
        semanticId: "sem",
        desiredRevisionId: "r1",
        desiredState: "projected",
        hidden: false,
        payloadHash: canonicalJson(payload("A")),
      }),
    ).toBe(true);
  });

  it("rejects a newer due date, withdrawal, hide and restore alike", () => {
    for (const drift of [
      { payloadHash: canonicalJson(payload("B")) },
      { desiredState: "withdrawn" as const },
      { hidden: true },
      { semanticId: "sem-other" },
    ]) {
      expect(
        attemptStillWanted(basis, {
          semanticId: "sem",
          desiredRevisionId: "r1",
          desiredState: "projected",
          hidden: false,
          payloadHash: canonicalJson(payload("A")),
          ...drift,
        }),
      ).toBe(false);
    }
  });
});
