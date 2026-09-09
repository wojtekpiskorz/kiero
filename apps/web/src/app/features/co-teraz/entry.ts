/**
 * "Co teraz" feature entry (A4 placeholder; the work/attention lanes own
 * the real implementation).
 *
 * Reachable straight from the module entries, without a mandatory
 * dashboard: the current obligations of the firm (tasks, reminders).
 */

import type { ReactNode } from "react";
import { appFeatureEntry, type AppFeatureEntry } from "../../registry";
import { FeaturePendingScreen } from "../../feature-pending";

function CoTerazPendingScreen(): ReactNode {
  return FeaturePendingScreen({ entry: coTerazFeatureEntry });
}

/** The registered host entry for the "Co teraz" surface. */
export const coTerazFeatureEntry: AppFeatureEntry = appFeatureEntry({
  kind: "app_feature",
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
  screen: CoTerazPendingScreen,
});
