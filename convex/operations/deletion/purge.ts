/**
 * The permanent-deletion initiating transaction (I4): `sources.purgeSource`,
 * the certified contract entry issue #56 owns.
 *
 * ONE Convex mutation does everything ("first tombstones the logical source
 * and revokes all application reads atomically, then enumerates ... durable
 * purge intents"):
 *
 * - guard: the source belongs to the actor's company; its lifecycle is
 *   `active` or `withdrawn` (a withdrawn source may still be permanently
 *   deleted; an already-purged one replays idempotently - the existing
 *   content-free ledger record is returned, never a second record);
 * - guard: the explicit confirmation phrase matches exactly (the impact
 *   preview's "wpisz: USUŃ TRWALE" contract); a mismatch is a typed
 *   conflict, never a silent near-miss;
 * - TOMBSTONE: the source row moves to `lifecycle: "purged"` with
 *   `purgedAtMs`, and its own content (`authorText`) is blanked in the SAME
 *   transaction - every read path that checks lifecycle (media access,
 *   export downloads, search hydration, notifications, citations) refuses
 *   from the commit on;
 * - LEDGER: one content-free `deletionRecords` row (counts and opaque
 *   identities only) plus one pending `deletionPurgeStages` row per
 *   derivative family, each carrying the 24-hour deadline;
 * - EVENT + JOB: the canonical `sources.sourcePurged` event and the durable
 *   `deletion.purge_source` registration commit under the SAME dedup key
 *   (the D1/withdrawal discipline), so the reaction can never be lost and a
 *   replay never double-registers. `operations.deletionRecorded` publishes
 *   the ledger entry for I5's backup sets and I6's restore replay;
 * - EAGER EXPORT INVALIDATION: every pre-terminal export linked to the
 *   source runs through I3's one-row invalidation core in this same
 *   transaction (the per-request download check remains the immediate
 *   guard either way).
 *
 * The derivative purging itself (media bytes, transcripts, findings
 * marking, search rows, notification work) does NOT run inline: the
 * registered executor (./executor.ts) performs it durably, idempotently
 * and inspectably, within the 24-hour window.
 */

import { Schema } from "effect";
import {
  errorResult,
  events,
  executors,
  okResult,
  sourcesOperations,
  type ResultEnvelope,
} from "@kiero/contracts";
import {
  conflictError,
  notFoundError,
  validationError,
  type RequestContext,
} from "@kiero/runtime";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { publishEvent, registerDurableJob } from "../../platform/publish";
import { normalizedActor, normalizedCompany, requireSource } from "../../memory/findings/references";
import { invalidateExportsForSourceCore } from "../exports/lifecycle";
import { PURGE_DEADLINE_MS, PURGE_STAGE_KINDS } from "./schema";

/** The contract entry this transaction implements (decode/typed authority). */
export const purgeSourceEntry = sourcesOperations["sources.purgeSource"];

/** The input type of `sources.purgeSource` as decoded by the checked path. */
export type PurgeSourceInput = Schema.Schema.Type<typeof purgeSourceEntry.input>;

/** The exact phrase the confirmation input must carry (product text, CONTEXT.md Polish). */
export const PURGE_CONFIRMATION_PHRASE = "USUŃ TRWALE";

/** Retry policy of the registered purge (bounded, like the withdrawal reaction). */
export const PURGE_RETRY_POLICY = { maxAttempts: 6, backoffBaseMs: 5_000 } as const;

/** The machine reason every finding marking of a purge records. */
export const PURGED_SUPPORT_REASON = "source_purged: trwałe usunięcie wiadomości źródłowej";

/**
 * A representative table id used only by the pre-insert decode templates
 * (the D1 pattern): proves the event payloads and the executor input still
 * accept the exact shapes this transaction constructs, BEFORE anything is
 * written.
 */
const REGISTRATION_TEMPLATE_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f";

/**
 * Everything that can throw or refuse during registration, resolved BEFORE
 * the first write (the D1 acceptance discipline): a failure here leaves
 * nothing committed, while the same failure after the patch would commit a
 * purged source with no purge reaction.
 */
function registrationTargets(): { ok: true } | { ok: false; error: ReturnType<typeof validationError> } {
  const purgedEvent = events["sources.sourcePurged"];
  if (purgedEvent === undefined) {
    return { ok: false, error: validationError("source_purged_event_missing") };
  }
  const recordedEvent = events["operations.deletionRecorded"];
  if (recordedEvent === undefined) {
    return { ok: false, error: validationError("deletion_recorded_event_missing") };
  }
  const executor = executors.find(
    (candidate) => candidate.jobKind === "deletion.purge_source",
  );
  if (executor === undefined) {
    return { ok: false, error: validationError("purge_executor_missing") };
  }
  Schema.decodeUnknownSync(purgedEvent.payload)({ sourceId: REGISTRATION_TEMPLATE_ID });
  Schema.decodeUnknownSync(recordedEvent.payload)({
    deletionRecordId: REGISTRATION_TEMPLATE_ID,
  });
  Schema.decodeUnknownSync(executor.input)({
    sourceId: REGISTRATION_TEMPLATE_ID,
    deletionRecordId: REGISTRATION_TEMPLATE_ID,
  });
  Schema.decodeUnknownSync(purgeSourceEntry.result)({
    deletionRecordId: REGISTRATION_TEMPLATE_ID,
  });
  return { ok: true };
}

