/**
 * Deterministic Calendar projection rules (G2, pure): which task deadlines
 * and event times deserve a copy in one boss's "Kalendarz Kiero w Google",
 * and what that copy's managed content is.
 *
 * Rules encoded here (issue #46; issue #14 resolution; CONTEXT.md
 * "Kalendarz Kiero w Google" / "Kopia kalendarzowa" / "Znacznik terminu"):
 *
 * - Projection is PERSONAL: planned company events plus OPEN tasks (Do
 *   zrobienia, W toku, Czeka) coordinated by that boss or unassigned,
 *   filtered by that boss's selected projects (default: all, closed ones
 *   with retained obligations included). A checklist point never projects
 *   ("Punkty checklisty nie mają osobnych kopii"); a task and its linked
 *   event keep SEPARATE copies ("nie są sklejane na podstawie daty").
 * - Dates come from the bound finding's CURRENT revision — never a copy.
 *   Internal plans and agreed terms project; proposals, approximations
 *   (month/year precision, range bounds without a day) and unresolved
 *   values (unknown/conflicted) never do.
 * - Mapping: a concrete date is an all-day entry; a known start AND end is
 *   a real interval; a lone time without a duration is a FIVE-MINUTE
 *   marker whose title/description says it is a time marker — the five
 *   minutes is Google presentation, never a work-duration fact.
 * - Elapsed time alone withdraws nothing; completion/cancellation (or an
 *   unresolved/removed term) does. Past unresolved obligations and past
 *   planned-unconfirmed events stay on their own dates.
 * - Copy content is Polish, short, and free of private source material:
 *   title, project, state/meaning, the term in company time and an
 *   authenticated Kiero link. Conversations, media and financial notes
 *   never enter a payload (the builder only ever sees work titles and
 *   project names).
 *
 * No I/O, no Convex, no clock: every function is total over small views.
 */

import type { EventOccurrenceState, TaskState } from "@kiero/contracts";
import type { KnowledgeStateWire, TemporalValueWire } from "../work/dueness";
import { localDateOfInstant } from "../findings/temporal";
import type { DesiredCopy } from "./diff";
import { isOpenTaskState } from "../work/taskState";

// ---------------------------------------------------------------------------
// Subject views (what one projection pass loads per candidate).
// ---------------------------------------------------------------------------

/** The bound term's current knowledge state and (temporal) value, if any. */
export interface TermBindingView {
  readonly knowledgeState: KnowledgeStateWire;
  /** Null when the current value is not temporal (the binding went stale). */
  readonly temporal: TemporalValueWire | null;
  /** The CURRENT revision the value was read from (the derivation basis). */
  readonly revisionId: string;
}

/** A task as the projection sees it (never a row copy of a date). */
export interface TaskSubjectView {
  readonly kind: "task";
  readonly taskId: string;
  readonly projectId: string;
  readonly title: string;
  readonly state: TaskState;
  /** Saved obstacle; present only while the state is Czeka. */
  readonly waitingReason?: string;
  /** The boss member responsible for the task, or null when unassigned. */
  readonly coordinatorMembershipId: string | null;
  /** Null when the task has no deadline binding. */
  readonly deadline: TermBindingView | null;
}

/** An event as the projection sees it (never a row copy of a date). */
export interface EventSubjectView {
  readonly kind: "event";
  readonly eventId: string;
  readonly projectId: string;
  readonly title: string;
  readonly state: EventOccurrenceState;
  /** Null when the event has no time binding. */
  readonly time: TermBindingView | null;
}

/** Either subject kind. */
export type WorkSubjectView = TaskSubjectView | EventSubjectView;

/** The boss's personal selection of projects (default: every project). */
export type ProjectSelection =
  | { readonly mode: "all_projects" }
  | { readonly mode: "explicit"; readonly projectIds: ReadonlySet<string> };

/** The personal scope one projection pass projects for. */
export interface PersonalScope {
  readonly projectSelection: ProjectSelection;
  /** The boss's own memberships in the firm (coordinated-by-me test). */
  readonly ownMembershipIds: ReadonlySet<string>;
}

/** Whether one project id is inside the boss's selection. */
export function projectSelected(selection: ProjectSelection, projectId: string): boolean {
  return selection.mode === "all_projects" || selection.projectIds.has(projectId);
}

