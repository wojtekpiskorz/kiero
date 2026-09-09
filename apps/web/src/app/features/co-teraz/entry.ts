/**
 * "Co teraz" feature entry (A4 placeholder; the work/attention lanes own
 * the real implementation).
 *
 * Reachable straight from the module entries, without a mandatory
 * dashboard: the current obligations of the firm (tasks, reminders).
 */

import { appFeatureEntry } from "../../registry";

/** The registered host entry for the "Co teraz" surface. */
export const coTerazFeatureEntry = appFeatureEntry({
  featureId: "attention.now",
  routePath: "/co-teraz",
  navLabel: "Co teraz",
  screenHeading: "Co teraz",
  pendingNote:
    "Przegląd tego, co czeka na firmę: zadania, ich stany i przypomnienia. Widok powstanie razem z implementacją zadań i przypomnień.",
  consumedOperations: [
    "work.changeTaskState",
    "attention.snoozeTaskReminders",
    "attention.evaluateDueIntents",
  ],
  implementation: "pending",
});
