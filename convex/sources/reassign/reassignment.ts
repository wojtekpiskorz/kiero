/**
 * Source project reassignment: the E7 transaction body plus its pure
 * decisions (issue #115, the operation H3's dossier named as its missing
 * prerequisite).
 *
 * The boss moves one "Wiadomość źródłowa" between projects or to/from
 * company-general by declaring the COMPLETE new project set. ONE Convex
 * mutation does everything, mirroring the withdrawal transaction's
 * discipline (convex/memory/recompute/withdrawal.ts):
 *
 * - guards: the source belongs to the actor's company, is still `active`
 *   (a withdrawn source keeps its historical placement, reassignment
 *   never rewrites withdrawal's history) and every referenced project —
 *   declared OR observed — is the company's own;
 * - R4 (issue #129): the command's REQUIRED `expectedProjectIds`
 *   precondition names the complete set the editor observed; a mismatch
 *   with the current committed set refuses the typed
 *   `source_placement_stale` conflict BEFORE any write, event or
 *   recomputation job, so a stale editor form never silently overwrites a
 *   newer reassignment (the comparison ignores ordering and duplicates,
 *   and nothing is ever merged);
 * - a typed conflict refuses a set equal to the current links (nothing to
 *   change), so client retries can never double-fire the reaction;
 * - the link rows themselves move (`sourceProjectLinks` is the single
 * source of truth for placement: the conversation views and the dossier
 * read it live, nothing is copied), links that stay are LEFT UNTOUCHED
 * (their assignment actor and time are history), removed links are
 * deleted, new links are inserted with the reassigning actor and the
 * source's immutable send time;
 * - the canonical `sources.sourceReassigned` event and the durable
 * `memory.recompute_dependents` registration (cause `source_reassigned`)
 * commit atomically under the SAME dedup key, so the outbox drain's
 * projection collapses onto this registration and the scope re-assessment
 * reaction can never be lost.
 *
 * The source row itself is never rewritten: text, authorship, send
 * snapshot, lifecycle and read state stay exactly as they were
 * ("Niezmienny po wysłaniu wpis użytkownika"; reassignment keeps read
 * state, CONTEXT.md's own note on the links table). The dependent
 * findings' re-assessment does NOT run inline: the registered C5 executor
 * (the memory findings lane's marking core,
 * convex/memory/findings/reassignment.ts) performs the scope marking in
 * its own transaction.
 *
 * Pure decisions (set comparison, the new-set validation) live here so
 * tests/e7 can prove them without a deployment.
 */

import { Schema } from "effect";
import {
  errorResult,
  events,
  executors,
  okResult,
  sourcesOperations,
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
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { publishEvent, registerDurableJob } from "../../platform/publish";
import { normalizedActor, normalizedCompany, requireSource } from "../../memory/findings/references";

/** The contract entry this transaction implements (decode/typed authority). */
export const reassignSourceEntry = sourcesOperations["sources.reassignSource"];

/** The input type of `sources.reassignSource` as decoded by the checked path. */
export type ReassignSourceInput = Schema.Schema.Type<typeof reassignSourceEntry.input>;

/** The result type of `sources.reassignSource` (the saved receipt). */
export type ReassignSourceReceipt = Schema.Schema.Type<typeof reassignSourceEntry.result>;

/** Retry policy of the registered scope re-assessment (bounded, like C5's). */
export const REASSIGN_RETRY_POLICY = { maxAttempts: 3, backoffBaseMs: 2_000 } as const;

/** Bounded reassignment: at most this many distinct projects per source. */
export const MAX_PROJECT_LINKS = 32;

// ---------------------------------------------------------------------------
// Pure decisions (unit-tested in tests/e7).
// ---------------------------------------------------------------------------

/** Order-preserving de-duplication of the declared project set. */
export function dedupeProjectIds(projectIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const projectId of projectIds) {
    if (!seen.has(projectId)) {
      seen.add(projectId);
      out.push(projectId);
    }
  }
  return out;
}

/**
 * Set equality of the declared links against the current ones: a
 * reassignment that changes nothing is refused as a typed conflict (the
 * order of a set is not its meaning). Generic over the id type so the
 * branded references compare without casts.
 */
