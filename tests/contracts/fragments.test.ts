/**
 * Schema fragment composition and integrity tests (A2 focused verification).
 *
 * These run the actual fragment modules (pinned convex 1.45.0 table
 * definitions) against the data dictionary invariants that are checkable
 * before deployment: table inventory, index presence for the architecture's
 * named reads, extension version immutability (required, append-only shape),
 * source immutability (no editable text core), and independent parent task
 * versus checklist item state.
 */

import { describe, expect, it } from "vitest";
import schema from "../../convex/schema";
import { extensionsTables } from "../../convex/memory/extensions/schema";
import { acceptTables } from "../../convex/sources/accept/schema";
import { workTables } from "../../convex/work/schema";
import {
  CalendarRemoteOutcome,
  ChecklistItemState,
  ContactKind,
  ContactRole,
  DurableJobKind,
  DurableJobState,
  EventOccurrenceState,
  ExportState,
  ExtensionFieldKind,
  MediaKind,
  MediaRepresentationRole,
  MembershipRole,
  OutboxDeliveryState,
  ProcessingRunState,
  ProjectStage,
  PublicationState,
  TABLE_ID_NAMES,
  TaskState,
  UploadStage,
} from "@kiero/contracts";
import type { TableIdName } from "@kiero/contracts";
import { type GenericValidator } from "convex/values";

const tables = schema.tables;

function objectFields(validator: GenericValidator, table: string): Record<string, GenericValidator> {
  expect(validator.isConvexValidator, table).toBe(true);
  if (validator.kind !== "object") {
    throw new Error(`${table}: expected an object validator`);
  }
  return validator.fields;
}

function fieldOf(
  fields: Record<string, GenericValidator>,
  table: string,
  name: string,
): GenericValidator {
  const field = fields[name];
  if (field === undefined) {
    throw new Error(`${table}: missing field ${name}`);
  }
  return field;
}

type IndexableTable = { " indexes"(): { indexDescriptor: string; fields: string[] }[] };

/** The pinned experimental accessor `" indexes"()` returns the index list. */
function indexFields(
  table: IndexableTable | undefined,
  tableName: string,
  indexName: string,
): string[] {
  if (table === undefined) {
    throw new Error(`${tableName}: missing table`);
  }
  const index = table[" indexes"]().find(
    (candidate) => candidate.indexDescriptor === indexName,
  );
  if (index === undefined) {
    throw new Error(`${tableName}: missing index ${indexName}`);
  }
  return index.fields;
}

function memberLiterals(validator: GenericValidator, table: string): string[] {
  if (validator.kind !== "union") {
    throw new Error(`${table}: expected a union validator`);
  }
  return validator.members
    .map((member) => (member.kind === "literal" ? String(member.value) : null))
    .filter((value): value is string => value !== null);
}

describe("schema composition", () => {
  it("composes exactly the closed table inventory (52 tables)", () => {
    const composed = Object.keys(tables).sort();
    const inventory = [...TABLE_ID_NAMES].sort();
    expect(composed).toEqual(inventory);
    // 52 since the A3 certification amendment added externalEffects.
    expect(composed).toHaveLength(52);
  });

  it("gives the domain event envelope a durable outbox home", () => {
    expect(Object.keys(tables)).toContain("outboxEvents");
    const fields = objectFields(tableOrFail("outboxEvents").validator, "outboxEvents");
    for (const name of ["eventId", "companyId", "eventName", "envelopeJson", "deliveryState", "attempts"]) {
      expect(fieldOf(fields, "outboxEvents", name).isOptional, name).toBe("required");
    }
    expect(indexFields(tables.outboxEvents, "outboxEvents", "by_delivery")).toEqual([
      "deliveryState",
      "nextAttemptAtMs",
    ]);
    expect(indexFields(tables.outboxEvents, "outboxEvents", "by_dedup")).toEqual(["dedupKey"]);
  });

  it("every fragment table carries a genuine pinned object validator", () => {
    for (const [name, table] of Object.entries(tables)) {
      expect(table.validator.isConvexValidator, name).toBe(true);
      expect(table.validator.kind, name).toBe("object");
    }
  });

  it("carries indexes for the architecture's named reads", () => {
    // company + conversation order
    expect(indexFields(tables.sources, "sources", "by_company_order")).toEqual([
      "companyId",
      "sentAtMs",
    ]);
    // company/project current work
    expect(indexFields(tables.tasks, "tasks", "by_project_state")).toEqual([
      "companyId",
      "projectId",
      "state",
    ]);
    // stable finding identity + current revision lookups
    expect(
      indexFields(tables.findingRevisions, "findingRevisions", "by_finding_revision"),
    ).toEqual(["findingId", "revision"]);
    expect(indexFields(tables.evidenceLinks, "evidenceLinks", "by_fragment")).toEqual([
      "sourceFragmentId",
    ]);
    // due workflow/notification state
    expect(
      indexFields(tables.notificationIntents, "notificationIntents", "by_due"),
    ).toEqual(["state", "dueAtMs"]);
    // user/source read state
    expect(indexFields(tables.readStates, "readStates", "by_user_source")).toEqual([
      "userId",
      "sourceId",
    ]);
    // user/company Calendar mapping
    expect(indexFields(tables.calendarCopies, "calendarCopies", "by_task")).toEqual([
      "taskId",
    ]);
    // export/source invalidation
    expect(
      indexFields(tables.exportSourceLinks, "exportSourceLinks", "by_source"),
    ).toEqual(["sourceId"]);
  });
});

