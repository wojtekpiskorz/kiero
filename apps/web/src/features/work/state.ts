/**
 * Work feature state (H2): Polish copy, vocabularies rendered from the
 * single domain source, the wire-value renderers for bound dates, and the
 * closed-error hints for the /praca surface.
 *
 * The task-state, checklist-mark and event-state labels come from the pure
 * domain rules (`packages/domain/work`) through one relative import, and
 * the temporal-role and tax-basis labels from the findings domain's label
 * module (`packages/domain/findings/labels`): the Polish rendering of the
 * fixed vocabulary has exactly one source, shared with the backend lanes
 * and the other surfaces that consume the same modules. Bound deadlines
 * and event times decode through the contract codecs at the boundary and
 * render exactly what is there: exact instants stay exact, date-only terms
 * say which day they end with, and a term the memory does not currently
 * know renders as unknown or disputed, never as a guessed date.
 *
 * Operation results arrive as `ResultEnvelope`s; every closed error maps
 * to the server's Polish message plus hints for the load-bearing machine
 * codes this surface can meet.
 */

import { Schema } from "effect";
import {
  FindingValue,
  KnowledgeState,
  TemporalValue,
  type TaxBasis,
} from "@kiero/contracts";
import {
  TAX_BASIS_LABELS,
  TEMPORAL_ROLE_LABELS,
} from "../../../../../packages/domain/findings/labels";
import {
  CHECKLIST_ITEM_STATE_LABELS,
  EVENT_STATE_LABELS,
  TASK_STATE_LABELS,
  type EventTiming,
  type TaskDueness,
} from "../../../../../packages/domain/work/index";
import { sessionFailureHints } from "../conversation/state";

/** The fixed task-state vocabulary rendered in Polish (one source: the domain rules). */
export const taskStateLabels = TASK_STATE_LABELS;

/** The checklist completion mark rendered in Polish. */
export const checklistItemStateLabels = CHECKLIST_ITEM_STATE_LABELS;

/** The event-state vocabulary rendered in Polish. */
export const eventStateLabels = EVENT_STATE_LABELS;

/** The states a boss may command for a task, in list order. */
export const taskStateOrder = ["todo", "in_progress", "waiting", "done", "cancelled"] as const;

/** The states a boss may command for an event. */
export const eventStateOrder = ["planned", "occurred", "cancelled"] as const;

// ---------------------------------------------------------------------------
// Polish copy (stable product text)
// ---------------------------------------------------------------------------

