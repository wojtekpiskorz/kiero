/**
 * Corrections and clarifications (C2): the explicit change paths that are
 * NOT source-backed publications.
 *
 * - `performCorrectFinding`: one explicit correction — a NEW revision
 *   (author, time, reason) superseding the current one, with the projection
 *   moving in the same transaction. The expected-revision check refuses when
 *   the finding moved since the corrector saw it — arrival or completion
 *   time never decides ("Korekta ustalenia ... nie przepisuje wcześniejszej
 *   wiadomości źródłowej").
 * - `performRaiseClarification` / `performResolveClarification`: the shared
 *   open question for entitled bosses; resolution keeps its author. R1
 *   (issue #126): resolution additionally persists whether its basis is
 *   source-backed (normalized source + optional fragment references,
 *   validated against the current state) or a manual boss decision (a note
 *   alone, no fabricated source); a repeated resolve refuses and never
 *   replaces the stored evidence. R2 (issue #127): raise refuses a
 *   conflicting fragment whose source is not ACTIVE (a retained tombstone
 *   never grounds new work), and a redacted open case refuses resolution
 *   (it is not actionable).
 * - `purgeClarificationContentForSource` (R2): the idempotent content
 *   purge the deletion executor runs BEFORE fragments leave — links to
 *   the purged source are removed, possibly derived text is replaced with
 *   the fixed Polish redaction copy, content-free audit metadata is
 *   recorded, and surviving ACTIVE references, actor and timestamps stay
 *   (bounded by the per-source scope, like every I4 stage).
 *
 * Every perform* body runs inside ONE Convex mutation; everything that can
 * throw or refuse runs before the first write (the D1 discipline).
 */

