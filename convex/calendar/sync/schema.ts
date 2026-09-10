/**
 * Calendar sync tables (G3, issue #47).
 *
 * Owning implementer: G3 (reconciliation of writes, unknown outcomes,
 * reconnects). G2's `calendarCopies` already carries the semantic identity,
 * the remote id, the desired revision and the personal-hide bookkeeping;
 * the tables here complete the remote ledger the issue names:
 *
 * - `calendarSyncAttempts`: ONE row per external Google leg that left the
 *   transaction (architecture step 9: "record attempts, semantic
 *   deduplication identity and known/unknown outcome"). A row is INSERTED
 *   with outcome `unknown` before the leg runs and patched when its clean
 *   answer arrives; a crash in between honestly leaves `unknown` — the
 *   effect may have happened, exactly the state reconciliation consumes.
 *   The row also carries the observation cache (the managed fields Google
 *   answered with) and the timing pair (`desiredAtMs`/`completedAtMs`)
 *   J4's 95%-within-60-seconds evaluation reads — recorded, never claimed
 *   before J4.
 * - `calendarProofEvents`: the FAKE Google Calendar's event store (the
 *   guarded proof fixtures only, the G1/A3 echo pattern; written solely by
 *   `KIERO_G1_PROOF_ENABLED`-guarded fixtures, never by business paths).
 *
 * Tables: calendarSyncAttempts, calendarProofEvents.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared, type ValueValidator } from "../../schema/shared";

/**
 * The external leg kinds one attempt can be (one bounded call each). The
 * single spelling of the vocabulary: the row validators below are BUILT
 * from this list, so a kind added here flows into the schema and drift
 * fails typecheck instead of dropping out of a hand-copied union.
 */
export const SYNC_LEG_KINDS = [
  "create",
  "update",
  "delete",
  "observe_get",
  "observe_list",
] as const;
export type SyncLegKind = (typeof SYNC_LEG_KINDS)[number];

/**
 * A leg's outcome — the A3 `ExternalOutcome` vocabulary, PINNED by type to
 * @kiero/runtime so the attempt rows and the durable-job outcome columns
 * can never disagree about what "uncertain" means. The row validator is
 * built from this list.
 */
export const SYNC_ATTEMPT_OUTCOMES = [
  "succeeded",
  "failed",
  "timeout",
  "unknown",
] as const;
export type SyncAttemptOutcome = (typeof SYNC_ATTEMPT_OUTCOMES)[number];

/**
 * One closed string vocabulary's validator, built from its constant list
 * (no cast: the annotation is a real pin — widening the literals would
 * fail typecheck here, not silently widen the row type).
 */
function vocabularyOf<T extends string>(kinds: readonly T[]): ValueValidator<T> {
  return v.union(...kinds.map((kind) => v.literal(kind)));
}

const syncLegKindValue = vocabularyOf(SYNC_LEG_KINDS);
const syncAttemptOutcomeValue = vocabularyOf(SYNC_ATTEMPT_OUTCOMES);

export const calendarSyncTables = {
  /**
   * One recorded external leg against Google Calendar. A blind second
   * create is structurally impossible only because `prepareCopyAttempt`
   * CLAIMS the attempt on the copy row (`calendarCopies.syncAttemptSeq`,
   * bumped in the same transaction that inserts this row): concurrent
   * prepares conflict on the copy document, Convex retries the loser into
   * a view that counts the winner's row, and the loser declines behind
   * the open-attempt guard. The counted rows alone are read-then-use —
   * they bound retries per (copy, leg kind, semantic id); they do not
   * serialize concurrency.
   */
  calendarSyncAttempts: defineTable({
    connectionId: shared.calendarConnectionId,
    copyId: shared.calendarCopyId,
    /** The semantic id the leg targeted (an account switch re-mints it). */
    semanticId: v.string(),
    legKind: syncLegKindValue,
    /** The machine decision that fired the leg (audit/diagnostics only). */
    decisionReason: v.string(),
    outcome: syncAttemptOutcomeValue,
    /** Sanitized closed error kind of the failure, when there was one. */
    errorKind: v.optional(v.string()),
    /** The desire basis the leg derived from (the stale-attempt guard). */
    desiredRevisionId: shared.findingRevisionId,
    desiredState: v.union(v.literal("projected"), v.literal("withdrawn")),
    hiddenBasis: v.boolean(),
    desiredPayloadHash: v.optional(v.string()),
    /**
     * The copy's `updatedAtMs` at leg start (the J4 latency basis).
     * `updatedAtMs` moves only on desire changes (create, correction,
     * withdrawal, hide, restore); ledger completions never touch it, so a
     * reconnect rebuild or drift leg measures from the desire revision,
     * never from the last ledger touch.
     */
    desiredAtMs: shared.tsMs,
    startedAtMs: shared.tsMs,
    completedAtMs: v.optional(shared.tsMs),
    /** The remote event id this leg touched or observed, when known. */
    googleEventId: v.optional(v.string()),
    /** The managed fields Google answered with (the observation cache). */
    observedJson: v.optional(v.string()),
    /**
     * Unique per attempt — the no-duplicate-effect ledger identity —
     * minted from the copy's persisted claim sequence.
     */
    dedupKey: v.string(),
    createdAtMs: shared.tsMs,
  })
    .index("by_copy", ["copyId"])
    .index("by_connection", ["connectionId"])
    .index("by_dedup", ["dedupKey"]),

  /**
   * The fake Google Calendar's event store (PROOF FIXTURE ONLY). Written
   * exclusively by the guarded fixtures in ./proofHttp.ts — the same
   * clearly-labeled stand-in pattern as G1's fake token/calendar
   * endpoints; the no-duplicate-effect proofs count effects here.
   */
  calendarProofEvents: defineTable({
    /** The fake Google account (from the proof code's number). */
    accountSubject: v.string(),
    calendarId: v.string(),
    eventId: v.string(),
    /** The private extended property key the observation filter uses. */
    kieroSemanticId: v.string(),
    status: v.union(v.literal("confirmed"), v.literal("cancelled")),
    /** The full event body the fake serves (managed + personal fields). */
    eventJson: v.string(),
    updatedAtMs: shared.tsMs,
  })
    .index("by_account_semantic", ["accountSubject", "kieroSemanticId"])
    .index("by_event", ["eventId"]),
} as const;