/** The source's content-free `source_purge` ledger row, when one exists. */
export async function sourcePurgeRecordOf(
  db: MutationCtx["db"] | QueryCtx["db"],
  sourceId: Id<"sources">,
): Promise<Id<"deletionRecords"> | null> {
  const rows = await db
    .query("deletionRecords")
    .withIndex("by_target_source", (q) => q.eq("targetSourceId", sourceId))
    .collect();
  const record = rows.find((row) => row.kind === "source_purge");
  return record === undefined ? null : record._id;
}

/** One count row of the content-free scope summary. */
async function scopeCounts(db: MutationCtx["db"], sourceId: Id<"sources">): Promise<string> {
  const attachments = await db
    .query("attachments")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  const fragments = await db
    .query("sourceFragments")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  const transcripts = await db
    .query("audioTranscripts")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  const evidenceLinks = await db
    .query("evidenceLinks")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  const exportLinks = await db
    .query("exportSourceLinks")
    .withIndex("by_source", (q) => q.eq("sourceId", sourceId))
    .collect();
  // Counts and kinds only, never text (the ledger is content-free by schema
  // and by construction).
  return JSON.stringify({
    attachmentCount: attachments.length,
    fragmentCount: fragments.length,
    transcriptCount: transcripts.length,
    witnessLinkCount: evidenceLinks.length,
    linkedExportCount: exportLinks.length,
  });
}

/**
 * Performs the whole permanent deletion in the caller's mutation
 * transaction: guards, the tombstone with content removal, the content-free
 * ledger row, the per-family purge stages, the canonical events, the durable
 * purge registration and the eager export invalidation - atomically.
 */
export async function performPurgeSource(
  tx: MutationCtx,
  context: RequestContext,
  input: PurgeSourceInput,
): Promise<ResultEnvelope> {
  const companyId = normalizedCompany(tx.db, context);
  if (companyId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }
  const actorUserId = normalizedActor(tx.db, context);
  if (actorUserId === null) {
    return errorResult(validationError("actor_user_unresolved"));
  }
  const source = await requireSource(tx.db, input.sourceId, companyId);
  if (source === null) {
    return errorResult(notFoundError("sources"));
  }
  if (source.lifecycle === "purged") {
    // Repeated delete requests replay idempotently: the committed tombstone
    // and its ledger row are the authority; a second record never exists.
    const existing = await sourcePurgeRecordOf(tx.db, source._id);
    if (existing === null) {
      return errorResult(conflictError("purge_record_missing", "sources", source._id));
    }
    return okResult({ deletionRecordId: existing });
  }
  if (input.confirmation.trim() !== PURGE_CONFIRMATION_PHRASE) {
    // The explicit permanent-delete confirmation: anything else refuses.
    return errorResult(conflictError("purge_confirmation_mismatch", "sources", source._id));
  }
  const targets = registrationTargets();
  if (!targets.ok) {
    return errorResult(targets.error);
  }

  // --- the atomic commit: tombstone + ledger + stages + event + job --------
  const nowMs = Date.now();
  const deadlineAtMs = nowMs + PURGE_DEADLINE_MS;
  const scopeSummary = await scopeCounts(tx.db, source._id);
  await tx.db.patch(source._id, {
    lifecycle: "purged",
    purgedAtMs: nowMs,
    // The source's own words leave with the tombstone; identity, authorship
    // and send snapshot stay as the non-content reference record.
    authorText: "",
  });
  const deletionRecordId = await tx.db.insert("deletionRecords", {
    companyId,
    kind: "source_purge",
    targetSourceId: source._id,
    requestedByUserId: actorUserId,
    scopeSummary,
    createdAtMs: nowMs,
    purgeDeadlineAtMs: deadlineAtMs,
  });
  for (const stageKind of PURGE_STAGE_KINDS) {
    await tx.db.insert("deletionPurgeStages", {
      deletionRecordId,
      companyId,
      sourceId: source._id,
      stageKind,
      state: "pending",
      attempts: 0,
      deadlineAtMs,
      createdAtMs: nowMs,
    });
  }
  // One dedup identity for the event, the job and the logical deletion:
  // publisher-side registration and the drain's projection collapse here,
  // and the idempotent replay above returns before reaching this point.
  const dedupKey = `sources.purgeSource:${source._id}`;
  await publishEvent(tx, {
    companyId: context.actor.companyId,
    eventName: "sources.sourcePurged",
    payload: { sourceId: source._id },
    dedupKey,
  });
  await registerDurableJob(tx, {
    kind: "deletion.purge_source",
    input: { sourceId: source._id, deletionRecordId },
    companyId: context.actor.companyId,
    sourceId: source._id,
    policy: PURGE_RETRY_POLICY,
    dedupKey,
  });
  await publishEvent(tx, {
    companyId: context.actor.companyId,
    eventName: "operations.deletionRecorded",
    payload: { deletionRecordId },
    dedupKey: `operations.deletionRecorded:${deletionRecordId}`,
  });
  // The eager I3 seam: every pre-terminal linked export invalidates NOW,
  // in the same transaction (the per-request download check stays the
  // immediate guard even before any drain runs).
  await invalidateExportsForSourceCore(tx, source._id, "source_purged", nowMs);
  return okResult({ deletionRecordId });
}
