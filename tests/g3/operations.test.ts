/**
 * G3 focused tests, part 4: the completion transaction's desire-clock
 * invariant (the round-3 small recorded on issue #47 before J4 builds its
 * latency percentile). A LEDGER-ONLY completion records remoteOutcome and
 * googleEventId on the copy but never moves `updatedAtMs`: that column is
 * the desire revision's clock and the next attempt's `desiredAtMs` basis,
 * so reconnect rebuilds and drift legs must measure from the desire
 * revision, not from the last ledger touch. A desire-derived hide
 * detection is the one completion-side exception and does move it.
 *
 * Drives the REAL completeCopyAttempt over the in-memory db
 * (tests/d2/harness.ts), the d5 drain-test precedent for transaction
 * tests; the live proof in live-proof.mjs runs the same functions against
 * the real dev deployment.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { performCompleteCopyAttempt } from "../../convex/calendar/sync/operations";
import { asTx, fakeCtx } from "../d2/harness";

let ctx: ReturnType<typeof fakeCtx>;

const tx = () => asTx(ctx);

const DESIRE_AT_MS = 1_000;
const COPY_UPDATED_AT_MS = 2_000;

interface Seeded {
  copyId: string;
  attemptDedupKey: string;
}

/** One projected, confirmed copy plus its attempts (the claim semantics live elsewhere). */
async function seedCopy(options: {
  priorCreateSucceeded: boolean;
  legKind: "update" | "observe_get";
}): Promise<Seeded> {
  const companyId = await ctx.db.insert("companies", {
    name: "g3-operations",
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
    createdAtMs: 1,
  });
  const connectionId = await ctx.db.insert("calendarConnections", {
    companyId,
    userId: "k0001ttttttttttttttttttttt",
    state: "active",
    createdAtMs: 1,
  });
  const copyId = await ctx.db.insert("calendarCopies", {
    connectionId,
    userId: "k0001ttttttttttttttttttttt",
    subjectKind: "event",
    eventId: "k0002ttttttttttttttttttttt",
    semanticId: "sem-1",
    desiredState: "projected",
    googleEventId: "google-1",
    desiredRevisionId: "rev-1",
    hidden: false,
    remoteOutcome: "confirmed",
    updatedAtMs: COPY_UPDATED_AT_MS,
  });
  if (options.priorCreateSucceeded) {
    await ctx.db.insert("calendarSyncAttempts", {
      connectionId,
      copyId,
      semanticId: "sem-1",
      legKind: "create",
      decisionReason: "initial",
      outcome: "succeeded",
      desiredRevisionId: "rev-1",
      desiredState: "projected",
      hiddenBasis: false,
      desiredAtMs: DESIRE_AT_MS,
      startedAtMs: 500,
      completedAtMs: 600,
      googleEventId: "google-1",
      dedupKey: "dk-create-1",
      createdAtMs: 500,
    });
  }
  const attemptDedupKey = "dk-open-1";
  await ctx.db.insert("calendarSyncAttempts", {
    connectionId,
    copyId,
    semanticId: "sem-1",
    legKind: options.legKind,
    decisionReason: "drift",
    outcome: "unknown",
    desiredRevisionId: "rev-1",
    desiredState: "projected",
    hiddenBasis: false,
    desiredAtMs: DESIRE_AT_MS,
    startedAtMs: 3_000,
    dedupKey: attemptDedupKey,
    createdAtMs: 3_000,
  });
  return { copyId, attemptDedupKey };
}

async function copyRow(copyId: string): Promise<Record<string, unknown>> {
  const row = await ctx.db.get(copyId);
  if (row === null) {
    throw new Error("copy row vanished");
  }
  return row;
}

beforeEach(() => {
  ctx = fakeCtx([
    "companies",
    "calendarConnections",
    "calendarCopies",
    "calendarSyncAttempts",
    "calendarSyncState",
    "outboxEvents",
  ]);
});

describe("completeCopyAttempt desire-clock invariant (round-3 small 1)", () => {
  it("a successful mutation leg records the ledger fact without moving updatedAtMs", async () => {
    const { copyId, attemptDedupKey } = await seedCopy({
      priorCreateSucceeded: false,
      legKind: "update",
    });

    const record = await performCompleteCopyAttempt(tx(), {
      attemptDedupKey,
      outcome: "succeeded",
      result: { kind: "mutation", report: { kind: "applied" } },
    });

    expect(record?.remoteOutcome).toBe("confirmed");
    const copy = await copyRow(copyId);
    expect(copy.updatedAtMs).toBe(COPY_UPDATED_AT_MS);
  });

  it("an uncertain observation demotes to unknown without moving updatedAtMs", async () => {
    const { copyId, attemptDedupKey } = await seedCopy({
      priorCreateSucceeded: false,
      legKind: "observe_get",
    });

    const record = await performCompleteCopyAttempt(tx(), {
      attemptDedupKey,
      outcome: "unknown",
      result: { kind: "observation", observation: { kind: "unknown" } },
    });

    expect(record?.remoteOutcome).toBe("unknown");
    const copy = await copyRow(copyId);
    expect(copy.updatedAtMs).toBe(COPY_UPDATED_AT_MS);
  });

  it("a personal-hide detection is a desire change and DOES move updatedAtMs", async () => {
    const { copyId, attemptDedupKey } = await seedCopy({
      priorCreateSucceeded: true,
      legKind: "observe_get",
    });

    const record = await performCompleteCopyAttempt(tx(), {
      attemptDedupKey,
      outcome: "succeeded",
      result: { kind: "observation", observation: { kind: "empty" } },
    });

    expect(record?.remoteOutcome).toBe("absent");
    expect(record?.detectedHide).toBe("deleted_in_google");
    const copy = await copyRow(copyId);
    expect(copy.hidden).toBe(true);
    expect(typeof copy.updatedAtMs).toBe("number");
    expect(copy.updatedAtMs as number).toBeGreaterThan(COPY_UPDATED_AT_MS);
  });
});
