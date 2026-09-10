/**
 * "Co teraz" feature state (H2): the Polish copy, the per-user grouping
 * rules and the record deep-link contract of the /co-teraz screen.
 *
 * The query-param keys are the parity-pinned pair G4's calendar copies
 * link back into (`subjectLinkPath` in `packages/domain/calendar` builds
 * `/co-teraz?zadanie=<id>` / `/co-teraz?zdarzenie=<id>`); this screen
 * owns the route, so this module owns the keys' one typed home on the
 * client. The work record surface (/praca) reuses the same keys for its
 * focus anchors.
 *
 * Grouping is pure and testable: "actionable" open work means the task
 * states that still oblige someone (Do zrobienia, W toku, Czeka; never
 * Wykonane/Anulowane), split into the viewer's own assignments, the
 * shared unassigned queue, and the remaining obligations of CLOSED
 * projects (which stay in the company queue by design).
 */

import type { EventView, TaskView } from "../../../../../convex/work/read";
import { sessionFailureHints } from "../conversation/state";
import { zoneOffsetOf } from "../company/time";
import type { ProjectJoin } from "../work/WorkFeature";

/** The query-param task deep-link key (G4 parity: /co-teraz?zadanie=<id>). */
export const TASK_PARAM = "zadanie";

/** The query-param event deep-link key (G4 parity: /co-teraz?zdarzenie=<id>). */
export const EVENT_PARAM = "zdarzenie";

/** Reads one string search param (empty reads as absent). */
export function searchParam(name: string): string | null {
  if (typeof window === "undefined") {
    return null;
  }
  const value = new URLSearchParams(window.location.search).get(name);
  return value === null || value.length === 0 ? null : value;
}

/** The /praca record link of one task (the authoritative record screen). */
export function taskRecordLink(taskId: string): string {
  return `/praca?${TASK_PARAM}=${encodeURIComponent(taskId)}`;
}

/** The /praca record link of one event (the authoritative record screen). */
export function eventRecordLink(eventId: string): string {
  return `/praca?${EVENT_PARAM}=${encodeURIComponent(eventId)}`;
}

/** The task states that still oblige someone ("actionable" open work). */
export const OPEN_TASK_STATES = ["todo", "in_progress", "waiting"] as const;

/** Whether one task still obliges someone (not Wykonane, not Anulowane). */
export function isOpenTask(task: TaskView): boolean {
  return (OPEN_TASK_STATES as readonly string[]).includes(task.state);
}

/** Whether one task's remaining obligation belongs to a closed project. */
export function isClosedProjectTask(task: TaskView, projects: Map<string, ProjectJoin>): boolean {
  return projects.get(task.projectId)?.closed === true;
}

/** The viewer's own assignments: tasks the viewer effectively coordinates. */
export function myOpenTasks(
  tasks: readonly TaskView[],
  myMembershipId: string,
): readonly TaskView[] {
  return tasks.filter(
    (task) => isOpenTask(task) && task.effectiveCoordinatorMembershipId === myMembershipId,
  );
}

/** The shared queue: open work no active boss currently coordinates. */
export function unassignedOpenTasks(tasks: readonly TaskView[]): readonly TaskView[] {
  return tasks.filter((task) => isOpenTask(task) && task.effectiveCoordinatorMembershipId === null);
}

/** Open work other active bosses coordinate (visible, not the viewer's). */
export function othersOpenTasks(
  tasks: readonly TaskView[],
  myMembershipId: string,
): readonly TaskView[] {
  return tasks.filter(
    (task) =>
      isOpenTask(task) &&
      task.effectiveCoordinatorMembershipId !== null &&
      task.effectiveCoordinatorMembershipId !== myMembershipId,
  );
}

/** Remaining obligations of closed projects (mine, others' and shared). */
export function closedProjectObligations(
  tasks: readonly TaskView[],
  projects: Map<string, ProjectJoin>,
): readonly TaskView[] {
  return tasks.filter((task) => isOpenTask(task) && isClosedProjectTask(task, projects));
}

/** Planned events whose term elapsed without explicit confirmation. */
export function eventsAwaitingConfirmation(events: readonly EventView[]): readonly EventView[] {
  return events.filter((event) => event.timing.kind === "planned_elapsed_unconfirmed");
}

