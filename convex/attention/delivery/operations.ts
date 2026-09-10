/**
 * Notification-intent transactions (F2): durable intent creation and the
 * idempotent due-time evaluator (issue 42's bounded solution).
 *
 * Everything runs inside ONE Convex mutation transaction per call:
 *
 * - `performEnsureSourceIntents` — the durable reaction to
 *   `sources.sourceAccepted`: one `source_entry` intent per then-active
 *   member EXCEPT the author ("Autor nie otrzymuje powiadomienia o własnym
 *   wpisie"), each with the semantic identity that collapses duplicate
 *   events, worker retries and duplicate scheduling onto one row.
 * - `performEnsureClarificationIntents` — the durable reaction to
 *   `memory.clarificationRaised`: the addressed agent question is a
 *   SEPARATE kind from ordinary source updates, so the source AUTHOR may
 *   receive it ("Pytanie ... jest kierowane przede wszystkim do autora
 *   źródła"); a clarification with no resolvable source is the general
 *   question and addresses every boss.
 * - `performKickSourceEvaluation` — the durable reaction to
 *   `memory.changeSetPublished`: it creates NO intent (ordinary agent
 *   confirmations produce no push — "zwykłe potwierdzenia porządkowania
 *   przez agenta nie tworzą dodatkowych pushy") and only wakes the
 *   evaluator because the assignment classification may have gone
 *   terminal. After analysis no new 60-second window starts.
 * - `performEvaluateDueIntents` — the evaluator: at due time it re-reads
 *   F1 read/preferences (the `decidePersonalDelivery` seam), current B3
 *   membership rights (a revoked member's intent dies), source business
 *   validity and the terminal assignment classification, then applies
 *   quiet hours through the same seam. A firing bucket carries every
 *   sibling pending intent of the same recipient and scope bucket — the
 *   window stays open from the first entry until the actual fire instant,
 *   so deferred quiet-hour work collapses into ONE current summary; read
 *   sources leave the batch before delivery.
 *
 * The evaluation order is pinned in ./model.ts (`EVALUATION_ORDER`):
 * business validity, recipient rights, assignment, read state, then the
 * personal delivery decision — suppression before deferral, exactly like
 * F1's seam.
 */

import { Schema } from "effect";
import {
  attentionOperations,
  errorResult,
  okResult,
  type ResultEnvelope,
} from "@kiero/contracts";
import { forbiddenError } from "@kiero/runtime";
import type { MutationCtx } from "../../_generated/server";
import type { Id, Doc } from "../../_generated/dataModel";
import { internal } from "../../_generated/api";
import { publishEvent } from "../../platform/publish";
import { decidePersonalDelivery, isValidTimezone } from "../preferences/evaluation";
import { preferenceWriteOf } from "../preferences/operations";
import {
  ASSIGNMENT_RETRY_MS,
  batchBucketOf,
  buildBatchSummary,
  deathReasonOfPersonalSuppression,
  dueAtMsOf,
  joinsBatch,
  resolveAssignment,
  type BatchScope,
  type SuppressedReason,
} from "./model";

/** The contract entry the evaluator implements (decode/typed authority). */
export const evaluateDueIntentsOperation = attentionOperations["attention.evaluateDueIntents"];
export type EvaluateDueIntentsInput = Schema.Schema.Type<typeof evaluateDueIntentsOperation.input>;
export type EvaluateDueIntentsResult = Schema.Schema.Type<typeof evaluateDueIntentsOperation.result>;

/** How many due intents one evaluator sweep processes (bounded batch). */
const SWEEP_LIMIT = 128;

/** The accepted-anchor field names the collapsed-summary inclusion reads. */
interface IntentPayloadAnchor {
  readonly acceptedAtMs?: number;
  readonly raisedAtMs?: number;
}

/** The intent payload's scope, as the clarification creation writes it. */
interface ClarificationPayloadScope {
  readonly kind: "company" | "project";
}