// ---------------------------------------------------------------------------
// Subject eligibility (personal scope; issue #14: "Połączenie i zakres
// osobisty").
// ---------------------------------------------------------------------------

/**
 * Why a subject is out of one boss's personal scope. The runtime list owns
 * the vocabulary (the schema fragment's validator and the transaction's
 * writer are typed against the derived union, so drift fails typecheck).
 */
export const SUBJECT_EXCLUSIONS = ["subject_closed", "out_of_personal_scope"] as const;
export type SubjectExclusion = (typeof SUBJECT_EXCLUSIONS)[number];

/**
 * The personal eligibility decision for one subject. Tasks are personal
 * (mine or unassigned); planned events are company-wide — both stay inside
 * the selected projects. Elapsed time and project closure alone never
 * exclude (closed projects keep retained obligations).
 */
export type SubjectEligibility =
  | { readonly eligible: true }
  | { readonly eligible: false; readonly reason: SubjectExclusion };

export function decideSubjectEligibility(
  subject: WorkSubjectView,
  scope: PersonalScope,
): SubjectEligibility {
  if (!projectSelected(scope.projectSelection, subject.projectId)) {
    return { eligible: false, reason: "out_of_personal_scope" };
  }
  switch (subject.kind) {
    case "task": {
      if (!isOpenTaskState(subject.state)) {
        return { eligible: false, reason: "subject_closed" };
      }
      const coordinated =
        subject.coordinatorMembershipId === null ||
        scope.ownMembershipIds.has(subject.coordinatorMembershipId);
      return coordinated
        ? { eligible: true }
        : { eligible: false, reason: "out_of_personal_scope" };
    }
    case "event": {
      if (subject.state !== "planned") {
        return { eligible: false, reason: "subject_closed" };
      }
      return { eligible: true };
    }
  }
}

// ---------------------------------------------------------------------------
// Term qualification (what kind of copy the CURRENT term deserves).
// ---------------------------------------------------------------------------

/** A term that maps to Google content. */
export type QualifiedTerm =
  | { readonly _tag: "all_day"; readonly day: string }
  | { readonly _tag: "all_day_range"; readonly startDay: string; readonly endDay: string }
  | { readonly _tag: "marker"; readonly epochMs: number };

/**
 * Why the current term does not earn (or no longer earns) a copy. One
 * runtime list (same ownership rule as SUBJECT_EXCLUSIONS); a withdrawn
 * copy names its reason from exactly this vocabulary.
 */
export const TERM_WITHDRAW_REASONS = [
  "no_binding",
  "term_unresolved",
  "term_not_temporal",
  "term_proposed",
  "term_actual",
  "term_approximate",
  "term_open_ended",
  "term_invalid",
] as const;
export type TermWithdrawReason = (typeof TERM_WITHDRAW_REASONS)[number];

/** The full machine vocabulary a withdrawn copy can record. */
export type WithdrawReason = SubjectExclusion | TermWithdrawReason;

/** The runtime list behind `WithdrawReason` (order: subject, then term). */
export const WITHDRAW_REASONS: readonly WithdrawReason[] = [
  ...SUBJECT_EXCLUSIONS,
  ...TERM_WITHDRAW_REASONS,
];

/**
 * The term decision over one binding's CURRENT revision. Proposals,
 * approximations and unresolved values are excluded by name so a withdrawn
 * copy can explain itself; the day/range/marker mapping follows CONTEXT.md
 * "Znacznik terminu".
 */
export type TermDecision =
  | { readonly ok: true; readonly term: QualifiedTerm; readonly binding: TermBindingView }
  | { readonly ok: false; readonly reason: TermWithdrawReason };