export function sameLinkSet<ProjectId extends string>(
  declared: readonly ProjectId[],
  current: readonly ProjectId[],
): boolean {
  if (declared.length !== current.length) {
    return false;
  }
  const currentSet = new Set(current);
  return declared.every((projectId) => currentSet.has(projectId));
}

// ---------------------------------------------------------------------------
// The registration pre-flight (everything that can throw, before any write).
// ---------------------------------------------------------------------------

/**
 * A representative table id used only by the pre-insert decode templates
 * (the D1/withdrawal pattern): proves the event payload, executor input
 * and receipt schemas still accept the exact shapes this transaction
 * constructs, BEFORE anything is written.
 */
const REGISTRATION_TEMPLATE_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f";

/**
 * Resolves everything that can THROW during registration BEFORE the first
 * write (the D1 discipline): a failure here is a typed validation error
 * with nothing committed, while the same failure after the first delete or
 * insert would commit a partial reassignment (a moved link with no event
 * and no recomputation reaction).
 */
function registrationTargets(): { ok: true } | {
  ok: false;
  error: ReturnType<typeof validationError>;
} {
  const eventEntry = events["sources.sourceReassigned"];
  if (eventEntry === undefined) {
    return { ok: false, error: validationError("source_reassigned_event_missing") };
  }
  const executor = executors.find(
    (candidate) => candidate.jobKind === "memory.recompute_dependents",
  );
  if (executor === undefined) {
    return { ok: false, error: validationError("recompute_executor_missing") };
  }
  Schema.decodeUnknownSync(eventEntry.payload)({
    sourceId: REGISTRATION_TEMPLATE_ID,
    projectIds: [REGISTRATION_TEMPLATE_ID],
  });
  Schema.decodeUnknownSync(executor.input)({
    rootFindingId: null,
    sourceId: REGISTRATION_TEMPLATE_ID,
    cause: "source_reassigned",
    reason: null,
    withdrawnByUserId: null,
    reassignedByUserId: REGISTRATION_TEMPLATE_ID,
  });
  Schema.decodeUnknownSync(reassignSourceEntry.result)({
    reassignedAtMs: 0,
    projectIds: [],
  });
  return { ok: true };
}

// ---------------------------------------------------------------------------
// The reassignment transaction (runs inside ONE Convex mutation).
// ---------------------------------------------------------------------------

/**
 * Resolves ONE complete project set — the declared replacement or the
 * observed-placement precondition — into the company's own normalized
 * project ids: de-duplicated (order preserved), bounded, reference-checked
 * and tenant-checked, BEFORE any write. One rule serves both sets the
 * command carries (they can never drift apart); a failure is the typed
 * error the transaction returns verbatim (the registrationTargets shape).
 */
async function resolveCompanyProjects(
  tx: MutationCtx,
  refs: readonly string[],
  companyId: Id<"companies">,
): Promise<{ ok: true; projectIds: Id<"projects">[] } | { ok: false; error: ClosedError }> {
  const deduped = dedupeProjectIds(refs);
  if (deduped.length > MAX_PROJECT_LINKS) {
    return { ok: false, error: validationError("too_many_project_links") };
  }
  const projectIds: Id<"projects">[] = [];
  for (const projectRef of deduped) {
    const projectId = tx.db.normalizeId("projects", projectRef);
    if (projectId === null) {
      return { ok: false, error: validationError("project_reference_not_found") };
    }
    const project = await tx.db.get(projectId);
    if (project === null) {
      return { ok: false, error: validationError("project_reference_not_found") };
    }
    if (project.companyId !== companyId) {
      return { ok: false, error: forbiddenError("tenant_scope_mismatch", "projects") };
    }
    projectIds.push(projectId);
  }
  return { ok: true, projectIds };
}

/**
 * Performs the whole reassignment in the caller's mutation transaction:
 * guards, the link set change, the canonical event and the durable scope
 * re-assessment registration, atomically.
 */
