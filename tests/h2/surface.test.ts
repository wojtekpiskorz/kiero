/**
 * H2 focused tests, deterministic half: the mounted surface invariants the
 * issue's acceptance names.
 *
 * - the mount/composition seam: /praca (work.records), /dodatkowe
 *   (memory.extensions) and the /co-teraz flip (attention.now) validated
 *   through the REAL host registry, with consumed operations that exist;
 * - deep-link parity: G4's calendar copies link `/co-teraz?zadanie=<id>` /
 *   `?zdarzenie=<id>` (subjectLinkPath); the now screen owns those param
 *   keys, and the record links into /praca reuse them;
 * - the per-user grouping rules: actionable open work (Do zrobienia, W
 *   toku, Czeka) split into mine / shared queue / others / closed-project
 *   obligations; only elapsed-unconfirmed planned events await action;
 * - vocabulary single-sourcing: task/event/checklist labels come from the
 *   domain rules the backend shares;
 * - honest copy: checklist independence, elapsed-dates-prove-nothing,
 *   closed-project obligations, the personal snooze scope, unknown money
 *   tax basis and unknown/disputed bound terms stay visibly unknown;
 * - the extension value builders: wire values that decode through the
 *   contract, with typed refusals for the invalid inputs (the
 *   "invalid extension version/value" failure family has its server half
 *   proven live; these pin the client half);
 * - the shared statement-to-source send: one idempotency key per logical
 *   statement, so a lost-response resubmit converges on one source
 *   (finding 1 of review round 1);
 * - the snooze parser reads the boss's wall time in the COMPANY zone
 *   (finding 4: DST-honest on the target day, never the phone's zone).
 *
 * The live halves (real Convex fixtures: create/edit/state transitions,
 * checklist independence, closed-project obligation, overdue date-only
 * work, snooze, reassignment, unassigned work, stale revisions, revoked
 * membership, removed coordinator, concurrent checklist/parent changes)
 * run in ./live-proof.mjs against the leased dev deployment and are
 * transcribed into the session report.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { operations, ResultEnvelope } from "@kiero/contracts";
import { subjectLinkPath } from "@kiero/domain";
import {
  CHECKLIST_ITEM_STATE_LABELS,
  EVENT_STATE_LABELS,
  TASK_STATE_LABELS,
} from "../../packages/domain/work/index";
import { TAX_BASIS_LABELS, TEMPORAL_ROLE_LABELS } from "../../packages/domain/findings/labels";
import { appFeatures } from "../../apps/web/src/app/app-features";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import {
  boundTermLabel,
  checklistItemStateLabels,
  eventStateLabels,
  failureHint as workFailureHint,
  taskStateLabels,
  taxBasisLabel,
  temporalValueLabel,
  workCopy,
} from "../../apps/web/src/features/work/state";
import { failureHint as extensionsFailureHint } from "../../apps/web/src/features/extensions/state";
import { TaskRow, EventRow, projectJoinOf } from "../../apps/web/src/features/work/WorkFeature";
import {
  EVENT_PARAM,
  TASK_PARAM,
  closedProjectObligations,
  eventRecordLink,
  eventsAwaitingConfirmation,
  myOpenTasks,
  nowCopy,
  othersOpenTasks,
  snoozeUntilMs,
  taskRecordLink,
  unassignedOpenTasks,
} from "../../apps/web/src/features/now/state";
import { NoticeArea } from "../../apps/web/src/features/company/dispatch";
import {
  freshStatementKey,
  nextStatementKey,
  sendStatementAsSource,
  type StatementSourceMutations,
} from "../../apps/web/src/features/company/statement-source";
import { deriveFieldId, fieldKindLabels } from "../../apps/web/src/features/extensions/state";
import {
  buildExtensionValue,
  emptySlots,
  parseScalarValue,
  type FieldInputSlots,
  type FieldShape,
} from "../../apps/web/src/features/extensions/value-editor";
import { draftsToFields } from "../../apps/web/src/features/extensions/ExtensionsFeature";
import type { EventView, TaskView } from "../../convex/work/read";
import type { ProjectsOverview } from "../../convex/projects/functions";

/** Representative table ids (the wire pattern the reads carry). */
const TASK_1 = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2a";
const TASK_2 = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2b";
const TASK_3 = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2c";
const TASK_4 = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2d";
const PROJECT_1 = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2p";
const PROJECT_CLOSED = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2q";
const EVENT_1 = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2e";
const ME = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2m";
const OTHER = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2n";