/** Copy for the /praca surface (tasks, checklists, events). */
export const workCopy = {
  title: "Praca",
  intro:
    "Zadania i zdarzenia projektów firmy. Zmiany przechodzą przez te same sprawdzone operacje, których używa agent; każda zachowuje autora, czas i podstawę.",
  // Task list
  tasksHeading: "Zadania",
  tasksNote:
    "Zakończenie zadania to osobna decyzja: odhaczenie całej checklisty go nie kończy, a zadanie można wykonać przy nieodhaczonych punktach, które zachowują swój stan.",
  noTasks: "Brak zadań. Zapisz pierwsze zadanie poniżej.",
  createNeedsProject: "Aby zapisać zadanie, najpierw utwórz projekt w sekcji Projekty.",
  focusedMark: "wskazane odnośnikiem",
  focusedRecordNotice: (kind: string): string =>
    `Odnośnik wskazuje jedno ${kind} na liście poniżej (wiersz oznaczony jako wskazane odnośnikiem).`,
  waitingReasonLabel: "Przeszkoda",
  executorLabel: (name: string | null): string =>
    name === null ? "wykonawca nieznany" : `wykonawca: ${name}`,
  coordinatorLabel: (assigned: boolean, revoked: boolean): string =>
    revoked
      ? "koordynator wygasł (członkostwo odebrane); zadanie wróciło do wspólnej kolejki"
      : assigned
        ? "koordynator przypisany"
        : "bez koordynatora (wspólna kolejka)",
  checklistProgressLabel: (checked: number, total: number): string =>
    `checklista: ${checked}/${total}`,
  promotedMark: "punkt przekształcony w zadanie",
  linkedEventLabel: "powiązane zdarzenie",
  parentTaskLabel: "wydzielone z zadania",
  revisionLabel: (revision: number): string => `rewizja ${revision}`,
  projectLabel: (name: string, closed: boolean): string =>
    closed ? `projekt: ${name} (zamknięty)` : `projekt: ${name}`,
  deadlineLabel: (label: string): string => `termin: ${label}`,
  duenessLabel: (dueness: TaskDueness): string => {
    switch (dueness.kind) {
      case "closed":
        return "zakończone, bez zaległości";
      case "no_deadline":
        return "bez terminu";
      case "term_unusable":
        return "termin nieznany lub sporny, przypomnienie wstrzymane";
      case "pending":
        return "termin jeszcze nie minął";
      case "overdue":
        return "po terminie";
    }
  },
  // Event list
  eventsHeading: "Zdarzenia",
  eventsNote:
    "Zdarzenie to dostawa, spotkanie lub inny element przebiegu pracy; samo nie przypisuje nikomu działania. Minięcie daty nie potwierdza, że się odbyło.",
  noEvents: "Brak zdarzeń.",
  timeLabel: (label: string): string => `termin: ${label}`,
  timingLabel: (timing: EventTiming): string => {
    switch (timing.kind) {
      case "occurred":
        return "odbyło się";
      case "cancelled":
        return "anulowane";
      case "planned_no_time":
        return "planowane, termin nieznany";
      case "planned_time_unusable":
        return "planowane, termin nieznany lub sporny";
      case "planned_upcoming":
        return "planowane, termin jeszcze nie minął";
      case "planned_elapsed_unconfirmed":
        return "planowane, termin minął bez potwierdzenia";
    }
  },
  // Create/edit task
  createHeading: "Zapisz zadanie",
  createIntro:
    "Zadanie powstaje z przekazanego zobowiązania albo Twojego bezpośredniego wpisu. Nowe zadanie rodzi się w stanie Do zrobienia; bez wskazanego koordynatora zostaje we wspólnej kolejce firmy.",
  editHeading: "Zmień zadanie",
  editIntro:
    "Odpowiedzialność i termin to jawne decyzje: wykonawcą może być kontakt z katalogu (także podwykonawca bez konta Kiero), a koordynatorem aktywny szef firmy. Termin wiąże się z ustaleniem datowym tej samej zakresu.",
  taskEditNote: "Puste zadanie w wyborze oznacza nowe zadanie.",
  taskProjectLabel: "Projekt",
  taskTitleLabel: "Nazwa zadania",
  taskTitlePlaceholder: "np. Odebrać dostawę okien",
  executorSelectLabel: "Wykonawca (kontakt z katalogu)",
  coordinatorSelectLabel: "Koordynator (szef firmy)",
  deadlineSelectLabel: "Termin (ustalenie datowe)",
  noneOption: "(brak)",
  createSubmit: "Zapisz zadanie",
  editSubmit: "Zapisz zmiany zadania",
  created: "Zadanie zapisane.",
  changed: "Zadanie zapisane.",
  // Task state form
  taskStateHeading: "Zmień stan zadania",
  taskStateIntro:
    "Stan zmienia tylko jednoznaczna decyzja: Twoja bezpośrednia zmiana albo jasna wypowiedź przekazana agentowi. Stan Czeka wymaga zapisanego powodu konkretnej przeszkody.",
  taskStateTaskLabel: "Zadanie",
  taskStateSelectLabel: "Nowy stan",
  taskStateWaitingReasonLabel: "Powód przeszkody (dla stanu Czeka)",
  taskStateWaitingReasonPlaceholder: "np. czekamy na okna",
  taskStateChange: "Zmień stan",
  taskStateChanged: "Stan zadania zmieniony.",
  // Checklist form
  checklistHeading: "Checklista zadania",
  checklistIntro:
    "Punkt checklisty korzysta z odpowiedzialności i terminu całego zadania. Odhaczenie zapisuje postęp listy i nie zmienia stanu zadania.",
  checklistTaskLabel: "Zadanie",
  checklistItemLabel: "Punkt (puste = nowy punkt)",
  checklistDescriptionLabel: "Opis punktu",
  checklistDescriptionPlaceholder: "np. kupić płytki",
  checklistStateLabel: "Oznaczenie",
  checklistChange: "Zapisz punkt",
  checklistChanged: "Punkt checklisty zapisany.",
  // Promotion form
  promoteHeading: "Przekształć punkt w zadanie",
  promoteIntro:
    "Punkt, który wymaga własnego odpowiedzialnego lub terminu, można przekształcić w osobne, powiązane zadanie. Punkt zachowuje swój stan i historię.",
  promoteTaskLabel: "Zadanie",
  promoteItemLabel: "Punkt",
  promote: "Przekształć w zadanie",
  promoted: "Punkt przekształcony w powiązane zadanie.",
  // Event create/edit + state
  eventHeading: "Zapisz zdarzenie",
  eventIntro:
    "Zdarzenie zapisuje znane terminy i fakty przebiegu pracy. Nowe zdarzenie rodzi się planowane; potwierdzenie odbycia jest zawsze osobną, jawną informacją.",
  eventEditNote: "Puste zdarzenie w wyborze oznacza nowe zdarzenie.",
  eventEventLabel: "Zdarzenie",
  eventProjectLabel: "Projekt",
  eventTitleLabel: "Nazwa zdarzenia",
  eventTitlePlaceholder: "np. Dostawa okien",
  eventTimeSelectLabel: "Termin (ustalenie datowe)",
  eventSubmit: "Zapisz zdarzenie",
  eventChanged: "Zdarzenie zapisane.",
  eventStateHeading: "Zmień stan zdarzenia",
  eventStateIntro:
    "Potwierdzenie odbycia się albo anulowanie wymaga jawnej informacji: wiadomości źródłowej albo Twojej bezpośredniej zmiany. Minięcie terminu niczego nie potwierdza.",
  eventStateEventLabel: "Zdarzenie",
  eventStateSelectLabel: "Nowy stan",
  eventStateChange: "Zmień stan",
  eventStateChanged: "Stan zdarzenia zmieniony.",
} as const;

