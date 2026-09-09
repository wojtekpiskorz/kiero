/**
 * Projects and contacts tables (A2 candidate, certified by A3).
 *
 * Owning implementer: C1 (projects, contacts, aliases, lifecycle).
 * A project exists from the first client inquiry; ordinary names may collide
 * while assigned codenames are firm-unique across retained history and stay
 * reserved through rename/closure. Pause is a separate mark, not a stage.
 *
 * Tables: contacts, contactRoles, projects, projectAliases.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared, type Encoded, type ValueValidator } from "../schema/shared";
import { ContactKind, ContactRole, ProjectStage } from "@kiero/contracts";

// Vocabulary pins: each closed union must equal its contracts-side schema's
// encoded literals exactly, or this file fails typecheck.
const contactKind: ValueValidator<Encoded<typeof ContactKind>> = v.union(
  v.literal("person"),
  v.literal("organization"),
);

const contactRole: ValueValidator<Encoded<typeof ContactRole>> = v.union(
  v.literal("client"),
  v.literal("executor"),
  v.literal("supplier"),
);

const projectStage: ValueValidator<Encoded<typeof ProjectStage>> = v.union(
  v.literal("inquiry"),
  v.literal("offer_preparation"),
  v.literal("awaiting_decision"),
  v.literal("agreed"),
  v.literal("in_progress"),
  v.literal("completed"),
  v.literal("cancelled"),
);

export const projectsTables = {
  /** Person or organization in the company catalog, distinct from user accounts. */
  contacts: defineTable({
    companyId: shared.companyId,
    kind: contactKind,
    displayName: v.string(),
    aliases: v.optional(v.array(v.string())),
    /** Bounded contact channels (phone/email), plain strings. */
    contactChannels: v.optional(
      v.array(v.object({ channel: v.string(), value: v.string() })),
    ),
    createdAtMs: shared.tsMs,
  }).index("by_company", ["companyId"]),

  /** One contact's relationship to one project: client, executor or supplier. */
  contactRoles: defineTable({
    companyId: shared.companyId,
    projectId: shared.projectId,
    contactId: shared.contactId,
    role: contactRole,
    createdAtMs: shared.tsMs,
  })
    .index("by_project_role", ["projectId", "role"])
    .index("by_project_contact_role", ["projectId", "contactId", "role"])
    .index("by_contact", ["contactId"])
    .index("by_company", ["companyId"]),

  /** One concrete matter from first inquiry to completion or cancellation. */
  projects: defineTable({
    companyId: shared.companyId,
    displayName: v.string(),
    clientId: v.optional(shared.contactId),
    /** Fixed stage vocabulary (issue 9); no stage is added for a pause. */
    stage: projectStage,
    stageRevision: shared.counter,
    /** Separate pause mark with reason and optional resume date. */
    paused: v.optional(
      v.object({ reason: v.string(), resumeOn: v.union(v.null(), v.string()) }),
    ),
    createdAtMs: shared.tsMs,
    closedAtMs: v.optional(shared.tsMs),
  })
    .index("by_company_stage", ["companyId", "stage"])
    .index("by_client", ["clientId"]),

  /** Firm-unique working codename ("Alias projektu"); history stays reserved. */
  projectAliases: defineTable({
    companyId: shared.companyId,
    projectId: shared.projectId,
    codename: v.string(),
    active: v.boolean(),
    assignedAtMs: shared.tsMs,
    /** When the codename was renamed away from; the row is retained. */
    retiredAtMs: v.optional(shared.tsMs),
  })
    .index("by_company_codename", ["companyId", "codename"])
    .index("by_project", ["projectId"]),
} as const;
