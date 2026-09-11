/**
 * The final core composition entry, web half (J2, issue #61).
 *
 * The full-flow join owns this explicit cross-module composition: ONE
 * module that composes the complete core feature list of the barebones
 * application and validates the JOIN's invariants loudly, so the shipped
 * host can never silently lose a core surface or resurrect the retired
 * separate capture route.
 *
 * What the join changed (and what this module pins):
 *
 * - the company conversation stays the default route and the FIRST entry,
 *   and now carries ALL capture modes (D4's recoverable-draft composer:
 *   text, one recording, photos, voice-only sends) plus E6's answer loop
 *   ("Zapytaj agenta" per message);
 * - the separate /wpis capture route RETIRES: no `capture.composer` entry
 *   composes anywhere in the core list;
 * - every other core surface stays reachable through its own mounted
 *   module entry (memory, search, source dossier, Co teraz, work,
 *   extensions, projects, membership, GM, GM processing, Calendar
 *   connection, push settings).
 *
 * `app-features.ts` (A4's one shared wiring file) delegates to
 * {@link fullCoreAppFeatures}; the composition semantics live HERE, in
 * the join's owned path, per the charter's "joins own explicit
 * cross-module composition".
 */

import { composeAppFeatures, type AppFeatureEntry } from "../app/registry";
import { conversationFeatureEntry } from "../app/features/conversation/entry";
import { memoryFeatureEntry } from "../app/features/memory/entry";
import { coTerazFeatureEntry } from "../app/features/co-teraz/entry";
import { workFeatureEntry } from "../app/features/work/entry";
import { extensionsFeatureEntry } from "../app/features/extensions/entry";
import { projectsFeatureEntry } from "../app/features/projects/entry";
import { membershipFeatureEntry } from "../app/features/membership/entry";
import { calendarFeatureEntry } from "../app/features/calendar/entry";
import { gmAccessFeatureEntry } from "../app/features/gm/entry";
import { notificationsFeatureEntry } from "../app/features/notifications/entry";
import { gmProcessingFeatureEntry } from "../app/features/gm/processing-entry";
import { searchFeatureEntry } from "../app/features/search/entry";
import { sourceDetailFeatureEntry } from "../app/features/source-detail/entry";
// I3's sanctioned append (flagged, issue #55): the firm-export surface.
import { exportsFeatureEntry } from "../app/features/exports/entry";

/** The mounted feature ids the complete core must compose, in order. */
export const FULL_CORE_FEATURE_IDS: readonly string[] = [
  "conversation.company",
  "memory.project",
  "search.evidence",
  "source.detail",
  "operations.exports",
  "attention.now",
  "work.records",
  "memory.extensions",
  "access.membership",
  "access.gm",
  "operations.processing",
  "calendar.connection",
  "attention.push",
];

/** Routes the core retired at this join (the separate capture screen). */
export const RETIRED_CORE_ROUTE_PATHS: readonly string[] = ["/wpis"];

/** The commands the joined conversation surface issues (send + read). */
const CONVERSATION_OPERATIONS: readonly string[] = [
  "sources.prepareUpload",
  "sources.acceptSource",
  "attention.markSourceRead",
];

/** One problem found by {@link validateFullCoreComposition}. */
export interface FullCoreProblem {
  readonly kind:
    | "conversation_not_first"
    | "feature_missing"
    | "feature_not_mounted"
    | "order_drift"
    | "retired_route_present"
    | "conversation_operations_drift";
  readonly name: string;
}

/**
 * Composes the complete core feature list (the same entries every lane
 * mounted) and validates the join's invariants. Throws loudly on drift:
 * the host imports this at startup, so a lost surface fails the boot, not
 * a user's click.
 */
export function fullCoreAppFeatures(): readonly AppFeatureEntry[] {
  const composed = composeAppFeatures([
    conversationFeatureEntry,
    memoryFeatureEntry,
    searchFeatureEntry,
    sourceDetailFeatureEntry,
    exportsFeatureEntry,
    coTerazFeatureEntry,
    workFeatureEntry,
    extensionsFeatureEntry,
    projectsFeatureEntry,
    membershipFeatureEntry,
    gmAccessFeatureEntry,
    gmProcessingFeatureEntry,
    calendarFeatureEntry,
    notificationsFeatureEntry,
  ]);
  const problems = fullCoreProblems(composed);
  if (problems.length > 0) {
    const listed = problems.map((problem) => `${problem.kind}: ${problem.name}`).join("; ");
    throw new Error(`Full core composition drift: ${listed}`);
  }
  return composed;
}

/** The pure drift check over any composed list (tests consume this). */
export function validateFullCoreComposition(
  entries: readonly AppFeatureEntry[],
): { readonly problems: readonly FullCoreProblem[] } {
  return { problems: fullCoreProblems(entries) };
}

function fullCoreProblems(entries: readonly AppFeatureEntry[]): FullCoreProblem[] {
  const problems: FullCoreProblem[] = [];
  const first = entries[0];
  if (first?.featureId !== "conversation.company" || first.routePath !== "/") {
    problems.push({ kind: "conversation_not_first", name: first?.featureId ?? "empty" });
  }
  const mountedIds: readonly string[] = entries
    .filter((entry) => entry.implementation === "mounted")
    .map((entry) => entry.featureId);
  for (const id of FULL_CORE_FEATURE_IDS) {
    if (!mountedIds.includes(id)) {
      problems.push({ kind: "feature_missing", name: id });
    }
  }
  if (mountedIds.join("|") !== FULL_CORE_FEATURE_IDS.join("|")) {
    problems.push({ kind: "order_drift", name: mountedIds.join("|") });
  }
  for (const entry of entries) {
    if (RETIRED_CORE_ROUTE_PATHS.includes(entry.routePath)) {
      problems.push({ kind: "retired_route_present", name: entry.routePath });
    }
  }
  const conversation = entries[0];
  if (
    conversation !== undefined &&
    [...conversation.consumedOperations].sort().join("|") !==
      [...CONVERSATION_OPERATIONS].sort().join("|")
  ) {
    problems.push({ kind: "conversation_operations_drift", name: "conversation.company" });
  }
  return problems;
}
