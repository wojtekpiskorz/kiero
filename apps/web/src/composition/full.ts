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
 *   extensions, projects, membership, GM, GM processing, push settings);
 * - R16 (issue #198) withheld the Calendar connection surface from the
 *   v1 host: the owner deferred the Google Calendar integration beyond
 *   v1 (ADR docs/adr/calendar-deferral-2026-09.md), so the entry stays
 *   registered as pending (a recorded deferral, its honest Polish note
 *   in the entry) while the composed output drops it from routes and
 *   navigation (see {@link FULL_CORE_DEFERRED_FEATURE_IDS}).
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
// I4's sanctioned append (flagged, issue #56, the I3 precedent): the
// permanent-deletion surface (impact preview, confirmation, cleanup status).
import { dataDeletionFeatureEntry } from "../app/features/data-deletion/entry";

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
  "attention.push",
  // I4's sanctioned append (flagged, issue #56): the deletion surface.
  "operations.deletion",
];

/**
 * Core surfaces the owner deferred beyond v1 (R16, issue #198; ADR
 * docs/adr/calendar-deferral-2026-09.md). Each id must stay composed as
 * a pending entry (the registry enforces the honest Polish pendingNote),
 * so a deferral stays recorded instead of silently missing, but the
 * entry is withheld from the v1 host composition: no route, no
 * navigation entry. The lane that remounts such a surface moves its id
 * back into {@link FULL_CORE_FEATURE_IDS}.
 */
export const FULL_CORE_DEFERRED_FEATURE_IDS: readonly string[] = ["calendar.connection"];

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
    | "deferred_not_pending"
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
 *
 * R16 (issue #198): the returned list is the v1 host composition the
 * router and navigation derive from, so surfaces deferred beyond v1
 * ({@link FULL_CORE_DEFERRED_FEATURE_IDS}) are withheld here (pending
 * entry, no route, no navigation entry) without any router or shell
 * edit. Pending entries outside the deferred list (the projects
 * placeholder) keep composing as honest placeholders.
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
    dataDeletionFeatureEntry,
  ]);
  const problems = fullCoreProblems(composed);
  if (problems.length > 0) {
    const listed = problems.map((problem) => `${problem.kind}: ${problem.name}`).join("; ");
    throw new Error(`Full core composition drift: ${listed}`);
  }
  return composed.filter((entry) => !withheldFromV1(entry));
}

/** True when a pending entry records a deferral beyond v1 (R16). */
function withheldFromV1(entry: AppFeatureEntry): boolean {
  return (
    entry.implementation === "pending" &&
    FULL_CORE_DEFERRED_FEATURE_IDS.includes(entry.featureId as string)
  );
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
  // Presence over both lists: a listed surface that silently leaves the
  // composition is drift, whether it must be mounted (the core) or
  // pending (a recorded deferral beyond v1, R16).
  const entriesById = new Map(entries.map((entry) => [entry.featureId as string, entry]));
  for (const id of FULL_CORE_FEATURE_IDS) {
    const entry = entriesById.get(id);
    if (entry === undefined) {
      problems.push({ kind: "feature_missing", name: id });
    } else if (entry.implementation !== "mounted") {
      // A core surface flipping to pending without a recorded deferral
      // (FULL_CORE_DEFERRED_FEATURE_IDS) is a quiet unship, not a
      // decision: name it.
      problems.push({ kind: "feature_not_mounted", name: id });
    }
  }
  for (const id of FULL_CORE_DEFERRED_FEATURE_IDS) {
    const entry = entriesById.get(id);
    if (entry === undefined) {
      problems.push({ kind: "feature_missing", name: id });
    } else if (entry.implementation !== "pending") {
      // A deferred id that remounts is a decision reversal flying under a
      // stale deferral record: name it here (the mounted order check does
      // NOT catch the half-done remount, because a stale deferred-list id
      // plus a remounted entry still joins to the core list).
      problems.push({ kind: "deferred_not_pending", name: id });
    }
  }
  const mountedIds: readonly string[] = entries
    .filter((entry) => entry.implementation === "mounted")
    .map((entry) => entry.featureId);
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