/** Reads one intent's payload anchor (acceptance/raise instant). */
function anchorOf(intent: Doc<"notificationIntents">): number {
  const payload = JSON.parse(intent.payloadJson) as IntentPayloadAnchor;
  return payload.acceptedAtMs ?? payload.raisedAtMs ?? intent.createdAtMs;
}

/** Schedules one evaluator hop at (or slightly after) the given instant. */
async function scheduleEvaluationAt(tx: MutationCtx, atMs: number): Promise<void> {
  const delay = Math.max(0, atMs - Date.now());
  await tx.scheduler.runAfter(delay, internal.attention.delivery.evaluate.evaluateDueIntents, {
    nowMs: atMs,
  });
}

/** One pending intent row as the sweep reads it. */
type PendingIntent = Doc<"notificationIntents">;

// ---------------------------------------------------------------------------
// Durable intent creation (the event reactions).
// ---------------------------------------------------------------------------

/** The active members of one company, enumerated through the composite prefix. */
async function activeMemberIds(tx: MutationCtx, companyId: Id<"companies">): Promise<Id<"users">[]> {
  const rows = await tx.db
    .query("memberships")
    .withIndex("by_company_user", (q) => q.eq("companyId", companyId))
    .filter((q) => q.eq(q.field("state"), "active"))
    .collect();
  return rows.map((row) => row.userId);
}

/** Inserts one intent unless its semantic identity already exists. */
async function ensureIntent(
  tx: MutationCtx,
  intent: {
    companyId: Id<"companies">;
    recipientUserId: Id<"users">;
    semanticKind: "source_entry" | "clarification";
    sourceId?: Id<"sources"> | null;
    clarificationId?: Id<"clarifications"> | null;
    dedupKey: string;
    dueAtMs: number;
    payloadJson: string;
  },
): Promise<Id<"notificationIntents"> | null> {
  const existing = await tx.db
    .query("notificationIntents")
    .withIndex("by_dedup", (q) => q.eq("dedupKey", intent.dedupKey))
    .first();
  if (existing !== null) {
    // Duplicate suppression by semantic identity: a replayed event, a
    // retried worker or a duplicate registration collapses onto the row.
    return null;
  }
  return tx.db.insert("notificationIntents", {
    companyId: intent.companyId,
    recipientUserId: intent.recipientUserId,
    semanticKind: intent.semanticKind,
    ...(intent.sourceId !== undefined && intent.sourceId !== null ? { sourceId: intent.sourceId } : {}),
    ...(intent.clarificationId !== undefined && intent.clarificationId !== null
      ? { clarificationId: intent.clarificationId }
      : {}),
    dedupKey: intent.dedupKey,
    state: "pending",
    dueAtMs: intent.dueAtMs,
    payloadJson: intent.payloadJson,
    createdAtMs: Date.now(),
  });
}

/**
 * Creates the ordinary source-entry intents for one accepted source, minus
 * the author, deduped by semantic identity, and schedules the evaluator at
 * the batching window close (60 s from DURABLE all-attachment acceptance).
 */
export async function performEnsureSourceIntents(
  tx: MutationCtx,
  sourceId: Id<"sources">,
): Promise<ResultEnvelope> {
  const source = await tx.db.get(sourceId);
  if (source === null) {
    return errorResult(forbiddenError("source_not_found"));
  }
  const recipients = (await activeMemberIds(tx, source.companyId)).filter(
    (userId) => userId !== source.authorUserId,
  );
  const dueAtMs = dueAtMsOf(source.fullyAcceptedAtMs);
  const created: Id<"notificationIntents">[] = [];
  for (const userId of recipients) {
    const id = await ensureIntent(tx, {
      companyId: source.companyId,
      recipientUserId: userId,
      semanticKind: "source_entry",
      sourceId: source._id,
      dedupKey: `source_entry:${source._id}:${userId}`,
      dueAtMs,
      payloadJson: JSON.stringify({
        kind: "source_entry",
        sourceId: source._id,
        authorUserId: source.authorUserId,
        acceptedAtMs: source.fullyAcceptedAtMs,
      }),
    });
    if (id !== null) {
      created.push(id);
    }
  }
  await scheduleEvaluationAt(tx, dueAtMs);
  return okResult({
    sourceId: source._id,
    createdIntentIds: created,
    recipientCount: recipients.length,
  });
}

