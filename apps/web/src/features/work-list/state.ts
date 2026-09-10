/**
 * Work list ("Co teraz" work half) feature state: Polish copy, the
 * task/item/event vocabularies rendered for product text, and the
 * closed-error classification for the C4 surface.
 *
 * The task-state, checklist-mark and event-state labels come from the pure
 * domain rules (`packages/domain/work`) through one relative import: the
 * Polish rendering of the fixed vocabulary has exactly one source, shared
 * with the backend lanes that consume the same module. Operation results
 * arrive as `ResultEnvelope`s; every closed error maps to the server's
 * Polish message plus hints for load-bearing machine codes.
 *
 * Dueness and event timing are DERIVED facts (the company timezone, the
 * clock at read time); the copy renders them as claims about the present,
 * never as state changes — an overdue task is still in its own state, an
 * elapsed planned event is still planned.
 */

import {
  CHECKLIST_ITEM_STATE_LABELS,
  EVENT_STATE_LABELS,
  TASK_STATE_LABELS,
  type TaskDueness,
  type EventTiming,
} from "../../../../../packages/domain/work/index";
import { signInCopy } from "../sign-in/state";

export { signInCopy };

/** The fixed task-state vocabulary rendered in Polish (one source: the domain rules). */
export const taskStateLabels = TASK_STATE_LABELS;

/** The checklist completion mark rendered in Polish. */
export const checklistItemStateLabels = CHECKLIST_ITEM_STATE_LABELS;

/** The event-state vocabulary rendered in Polish. */
export const eventStateLabels = EVENT_STATE_LABELS;

/** The states a boss may command for a task, in list order. */
export const taskStateOrder = [
  "todo",
  "in_progress",
  "waiting",
  "done",
  "cancelled",
] as const;

/** The states a boss may command for an event. */
export const eventStateOrder = ["planned", "occurred", "cancelled"] as const;

/** Polish copy for the work-list surface (stable product text). */
export const workCopy = {
  title: "Co teraz",
  connectionUnconfigured:
    "Aplikacja nie jest połączona z backendem (VITE_CONVEX_URL nie jest ustawiony).",
  connectionMisconfigured: "Adres backendu jest nieprawidłowy — aplikacja działa bez połączenia.",
  checkingSession: "Sprawdzamy Twoją sesję…",
  sessionEndedNotice: signInCopy.sessionEndedNotice,
  signInAgain: signInCopy.signInAgain,
  // Task list
  tasksHeading: "Zadania",
  tasksNote:
    "Zakończenie zadania to osobna decyzja — odhaczenie całej checklisty go nie kończy, a zadanie można wykonać przy nieodhaczonych punktach, które zachowują swój stan.",
  noTasks: "Brak zadań. Zapisz pierwsze zadanie poniżej.",
  createNeedsProject: "Aby zapisać zadanie, najpierw utwórz projekt w katalogu projektów.",
  waitingReasonLabel: "Przeszkoda",
  executorLabel: (name: string | null): string =>
    name === null ? "wykonawca nieznany" : `wykonawca: ${name}`,
  coordinatorLabel: (assigned: boolean): string =>
    assigned ? "koordynator przypisany" : "bez koordynatora (wspólna kolejka)",
  checklistProgressLabel: (checked: number, total: number): string =>
    `checklista: ${checked}/${total}`,
  promotedMark: "punkt przekształcony w zadanie",
  linkedEventLabel: "powiązane zdarzenie",
  parentTaskLabel: "wydzielone z zadania",
  duenessLabel: (dueness: TaskDueness): string => {
    switch (dueness.kind) {
      case "closed":
        return "zakończone — bez zaległości";
      case "no_deadline":
        return "bez terminu";
      case "term_unusable":
        return "termin nieznany lub sporny — przypomnienie wstrzymane";
      case "pending":
        return "termin jeszcze nie minął";
      case "overdue":
        return "po terminie";
    }
  },
  // Event list
  eventsHeading: "Zdarzenia",
  eventsNote:
    "Zdarzenie to dostawa, spotkanie lub inny element przebiegu pracy — samo nie przypisuje nikomu działania. Minięcie daty nie potwierdza, że się odbyło.",
  noEvents: "Brak zdarzeń.",
  timingLabel: (timing: EventTiming): string => {
    switch (timing.kind) {
      case "occurred":
        return "odbyło się";
      case "cancelled":
        return "anulowane";
      case "planned_no_time":
        return "planowane — termin nieznany";
      case "planned_time_unusable":
        return "planowane — termin nieznany lub sporny";
      case "planned_upcoming":
        return "planowane — termin jeszcze nie minął";
      case "planned_elapsed_unconfirmed":
        return "planowane — termin minął bez potwierdzenia";
    }
  },
  // Create form
  createHeading: "Zapisz zadanie",
  createIntro:
    "Zadanie powstaje z przekazanego zobowiązania albo Twojego bezpośredniego wpisu. Nowe zadanie rodzi się w stanie Do zrobienia; bez wskazanego koordynatora zostaje we wspólnej kolejce firmy.",
  createProjectLabel: "Projekt",
  createTitleLabel: "Nazwa zadania",
  createPlaceholder: "np. Odebrać dostawę okien",
  createSubmit: "Zapisz zadanie",
  created: "Zadanie zapisane.",
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
  // Event state form
  eventStateHeading: "Zmień stan zdarzenia",
  eventStateIntro:
    "Potwierdzenie odbycia się albo anulowanie wymaga jawnej informacji — wiadomości źródłowej albo Twojej bezpośredniej zmiany. Minięcie terminu niczego nie potwierdza.",
  eventStateEventLabel: "Zdarzenie",
  eventStateSelectLabel: "Nowy stan",
  eventStateChange: "Zmień stan",
  eventStateChanged: "Stan zdarzenia zmieniony.",
} as const;

/** Extra Polish hints for the load-bearing closed-error codes. */
const codeHints: Record<string, string> = {
  waiting_reason_required: "Stan Czeka wymaga powodu konkretnej przeszkody, np. braku materiałów.",
  waiting_reason_only_for_waiting: "Powód przeszkody należy do stanu Czeka — usuń go albo wybierz Czeka.",
  item_promoted: "Ten punkt został już przekształcony w zadanie — jego zobowiązanie żyje w tym zadaniu.",
  item_checked: "Odhaczony punkt nie potrzebuje własnego odpowiedzialnego ani terminu.",
  revision_mismatch: "Zadanie lub zdarzenie zmieniło się w międzyczasie. Odśwież widok i spróbuj ponownie.",
  task_title_empty: "Tytuł zadania nie może być pusty.",
  checklist_description_empty: "Opis punktu nie może być pusty.",
  event_title_empty: "Tytuł zdarzenia nie może być pusty.",
  finding_not_temporal: "To ustalenie nie jest datą — termin można wiązać tylko z ustaleniem datowym.",
  deadline_role_actual: "Data faktycznego wykonania nie jest terminem do wykonania.",
  finding_project_mismatch: "To ustalenie należy do innego projektu.",
  linked_event_project_mismatch: "Zdarzenie i zadanie muszą należeć do tego samego projektu.",
  coordinator_membership_not_active:
    "Tylko aktywny szef firmy może być koordynatorem zadania.",
  basis_source_not_active: "Wiadomość wycofana nie może być podstawą nowej zmiany.",
};

/** The Polish hint for a closed-error code, or null when the server message suffices. */
export function failureHint(code: string | undefined): string | null {
  if (code === undefined) {
    return null;
  }
  return codeHints[code] ?? null;
}