import { Schema } from "effect";
import {
  errorResult,
  events,
  okResult,
  type ClosedError,
  type ResultEnvelope,
} from "@kiero/contracts";
import {
  conflictError,
  forbiddenError,
  notFoundError,
  validationError,
  type RequestContext,
} from "@kiero/runtime";
import { decideCorrection } from "@kiero/domain";
import type { MutationCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { publishEvent } from "../../platform/publish";
import { checkExtensionFindingValue, recordExtensionValueUsage } from "../extensions/validate";
import {
  checkResolutionEvidenceReference,
  clarificationContentRuleOf,
  normalizedActor,
  normalizedCompany,
  requireFinding,
  requireProject,
  REDACTED_CLARIFICATION_QUESTION_COPY,
  REDACTED_CLARIFICATION_RESOLUTION_COPY,
  type ResolutionEvidenceRefusalCode,
} from "./references";
import {
  correctFindingEntry,
  encodeFindingValue,
  encodeKnowledgeState,
  raiseClarificationEntry,
  resolveClarificationEntry,
  TEMPLATE_ID,
  type CorrectFindingInput,
  type RaiseClarificationInput,
  type ResolveClarificationInput,
} from "./semantics";

export async function performCorrectFinding(
  tx: MutationCtx,
  context: RequestContext,
  input: CorrectFindingInput,
): Promise<ResultEnvelope> {
  const companyId = normalizedCompany(tx.db, context);
  if (companyId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }
  const finding = await requireFinding(tx.db, input.findingId, companyId);
  if (finding === null) {
    return errorResult(notFoundError("findings"));
  }
  const decision = decideCorrection(input.expectedRevision, finding.revisionCounter);
  if (decision.decision === "refuse") {
    return errorResult(conflictError(decision.code, "findings", finding._id));
  }
  const actorUserId = normalizedActor(tx.db, context);
  if (actorUserId === null) {
    return errorResult(validationError("actor_user_unresolved"));
  }
  Schema.decodeUnknownSync(correctFindingEntry.result)({ revisionId: TEMPLATE_ID });
  const findingRevised = events["memory.findingRevised"];
  if (findingRevised === undefined) {
    return errorResult(validationError("memory_events_missing"));
  }
  Schema.decodeUnknownSync(findingRevised.payload)({
    findingId: TEMPLATE_ID,
    revisionId: TEMPLATE_ID,
    supersedesRevisionId: null,
  });

  // C3 seam (additive, flagged): a correction's value validates against the
  // exact stored definition version before anything is written, and the
  // committed-usage counter moves with the revision that carries it.
  const encodedCorrectionValue = encodeFindingValue(input.value);
  const extensionCheck = await checkExtensionFindingValue(
    tx.db,
    companyId,
    encodedCorrectionValue,
  );
  if (extensionCheck !== null && !extensionCheck.ok) {
    return errorResult(validationError(extensionCheck.code));
  }

  const nowMs = Date.now();
  const revisionNumber = finding.revisionCounter + 1;
  const revisionId = await tx.db.insert("findingRevisions", {
    findingId: finding._id,
    revision: revisionNumber,
    value: encodedCorrectionValue,
    knowledgeState: encodeKnowledgeState(input.knowledgeState),
    ...(finding.currentRevisionId === undefined
      ? {}
      : { supersedesRevisionId: finding.currentRevisionId }),
    origin: "correction",
    reason: input.reason,
    recordedByUserId: actorUserId,
    recordedAtMs: nowMs,
  });
  await recordExtensionValueUsage(tx.db, companyId, encodedCorrectionValue, nowMs);
  await tx.db.patch(finding._id, {
    currentRevisionId: revisionId,
    knowledgeState: encodeKnowledgeState(input.knowledgeState),
    revisionCounter: revisionNumber,
    updatedAtMs: nowMs,
  });
  await publishEvent(tx, {
    companyId: context.actor.companyId,
    eventName: "memory.findingRevised",
    payload: {
      findingId: finding._id,
      revisionId,
      supersedesRevisionId: finding.currentRevisionId ?? null,
    },
    dedupKey: `memory.findingRevised:${revisionId}`,
  });
  return okResult(Schema.decodeUnknownSync(correctFindingEntry.result)({ revisionId }));
}

export async function performRaiseClarification(
  tx: MutationCtx,
  context: RequestContext,
  input: RaiseClarificationInput,
): Promise<ResultEnvelope> {
  const companyId = normalizedCompany(tx.db, context);
  if (companyId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }
  let scopeProjectId: Id<"projects"> | undefined;
  if (input.scope._tag === "project") {
    const resolved = await requireProject(tx.db, input.scope.projectId, companyId);
    if (resolved === null) {
      return errorResult(notFoundError("projects", "project_scope_not_found"));
    }
    scopeProjectId = resolved;
  }
  const fragmentIds: Id<"sourceFragments">[] = [];
  for (const fragmentRef of input.conflictingEvidence) {
    const fragmentId = tx.db.normalizeId("sourceFragments", fragmentRef);
    const fragment = fragmentId === null ? null : await tx.db.get(fragmentId);
    if (fragment === null || fragmentId === null) {
      return errorResult(validationError("conflicting_fragment_not_found"));
    }
    const fragmentSource = await tx.db.get(fragment.sourceId);
    if (fragmentSource === null || fragmentSource.companyId !== companyId) {
      return errorResult(
        forbiddenError("conflicting_fragment_not_in_company", "sourceFragments"),
      );
    }
    // R2 (issue #127): the accepted source LIFECYCLE, not row existence,
    // decides — a retained tombstone (permanent deletion) or a withdrawn
    // source is not conflicting evidence a new case may rest on, so late
    // work can never publish over a deleted source.
    if (fragmentSource.lifecycle !== "active") {
      return errorResult(validationError("conflicting_fragment_source_not_active"));
    }
    fragmentIds.push(fragmentId);
  }
  const raised = events["memory.clarificationRaised"];
  if (raised === undefined) {
    return errorResult(validationError("memory_events_missing"));
  }
  Schema.decodeUnknownSync(raised.payload)({ clarificationId: TEMPLATE_ID });
  Schema.decodeUnknownSync(raiseClarificationEntry.result)({ clarificationId: TEMPLATE_ID });

  const clarificationId = await tx.db.insert("clarifications", {
    companyId,
    scopeKind: input.scope._tag,
    ...(scopeProjectId === undefined ? {} : { scopeProjectId }),
    question: input.question,
    conflictingFragmentIds: fragmentIds,
    state: "open",
    raisedAtMs: Date.now(),
  });
  await publishEvent(tx, {
    companyId: context.actor.companyId,
    eventName: "memory.clarificationRaised",
    payload: { clarificationId },
    dedupKey: `memory.clarificationRaised:${clarificationId}`,
  });
  return okResult(
    Schema.decodeUnknownSync(raiseClarificationEntry.result)({ clarificationId }),
  );
}

/**
 * One normalized resolution-evidence reference, as the transaction stores it.
 * `fragmentId` null = whole-source evidence (the fragment contract's rule).
 */
interface StoredResolutionEvidence {
  readonly sourceId: Id<"sources">;
  readonly fragmentId: Id<"sourceFragments"> | null;
}

/**
 * Wraps one shared refusal code in THIS transaction's error shape: the
 * cross-company refusal is a closed `forbidden` (tenant boundary), the
 * other three are `validation` (the reference names nothing usable).
 */
function resolutionEvidenceError(code: ResolutionEvidenceRefusalCode): ClosedError {
  return code === "resolution_source_not_in_company"
    ? forbiddenError(code, "sources")
    : validationError(code);
}

/**
 * R1: validates the cited resolution evidence against the CURRENT state,
 * before any write (the D1 discipline — a refusal leaves the case open and
 * stores nothing). The per-reference rule lives ONCE in ./references
 * (`checkResolutionEvidenceReference`); this wrapper adds the transaction's
 * error shape and collapses duplicate (source, fragment) pairs, preserving
 * first-seen order.
 */
async function validatedResolutionEvidence(
  tx: MutationCtx,
  companyId: Id<"companies">,
  cited: readonly {
    sourceId: string;
    fragmentId: string | null;
  }[],
): Promise<
  | { readonly ok: true; readonly evidence: readonly StoredResolutionEvidence[] }
  | { readonly ok: false; readonly error: ClosedError }
> {
  const evidence: StoredResolutionEvidence[] = [];
  const seen = new Set<string>();
  for (const reference of cited) {
    const refusal = await checkResolutionEvidenceReference(tx.db, companyId, reference);
    if (refusal !== null) {
      return { ok: false, error: resolutionEvidenceError(refusal) };
    }
    const sourceId = tx.db.normalizeId("sources", reference.sourceId) as Id<"sources">;
    let fragmentId: Id<"sourceFragments"> | null = null;
    if (reference.fragmentId !== null) {
      fragmentId = tx.db.normalizeId(
        "sourceFragments",
        reference.fragmentId,
      ) as Id<"sourceFragments">;
    }
    const deduplicationKey = `${sourceId}#${fragmentId ?? ""}`;
    if (seen.has(deduplicationKey)) {
      continue;
    }
    seen.add(deduplicationKey);
    evidence.push({ sourceId, fragmentId });
  }
  return { ok: true, evidence };
}

export async function performResolveClarification(
  tx: MutationCtx,
  context: RequestContext,
  input: ResolveClarificationInput,
): Promise<ResultEnvelope> {
  const companyId = normalizedCompany(tx.db, context);
  if (companyId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }
  const clarificationId = tx.db.normalizeId("clarifications", input.clarificationId);
  if (clarificationId === null) {
    return errorResult(notFoundError("clarifications"));
  }
  const clarification = await tx.db.get(clarificationId);
  if (clarification === null || clarification.companyId !== companyId) {
    return errorResult(notFoundError("clarifications"));
  }
  if (clarification.state !== "open") {
    return errorResult(
      conflictError("clarification_already_resolved", "clarifications", clarificationId),
    );
  }
  // R2 (issue #127): a redacted open case is not actionable — its question
  // possibly derived from a permanently deleted source, so resolving it
  // would publish a note about content that must stay gone. The refusal
  // leaves the row exactly as it is (the shared rule decides honestly).
  const contentRule = await clarificationContentRuleOf(tx.db, clarification);
  if (!contentRule.actionable) {
    return errorResult(
      conflictError("clarification_redacted", "clarifications", clarificationId),
    );
  }
  const actorUserId = normalizedActor(tx.db, context);
  if (actorUserId === null) {
    return errorResult(validationError("actor_user_unresolved"));
  }
  // R1: validate the cited evidence against the current state BEFORE any
  // write — an unknown, cross-company, inactive or mismatched-fragment
  // reference refuses the WHOLE command (the case stays open). Absent or
  // empty evidence is a manual boss decision, never a fabricated source.
  const validated = await validatedResolutionEvidence(
    tx,
    companyId,
    input.evidence ?? [],
  );
  if (!validated.ok) {
    return errorResult(validated.error);
  }
  const resolved = events["memory.clarificationResolved"];
  if (resolved === undefined) {
    return errorResult(validationError("memory_events_missing"));
  }
  Schema.decodeUnknownSync(resolved.payload)({ clarificationId: TEMPLATE_ID });
  Schema.decodeUnknownSync(resolveClarificationEntry.result)({ clarificationId: TEMPLATE_ID });

  const nowMs = Date.now();
  await tx.db.patch(clarificationId, {
    state: "resolved",
    resolvedByUserId: actorUserId,
    resolutionNote: input.resolutionNote,
    resolvedAtMs: nowMs,
    resolutionBasis:
      validated.evidence.length > 0 ? "source_backed" : "manual_boss_decision",
    resolutionEvidence: validated.evidence.map((reference) => ({
      sourceId: reference.sourceId,
      ...(reference.fragmentId === null
        ? {}
        : { sourceFragmentId: reference.fragmentId }),
    })),
  });
  await publishEvent(tx, {
    companyId: context.actor.companyId,
    eventName: "memory.clarificationResolved",
    payload: { clarificationId },
    dedupKey: `memory.clarificationResolved:${clarificationId}`,
  });
  return okResult(
    Schema.decodeUnknownSync(resolveClarificationEntry.result)({ clarificationId }),
  );
}

// ---------------------------------------------------------------------------
// R2 (issue #127): the durable clarification content purge.
// ---------------------------------------------------------------------------

/**
 * Whether one clarification row links to the given source at all — through
 * conflicting fragments or through stored R1 resolution evidence. This is
 * the AFFECTED test; the per-row redaction itself is the shared content
 * rule (./references), never a private copy of it. Redaction removes the
 * very links this function looks for, which is what makes the purge
 * idempotent: a re-run finds an already-redacted row unlinked.
 */
async function rowLinksToSource(
  tx: MutationCtx,
  row: Doc<"clarifications">,
  sourceId: Id<"sources">,
): Promise<boolean> {
  for (const fragmentId of row.conflictingFragmentIds) {
    const fragment = await tx.db.get(fragmentId);
    if (fragment !== null && fragment.sourceId === sourceId) {
      return true;
    }
  }
  return (row.resolutionEvidence ?? []).some((reference) => reference.sourceId === sourceId);
}

/**
 * R2: purges the clarification content of ONE permanently deleted source,
 * inside the deletion executor's single stage transaction. The work is
 * bounded by the per-source scope exactly like every other I4 stage (a
 * row qualifies only through THIS source's fragments or resolution
 * evidence), and idempotent by construction: redaction removes the very
 * links `rowLinksToSource` tests, so a retry of the stage finds nothing
 * left to do — no duplicate audit entries, events or restored content.
 *
 * What one redaction does (exactly what the shared content rule already
 * shows, frozen into storage):
 * - removes the associations to the deleted source (conflicting fragment
 *   ids and resolution-evidence references; surviving ACTIVE references
 *   stay, in their stored order);
 * - replaces possibly derived question/resolution text with the FIXED
 *   Polish redaction copy (never a summary of the deleted content);
 * - records the content-free purge audit (source ids and timestamps only);
 * - keeps state, actor and timestamps untouched.
 *
 * The purge publishes no event — the tombstone's own event already told
 * the world, and I6 replays redaction from the stored audit state.
 */
export async function purgeClarificationContentForSource(
  tx: MutationCtx,
  params: {
    readonly companyId: Id<"companies">;
    readonly sourceId: Id<"sources">;
  },
): Promise<void> {
  const rows = await tx.db
    .query("clarifications")
    .withIndex("by_company_state", (q) => q.eq("companyId", params.companyId))
    .collect();
  // Deterministic order (oldest raised first) keeps the redaction sequence
  // stable across stage retries.
  const nowMs = Date.now();
  for (const row of rows.sort((a, b) => a.raisedAtMs - b.raisedAtMs)) {
    if (!(await rowLinksToSource(tx, row, params.sourceId))) {
      continue;
    }
    const rule = await clarificationContentRuleOf(tx.db, row);
    const previousAudit = row.purgeAudit;
    // The audit keeps the FIRST redaction time (never moves once set).
    const questionRedactedAtMs = rule.questionRedacted
      ? (previousAudit?.questionRedactedAtMs ?? nowMs)
      : undefined;
    const noteRedactedAtMs = rule.resolutionNoteRedacted
      ? (previousAudit?.resolutionNoteRedactedAtMs ?? nowMs)
      : undefined;
    await tx.db.patch(row._id, {
      // The stored text converges to what the shared rule already reads.
      ...(rule.questionRedacted
        ? { question: REDACTED_CLARIFICATION_QUESTION_COPY }
        : {}),
      ...(rule.resolutionNoteRedacted && row.resolutionNote !== undefined
        ? { resolutionNote: REDACTED_CLARIFICATION_RESOLUTION_COPY }
        : {}),
      conflictingFragmentIds: rule.activeConflictingEvidence.map(
        (entry) => entry.fragmentId,
      ),
      ...(row.resolutionEvidence === undefined && rule.activeResolutionEvidence.length === 0
        ? {}
        : {
            resolutionEvidence: rule.activeResolutionEvidence.map((reference) => ({
              sourceId: reference.sourceId,
              ...(reference.fragmentId === null
                ? {}
                : { sourceFragmentId: reference.fragmentId }),
            })),
          }),
      // Content-free audit metadata only: identities and timestamps.
      purgeAudit: {
        redactedSourceIds: [
          ...new Set([...(previousAudit?.redactedSourceIds ?? []), params.sourceId]),
        ],
        ...(questionRedactedAtMs === undefined
          ? {}
          : { questionRedactedAtMs }),
        ...(noteRedactedAtMs === undefined
          ? {}
          : { resolutionNoteRedactedAtMs: noteRedactedAtMs }),
      },
    });
  }
}