/**
 * Creates the addressed clarification intents for one raised clarification.
 * The source author is the primary addressee (an agent question MAY notify
 * them about their own entry); without a resolvable source it is the
 * general question and addresses every active boss.
 */
export async function performEnsureClarificationIntents(
  tx: MutationCtx,
  clarificationId: Id<"clarifications">,
): Promise<ResultEnvelope> {
  const clarification = await tx.db.get(clarificationId);
  if (clarification === null) {
    return errorResult(forbiddenError("clarification_not_found"));
  }
  // The source the question is about, two durable paths: the raising run's
  // source (the row's optional linkage, E4's later direct emissions), and
  // — the path today's checked dispatch produces — the first conflicting
  // EVIDENCE fragment, whose source is the analyzed entry.
  let authorUserId: Id<"users"> | null = null;
  let sourceId: Id<"sources"> | null = null;
  if (clarification.raisedByRunId !== undefined) {
    const run = await tx.db.get(clarification.raisedByRunId);
    if (run !== null) {
      const source = await tx.db.get(run.sourceId);
      if (source !== null) {
        sourceId = source._id;
        authorUserId = source.authorUserId;
      }
    }
  }
  const firstFragmentId = clarification.conflictingFragmentIds[0];
  if (sourceId === null && firstFragmentId !== undefined) {
    const fragment = await tx.db.get(firstFragmentId);
    if (fragment !== null) {
      const source = await tx.db.get(fragment.sourceId);
      if (source !== null && source.companyId === clarification.companyId) {
        sourceId = source._id;
        authorUserId = source.authorUserId;
      }
    }
  }
  const recipients =
    authorUserId !== null ? [authorUserId] : await activeMemberIds(tx, clarification.companyId);
  const dueAtMs = dueAtMsOf(clarification.raisedAtMs);
  const created: Id<"notificationIntents">[] = [];
  for (const userId of recipients) {
    const id = await ensureIntent(tx, {
      companyId: clarification.companyId,
      recipientUserId: userId,
      semanticKind: "clarification",
      sourceId,
      clarificationId: clarification._id,
      dedupKey: `clarification:${clarification._id}:${userId}`,
      dueAtMs,
      payloadJson: JSON.stringify({
        kind: "clarification",
        clarificationId: clarification._id,
        sourceId,
        authorUserId,
        raisedAtMs: clarification.raisedAtMs,
        scope:
          clarification.scopeKind === "project" && clarification.scopeProjectId !== undefined
            ? ({ kind: "project" } satisfies ClarificationPayloadScope)
            : ({ kind: "company" } satisfies ClarificationPayloadScope),
      }),
    });
    if (id !== null) {
      created.push(id);
    }
  }
  await scheduleEvaluationAt(tx, dueAtMs);
  return okResult({
    clarificationId: clarification._id,
    createdIntentIds: created,
    addressedToAuthor: authorUserId !== null,
  });
}

/**
 * Wakes the evaluator for one source whose analysis published changes: no
 * intent is created (ordinary agent confirmations produce no push), and no
 * new 60-second window starts — the pending intents keep their original
 * acceptance-anchored window and fire once the assignment is terminal.
 */