describe("extension definition versioning immutability", () => {
  const fields = objectFields(extensionsTables.extensionVersions.validator, "extensionVersions");

  it("a version snapshot is complete and required: no silent meaning change", () => {
    // The full declared meaning travels with the version row; a changed
    // meaning or field kind is a NEW version, never an edit in place.
    for (const name of ["definitionId", "version", "name", "fields", "changeNote"]) {
      expect(fieldOf(fields, "extensionVersions", name).isOptional, name).toBe("required");
    }
    const shapeField = fieldOf(fields, "extensionVersions", "fields");
    if (shapeField.kind !== "array") {
      throw new Error("extensionVersions.fields must be an array validator");
    }
    const element = shapeField.element;
    expect(element.isConvexValidator).toBe(true);
    if (element.kind !== "object") {
      throw new Error("extensionVersions.fields items must be objects");
    }
    const kindField = fieldOf(
      objectFields(element, "extensionVersions.fields"),
      "extensionVersions.fields",
      "kind",
    );
    if (kindField.kind !== "union") {
      throw new Error("field kind must be a closed union");
    }
  });

  it("versions are keyed by definition and version (append-only identity)", () => {
    expect(
      indexFields(extensionsTables.extensionVersions, "extensionVersions", "by_definition_version"),
    ).toEqual(["definitionId", "version"]);
  });
});

describe("source correction immutability", () => {
  const fields = objectFields(acceptTables.sources.validator, "sources");

  it("immutable core is required and the editable-text blocklist is absent", () => {
    // General invariant, blocklist witness: schema validators cannot express
    // "no field of this shape may ever exist", so the checked names are the
    // plausible editable-text twins; the required core is the general part.
    // The boss's own words, authorship and send-time snapshot are required at
    // acceptance; a correction is a NEW source, lifecycle stays explicit.
    for (const name of ["authorUserId", "authorText", "sentAtMs", "sentAtTimezone"]) {
      expect(fieldOf(fields, "sources", name).isOptional, name).toBe("required");
    }
    // No in-place editable text override may exist.
    for (const forbidden of ["editedText", "currentText", "textOverride", "correctedText"]) {
      expect(fields[forbidden], forbidden).toBeUndefined();
    }
    // Withdrawal is an explicit lifecycle transition with reason and time.
    const withdrawnReason = fields.withdrawnReason;
    expect(withdrawnReason?.isOptional).toBe("optional");
    expect(fieldOf(fields, "sources", "lifecycle").kind).toBe("union");
  });
});

describe("independent parent and checklist state", () => {
  const taskFields = objectFields(workTables.tasks.validator, "tasks");
  const itemFields = objectFields(workTables.checklistItems.validator, "checklistItems");

  it("task state and checklist item state are separate closed vocabularies", () => {
    const taskState = fieldOf(taskFields, "tasks", "state");
    const itemState = fieldOf(itemFields, "checklistItems", "state");
    expect(taskState.kind).toBe("union");
    expect(itemState.kind).toBe("union");
    expect(memberLiterals(taskState, "tasks.state")).toEqual([
      "todo",
      "in_progress",
      "waiting",
      "done",
      "cancelled",
    ]);
    // The item vocabulary has no task states: no inherited completion.
    expect(memberLiterals(itemState, "checklistItems.state")).toEqual(["open", "checked"]);
  });

  it("keeps parent and checklist state independent (vocabularies disjoint, blocklist of coupling fields absent)", () => {
    // The general part is the disjoint state vocabularies above; the
    // coupling check itself is a blocklist witness (derivedDone et al.),
    // since validators cannot name "any possible coupling field".
    for (const forbidden of ["taskState", "parentState", "derivedDone"]) {
      expect(itemFields[forbidden], forbidden).toBeUndefined();
    }
    for (const forbidden of ["computedDone", "checklistComplete"]) {
      expect(taskFields[forbidden], forbidden).toBeUndefined();
    }
    expect(taskFields.parentTaskId?.isOptional).toBe("optional");
  });
});