/** A minimal task view fixture (the same plain-string override rule). */
function taskOf(
  overrides: { [K in keyof TaskView]?: unknown } & { readonly taskId: string },
): TaskView {
  return {
    projectId: PROJECT_1,
    title: "Zadanie",
    state: "todo",
    stateLabel: TASK_STATE_LABELS.todo,
    waitingReason: null,
    executorContactId: null,
    executorName: null,
    coordinatorMembershipId: null,
    effectiveCoordinatorMembershipId: null,
    deadline: null,
    dueness: { kind: "no_deadline" },
    linkedEventId: null,
    parentTaskId: null,
    revisionCounter: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    stateChangedAtMs: 1,
    checklist: [],
    checklistProgress: { checked: 0, total: 0 },
    ...(overrides as Partial<TaskView>),
  } as TaskView;
}

/** A minimal event view fixture (the same plain-string override rule). */
function eventOf(
  overrides: { [K in keyof EventView]?: unknown } & { readonly eventId: string },
): EventView {
  return {
    projectId: PROJECT_1,
    title: "Zdarzenie",
    state: "planned",
    stateLabel: EVENT_STATE_LABELS.planned,
    time: null,
    timing: { kind: "planned_upcoming" } as EventView["timing"],
    revisionCounter: 1,
    createdAtMs: 1,
    updatedAtMs: 1,
    ...(overrides as Partial<EventView>),
  } as EventView;
}

const catalog = {
  active: [
    {
      projectId: PROJECT_1,
      displayName: "Banan",
      stage: "in_progress",
      stageRevision: 1,
      paused: null,
      clientId: null,
      clientName: null,
      closedAtMs: null,
      createdAtMs: 1,
      activeCodename: null,
      aliases: [],
      sourceLinkCount: 0,
    },
  ],
  closed: [
    {
      projectId: PROJECT_CLOSED,
      displayName: "Kaczmarek",
      stage: "completed",
      stageRevision: 2,
      paused: null,
      clientId: null,
      clientName: null,
      closedAtMs: 123,
      createdAtMs: 1,
      activeCodename: null,
      aliases: [],
      sourceLinkCount: 0,
    },
  ],
  contacts: [],
  roles: [],
} as unknown as ProjectsOverview;

// ---------------------------------------------------------------------------
// The mount/composition seam
// ---------------------------------------------------------------------------