export async function performKickSourceEvaluation(
  tx: MutationCtx,
  sourceId: Id<"sources">,
): Promise<ResultEnvelope> {
  const pending = await tx.db
    .query("notificationIntents")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .filter((q) => q.eq(q.field("state"), "pending"))
    .take(50);
  if (pending.length > 0) {
    const earliest = pending.reduce((first, candidate) => (candidate.dueAtMs < first.dueAtMs ? candidate : first));
    await scheduleEvaluationAt(tx, Math.max(Date.now() + 1_000, earliest.dueAtMs));
  }
  return okResult({ sourceId, pendingIntents: pending.length > 0 });
}

// ---------------------------------------------------------------------------
// The due-time evaluator.
// ---------------------------------------------------------------------------

/** Resolves the terminal assignment classification of one source (cached per sweep). */
class AssignmentCache {
  private readonly sources = new Map<Id<"sources">, "pending" | "invalid" | BatchScope>();

  constructor(private readonly tx: MutationCtx) {}

  async resolve(sourceId: Id<"sources">): Promise<"pending" | "invalid" | BatchScope> {
    const cached = this.sources.get(sourceId);
    if (cached !== undefined) {
      return cached;
    }
    const source = await this.tx.db.get(sourceId);
    if (source === null || source.lifecycle !== "active") {
      // Business validity: a withdrawn or purged source notifies nobody.
      this.sources.set(sourceId, "invalid");
      return "invalid";
    }
    const runs = await this.tx.db
      .query("processingRuns")
      .withIndex("by_source_started", (q) => q.eq("sourceId", sourceId))
      .take(20);
    // The latest run by started time (bounded collect + reduce; the same
    // result the index's descending order would hand `first()`).
    const latestRun =
      runs.length === 0
        ? null
        : runs.reduce((latest, candidate) =>
            candidate.startedAtMs > latest.startedAtMs ? candidate : latest,
          );
    const links = await this.tx.db
      .query("sourceProjectLinks")
      .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
      .collect();
    const resolution = resolveAssignment(
      latestRun === null ? null : { state: latestRun.state as "running" | "succeeded" | "failed" | "superseded" },
      links.map((link) => link.projectId),
    );
    const value: "pending" | BatchScope =
      resolution.state === "pending"
        ? "pending"
        : resolution.state === "company"
          ? { kind: "company", projectIds: [] }
          : { kind: "project", projectIds: resolution.projectIds };
    this.sources.set(sourceId, value);
    return value;
  }
}

/** Reads one recipient's current read state for one source. */
async function readOf(
  tx: MutationCtx,
  userId: Id<"users">,
  sourceId: Id<"sources">,
): Promise<boolean> {
  const row = await tx.db
    .query("readStates")
    .withIndex("by_user_source", (q) => q.eq("userId", userId).eq("sourceId", sourceId))
    .first();
  return row?.read === true;
}

/** Reads one recipient's current personal settings (defaults when no row). */
async function settingsOf(tx: MutationCtx, companyId: Id<"companies">, userId: Id<"users">) {
  const row = await tx.db
    .query("notificationPreferences")
    .withIndex("by_company_user", (q) => q.eq("companyId", companyId).eq("userId", userId))
    .first();
  return preferenceWriteOf(row ?? null);
}

/** Records one terminal intent decision and publishes its canonical event. */
async function settleIntent(
  tx: MutationCtx,
  intent: PendingIntent,
  decision:
    | { state: "suppressed"; reason: SuppressedReason }
    | { state: "delivered"; deliveryJson: string }
    | { state: "failed"; reason: string },
  nowMs: number,
): Promise<void> {
  await tx.db.patch(intent._id, {
    state: decision.state,
    lastEvaluatedAtMs: nowMs,
    // Delivered intents carry the collapsed summary; terminal failures and
    // suppressions share the machine-readable reason column.
    ...(decision.state === "delivered"
      ? { deliveryJson: decision.deliveryJson, deliveredAtMs: nowMs }
      : { suppressedReason: decision.reason }),
  });
  await publishEvent(tx, {
    companyId: intent.companyId,
    eventName: "attention.intentDelivered",
    payload: {
      notificationIntentId: intent._id,
      outcome:
        decision.state === "delivered" ? "delivered" : decision.state === "failed" ? "failed" : "suppressed",
    },
  });
}