export async function performReassignment(
  tx: MutationCtx,
  context: RequestContext,
  input: ReassignSourceInput,
  idempotencyKey: string | undefined,
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
  // A withdrawn source keeps its historical placement (withdrawal semantics
  // untouched); a purged one is gone. Only an active source moves.
  if (source.lifecycle !== "active") {
    return errorResult(
      conflictError(
        source.lifecycle === "withdrawn" ? "source_withdrawn" : "source_not_active",
        "sources",
        source._id,
      ),
    );
  }

  // --- the two project sets the command carries: ONE resolution rule -------
  // The declared replacement and the observed-placement precondition (R4, a
  // REQUIRED contract key) resolve through the SAME company-project rule:
  // a foreign or unknown reference in EITHER set refuses BEFORE any write
  // and never exposes placement, and the comparison ignores ordering and
  // duplicates (resolveCompanyProjects de-duplicates).
  const declared = await resolveCompanyProjects(tx, input.projectIds, companyId);
  if (!declared.ok) {
    return errorResult(declared.error);
  }
  const observed = await resolveCompanyProjects(tx, input.expectedProjectIds, companyId);
  if (!observed.ok) {
    return errorResult(observed.error);
  }

  // --- the current links: the stale precondition fires FIRST ---------------
  // A complete replacement declares what the editor SAW; if the committed
  // set moved since that read, the form is stale and the command refuses
  // BEFORE any write, event or recomputation job (the refused editor
  // reloads the authoritative placement through the detail read; the stale
  // and current sets are never merged). This precedes the nothing-to-change
  // refusal: an editor whose desired set happens to equal the current one
  // still never reassigns blindly off a stale observation.
  const currentLinks = await tx.db
    .query("sourceProjectLinks")
    .withIndex("by_source", (q) => q.eq("sourceId", source._id))
    .collect();
  const currentProjectIds = currentLinks.map((link) => link.projectId);
  if (!sameLinkSet(observed.projectIds, currentProjectIds)) {
    return errorResult(conflictError("source_placement_stale", "sources", source._id));
  }
  if (sameLinkSet(declared.projectIds, currentProjectIds)) {
    return errorResult(conflictError("source_links_unchanged", "sources", source._id));
  }

  // --- pre-flight: every throwing step resolves BEFORE the first write ----
  const targets = registrationTargets();
  if (!targets.ok) {
    return errorResult(targets.error);
  }

  // --- the atomic commit: links + event + job, or nothing -----------------
  const nowMs = Date.now();
  const declaredSet = new Set(declared.projectIds);
  for (const link of currentLinks) {
    if (!declaredSet.has(link.projectId)) {
      await tx.db.delete(link._id);
    }
  }
  const currentSet = new Set(currentProjectIds);
  for (const projectId of declared.projectIds) {
    if (currentSet.has(projectId)) {
      continue; // kept links keep their assignment actor and time (history)
    }
    await tx.db.insert("sourceProjectLinks", {
      sourceId: source._id,
      projectId,
      assignedByUserId: actorUserId,
      assignedAtMs: nowMs,
      // The source's immutable send time, denormalized for conversation
      // order exactly like acceptance writes it.
      sentAtMs: source.sentAtMs,
    });
  }
  // One dedup identity for the event, the job and the logical reassignment.
  // A caller-supplied idempotency key names the logical operation; without
  // one, the source id plus this transaction's instant keeps distinct
  // reassignments distinct (the nothing-to-change guard collapses retries).
  const dedupKey = `sources.reassignSource:${companyId}:${
    idempotencyKey ?? `${source._id}:${nowMs}`
  }`;
  await publishEvent(tx, {
    companyId: context.actor.companyId,
    eventName: "sources.sourceReassigned",
    payload: { sourceId: source._id, projectIds: declared.projectIds },
    dedupKey,
  });
  await registerDurableJob(tx, {
    kind: "memory.recompute_dependents",
    input: {
      rootFindingId: null,
      sourceId: source._id,
      cause: "source_reassigned",
      reason: null,
      withdrawnByUserId: null,
      reassignedByUserId: actorUserId,
    },
    companyId: context.actor.companyId,
    sourceId: source._id,
    policy: REASSIGN_RETRY_POLICY,
    dedupKey,
  });
  return okResult(
    Schema.decodeUnknownSync(reassignSourceEntry.result)({
      reassignedAtMs: nowMs,
      projectIds: declared.projectIds,
    }),
  );
}