export function decideTerm(binding: TermBindingView | null): TermDecision {
  if (binding === null) {
    return { ok: false, reason: "no_binding" };
  }
  if (binding.knowledgeState._tag !== "known") {
    return { ok: false, reason: "term_unresolved" };
  }
  if (binding.temporal === null) {
    return { ok: false, reason: "term_not_temporal" };
  }
  switch (binding.temporal.role) {
    case "proposed":
      return { ok: false, reason: "term_proposed" };
    case "actual":
      return { ok: false, reason: "term_actual" };
    case "internal":
    case "agreed":
      break;
  }
  const shape = binding.temporal.shape;
  switch (shape._tag) {
    case "day":
      return { ok: true, term: { _tag: "all_day", day: shape.day }, binding };
    case "month":
    case "year":
      return { ok: false, reason: "term_approximate" };
    case "range": {
      if (shape.start === null || shape.end === null) {
        return { ok: false, reason: "term_open_ended" };
      }
      if (shape.start._tag !== "day" || shape.end._tag !== "day") {
        return { ok: false, reason: "term_approximate" };
      }
      return {
        ok: true,
        term: { _tag: "all_day_range", startDay: shape.start.day, endDay: shape.end.day },
        binding,
      };
    }
    case "date_time": {
      // The bracketed IANA zone is presentation; the instant comes from the
      // ISO offset exactly as stored (no re-interpretation of "jutro").
      const iso = shape.value.replace(/\[[^\]]*\]$/, "");
      const epochMs = Date.parse(iso);
      if (Number.isNaN(epochMs)) {
        return { ok: false, reason: "term_invalid" };
      }
      return { ok: true, term: { _tag: "marker", epochMs }, binding };
    }
  }
}

/** The derivation basis the term decision was made against. */
export function termRevisionId(binding: TermBindingView | null): string | null {
  return binding === null ? null : binding.revisionId;
}

// ---------------------------------------------------------------------------
// Polish copy text (managed fields Kiero owns; issue #14 "Zawartość i
// ustawienia kopii").
// ---------------------------------------------------------------------------

/** Meaning of a term's role, in the firm's language. */
export function roleLabel(role: "internal" | "agreed"): string {
  return role === "agreed" ? "termin uzgodniony" : "plan wewnętrzny";
}

/** Task state labels (CONTEXT.md "Stan zadania"). */
export function taskStateLabel(state: TaskState, waitingReason?: string): string {
  switch (state) {
    case "todo":
      return "Do zrobienia";
    case "in_progress":
      return "W toku";
    case "waiting":
      return waitingReason === undefined
        ? "Czeka"
        : `Czeka (${waitingReason})`;
    case "done":
      return "Wykonane";
    case "cancelled":
      return "Anulowane";
  }
}

/** Event state labels (CONTEXT.md "Stan zdarzenia"). */
export function eventStateLabel(state: EventOccurrenceState): string {
  switch (state) {
    case "planned":
      return "Planowane";
    case "occurred":
      return "Odbyło się";
    case "cancelled":
      return "Anulowane";
  }
}

/** `DD.MM.YYYY` of one instant in one IANA zone (the company-time form). */
export function companyDate(epochMs: number, timeZone: string): string {
  const day = localDateOfInstant(epochMs, timeZone);
  const [y, m, d] = day.split("-");
  return `${d}.${m}.${y}`;
}

/** `DD.MM` of one instant in one IANA zone. */
export function companyDayMonth(epochMs: number, timeZone: string): string {
  const day = localDateOfInstant(epochMs, timeZone);
  const [, m, d] = day.split("-");
  return `${d}.${m}`;
}

/** `HH:mm` of one instant in one IANA zone (DST rules included). */
export function companyTime(epochMs: number, timeZone: string): string {
  return new Intl.DateTimeFormat("pl-PL", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(epochMs));
}

/** The exclusive end date of one all-day entry (the next calendar day). */
function addOneDay(day: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (match === null) {
    throw new Error(`addOneDay: not a calendar day: ${day}`);
  }
  // UTC-noon arithmetic cannot cross a DST boundary into another date.
  const next = new Date(
    Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]) + 1, 12),
  );
  return next.toISOString().slice(0, 10);
}

/**
 * The marker length: FIVE minutes of Google presentation for a time
 * without a known duration ("Znacznik terminu", CONTEXT.md). Exported for
 * tests and for the description note; it is NEVER a work-duration fact.
 */
export const MARKER_DURATION_MS = 5 * 60 * 1000;

/** The canonical DD.MM of a `YYYY-MM-DD` calendar day. */
function dayLabel(day: string): string {
  const [, m, d] = day.split("-");
  return `${d}.${m}`;
}