/** Copy for the /co-teraz surface (the per-user "what now" list). */
export const nowCopy = {
  title: "Co teraz",
  intro:
    "To, co teraz czeka na Ciebie i na firmę: Twoje zadania, wspólna kolejka, zobowiązania z zamkniętych projektów, zdarzenia czekające na potwierdzenie, sprawy do wyjaśnienia i stan przypomnień.",
  // Sections
  mineHeading: "Twoje zadania",
  mineIntro:
    "Zadania, którymi koordynujesz. Stan zmienia jednoznaczna decyzja; odhaczenie punktów checklisty jej nie zastępuje.",
  noMine: "Nie koordynujesz teraz żadnego otwartego zadania.",
  sharedHeading: "Wspólna kolejka (zadania bez koordynatora)",
  sharedIntro:
    "Otwarta praca bez przypisanego szefa. Przypomnienia o takich zadaniach trafiają do wszystkich szefów firmy.",
  noShared: "Wspólna kolejka jest pusta.",
  othersHeading: "Zadania innych koordynatorów",
  othersIntro: "Otwarta praca koordynowana przez innych szefów firmy.",
  noOthers: "Inni szefowie nie koordynują teraz otwartych zadań.",
  closedHeading: "Zobowiązania z zamkniętych projektów",
  closedIntro:
    "Zamknięcie projektu nie zamyka jego otwartych zobowiązań: te zadania pozostają w firmowej kolejce i nadal przypominają.",
  noClosed: "Zamknięte projekty nie zostawiają otwartych zobowiązań.",
  eventsHeading: "Zdarzenia czekające na potwierdzenie",
  eventsIntro:
    "Planowane zdarzenia, których termin minął bez potwierdzenia. Upływ daty niczego nie potwierdza: oznacz Odbyło się albo Anulowane.",
  noEvents: "Żadne planowane zdarzenie nie czeka na potwierdzenie.",
  questionsHeading: "Sprawy do wyjaśnienia",
  questionsIntro:
    "Pytania agenta o sprzeczności i niejednoznaczności. Rozstrzygnięcie ma autora i zostaje w historii.",
  companyScopeLabel: "wiedza firmy",
  projectScopeLabel: (name: string): string => `projekt: ${name}`,
  // Row copy
  recordLinkTask: "szczegóły zadania",
  recordLinkEvent: "szczegóły zdarzenia",
  overdueMark: "po terminie",
  snoozedUntil: (label: string): string => `przypomnienia odroczone do ${label}`,
  pendingReminderAt: (label: string): string => `przypomnienie zaplanowane na ${label}`,
  deliveredReminder: "przypomnienie dostarczone",
  suppressedReminder: (reason: string): string => `przypomnienie wstrzymane (${reason})`,
  noReminder: "brak zaplanowanych przypomnień",
  // The honest unavailable state: a refused projection is NOT "no reminders".
  remindersLoading: "Sprawdzamy stan przypomnień…",
  remindersUnavailable: "stan przypomnień chwilowo niedostępny",
  // State-change control (the actionable half of Co teraz)
  stateChangeLabel: "Zmień stan",
  stateSelectLabel: (title: string): string => `Nowy stan zadania „${title}”`,
  stateChanged: "Stan zadania zmieniony.",
  stateWaitingReasonLabel: "Powód przeszkody (dla stanu Czeka)",
  stateWaitingReasonPlaceholder: "np. czekamy na okna",
  // Snooze control
  snoozeUntilLabel: (title: string, companyZone: string): string =>
    `Odrocz przypomnienia o „${title}” do (strefa firmy ${companyZone})`,
  snoozeScopeNote:
    "Odroczenie wstrzymuje Twoje przypomnienia o jednym zadaniu do wskazanego momentu; nie zmienia terminu zadania ani przypomnień innych szefów.",
  snoozeSubmit: "Odrocz",
  snoozed: "Przypomnienia odroczone.",
  // Question answering
  answerLabel: "Twoje rozstrzygnięcie",
  answerPlaceholder: "np. Obowiązuje kwota z czwartkowej rozmowy.",
  answerSubmit: "Odpowiedz",
  answered: "Sprawa rozstrzygnięta.",
  // Deep-link focus
  focusedMark: "wskazane odnośnikiem",
  focusedTaskNotice: "Odnośnik (np. z kopii kalendarzowej) wskazuje to zadanie.",
  focusedTaskIdLabel: (id: string): string => `identyfikator zadania: ${id}`,
  focusedEventNotice: "Odnośnik (np. z kopii kalendarzowej) wskazuje to zdarzenie.",
  // Event confirmation
  eventConfirmed: "Stan zdarzenia zmieniony.",
  eventConfirmLabel: (title: string): string => `Potwierdź stan zdarzenia „${title}”`,
  eventConfirmSubmit: "Zatwierdź stan",
  // Question answering
  questionsEvidenceLabel: "Sprzeczne źródła:",
  questionsSourceLink: "wiadomość źródłowa",
  // Snooze input
  snoozeInvalid: "Wskaż moment odroczenia (data i godzina).",
} as const;

/**
 * Parses one datetime-local value ("YYYY-MM-DDTHH:mm") into the instant it
 * names IN THE COMPANY ZONE (CONTEXT.md "Strefa czasu firmy": reminder
 * times are the firm's wall times and do not follow the boss's phone).
 * The zone's offset is derived ON THE TARGET DAY (UTC noon, away from the
 * DST transition hours), so a snooze into another DST period still lands
 * on the moment the firm means. The chosen INSTANT is what the snooze
 * command stores; an unresolvable zone refuses instead of guessing.
 */
export function snoozeUntilMs(value: string, companyZone: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})$/.exec(value);
  if (match === null) {
    return null;
  }
  const [, year, month, day, time] = match;
  if (year === undefined || month === undefined || day === undefined || time === undefined) {
    return null;
  }
  const zoneOffset = zoneOffsetOf(
    companyZone,
    Date.UTC(Number.parseInt(year, 10), Number.parseInt(month, 10) - 1, Number.parseInt(day, 10), 12),
  );
  if (zoneOffset === "") {
    return null;
  }
  const ms = Date.parse(`${year}-${month}-${day}T${time}:00.000${zoneOffset}`);
  return Number.isNaN(ms) ? null : ms;
}

// ---------------------------------------------------------------------------
// Closed-error hints (the attention command this surface owns)
// ---------------------------------------------------------------------------

/** Extra Polish hints for the closed-error codes the snooze command can meet. */
const codeHints: Record<string, string> = {
  ...sessionFailureHints,
  snooze_until_not_in_future: "Moment odroczenia musi być w przyszłości.",
  snooze_until_too_far: "Nie można odroczyć przypomnień tak daleko w przyszłość.",
  task_not_found: "Nie ma takiego zadania; odśwież widok.",
};

/** The Polish hint for a closed-error code, or the server message. */
export function failureHint(code: string | undefined, serverMessage: string): string {
  if (code === undefined) {
    return serverMessage;
  }
  return codeHints[code] ?? serverMessage;
}
