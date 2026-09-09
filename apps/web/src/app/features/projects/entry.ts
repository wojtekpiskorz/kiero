/**
 * Projects (project context) feature entry (A4 placeholder; the projects
 * lane owns the real implementation).
 *
 * A project exists from the first client inquiry; the surface reaches
 * project memory and context without a mandatory dashboard before capture.
 */

import type { ReactNode } from "react";
import { appFeatureEntry, type AppFeatureEntry } from "../../registry";
import { FeaturePendingScreen } from "../../feature-pending";

function ProjectsPendingScreen(): ReactNode {
  return FeaturePendingScreen({ entry: projectsFeatureEntry });
}

/** The registered host entry for the projects context surface. */
export const projectsFeatureEntry: AppFeatureEntry = appFeatureEntry({
  kind: "app_feature",
  featureId: "projects.context",
  routePath: "/projekty",
  navLabel: "Projekty",
  screenHeading: "Projekty",
  pendingNote:
    "Projekty od pierwszego zapytania klienta: aliasy, etapy, wstrzymania i pamięć projektu. Widok jest w przygotowaniu.",
  consumedOperations: [
    "projects.identifyProject",
    "projects.assignCodename",
    "projects.changeStage",
    "projects.setPause",
  ],
  implementation: "pending",
  screen: ProjectsPendingScreen,
});