// ---------------------------------------------------------------------------
// Closed-error hints (load-bearing codes only; the server message shows else)
// ---------------------------------------------------------------------------

/** Extra Polish hints for the closed-error codes this surface can meet. */
const codeHints: Record<string, string> = {
  ...sessionFailureHints,
  waiting_reason_required: "Stan Czeka wymaga powodu konkretnej przeszkody, np. braku materiałów.",
  waiting_reason_only_for_waiting: "Powód przeszkody należy do stanu Czeka: usuń go albo wybierz Czeka.",
  item_promoted: "Ten punkt został już przekształcony w zadanie; jego zobowiązanie żyje w tym zadaniu.",
  item_checked: "Odhaczony punkt nie potrzebuje własnego odpowiedzialnego ani terminu.",
  revision_mismatch:
    "Zadanie lub zdarzenie zmieniło się w międzyczasie (ktoś inny zapisał zmianę). Odśwież widok i spróbuj ponownie.",
  task_title_empty: "Tytuł zadania nie może być pusty.",
  checklist_description_empty: "Opis punktu nie może być pusty.",
  event_title_empty: "Tytuł zdarzenia nie może być pusty.",
  finding_not_temporal: "To ustalenie nie jest datą; termin można wiązać tylko z ustaleniem datowym.",
  deadline_role_actual: "Data faktycznego wykonania nie jest terminem do wykonania.",
  finding_project_mismatch: "To ustalenie należy do innego projektu.",
  linked_event_project_mismatch: "Zdarzenie i zadanie muszą należeć do tego samego projektu.",
  task_project_change_unsupported: "Zadanie należy do projektu, w którym powstało; przenoszenie nie jest zmianą pola.",
  event_project_change_unsupported: "Zdarzenie należy do projektu, w którym powstało; przenoszenie nie jest zmianą pola.",
  executor_contact_not_found: "Nie ma takiego kontaktu w katalogu firmy.",
  coordinator_membership_not_found: "Nie ma takiego członkostwa w tej firmie.",
  coordinator_membership_not_active: "Tylko aktywny szef firmy może być koordynatorem zadania.",
  deadline_finding_not_found: "Nie ma takiego ustalenia datowego.",
  time_finding_not_found: "Nie ma takiego ustalenia datowego.",
  linked_event_not_found: "Nie ma takiego zdarzenia.",
  basis_source_not_active: "Wiadomość wycofana nie może być podstawą nowej zmiany.",
};

/** The Polish hint for a closed-error code, or the server message. */
export function failureHint(code: string | undefined, serverMessage: string): string {
  if (code === undefined) {
    return serverMessage;
  }
  return codeHints[code] ?? serverMessage;
}