describe("the H2 host mounts", () => {
  it("mounts work records at /praca with C4's operation set", () => {
    const entry = appFeatures.find((candidate) => candidate.featureId === "work.records");
    expect(entry).toBeDefined();
    expect(entry?.routePath).toBe("/praca");
    expect(entry?.navLabel).toBe("Praca");
    expect(entry?.implementation).toBe("mounted");
    expect(entry?.consumedOperations).toEqual([
      "work.changeTask",
      "work.changeTaskState",
      "work.changeChecklistItem",
      "work.promoteChecklistItem",
      "work.changeEvent",
      "work.changeEventState",
    ]);
  });

  it("mounts typed extensions at /dodatkowe consuming C3's operation set", () => {
    const entry = appFeatures.find((candidate) => candidate.featureId === "memory.extensions");
    expect(entry).toBeDefined();
    expect(entry?.routePath).toBe("/dodatkowe");
    expect(entry?.navLabel).toBe("Dodatkowe informacje");
    expect(entry?.implementation).toBe("mounted");
    for (const operation of entry?.consumedOperations ?? []) {
      expect(operation in operations).toBe(true);
    }
  });

  it("flips /co-teraz to the real per-user screen with the F4 snooze command", () => {
    const entry = appFeatures.find((candidate) => candidate.featureId === "attention.now");
    expect(entry).toBeDefined();
    expect(entry?.routePath).toBe("/co-teraz");
    expect(entry?.implementation).toBe("mounted");
    expect(entry?.consumedOperations).toContain("attention.snoozeTaskReminders");
    expect(entry?.consumedOperations).toContain("work.changeTaskState");
    expect(entry?.consumedOperations).toContain("memory.resolveClarification");
  });

  it("keeps every consumed operation declared in the contracts registry", () => {
    for (const entry of appFeatures) {
      for (const operation of entry.consumedOperations) {
        expect(operation in operations).toBe(true);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Deep-link parity with G4's calendar copies
// ---------------------------------------------------------------------------

describe("the /co-teraz deep-link contract", () => {
  it("uses exactly the param keys subjectLinkPath builds", () => {
    // The parity pin: G4's copy link is /co-teraz?zadanie=<id> for tasks and
    // /co-teraz?zdarzenie=<id> for events. The screen that owns the route
    // must read those exact keys, or a notification click lands blind.
    const taskLink = subjectLinkPath({
      kind: "task",
      taskId: TASK_1,
      projectId: PROJECT_1,
      title: "Zadanie",
      state: "todo",
      coordinatorMembershipId: null,
      deadline: null,
    });
    const eventLink = subjectLinkPath({
      kind: "event",
      eventId: EVENT_1,
      projectId: PROJECT_1,
      title: "Zdarzenie",
      state: "planned",
      time: null,
    });
    expect(taskLink).toBe(`/co-teraz?${TASK_PARAM}=${TASK_1}`);
    expect(eventLink).toBe(`/co-teraz?${EVENT_PARAM}=${EVENT_1}`);
    expect(TASK_PARAM).toBe("zadanie");
    expect(EVENT_PARAM).toBe("zdarzenie");
  });

  it("links Co teraz rows to the authoritative /praca records with the same keys", () => {
    expect(taskRecordLink(TASK_1)).toBe(`/praca?${TASK_PARAM}=${TASK_1}`);
    expect(eventRecordLink(EVENT_1)).toBe(`/praca?${EVENT_PARAM}=${EVENT_1}`);
  });
});

// ---------------------------------------------------------------------------
// The per-user grouping rules
// ---------------------------------------------------------------------------

describe("Co teraz grouping", () => {
  const tasks = [
    taskOf({ taskId: TASK_1, title: "Moje", effectiveCoordinatorMembershipId: ME, coordinatorMembershipId: ME }),
    taskOf({ taskId: TASK_2, title: "Wspolna" }),
    taskOf({ taskId: TASK_3, title: "Cudze", effectiveCoordinatorMembershipId: OTHER, coordinatorMembershipId: OTHER }),
    taskOf({ taskId: TASK_4, title: "Zamkniete", projectId: PROJECT_CLOSED }),
    taskOf({ taskId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2x", title: "Wykonane", state: "done", stateLabel: "Wykonane" }),
    taskOf({ taskId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2y", title: "Anulowane", state: "cancelled", stateLabel: "Anulowane" }),
  ];
  const projects = projectJoinOf(catalog);

  it("splits open work into mine, the shared queue and others'", () => {
    expect(myOpenTasks(tasks, ME).map((task) => task.taskId)).toEqual([TASK_1]);
    expect(unassignedOpenTasks(tasks).map((task) => task.taskId)).toEqual([TASK_2, TASK_4]);
    expect(othersOpenTasks(tasks, ME).map((task) => task.taskId)).toEqual([TASK_3]);
  });

  it("keeps closed-project obligations in the actionable queue", () => {
    expect(closedProjectObligations(tasks, projects).map((task) => task.taskId)).toEqual([TASK_4]);
    // The join marks the closure so the copy can say why it is still here.
    expect(projects.get(PROJECT_CLOSED)).toEqual({ name: "Kaczmarek", closed: true });
    expect(projects.get(PROJECT_1)?.closed).toBe(false);
  });

  it("never treats Wykonane/Anulowane as actionable", () => {
    const open = [...myOpenTasks(tasks, ME), ...unassignedOpenTasks(tasks), ...othersOpenTasks(tasks, ME)];
    expect(open.map((task) => task.state)).not.toContain("done");
    expect(open.map((task) => task.state)).not.toContain("cancelled");
  });

  it("awaits confirmation only for planned events whose term elapsed", () => {
    const events = [
      eventOf({ eventId: EVENT_1, timing: { kind: "planned_elapsed_unconfirmed" } }),
      eventOf({ eventId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f", timing: { kind: "planned_upcoming" } }),
      eventOf({
        eventId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2g",
        state: "occurred",
        timing: { kind: "occurred" },
      }),
    ];
    expect(eventsAwaitingConfirmation(events).map((event) => event.eventId)).toEqual([EVENT_1]);
  });
});

// ---------------------------------------------------------------------------
// Vocabulary single-sourcing and honest copy
// ---------------------------------------------------------------------------

describe("vocabulary and copy", () => {
  it("renders the domain task/event/checklist vocabularies, one source", () => {
    expect(taskStateLabels).toEqual(TASK_STATE_LABELS);
    expect(eventStateLabels).toEqual(EVENT_STATE_LABELS);
    expect(checklistItemStateLabels).toEqual(CHECKLIST_ITEM_STATE_LABELS);
    // The exact CONTEXT.md terms.
    expect(TASK_STATE_LABELS.waiting).toBe("Czeka");
    expect(EVENT_STATE_LABELS.occurred).toBe("Odbyło się");
  });

  it("carries the independence and explicit-decision copy", () => {
    expect(workCopy.tasksNote).toContain("nie kończy");
    expect(workCopy.checklistIntro).toContain("nie zmienia stanu zadania");
    expect(nowCopy.mineIntro).toContain("jednoznaczna decyzja");
  });

  it("carries the elapsed-dates-prove-nothing copy on both surfaces", () => {
    expect(workCopy.eventsNote).toContain("Minięcie daty nie potwierdza");
    expect(nowCopy.eventsIntro).toContain("Upływ daty niczego nie potwierdza");
  });

  it("keeps closed-project obligations visible with their own copy", () => {
    expect(nowCopy.closedIntro).toContain("Zamknięcie projektu");
    expect(nowCopy.closedIntro).toContain("nadal przypominają");
  });

  it("scopes the snooze copy to one boss and one task", () => {
    // The scope note renders inside the snooze control itself (where the
    // decision happens), not on a section the screen does not have.
    expect(nowCopy.snoozeScopeNote).toContain("nie zmienia terminu zadania");
    expect(nowCopy.snoozeScopeNote).toContain("przypomnień innych szefów");
  });

  it("renders the value vocabularies from the findings domain's one label module", () => {
    // Single-sourcing (finding 5): the work surface renders the SAME maps
    // the extension value editor and the memory surface import.
    expect(taxBasisLabel("not_specified")).toBe(TAX_BASIS_LABELS.not_specified);
    expect(taxBasisLabel("net")).toBe(TAX_BASIS_LABELS.net);
    const temporal = {
      shape: { _tag: "day", day: "2026-09-11" },
      originalExpression: "koniec tygodnia",
      role: "actual",
    } as Parameters<typeof temporalValueLabel>[0];
    expect(temporalValueLabel(temporal)).toContain(TEMPORAL_ROLE_LABELS.actual);
  });

  it("renders unknown money tax basis without guessing", () => {
    expect(taxBasisLabel("not_specified")).toBe("podatek nieokreślony");
  });

  it("renders a bound term the memory does not know as unknown, never as a date", () => {
    expect(boundTermLabel({ knowledgeState: { _tag: "unknown", reason: "finding_revision_missing" }, temporal: null }))
      .toBe("termin nieznany");
    expect(boundTermLabel({ knowledgeState: { _tag: "conflicted" }, temporal: null }))
      .toContain("sporny");
  });

  it("derives stable field ids from Polish labels (diacritics folded)", () => {
    expect(deriveFieldId("Grubość płytki")).toBe("grubosc_plytki");
    expect(deriveFieldId("Numer telefonu do klienta!")).toBe("numer_telefonu_do_klienta");
    expect(deriveFieldId("8 mm")).toBe(""); // a digit start is not a valid id
  });
});

// ---------------------------------------------------------------------------
// The extension value builders (client half of invalid value handling)
// ---------------------------------------------------------------------------

const quantityField: FieldShape = { fieldId: "grubosc", label: "Grubość", kind: "quantity", unit: "mm" };

function slotsOf(patch: Partial<FieldInputSlots>): FieldInputSlots {
  return { ...emptySlots(), ...patch };
}

describe("extension value builders", () => {
  it("builds a single-field scalar value that decodes through the contract", () => {
    const built = buildExtensionValue([quantityField], [quantityField], {
      grubosc: slotsOf({ amount: "8.5" }),
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.value).toEqual({ _tag: "quantity", amount: "8.5", unit: "mm" });
    }
  });

  it("builds an object value for a multi-field version with the v1 baseline required", () => {
    const v1: FieldShape[] = [quantityField];
    const v2: FieldShape[] = [
      quantityField,
      { fieldId: "uwagi", label: "Uwagi", kind: "text" },
    ];
    // The required v1 field missing refuses; the optional later field may stay untouched.
    const refused = buildExtensionValue(v2, v1, { uwagi: slotsOf({ text: "kruszywo" }) });
    expect(refused).toEqual({ ok: false, code: "value_field_missing" });
    const built = buildExtensionValue(v2, v1, {
      grubosc: slotsOf({ amount: "8" }),
      uwagi: slotsOf({ text: "kruszywo" }),
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.value).toEqual({
        _tag: "object",
        fields: [
          { fieldId: "grubosc", value: { _tag: "quantity", amount: "8", unit: "mm" } },
          { fieldId: "uwagi", value: { _tag: "text", text: "kruszywo" } },
        ],
      });
    }
  });

  it("builds a list value for a single list field", () => {
    const field: FieldShape = { fieldId: "punkty", label: "Punkty", kind: "list", itemKind: "text" };
    const built = buildExtensionValue([field], [field], {
      punkty: slotsOf({ lines: "pierwszy\n\n  drugi  " }),
    });
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.value).toEqual({
        _tag: "list",
        items: [
          { _tag: "text", text: "pierwszy" },
          { _tag: "text", text: "drugi" },
        ],
      });
    }
  });

  it("refuses malformed amounts, days and units with typed codes", () => {
    expect(parseScalarValue("quantity", slotsOf({ amount: "osiem" }), { unit: "mm" })).toEqual({
      ok: false,
      code: "input_amount_invalid",
    });
    expect(parseScalarValue("quantity", slotsOf({ amount: "8" }), {})).toEqual({
      ok: false,
      code: "value_unit_required",
    });
    expect(
      parseScalarValue("temporal", slotsOf({ temporalShape: "day", temporalValue: "jutro", originalExpression: "jutro" })),
    ).toEqual({ ok: false, code: "input_day_invalid" });
    expect(parseScalarValue("text", slotsOf({}))).toEqual({ ok: false, code: "input_required" });
  });

  it("discriminates the temporal parse failures per shape (typed codes, live hints)", () => {
    // A bad month, year or exact datetime names ITS format, not the day's
    // (the input_month_invalid / input_year_invalid hints stop being dead).
    expect(
      parseScalarValue("temporal", slotsOf({ temporalShape: "month", temporalValue: "wrzesien", originalExpression: "wrzesien" })),
    ).toEqual({ ok: false, code: "input_month_invalid" });
    expect(
      parseScalarValue("temporal", slotsOf({ temporalShape: "year", temporalValue: "26", originalExpression: "26" })),
    ).toEqual({ ok: false, code: "input_year_invalid" });
    expect(
      parseScalarValue("temporal", slotsOf({ temporalShape: "exact", temporalExact: "jutro", originalExpression: "jutro" })),
    ).toEqual({ ok: false, code: "input_exact_invalid" });
    for (const code of ["input_day_invalid", "input_month_invalid", "input_year_invalid", "input_exact_invalid"]) {
      expect(extensionsFailureHint(code, `server ${code}`)).not.toBe(`server ${code}`);
    }
  });

  it("builds a financial value whose tax basis stays explicitly visible", () => {
    const built = parseScalarValue("financial", slotsOf({ amount: "1250.50", taxBasis: "not_specified" }));
    expect(built.ok).toBe(true);
    if (built.ok) {
      expect(built.value).toEqual({
        _tag: "financial",
        money: {
          role: "agreed_price",
          amount: { _tag: "exact", value: "1250.50" },
          currency: "PLN",
          currencyOrigin: "company_default",
          taxBasis: "not_specified",
          certainty: "exact",
        },
      });
    }
  });

  it("parses definition drafts, refusing bad option lines and unitless quantities", () => {
    const ok = draftsToFields([
      { label: "Grubość", fieldId: "grubosc", kind: "quantity", unit: "mm", itemKind: "text", optionsText: "" },
      {
        label: "Rodzaj",
        fieldId: "rodzaj",
        kind: "enum",
        unit: "",
        itemKind: "text",
        optionsText: "glazura:Glazura\ntarket:Tarket",
      },
    ]);
    expect(ok.ok).toBe(true);
    const noUnit = draftsToFields([
      { label: "Grubość", fieldId: "grubosc", kind: "quantity", unit: " ", itemKind: "text", optionsText: "" },
    ]);
    expect(noUnit).toEqual({ ok: false, code: "quantity_field_without_unit" });
    const badOption = draftsToFields([
      { label: "Rodzaj", fieldId: "rodzaj", kind: "enum", unit: "", itemKind: "text", optionsText: "bez dwukropka" },
    ]);
    expect(badOption).toEqual({ ok: false, code: "input_option_invalid" });
  });

  it("labels every definition field kind in Polish (typed by the contract set)", () => {
    const kinds = ["text", "quantity", "boolean", "enum", "financial", "temporal", "entity_ref", "list"] as const;
    for (const kind of kinds) {
      expect(fieldKindLabels[kind]).toBeTypeOf("string");
    }
    expect(Object.keys(fieldKindLabels).sort()).toEqual([...kinds].sort());
  });
});

// ---------------------------------------------------------------------------
// Snooze input parsing (the company zone's wall time)
// ---------------------------------------------------------------------------

describe("the snooze moment parser", () => {
  it("parses a datetime-local value as the company zone's wall time", () => {
    // Summer (CEST, +02:00) and winter (CET, +01:00): the offset comes from
    // the TARGET DAY in the firm's zone, so the same wall clock maps to the
    // instant the firm means regardless of the test machine's own zone
    // (CONTEXT.md "Strefa czasu firmy": reminder times do not follow the
    // boss's phone).
    expect(snoozeUntilMs("2026-09-11T08:30", "Europe/Warsaw")).toBe(
      Date.parse("2026-09-11T08:30:00.000+02:00"),
    );
    expect(snoozeUntilMs("2026-01-15T08:30", "Europe/Warsaw")).toBe(
      Date.parse("2026-01-15T08:30:00.000+01:00"),
    );
  });

  it("refuses empty, malformed values and an unresolvable company zone", () => {
    expect(snoozeUntilMs("", "Europe/Warsaw")).toBeNull();
    expect(snoozeUntilMs("jutro rano", "Europe/Warsaw")).toBeNull();
    expect(snoozeUntilMs("2026-09-11", "Europe/Warsaw")).toBeNull();
    expect(snoozeUntilMs("2026-09-11T08:30", "Not/AZone")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The shared statement-to-source send (one key per logical statement)
// ---------------------------------------------------------------------------

/** One command the fake server saw: which command, under which key. */
interface RecordedSend {
  readonly kind: "draft" | "accept";
  readonly key: string;
}

/**
 * A fake server with J1's acceptance-key uniqueness: one idempotency key
 * resolves to ONE source. The FIRST accept under a fresh key is recorded
 * and then its RESPONSE is lost (the write happened; the boss saw nothing).
 */
function lostResponseServer(): {
  readonly mutations: StatementSourceMutations;
  readonly sources: Map<string, string>;
  readonly recorded: RecordedSend[];
} {
  const sources = new Map<string, string>();
  const recorded: RecordedSend[] = [];
  let next = 0;
  const mutations: StatementSourceMutations = {
    prepareUpload: async (args) => {
      const draftId = (args.envelope.input as { readonly draftId: string }).draftId;
      recorded.push({ kind: "draft", key: draftId });
      return Schema.decodeUnknownSync(ResultEnvelope)({
        _tag: "ok",
        value: { uploadId: `uploads_${draftId}`, stage: "draft" },
      });
    },
    acceptSource: async (args) => {
      const key = args.envelope.idempotencyKey ?? "";
      recorded.push({ kind: "accept", key });
      const existing = sources.get(key);
      if (existing !== undefined) {
        return Schema.decodeUnknownSync(ResultEnvelope)({
          _tag: "ok",
          value: { sourceId: existing, fullyAcceptedAtMs: 1 },
        });
      }
      const sourceId = `sources_${next++}`;
      sources.set(key, sourceId);
      throw new Error("network lost");
    },
  };
  return { mutations, sources, recorded };
}

const STATEMENT = {
  authorText: "Płytki mają 8 mm grubości.",
  timezoneSnapshot: "Europe/Warsaw",
  projectHints: [],
} as const;

describe("the shared statement-to-source send", () => {
  it("converges a lost-response resubmit of the same logical statement on one source", async () => {
    const fake = lostResponseServer();
    const key = freshStatementKey();

    // First attempt: the server accepted the source, the response was lost.
    const lost = await sendStatementAsSource(fake.mutations, key, STATEMENT);
    expect(lost).toMatchObject({ _tag: "lost" });
    // The key discipline keeps the key: only a CONFIRMED acceptance rotates.
    expect(nextStatementKey(key, lost)).toBe(key);

    // The resubmit of the SAME logical statement rides the SAME key, so the
    // server's acceptance-key uniqueness answers with the source that
    // already exists: one statement, one source, never a second one.
    const retry = await sendStatementAsSource(fake.mutations, nextStatementKey(key, lost), STATEMENT);
    expect(retry).toMatchObject({ _tag: "accepted", receipt: { sourceId: "sources_0" } });
    expect(nextStatementKey(key, retry)).not.toBe(key);

    // Every command of BOTH attempts carried the ONE key: the draft id and
    // the acceptance idempotency key are the same value, never two
    // unrelated fresh keys.
    expect(fake.sources.size).toBe(1);
    expect(fake.recorded.map((entry) => entry.key)).toEqual([key, key, key, key]);
  });

  it("reports a refused send without consuming the statement's key", async () => {
    const refused = Schema.decodeUnknownSync(ResultEnvelope)({
      _tag: "error",
      error: { _tag: "unauthenticated", code: "session_inactive", message: "sesja wygasła" },
    });
    const mutations: StatementSourceMutations = {
      prepareUpload: async () => refused,
      acceptSource: async () => refused,
    };
    const key = freshStatementKey();
    const outcome = await sendStatementAsSource(mutations, key, STATEMENT);
    expect(outcome).toMatchObject({ _tag: "refused", code: "session_inactive" });
    expect(nextStatementKey(key, outcome)).toBe(key);
  });

  it("mints keys in the command envelope's certified idem shape", () => {
    expect(freshStatementKey()).toMatch(/^idem_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    expect(freshStatementKey()).not.toBe(freshStatementKey());
  });
});

// ---------------------------------------------------------------------------
// The shared notice area (one definition, alert on error, status on ok)
// ---------------------------------------------------------------------------

describe("the shared dispatch notice area", () => {
  it("renders an alert for errors and a status for confirmations", () => {
    const error = renderToString(
      createElement(NoticeArea, { notice: { kind: "error", text: "Nie udało się." } }),
    );
    expect(error).toContain('role="alert"');
    expect(error).toContain("Nie udało się.");
    const ok = renderToString(
      createElement(NoticeArea, { notice: { kind: "ok", text: "Zapisano." } }),
    );
    expect(ok).toContain('role="status"');
    expect(renderToString(createElement(NoticeArea, { notice: null }))).toBe("");
  });
});

// ---------------------------------------------------------------------------
// Failure-copy coverage (the deterministic half of the failure list)
// ---------------------------------------------------------------------------

describe("failure hints for the load-bearing refusal codes", () => {
  it("explains stale revisions, revoked coordinators and extension refusals in Polish", () => {
    // The refusal behaviors are proven live (the live proof's failure
    // scenarios); these pin the Polish explanation the surfaces render.
    const hints: Record<string, string> = {
      revision_mismatch: "zmieniło się w międzyczasie",
      coordinator_membership_not_active: "Tylko aktywny szef firmy",
      deadline_role_actual: "Data faktycznego wykonania",
      item_promoted: "przekształcony w zadanie",
    };
    for (const [code, fragment] of Object.entries(hints)) {
      expect(workFailureHint(code, `server ${code}`)).toContain(fragment);
    }
    // Unknown codes fall back to the server message (no invented hints).
    expect(workFailureHint("some_new_code", "server some_new_code")).toBe("server some_new_code");
    const extensionHints: Record<string, string> = {
      version_not_found: "Nie ma takiej wersji definicji.",
      value_kind_mismatch: "nie pasuje",
      entity_reference_not_in_company: "poza firmę",
    };
    for (const [code, fragment] of Object.entries(extensionHints)) {
      expect(extensionsFailureHint(code, `server ${code}`)).toContain(fragment);
    }
  });

  it("decodes the work operations' input schemas the surfaces send", () => {
    // The exact input shapes the /praca and /co-teraz forms send decode
    // through the contract entries: the client never invents a field.
    const changeTask = operations["work.changeTask"]!;
    const input = Schema.decodeUnknownSync(changeTask.input)({
      taskId: null,
      projectId: PROJECT_1,
      title: "Odebrać dostawę",
      executorContactId: null,
      coordinatorMembershipId: ME,
      deadlineFindingId: null,
      expectedRevision: 1,
    });
    expect((input as { title: string }).title).toBe("Odebrać dostawę");
    const snooze = operations["attention.snoozeTaskReminders"]!;
    const snoozeInput = Schema.decodeUnknownSync(snooze.input)({
      taskId: TASK_1,
      untilMs: 1_752_000_000_000,
    });
    expect((snoozeInput as { untilMs: number }).untilMs).toBe(1_752_000_000_000);
  });
});

// ---------------------------------------------------------------------------
// Presentational row rendering (consumed by the a11y smoke file)
// ---------------------------------------------------------------------------

describe("record rows render the derived facts honestly", () => {
  it("shows the revoked coordinator as expired, never as assigned", () => {
    const task = taskOf({
      taskId: TASK_1,
      coordinatorMembershipId: OTHER,
      effectiveCoordinatorMembershipId: null,
    });
    const html = renderToString(createElement(TaskRow, { task, project: null, focused: false }));
    expect(html).toContain("koordynator wygasł");
  });

  it("marks the closed project on its rows and overdue work", () => {
    const task = taskOf({
      taskId: TASK_4,
      projectId: PROJECT_CLOSED,
      dueness: { kind: "overdue" },
    });
    const projects = projectJoinOf(catalog);
    const html = renderToString(
      createElement(TaskRow, { task, project: projects.get(PROJECT_CLOSED) ?? null, focused: false }),
    );
    expect(html).toContain("zamknięty");
    expect(html).toContain("po terminie");
  });

  it("renders the elapsed-unconfirmed event as still planned", () => {
    const event = eventOf({ eventId: EVENT_1, timing: { kind: "planned_elapsed_unconfirmed" } });
    const html = renderToString(createElement(EventRow, { event, project: null, focused: false }));
    expect(html).toContain("Planowane");
    expect(html).toContain("termin minął bez potwierdzenia");
  });
});
