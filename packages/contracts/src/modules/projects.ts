/**
 * Projects module surface (architecture "Deep modules": Projects and work,
 * the projects half). Implements lanes: C1.
 *
 * Stable identity, firm-unique codenames reserved through rename/closure,
 * fixed project stages plus a separate pause mark, contact roles without
 * per-role identities. Stage vocabulary from issue 9: Zapytanie,
 * Przygotowanie oferty, Oczekiwanie na decyzję, Uzgodnione, W realizacji,
 * Zakończone, Anulowane.
 */

import { Schema } from "effect";
import { tableIdSchema } from "../tableIds";
import { RevisionCounter } from "../actor";
import { LocalDate } from "../values/temporal";
import { operationEntry, eventEntry } from "./registration";

/** Contact catalog kind: a person or an organization (CONTEXT.md "Kontakt"). */
export const ContactKind = Schema.Literals(["person", "organization"]);
export type ContactKind = Schema.Schema.Type<typeof ContactKind>;

/** One contact's relationship to a project: client, executor or supplier. */
export const ContactRole = Schema.Literals(["client", "executor", "supplier"]);
export type ContactRole = Schema.Schema.Type<typeof ContactRole>;

/** Fixed project stage vocabulary; no stage is added for a pause (issue 9). */
export const ProjectStage = Schema.Literals([
  "inquiry",
  "offer_preparation",
  "awaiting_decision",
  "agreed",
  "in_progress",
  "completed",
  "cancelled",
]);
export type ProjectStage = Schema.Schema.Type<typeof ProjectStage>;

/** Separate pause mark with reason and optional resume date (issue 9). */
export const ProjectPause = Schema.Struct({
  reason: Schema.NonEmptyString,
  resumeOn: Schema.NullOr(LocalDate),
});
export type ProjectPause = Schema.Schema.Type<typeof ProjectPause>;

export const projectsOperations = {
  "projects.identifyProject": operationEntry({
    kind: "operation",
    name: "projects.identifyProject",
    input: Schema.Struct({
      displayName: Schema.NonEmptyString,
      initialStage: ProjectStage,
      clientId: Schema.NullOr(tableIdSchema("contacts")),
    }),
    result: Schema.Struct({
      projectId: tableIdSchema("projects"),
      aliasId: tableIdSchema("projectAliases"),
    }),
    errorKinds: ["forbidden", "validation"],
  }),
  "projects.assignCodename": operationEntry({
    kind: "operation",
    name: "projects.assignCodename",
    input: Schema.Struct({
      projectId: tableIdSchema("projects"),
      codename: Schema.NonEmptyString,
    }),
    result: Schema.Struct({ aliasId: tableIdSchema("projectAliases") }),
    errorKinds: ["forbidden", "not_found", "conflict"],
  }),
  "projects.changeStage": operationEntry({
    kind: "operation",
    name: "projects.changeStage",
    input: Schema.Struct({
      projectId: tableIdSchema("projects"),
      expectedRevision: RevisionCounter,
      stage: ProjectStage,
    }),
    result: Schema.Struct({ projectId: tableIdSchema("projects") }),
    errorKinds: ["forbidden", "not_found", "conflict", "validation"],
  }),
  "projects.setPause": operationEntry({
    kind: "operation",
    name: "projects.setPause",
    input: Schema.Struct({
      projectId: tableIdSchema("projects"),
      expectedRevision: RevisionCounter,
      pause: Schema.NullOr(ProjectPause),
    }),
    result: Schema.Struct({ projectId: tableIdSchema("projects") }),
    errorKinds: ["forbidden", "not_found", "conflict"],
  }),
  "projects.upsertContact": operationEntry({
    kind: "operation",
    name: "projects.upsertContact",
    input: Schema.Struct({
      contactId: Schema.NullOr(tableIdSchema("contacts")),
      kind: ContactKind,
      displayName: Schema.NonEmptyString,
    }),
    result: Schema.Struct({ contactId: tableIdSchema("contacts") }),
    errorKinds: ["forbidden", "validation"],
  }),
  "projects.assignContactRole": operationEntry({
    kind: "operation",
    name: "projects.assignContactRole",
    input: Schema.Struct({
      projectId: tableIdSchema("projects"),
      contactId: tableIdSchema("contacts"),
      role: ContactRole,
    }),
    result: Schema.Struct({ contactRoleId: tableIdSchema("contactRoles") }),
    errorKinds: ["forbidden", "not_found", "validation"],
  }),
} as const;

export const projectsEvents = {
  "projects.projectIdentified": eventEntry({
    kind: "event",
    name: "projects.projectIdentified",
    payload: Schema.Struct({ projectId: tableIdSchema("projects") }),
  }),
  "projects.codenameAssigned": eventEntry({
    kind: "event",
    name: "projects.codenameAssigned",
    payload: Schema.Struct({
      projectId: tableIdSchema("projects"),
      aliasId: tableIdSchema("projectAliases"),
    }),
  }),
  "projects.stageChanged": eventEntry({
    kind: "event",
    name: "projects.stageChanged",
    payload: Schema.Struct({
      projectId: tableIdSchema("projects"),
      fromStage: ProjectStage,
      toStage: ProjectStage,
    }),
  }),
  "projects.pauseChanged": eventEntry({
    kind: "event",
    name: "projects.pauseChanged",
    payload: Schema.Struct({
      projectId: tableIdSchema("projects"),
      paused: Schema.Boolean,
    }),
  }),
} as const;