/** Defers one intent to a later instant (quiet hours / pending assignment). */
async function deferIntent(
  tx: MutationCtx,
  intent: PendingIntent,
  dueAtMs: number,
  nowMs: number,
): Promise<void> {
  await tx.db.patch(intent._id, { dueAtMs, lastEvaluatedAtMs: nowMs });
}

/** One bucket of intents sharing a recipient and scope bucket. */
interface Bucket {
  readonly recipientUserId: Id<"users">;
  readonly companyId: Id<"companies">;
  readonly bucketKey: string;
  readonly scope: BatchScope;
  readonly semanticKind: "source_entry" | "clarification";
  /** The due intents that formed the bucket; read ones carry their flag. */
  readonly intents: { readonly intent: PendingIntent; readonly read: boolean }[];
}

/** The scope bucket one intent belongs to, resolved through the caches. */
async function bucketKeyOf(
  tx: MutationCtx,
  assignment: AssignmentCache,
  intent: PendingIntent,
): Promise<"pending" | "invalid" | string> {
  if (intent.semanticKind === "source_entry") {
    if (intent.sourceId === undefined) {
      return "invalid";
    }
    const resolution = await assignment.resolve(intent.sourceId);
    if (resolution === "pending" || resolution === "invalid") {
      return resolution;
    }
    return batchBucketOf(resolution);
  }
  if (intent.clarificationId === undefined) {
    return "invalid";
  }
  const clarification = await tx.db.get(intent.clarificationId);
  if (clarification === null) {
    return "invalid";
  }
  const scope: BatchScope =
    clarification.scopeKind === "project" && clarification.scopeProjectId !== undefined
      ? { kind: "project", projectIds: [clarification.scopeProjectId] }
      : { kind: "company", projectIds: [] };
  return `clarification:${batchBucketOf(scope)}`;
}

/** Adds one due intent to its bucket (read entries still form the bucket). */
async function addToBucket(
  buckets: Map<string, Bucket>,
  intent: PendingIntent,
  bucketKey: string,
  scope: BatchScope,
  semanticKind: "source_entry" | "clarification",
  read: boolean,
): Promise<void> {
  const mapKey = `${intent.recipientUserId}|${bucketKey}`;
  const existing = buckets.get(mapKey);
  if (existing === undefined) {
    buckets.set(mapKey, {
      recipientUserId: intent.recipientUserId,
      companyId: intent.companyId,
      bucketKey,
      scope,
      semanticKind,
      intents: [{ intent, read }],
    });
  } else {
    existing.intents.push({ intent, read });
  }
}

/**
 * The evaluator: re-checks and delivers every due pending intent. The
 * caller owns `nowMs` (the scheduled entry passes the wall clock; the
 * guarded probe may pass a chosen instant), and every decision inside is
 * computed AT that instant through F1's seam, so quiet-hour and DST
 * boundaries behave identically in proofs and production.
 */
