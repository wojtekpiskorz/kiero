/**
 * Projects transactions (C1): the write halves of the pure domain rules in
 * `packages/domain/projects`, each inside ONE Convex mutation.
 *
 * Every entry runs through the typed command dispatch (./dispatch.ts):
 * envelope decode -> registry -> B1 identity resolution (provision-or-refresh
 * + the canonical chain) -> the C1 policy -> contract input decode ->
 * handler. The company scope always comes from the RESOLVED context; a
 * cross-company project/contact reference is indistinguishable from a
 * missing one (`not_found`, no existence leak).
 *
 * ATOMICITY (the B3/D1 discipline): every step that can throw (validations,
 * row loads, domain decisions) runs BEFORE the first insert/patch; between
 * the first write and the return only pre-validated writes and total decodes
 * of transaction-generated values remain. State changes publish their
 * canonical events (`projects.*`) atomically in the same transaction.
 *
 * Revision discipline: `projects.stageRevision` is the optimistic counter
 * for lifecycle state. `changeStage` and `setPause` both verify the expected
 * revision and both advance it — a stage change and a pause change on one
 * project serialize through the same counter, while the pause NEVER writes
 * the stage field and the stage NEVER writes the pause field.
 */

import { Schema } from "effect";
import {
  events,
  okResult,
  projectsOperations,
  errorResult,
  type ResultEnvelope,
} from "@kiero/contracts";
import {
  conflictError,
  notFoundError,
  unavailableError,
  validationError,
  type RequestContext,
} from "@kiero/runtime";
import type { MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { publishEvent } from "../platform/publish";
import {
  decideCodenameReservation,
  decideContactRoleAssignment,
  decidePauseChange,
  decideStageChange,
  generatedCodename,
  isClosedStage,
  nextWorkingAliasSequence,
  validateCodename,
  validateContactName,
  validatePauseReason,
  validateProjectDisplayName,
  type AliasReservationView,
} from "../../packages/domain/projects/index";

// The contract entries these transactions implement (decode authority).
export const identifyProjectEntry = projectsOperations["projects.identifyProject"];
export const assignCodenameEntry = projectsOperations["projects.assignCodename"];
export const changeStageEntry = projectsOperations["projects.changeStage"];
export const setPauseEntry = projectsOperations["projects.setPause"];
export const upsertContactEntry = projectsOperations["projects.upsertContact"];
export const assignContactRoleEntry = projectsOperations["projects.assignContactRole"];

/** Typed decoded inputs of the implemented operations. */
export type IdentifyProjectInput = Schema.Schema.Type<typeof identifyProjectEntry.input>;
export type AssignCodenameInput = Schema.Schema.Type<typeof assignCodenameEntry.input>;
export type ChangeStageInput = Schema.Schema.Type<typeof changeStageEntry.input>;
export type SetPauseInput = Schema.Schema.Type<typeof setPauseEntry.input>;
export type UpsertContactInput = Schema.Schema.Type<typeof upsertContactEntry.input>;
export type AssignContactRoleInput = Schema.Schema.Type<typeof assignContactRoleEntry.input>;

/**
 * The company scope every transaction resolves first: the Convex-normalized
 * company id from the RESOLVED request context (never client input). An
 * unresolvable reference fails closed before any read or write.
 */
function companyScopeOf(
  tx: MutationCtx,
  context: RequestContext,
): { readonly ok: true; readonly companyId: Id<"companies"> } | {
  readonly ok: false;
  readonly error: ResultEnvelope;
} {
  const companyId = tx.db.normalizeId("companies", context.actor.companyId);
  if (companyId === null) {
    return { ok: false, error: errorResult(validationError("company_scope_unresolved")) };
  }
  return { ok: true, companyId };
}

/**
 * Loads one project inside the actor's company scope. Cross-company ids are
 * indistinguishable from missing ones.
 */
async function loadCompanyProject(
  tx: MutationCtx,
  companyId: Id<"companies">,
  projectId: string,
): Promise<Doc<"projects"> | null> {
  const id = tx.db.normalizeId("projects", projectId);
  if (id === null) {
    return null;
  }
  const project = await tx.db.get(id);
  if (project === null || project.companyId !== companyId) {
    return null;
  }
  return project;
}

/** Loads one contact inside the actor's company scope (same no-leak rule). */
async function loadCompanyContact(
  tx: MutationCtx,
  companyId: Id<"companies">,
  contactId: string,
): Promise<Doc<"contacts"> | null> {
  const id = tx.db.normalizeId("contacts", contactId);
  if (id === null) {
    return null;
  }
  const contact = await tx.db.get(id);
  if (contact === null || contact.companyId !== companyId) {
    return null;
  }
  return contact;
}

/** The retained reservation rows of one (company, codename) pair. */
async function codenameReservations(
  tx: MutationCtx,
  companyId: Id<"companies">,
  codename: string,
): Promise<AliasReservationView[]> {
  const rows = await tx.db
    .query("projectAliases")
    .withIndex("by_company_codename", (q) => q.eq("companyId", companyId).eq("codename", codename))
    .collect();
  return rows.map((row) => ({
    aliasId: row._id,
    projectId: row.projectId,
    active: row.active,
  }));
}

/** Retires the project's active codename rows other than `keepAliasId`. */
async function retireActiveCodenames(
  tx: MutationCtx,
  projectId: Id<"projects">,
  keepAliasId: Id<"projectAliases"> | null,
  nowMs: number,
): Promise<void> {
  const rows = await tx.db
    .query("projectAliases")
    .withIndex("by_project", (q) => q.eq("projectId", projectId))
    .collect();
  for (const row of rows) {
    if (row.active && row._id !== keepAliasId) {
      await tx.db.patch(row._id, { active: false, retiredAtMs: nowMs });
    }
  }
}

/** Publishes one projects event (payload pre-decoded against the registry). */
async function publishProjectsEvent(
  tx: MutationCtx,
  companyId: Id<"companies">,
  eventName: string,
  payload: unknown,
  dedupKey: string,
): Promise<void> {
  const entry = events[eventName];
  if (entry === undefined) {
    // The composed registry guarantees existence at import time; this keeps
    // the transaction honest even under future composition drift.
    throw new Error(`projects transaction: unknown event ${eventName}`);
  }
  Schema.decodeUnknownSync(entry.payload)(payload);
  await publishEvent(tx, { companyId, eventName, payload, dedupKey });
}

/**
 * Identifies (creates) one project from possibly incomplete information:
 * any starting stage, an optional already-known client, and a display name
 * that may collide with other projects. The project is born with a
 * GENERATED working alias (`#<sequence>`), unique within the firm by
 * construction, so project resolution works from the first inquiry before
 * any boss-chosen codename exists.
 */
export async function performIdentifyProject(
  tx: MutationCtx,
  context: RequestContext,
  input: IdentifyProjectInput,
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const scope = companyScopeOf(tx, context);
  if (!scope.ok) {
    return scope.error;
  }
  const { companyId } = scope;
  const name = validateProjectDisplayName(input.displayName);
  if (!name.ok) {
    return errorResult(validationError(name.code));
  }

  let clientId: Id<"contacts"> | undefined;
  if (input.clientId !== null) {
    const client = await loadCompanyContact(tx, companyId, input.clientId);
    if (client === null) {
      return errorResult(notFoundError("contacts", "client_contact_not_found"));
    }
    clientId = client._id;
  }

  const companyProjects = await tx.db
    .query("projects")
    .withIndex("by_company_stage", (q) => q.eq("companyId", companyId))
    .collect();
  const codename = generatedCodename(nextWorkingAliasSequence(companyProjects.length));

  // --- the atomic commit: project + working alias + canonical event -------
  const projectId = await tx.db.insert("projects", {
    companyId,
    displayName: name.value,
    ...(clientId !== undefined && { clientId }),
    stage: input.initialStage,
    stageRevision: 1,
    // A retrospectively recorded closed project is born closed.
    ...(isClosedStage(input.initialStage) && { closedAtMs: nowMs }),
    createdAtMs: nowMs,
  });
  const aliasId = await tx.db.insert("projectAliases", {
    companyId,
    projectId,
    codename,
    active: true,
    assignedAtMs: nowMs,
  });
  await publishProjectsEvent(
    tx,
    companyId,
    "projects.projectIdentified",
    { projectId },
    `projects.projectIdentified:${projectId}`,
  );
  return okResult(
    Schema.decodeUnknownSync(identifyProjectEntry.result)({ projectId, aliasId }),
  );
}

/**
 * Assigns (or renames) the firm-unique codename of one project. The claim
 * is decided against the firm's RETAINED reservation history for that
 * codename: another project's alias — active, renamed-away or belonging to a
 * closed project — refuses with `conflict`. Re-claiming the project's own
 * retired codename reactivates the retained row; re-commanding the active
 * codename is an idempotent no-op. A rename retires the previous codename
 * row (retained, still denoting the same project) in the same transaction.
 */
export async function performAssignCodename(
  tx: MutationCtx,
  context: RequestContext,
  input: AssignCodenameInput,
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const scope = companyScopeOf(tx, context);
  if (!scope.ok) {
    return scope.error;
  }
  const { companyId } = scope;
  const codename = validateCodename(input.codename);
  if (!codename.ok) {
    return errorResult(validationError(codename.code));
  }
  const project = await loadCompanyProject(tx, companyId, input.projectId);
  if (project === null) {
    return errorResult(notFoundError("projects"));
  }

  const reserved = await codenameReservations(tx, companyId, codename.value);
  const decision = decideCodenameReservation(reserved, project._id);
  if (decision.kind === "reserved_by_other") {
    // No recordTable here: the closed conflict vocabulary names only
    // revision-expectation tables (findings/tasks/projects/...), and
    // "projectAliases" is not a member — a non-member recordTable makes
    // the closed-error decode itself throw. The machine code is the
    // load-bearing detail (the web surface hints it in Polish).
    return errorResult(conflictError("codename_reserved"));
  }
  if (decision.kind === "already_active") {
    const aliasId = tx.db.normalizeId("projectAliases", decision.aliasId);
    if (aliasId === null) {
      return errorResult(unavailableError(true, "alias_id_unresolvable"));
    }
    return okResult(Schema.decodeUnknownSync(assignCodenameEntry.result)({ aliasId }));
  }

  // --- the atomic commit: retire + claim + canonical event -----------------
  if (decision.kind === "reactivate") {
    const aliasId = tx.db.normalizeId("projectAliases", decision.aliasId);
    if (aliasId === null) {
      return errorResult(unavailableError(true, "alias_id_unresolvable"));
    }
    await retireActiveCodenames(tx, project._id, aliasId, nowMs);
    await tx.db.patch(aliasId, { active: true, assignedAtMs: nowMs, retiredAtMs: undefined });
    await publishProjectsEvent(
      tx,
      companyId,
      "projects.codenameAssigned",
      { projectId: project._id, aliasId },
      `projects.codenameAssigned:${aliasId}:${nowMs}`,
    );
    return okResult(Schema.decodeUnknownSync(assignCodenameEntry.result)({ aliasId }));
  }

  await retireActiveCodenames(tx, project._id, null, nowMs);
  const aliasId = await tx.db.insert("projectAliases", {
    companyId,
    projectId: project._id,
    codename: codename.value,
    active: true,
    assignedAtMs: nowMs,
  });
  await publishProjectsEvent(
    tx,
    companyId,
    "projects.codenameAssigned",
    { projectId: project._id, aliasId },
    `projects.codenameAssigned:${aliasId}:${nowMs}`,
  );
  return okResult(Schema.decodeUnknownSync(assignCodenameEntry.result)({ aliasId }));
}

/**
 * Changes the project stage by explicit command. The decision is total over
 * the fixed vocabulary (no sequencing enforced); the revision expectation
 * serializes concurrent lifecycle commands; close records the closure
 * instant, reopen clears it, reclassify keeps it; the pause mark, contacts,
 * aliases and source links are untouched — closure never cascades.
 *
 * There is deliberately no input through which silence, an elapsed date or
 * the absence of open tasks could close a project: the ONLY way in is an
 * explicit target stage commanded by the resolved boss (or the agent acting
 * through the same checked operation).
 */
export async function performChangeStage(
  tx: MutationCtx,
  context: RequestContext,
  input: ChangeStageInput,
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const scope = companyScopeOf(tx, context);
  if (!scope.ok) {
    return scope.error;
  }
  const { companyId } = scope;
  const project = await loadCompanyProject(tx, companyId, input.projectId);
  if (project === null) {
    return errorResult(notFoundError("projects"));
  }
  if (input.expectedRevision !== project.stageRevision) {
    return errorResult(conflictError("revision_mismatch", "projects", project._id));
  }

  const decision = decideStageChange(project.stage, input.stage);
  if (decision.kind === "unchanged") {
    return okResult(Schema.decodeUnknownSync(changeStageEntry.result)({ projectId: project._id }));
  }

  // --- the atomic commit: stage + revision + canonical event ---------------
  await tx.db.patch(project._id, {
    stage: input.stage,
    stageRevision: project.stageRevision + 1,
    ...(decision.kind === "close" && { closedAtMs: nowMs }),
    ...(decision.kind === "reopen" && { closedAtMs: undefined }),
  });
  await publishProjectsEvent(
    tx,
    companyId,
    "projects.stageChanged",
    { projectId: project._id, fromStage: project.stage, toStage: input.stage },
    `projects.stageChanged:${project._id}:${project.stageRevision + 1}`,
  );
  return okResult(Schema.decodeUnknownSync(changeStageEntry.result)({ projectId: project._id }));
}

/**
 * Sets, replaces or clears the pause mark. The mark records a reason and an
 * optional PROPOSED resume date (a calendar-verified local day whose arrival
 * implies nothing — actual resumption is this explicit clear). The patch
 * NEVER touches the stage: pause is a separate mark ("Wstrzymanie projektu"),
 * and deadlines live outside this record entirely. Pausing a closed project
 * is refused as a state conflict; clearing is always allowed.
 */
export async function performSetPause(
  tx: MutationCtx,
  context: RequestContext,
  input: SetPauseInput,
): Promise<ResultEnvelope> {
  const scope = companyScopeOf(tx, context);
  if (!scope.ok) {
    return scope.error;
  }
  const { companyId } = scope;
  const project = await loadCompanyProject(tx, companyId, input.projectId);
  if (project === null) {
    return errorResult(notFoundError("projects"));
  }
  if (input.expectedRevision !== project.stageRevision) {
    return errorResult(conflictError("revision_mismatch", "projects", project._id));
  }
  if (input.pause !== null) {
    const reason = validatePauseReason(input.pause.reason);
    if (!reason.ok) {
      return errorResult(validationError(reason.code));
    }
  }

  const decision = decidePauseChange(project.stage, input.pause);
  if (decision.kind === "rejected_closed") {
    return errorResult(conflictError("project_closed", "projects", project._id));
  }

  // --- the atomic commit: mark + revision + canonical event ----------------
  await tx.db.patch(project._id, {
    ...(input.pause === null
      ? { paused: undefined }
      : {
          paused: {
            reason: input.pause.reason.trim(),
            resumeOn: input.pause.resumeOn,
          },
        }),
    stageRevision: project.stageRevision + 1,
  });
  await publishProjectsEvent(
    tx,
    companyId,
    "projects.pauseChanged",
    { projectId: project._id, paused: input.pause !== null },
    `projects.pauseChanged:${project._id}:${project.stageRevision + 1}`,
  );
  return okResult(Schema.decodeUnknownSync(setPauseEntry.result)({ projectId: project._id }));
}

/**
 * Creates or updates one catalog contact (a person or organization). The
 * contact is the identity; a name is catalog text, deliberately not unique.
 * An update keeps the row (and every role row referencing it) intact.
 */
export async function performUpsertContact(
  tx: MutationCtx,
  context: RequestContext,
  input: UpsertContactInput,
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const scope = companyScopeOf(tx, context);
  if (!scope.ok) {
    return scope.error;
  }
  const { companyId } = scope;
  const name = validateContactName(input.displayName);
  if (!name.ok) {
    return errorResult(validationError(name.code));
  }

  if (input.contactId === null) {
    const contactId = await tx.db.insert("contacts", {
      companyId,
      kind: input.kind,
      displayName: name.value,
      createdAtMs: nowMs,
    });
    return okResult(Schema.decodeUnknownSync(upsertContactEntry.result)({ contactId }));
  }

  const contact = await loadCompanyContact(tx, companyId, input.contactId);
  if (contact === null) {
    return errorResult(notFoundError("contacts"));
  }
  await tx.db.patch(contact._id, { kind: input.kind, displayName: name.value });
  return okResult(Schema.decodeUnknownSync(upsertContactEntry.result)({ contactId: contact._id }));
}

/**
 * Assigns one project role to one contact. The same contact may hold client,
 * executor and supplier roles of the same project — one identity, several
 * rows, no per-role identity duplication. Commanding an already-held role is
 * an idempotent no-op returning the existing row.
 */
export async function performAssignContactRole(
  tx: MutationCtx,
  context: RequestContext,
  input: AssignContactRoleInput,
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const scope = companyScopeOf(tx, context);
  if (!scope.ok) {
    return scope.error;
  }
  const { companyId } = scope;
  const project = await loadCompanyProject(tx, companyId, input.projectId);
  if (project === null) {
    return errorResult(notFoundError("projects"));
  }
  const contact = await loadCompanyContact(tx, companyId, input.contactId);
  if (contact === null) {
    return errorResult(notFoundError("contacts"));
  }

  const existing = await tx.db
    .query("contactRoles")
    .withIndex("by_project_contact_role", (q) =>
      q.eq("projectId", project._id).eq("contactId", contact._id).eq("role", input.role),
    )
    .first();
  const decision = decideContactRoleAssignment(
    existing === null ? [] : [{ contactRoleId: existing._id, role: existing.role }],
    input.role,
  );
  if (decision.kind === "existing") {
    return okResult(
      Schema.decodeUnknownSync(assignContactRoleEntry.result)({
        contactRoleId: decision.contactRoleId,
      }),
    );
  }

  const contactRoleId = await tx.db.insert("contactRoles", {
    companyId,
    projectId: project._id,
    contactId: contact._id,
    role: input.role,
    createdAtMs: nowMs,
  });
  return okResult(
    Schema.decodeUnknownSync(assignContactRoleEntry.result)({ contactRoleId }),
  );
}
