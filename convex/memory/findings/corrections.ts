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
 *   open question for entitled bosses; resolution keeps its author.
 *
 * Every perform* body runs inside ONE Convex mutation; everything that can
 * throw or refuse runs before the first write (the D1 discipline).
 */

import { Schema } from "effect";
import {
  errorResult,
  events,
  okResult,
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
import type { Id } from "../../_generated/dataModel";
import { publishEvent } from "../../platform/publish";
import {
  normalizedActor,
  normalizedCompany,
  requireFinding,
  requireProject,
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

  const nowMs = Date.now();
  const revisionNumber = finding.revisionCounter + 1;
  const revisionId = await tx.db.insert("findingRevisions", {
    findingId: finding._id,
    revision: revisionNumber,
    value: encodeFindingValue(input.value),
    knowledgeState: encodeKnowledgeState(input.knowledgeState),
    ...(finding.currentRevisionId === undefined
      ? {}
      : { supersedesRevisionId: finding.currentRevisionId }),
    origin: "correction",
    reason: input.reason,
    recordedByUserId: actorUserId,
    recordedAtMs: nowMs,
  });
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
  const actorUserId = normalizedActor(tx.db, context);
  if (actorUserId === null) {
    return errorResult(validationError("actor_user_unresolved"));
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