export async function performEvaluateDueIntents(
  tx: MutationCtx,
  input: EvaluateDueIntentsInput,
): Promise<ResultEnvelope> {
  const nowMs = input.nowMs;
  const due = await tx.db
    .query("notificationIntents")
    .withIndex("by_due", (q) => q.eq("state", "pending").lte("dueAtMs", nowMs))
    .take(SWEEP_LIMIT);

  const assignment = new AssignmentCache(tx);
  const buckets = new Map<string, Bucket>();
  const touched: Id<"notificationIntents">[] = [];

  for (const intent of due) {
    touched.push(intent._id);

    // task_reminder is F4's kind; confirmation is never created (ordinary
    // agent confirmations produce no push intent). Neither is pending here
    // today; if one ever is, it stays for its owning lane's evaluator.
    if (intent.semanticKind !== "source_entry" && intent.semanticKind !== "clarification") {
      continue;
    }

    // --- business validity --------------------------------------------------
    if (intent.semanticKind === "source_entry") {
      if (intent.sourceId === undefined) {
        await settleIntent(tx, intent, { state: "suppressed", reason: "source_no_longer_valid" }, nowMs);
        continue;
      }
      const resolution = await assignment.resolve(intent.sourceId);
      if (resolution === "invalid") {
        await settleIntent(tx, intent, { state: "suppressed", reason: "source_no_longer_valid" }, nowMs);
        continue;
      }
      // --- assignment: still pending -> wait, never a company bypass -------
      if (resolution === "pending") {
        await deferIntent(tx, intent, nowMs + ASSIGNMENT_RETRY_MS, nowMs);
        continue;
      }
      // --- read state: read entries leave the batch before delivery, but
      // still form the bucket — the batch's window is anchored at the FIRST
      // entry, so a read entry's fire instant may yet carry an unread
      // sibling accepted inside that same window.
      const read = await readOf(tx, intent.recipientUserId, intent.sourceId);
      await addToBucket(buckets, intent, batchBucketOf(resolution), resolution, "source_entry", read);
      continue;
    }

    // --- clarification: resolved/closed questions no longer notify ---------
    if (intent.clarificationId === undefined) {
      await settleIntent(tx, intent, { state: "suppressed", reason: "clarification_resolved" }, nowMs);
      continue;
    }
    const clarification = await tx.db.get(intent.clarificationId);
    if (clarification === null || clarification.state !== "open") {
      await settleIntent(tx, intent, { state: "suppressed", reason: "clarification_resolved" }, nowMs);
      continue;
    }
    // The author may be asked about their own source; the read rule is the
    // underlying source's read state for this recipient.
    if (intent.sourceId !== undefined && (await readOf(tx, intent.recipientUserId, intent.sourceId))) {
      await settleIntent(tx, intent, { state: "suppressed", reason: "already_read" }, nowMs);
      continue;
    }
    const scope: BatchScope =
      clarification.scopeKind === "project" && clarification.scopeProjectId !== undefined
        ? { kind: "project", projectIds: [clarification.scopeProjectId] }
        : { kind: "company", projectIds: [] };
    await addToBucket(buckets, intent, `clarification:${batchBucketOf(scope)}`, scope, "clarification", false);
  }

  for (const bucket of buckets.values()) {
    // --- recipient rights: a revoked member's intent dies -------------------
    const membership = await tx.db
      .query("memberships")
      .withIndex("by_company_user", (q) =>
        q.eq("companyId", bucket.companyId).eq("userId", bucket.recipientUserId),
      )
      .filter((q) => q.eq(q.field("state"), "active"))
      .first();
    if (membership === null) {
      for (const { intent } of bucket.intents) {
        await settleIntent(tx, intent, { state: "suppressed", reason: "membership_revoked" }, nowMs);
      }
      continue;
    }

    // --- read state: the read due entries die here (after rights, before
    // the personal decision — F1's seam order), leaving the live batch.
    const live: PendingIntent[] = [];
    for (const member of bucket.intents) {
      if (member.read) {
        await settleIntent(tx, member.intent, { state: "suppressed", reason: "already_read" }, nowMs);
      } else {
        live.push(member.intent);
      }
    }

    // --- the window stays open until the ACTUAL fire instant: every sibling
    // pending intent of this recipient in the same scope bucket joins the
    // batch (an intent accepted after this instant cannot exist yet; one
    // accepted before it keeps its own later window only if it lands in a
    // DIFFERENT bucket). Read siblings die like read due entries.
    const siblings = await tx.db
      .query("notificationIntents")
      .withIndex("by_recipient_state", (q) =>
        q.eq("recipientUserId", bucket.recipientUserId).eq("state", "pending"),
      )
      .collect();
    const liveIds = new Set(live.map((intent) => intent._id));
    for (const candidate of siblings) {
      if (candidate.semanticKind !== bucket.semanticKind || liveIds.has(candidate._id)) {
        continue;
      }
      const key = await bucketKeyOf(tx, assignment, candidate);
      if (key !== bucket.bucketKey || !joinsBatch(anchorOf(candidate), nowMs)) {
        continue;
      }
      if (
        candidate.sourceId !== undefined &&
        (await readOf(tx, candidate.recipientUserId, candidate.sourceId))
      ) {
        await settleIntent(tx, candidate, { state: "suppressed", reason: "already_read" }, nowMs);
        touched.push(candidate._id);
        continue;
      }
      live.push(candidate);
      liveIds.add(candidate._id);
      touched.push(candidate._id);
    }
    if (live.length === 0) {
      // Everything in the batch was read before delivery: nothing notifies.
      continue;
    }

    const company = await tx.db.get(bucket.companyId);
    if (company === null || !isValidTimezone(company.timezone)) {
      for (const intent of live) {
        await settleIntent(tx, intent, { state: "failed", reason: "company_unresolvable" }, nowMs);
      }
      continue;
    }

    // --- the personal delivery decision (F1's seam, suppression first) ------
    const decision = decidePersonalDelivery({
      kind: bucket.semanticKind,
      scope: bucket.scope.kind,
      projectIds: [...bucket.scope.projectIds],
      isAuthor: bucket.semanticKind === "clarification",
      read: false, // read intents already left the batch above
      nowMs,
      companyTimezone: company.timezone,
      settings: await settingsOf(tx, bucket.companyId, bucket.recipientUserId),
    });

    if (decision.decision === "suppressed") {
      const reason = deathReasonOfPersonalSuppression(decision.reason);
      for (const intent of live) {
        await settleIntent(tx, intent, { state: "suppressed", reason }, nowMs);
      }
      continue;
    }
    if (decision.decision === "deferred") {
      // Quiet hours defer; the deferred batch re-collapses at the window
      // end instead of replaying stale items (the fire then includes
      // everything accepted by that later instant).
      for (const intent of live) {
        await deferIntent(tx, intent, decision.untilMs, nowMs);
      }
      continue;
    }

    // --- eligible: ONE collapsed current summary for the batch --------------
    const summary = buildBatchSummary({
      semanticKind: bucket.semanticKind,
      bucket: bucket.bucketKey,
      scope: bucket.scope,
      sourceIds: live.flatMap((intent) =>
        intent.sourceId !== undefined ? [intent.sourceId] : [],
      ),
      clarificationIds: live.flatMap((intent) =>
        intent.clarificationId !== undefined ? [intent.clarificationId] : [],
      ),
      deliveredAtMs: nowMs,
    });
    const deliveryJson = JSON.stringify(summary);
    for (const intent of live) {
      await settleIntent(tx, intent, { state: "delivered", deliveryJson }, nowMs);
    }
  }

  // The report dedupes: a sibling absorbed into a fired batch and already
  // recorded by the sweep counts once.
  const evaluatedIntentIds = [...new Set(touched)];

  // The durable chain: one scheduled hop at the earliest future due time
  // (bounded collect + reduce over the by_due index's pending range).
  const remaining = await tx.db
    .query("notificationIntents")
    .withIndex("by_due", (q) => q.eq("state", "pending"))
    .take(SWEEP_LIMIT);
  if (remaining.length > 0) {
    const nextPending = remaining.reduce((first, candidate) =>
      candidate.dueAtMs < first.dueAtMs ? candidate : first,
    );
    if (nextPending.dueAtMs > nowMs) {
      await scheduleEvaluationAt(tx, nextPending.dueAtMs);
    }
  }

  return okResult(
    Schema.decodeUnknownSync(evaluateDueIntentsOperation.result)({
      evaluatedIntentIds,
    }),
  );
}