// ---------------------------------------------------------------------------
// Wire-value renderers (contract-decoded -> plain Polish)
// ---------------------------------------------------------------------------

// The temporal-role and tax-basis renderings come from the findings
// domain's one label module (packages/domain/findings/labels.ts), the
// same single-source pattern as the state vocabularies above.

/** Renders one decoded date-only bound; no component is invented. */
function dateOnlyLabel(bound: Extract<TemporalValue["shape"], { _tag: "day" | "month" | "year" }>): string {
  switch (bound._tag) {
    case "day":
      return bound.day;
    case "month":
      return `${bound.month} (do danego miesiąca)`;
    case "year":
      return `${bound.year} (do danego roku)`;
  }
}

/**
 * Renders one decoded temporal value: calendar facts plus the original
 * words. An exact date/time stays an exact instant; a date-only term names
 * the day it ends with; an open range end stays open.
 */
export function temporalValueLabel(temporal: TemporalValue): string {
  let when: string;
  switch (temporal.shape._tag) {
    case "day":
    case "month":
    case "year":
      when = dateOnlyLabel(temporal.shape);
      break;
    case "date_time":
      when = temporal.shape.value.toString();
      break;
    case "range": {
      const { start, end } = temporal.shape;
      when =
        start === null && end === null
          ? "zakres nieokreślony"
          : `od ${start === null ? "…" : dateOnlyLabel(start)} do ${end === null ? "…" : dateOnlyLabel(end)}`;
      break;
    }
  }
  return `${when} (${TEMPORAL_ROLE_LABELS[temporal.role]}; powiedziano: „${temporal.originalExpression}”)`;
}

/** The honest tax-basis label of a money value (never guessed). */
export function taxBasisLabel(taxBasis: TaxBasis): string {
  return TAX_BASIS_LABELS[taxBasis];
}

/**
 * Renders one bound term's knowledge: a currently-known term decodes and
 * renders as the calendar fact; anything else says what the memory does
 * NOT know, so an unknown or disputed term can never read as a date.
 */
export function boundTermLabel(bound: {
  readonly knowledgeState: unknown;
  readonly temporal: unknown;
}): string {
  const decodedState = Schema.decodeUnknownSync(KnowledgeState)(bound.knowledgeState);
  if (decodedState._tag !== "known") {
    switch (decodedState._tag) {
      case "unknown":
        return "termin nieznany";
      case "conflicted":
        return "termin sporny, wymaga rozstrzygnięcia";
      case "updating":
        return "termin wymaga ponownego potwierdzenia, podstawa się zmieniła";
      case "not_applicable":
        return "termin nie dotyczy";
    }
  }
  const decodedTerm = Schema.decodeUnknownSync(TemporalValue)(bound.temporal);
  return temporalValueLabel(decodedTerm);
}

// ---------------------------------------------------------------------------
// Term-binding candidates (what the deadline/time selects may offer)
// ---------------------------------------------------------------------------

/** One current-findings row in the wire form the public read carries. */
export interface FindingWireRow {
  readonly findingId: string;
  readonly semanticKey: string;
  readonly value: unknown;
}

/**
 * The decoded temporal payload of one findings row, or null when the row's
 * current value is not a term (money, text or extension findings never
 * bind as dates).
 */
export function findingTerm(row: FindingWireRow): TemporalValue | null {
  let decoded: FindingValue;
  try {
    decoded = Schema.decodeUnknownSync(FindingValue)(row.value);
  } catch {
    return null;
  }
  return decoded._tag === "temporal" ? decoded.temporal : null;
}

/**
 * Whether one findings row may bind as a TASK deadline: a term still ahead
 * (proposed/internal/agreed). An `actual` date records when something
 * happened and is not a deadline; the server re-checks the same rule.
 */
export function bindableDeadline(row: FindingWireRow): boolean {
  const term = findingTerm(row);
  return term !== null && term.role !== "actual";
}

/** Whether one findings row may bind as an EVENT's known time (any role). */
export function bindableEventTime(row: FindingWireRow): boolean {
  return findingTerm(row) !== null;
}

/** The select-option label of one bindable findings row. */
export function findingTermOptionLabel(row: FindingWireRow): string {
  const term = findingTerm(row);
  return term === null ? row.semanticKey : `${row.semanticKey}: ${temporalValueLabel(term)}`;
}