/** The barebones deep-link path of one subject (authenticated app route). */
export function subjectLinkPath(subject: WorkSubjectView): string {
  return subject.kind === "task"
    ? `/co-teraz?zadanie=${encodeURIComponent(subject.taskId)}`
    : `/co-teraz?zdarzenie=${encodeURIComponent(subject.eventId)}`;
}

/** Context the copy text needs beyond the subject itself. */
export interface CopyContext {
  readonly projectName: string;
  /** The firm's IANA zone ("Strefa czasu firmy"); copy text renders in it. */
  readonly companyTimezone: string;
  /** Absolute base URL of the Kiero app (the authenticated link target). */
  readonly appBaseUrl: string;
}

/** The managed Google-event payload one desired copy carries. */
export interface DesiredGoogleEvent {
  readonly summary: string;
  readonly description: string;
  readonly start: { readonly date?: string | undefined; readonly dateTime?: string | undefined };
  readonly end: { readonly date?: string | undefined; readonly dateTime?: string | undefined };
  /** Wolny czas: the company plan never blocks availability by default. */
  readonly transparency: "transparent";
  /**
   * New copies start without Google event reminders (Kiero's own reminder
   * system owns them); a managed UPDATE never re-sends this field, so
   * personally added reminders survive (G3's reconciliation contract).
   * The list is ALWAYS empty by construction (both construction sites below
   * pass the literal `[]`); typed `string[]` so the schema validator and
   * this interface pin against each other exactly.
   */
  readonly reminders: { readonly useDefault: false; readonly overrides: string[] };
}

/** The ISO instant form Google consumes (offset, no bracketed zone). */
function googleDateTime(epochMs: number): string {
  return new Date(epochMs).toISOString();
}

/**
 * Builds the copy title. Short and Polish; a marker adds the hour labeled
 * as company time ("godzina umieszczona w tytule również jest oznaczona
 * jako czas firmy").
 */
export function copyTitle(
  subject: WorkSubjectView,
  term: QualifiedTerm,
  context: CopyContext,
): string {
  const base =
    subject.kind === "task" ? `Zadanie: ${subject.title}` : `Zdarzenie: ${subject.title}`;
  if (term._tag === "marker") {
    const time = companyTime(term.epochMs, context.companyTimezone);
    return `${base} — godz. ${time} (czas firmy)`;
  }
  return base;
}

/** Builds the copy description (project, state, meaning, term, link). */
export function copyDescription(
  subject: WorkSubjectView,
  binding: TermBindingView,
  term: QualifiedTerm,
  context: CopyContext,
): string {
  const role =
    binding.temporal !== null && (binding.temporal.role === "internal" || binding.temporal.role === "agreed")
      ? roleLabel(binding.temporal.role)
      : "termin";
  const stateLine =
    subject.kind === "task"
      ? `Stan: ${taskStateLabel(subject.state, subject.waitingReason)}`
      : `Stan: ${eventStateLabel(subject.state)}`;
  let termLine: string;
  let markerNote = "";
  switch (term._tag) {
    case "all_day":
      termLine = `Termin: ${dayLabel(term.day)} (cały dzień)`;
      break;
    case "all_day_range":
      termLine = `Termin: ${dayLabel(term.startDay)} – ${dayLabel(term.endDay)} (całe dni)`;
      break;
    case "marker": {
      const date = companyDate(term.epochMs, context.companyTimezone);
      const time = companyTime(term.epochMs, context.companyTimezone);
      termLine = `Termin: ${date}, godz. ${time} (czas firmy)`;
      markerNote =
        "Godzina bez znanego czasu trwania: pięciominutowy znacznik terminu w Google, nie ustalenie czasu pracy.";
      break;
    }
  }
  const link = `${context.appBaseUrl.replace(/\/$/, "")}${subjectLinkPath(subject)}`;
  const lines = [
    `Projekt: ${context.projectName}`,
    stateLine,
    `Znaczenie terminu: ${role}`,
    termLine,
    ...(markerNote === "" ? [] : [markerNote]),
    "Wpis jest zarządzany przez Kiero: zmiany wykonane w Google nie zmieniają ustaleń firmy.",
    `Sprawa i jej ustalenia: ${link}`,
  ];
  return lines.join("\n");
}