describe("fragment vocabulary pins equal the contracts vocabularies", () => {
  it("every pinned closed union carries exactly the contracts-side literals", () => {
    // The pins are compile-time checks (ValueValidator<Encoded<typeof X>>);
    // this compares both sides at runtime too, through the actual table
    // validators and the actual contracts schemas.
    const cases: ReadonlyArray<{
      readonly table: GenericValidator;
      readonly tableName: string;
      readonly path: readonly string[];
      readonly schema: { readonly ast: unknown };
    }> = [
      { table: workTables.tasks.validator, tableName: "tasks", path: ["state"], schema: TaskState },
      {
        table: workTables.checklistItems.validator,
        tableName: "checklistItems",
        path: ["state"],
        schema: ChecklistItemState,
      },
      {
        table: workTables.events.validator,
        tableName: "events",
        path: ["state"],
        schema: EventOccurrenceState,
      },
      {
        table: tableOrFail("projects").validator,
        tableName: "projects",
        path: ["stage"],
        schema: ProjectStage,
      },
      {
        table: tableOrFail("uploads").validator,
        tableName: "uploads",
        path: ["stage"],
        schema: UploadStage,
      },
      {
        table: tableOrFail("mediaRepresentations").validator,
        tableName: "mediaRepresentations",
        path: ["role"],
        schema: MediaRepresentationRole,
      },
      {
        table: tableOrFail("changeSets").validator,
        tableName: "changeSets",
        path: ["state"],
        schema: PublicationState,
      },
      {
        table: tableOrFail("memberships").validator,
        tableName: "memberships",
        path: ["role"],
        schema: MembershipRole,
      },
      {
        table: tableOrFail("invitations").validator,
        tableName: "invitations",
        path: ["role"],
        schema: MembershipRole,
      },
      {
        table: tableOrFail("contacts").validator,
        tableName: "contacts",
        path: ["kind"],
        schema: ContactKind,
      },
      {
        table: tableOrFail("contactRoles").validator,
        tableName: "contactRoles",
        path: ["role"],
        schema: ContactRole,
      },
      {
        table: tableOrFail("attachments").validator,
        tableName: "attachments",
        path: ["kind"],
        schema: MediaKind,
      },
      {
        table: tableOrFail("calendarCopies").validator,
        tableName: "calendarCopies",
        path: ["remoteOutcome"],
        schema: CalendarRemoteOutcome,
      },
      {
        table: tableOrFail("processingRuns").validator,
        tableName: "processingRuns",
        path: ["state"],
        schema: ProcessingRunState,
      },
      {
        table: tableOrFail("exports").validator,
        tableName: "exports",
        path: ["state"],
        schema: ExportState,
      },
      {
        table: tableOrFail("durableJobs").validator,
        tableName: "durableJobs",
        path: ["kind"],
        schema: DurableJobKind,
      },
      {
        table: tableOrFail("durableJobs").validator,
        tableName: "durableJobs",
        path: ["state"],
        schema: DurableJobState,
      },
      {
        table: tableOrFail("outboxEvents").validator,
        tableName: "outboxEvents",
        path: ["deliveryState"],
        schema: OutboxDeliveryState,
      },
    ];

    for (const entry of cases) {
      let current: GenericValidator = entry.table;
      for (const step of entry.path) {
        const fields = objectFields(current, entry.tableName);
        current = fieldOf(fields, entry.tableName, step);
      }
      const tableName = `${entry.tableName}.${entry.path.join(".")}`;
      expect(
        memberLiterals(current, entry.tableName).sort(),
        tableName,
      ).toEqual(schemaLiterals(entry.schema, entry.tableName));
    }

    // The nested extension field-kind pin travels through the array element.
    const fieldsField = fieldOf(
      objectFields(extensionsTables.extensionVersions.validator, "extensionVersions"),
      "extensionVersions",
      "fields",
    );
    if (fieldsField.kind !== "array") {
      throw new Error("extensionVersions.fields must be an array validator");
    }
    const kindField = fieldOf(
      objectFields(fieldsField.element, "extensionVersions.fields"),
      "extensionVersions.fields",
      "kind",
    );
    expect(memberLiterals(kindField, "extensionVersions.fields.kind").sort()).toEqual(
      schemaLiterals(ExtensionFieldKind, "ExtensionFieldKind"),
    );
  });
});

function tableOrFail(name: TableIdName): { validator: GenericValidator } {
  const table = tables[name];
  if (table === undefined) {
    throw new Error(`missing table ${name}`);
  }
  return table;
}

/** Extracts the string literals of a union-of-literals schema AST. */
function schemaLiterals(schema: { readonly ast: unknown }, name: string): string[] {
  const ast = schema.ast;
  if (typeof ast !== "object" || ast === null || !("_tag" in ast) || ast._tag !== "Union") {
    throw new Error(`${name}: expected a union-of-literals schema`);
  }
  if (!("types" in ast) || !Array.isArray(ast.types)) {
    throw new Error(`${name}: expected union members`);
  }
  const out: string[] = [];
  for (const member of ast.types) {
    if (
      typeof member !== "object" ||
      member === null ||
      !("_tag" in member) ||
      member._tag !== "Literal" ||
      !("literal" in member) ||
      typeof member.literal !== "string"
    ) {
      throw new Error(`${name}: expected string literal members`);
    }
    out.push(member.literal);
  }
  return out.sort();
}