/** The complete desired payload of one qualifying subject. */
export function desiredEvent(
  subject: WorkSubjectView,
  binding: TermBindingView,
  term: QualifiedTerm,
  context: CopyContext,
): DesiredGoogleEvent {
  const summary = copyTitle(subject, term, context);
  const description = copyDescription(subject, binding, term, context);
  switch (term._tag) {
    case "all_day":
      return {
        summary,
        description,
        start: { date: term.day },
        end: { date: addOneDay(term.day) },
        transparency: "transparent",
        reminders: { useDefault: false, overrides: [] },
      };
    case "all_day_range":
      return {
        summary,
        description,
        start: { date: term.startDay },
        end: { date: addOneDay(term.endDay) },
        transparency: "transparent",
        reminders: { useDefault: false, overrides: [] },
      };
    case "marker":
      return {
        summary,
        description,
        start: { dateTime: googleDateTime(term.epochMs) },
        end: { dateTime: googleDateTime(term.epochMs + MARKER_DURATION_MS) },
        transparency: "transparent",
        reminders: { useDefault: false, overrides: [] },
      };
  }
}

// ---------------------------------------------------------------------------
// Deterministic copy identity (issue #46: one stable projection identity
// per user/company and Google account; task and related event separate).
// ---------------------------------------------------------------------------

/** The identity inputs of one copy. */
export interface CopyIdentity {
  readonly companyId: string;
  readonly userId: string;
  /** Google account of the connection's current binding; null while unbound. */
  readonly googleAccountSubject: string | null;
  readonly subjectKind: "task" | "event";
  readonly subjectId: string;
}

/** The deterministic semantic id of one copy (stable across re-derivation). */
export function copySemanticId(identity: CopyIdentity): string {
  const account = identity.googleAccountSubject ?? "google:unbound";
  return [
    "kiero-copy-v1",
    identity.companyId,
    identity.userId,
    account,
    identity.subjectKind,
    identity.subjectId,
  ].join(":");
}

// ---------------------------------------------------------------------------
// One subject's complete desired copy (eligibility + term + payload +
// identity). The single entry point the Convex pass calls per candidate.
// ---------------------------------------------------------------------------

/** Everything one derivation needs beyond the subject itself. */
export interface DerivationContext extends CopyContext {
  readonly companyId: string;
  readonly userId: string;
  readonly googleAccountSubject: string | null;
}

/**
 * The desired copy of one subject: projected with its managed payload when
 * the subject is inside the boss's personal scope and the CURRENT term
 * qualifies; withdrawn with a machine reason otherwise. The derivation
 * basis is the CURRENT revision of the bound finding — a correction
 * re-derives the whole decision ("korekta ustalenia" changes the desire,
 * never a stored copy of the date).
 */
export function desiredCopyForSubject(
  subject: WorkSubjectView,
  scope: PersonalScope,
  context: DerivationContext,
): DesiredCopy {
  const binding = subject.kind === "task" ? subject.deadline : subject.time;
  const identity: CopyIdentity = {
    companyId: context.companyId,
    userId: context.userId,
    googleAccountSubject: context.googleAccountSubject,
    subjectKind: subject.kind,
    subjectId: subject.kind === "task" ? subject.taskId : subject.eventId,
  };
  const semanticId = copySemanticId(identity);
  const eligibility = decideSubjectEligibility(subject, scope);
  if (!eligibility.eligible) {
    return {
      subjectKind: subject.kind,
      subjectId: identity.subjectId,
      semanticId,
      desired: {
        state: "withdrawn",
        reason: eligibility.reason,
        derivationRevisionId: termRevisionId(binding),
      },
    };
  }
  // The ok-arm carries the NARROWED binding: no null re-check and no cast
  // below, and the payload builder reads the same revision the decision
  // derived from.
  const term = decideTerm(binding);
  if (!term.ok) {
    return {
      subjectKind: subject.kind,
      subjectId: identity.subjectId,
      semanticId,
      desired: {
        state: "withdrawn",
        reason: term.reason,
        derivationRevisionId: termRevisionId(binding),
      },
    };
  }
  return {
    subjectKind: subject.kind,
    subjectId: identity.subjectId,
    semanticId,
    desired: {
      state: "projected",
      payload: desiredEvent(subject, term.binding, term.term, context),
      derivationRevisionId: term.binding.revisionId,
    },
  };
}
