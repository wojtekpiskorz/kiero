/**
 * Durable notification-intent model (F2): the PURE decision core the
 * evaluator runs (issue 42: "durable notification intents and an
 * idempotent evaluator").
 *
 * Everything here is deterministic over its inputs — no Convex, no clock,
 * no environment — so the 60-second batching window arithmetic, the
 * terminal-assignment classification, the scope-bucket grouping and the
 * collapsed-summary shape are unit-testable without a deployment
 * (tests/f2/delivery.test.ts) while ./operations.ts re-runs the SAME
 * functions inside its transactions over live rows (the F1 `evaluation.ts`
 * precedent).
 *
 * Semantics pinned by the accepted notification decision (issue 7
 * resolution) and issue 42's bounded solution:
 *
 * - The batching window is 60 seconds counted from the FIRST qualifying
 *   entry's durable all-attachment acceptance ("Pozostaje grupowanie przez
 *   60 sekund od pierwszego nowego wpisu"); a batch firing later (waiting
 *   for assignment, quiet hours) still carries every intent accepted by
 *   the fire instant, so deferred work collapses into ONE current summary
 *   instead of replaying stale items.
 * - While assignment is still pending the send WAITS even past the window
 *   ("Jeśli po 60 sekundach nie znamy jeszcze odbiorców, wysyłka czeka na
 *   wynik przypisania"); pending analysis is never treated as an unassigned
 *   company source (issue 42 acceptance).
 * - Company-entry rules apply only after terminal unassigned
 *   classification or terminal analysis failure; later assignment sends no
 *   second source notification (structural: terminal intents stay
 *   terminal).
 * - A mixed-project source is ONE notification for the person ("zachowując
 *   jedno powiadomienie o źródle"), batched in its own scope bucket — never
 *   duplicated per project.
 * - Quiet hours DEFER delivery to `nextQuietHoursEndMs` (F1's seam); the
 *   deferral never replays stale items, it re-collapses the current batch.
 */

/** The batching window, from durable acceptance to earliest delivery (issue 7). */
export const BATCH_WINDOW_MS = 60_000;

/**
 * Re-check cadence while a source's assignment classification is still
 * pending at due time. Not a delivery promise — the event-driven kick
 * (`memory.changeSetPublished`) usually resolves it sooner.
 */
export const ASSIGNMENT_RETRY_MS = 30_000;

/** Terminal processing-run states as the evaluator sees them. */
export type RunTerminalState = "succeeded" | "failed";

/** The latest processing run of a source, as the assignment resolution reads it. */
export interface LatestRunView {
  readonly state: "running" | RunTerminalState | "superseded";
}

/**
 * The generic assignment/agent-message classification (issue 42: "Consume
 * the generic assignment/agent-message state contract, independent of media
 * implementation. E4 later emits the same terminal states").
 *
 * - `pending`: no run yet, or the latest run is still running/superseded
 *   without a successor — never a company entry in this state.
 * - `company`: terminal analysis failure, or terminal success with NO
 *   project links (terminal unassigned classification).
 * - `projects`: terminal success with at least one project link; the ids
 *   are the CURRENT links (re-read at due time, so a later reassignment
 *   respects the mutes of what the source is now).
 */
export type AssignmentResolution =
  | { readonly state: "pending" }
  | { readonly state: "company" }
  | { readonly state: "projects"; readonly projectIds: readonly string[] };

/**
 * Classifies one source's assignment from its latest processing run and
 * current project links. PURE: the evaluator feeds it live rows; E4's
 * later media runs emit the same terminal states.
 */
export function resolveAssignment(
  latestRun: LatestRunView | null,
  linkedProjectIds: readonly string[],
): AssignmentResolution {
  if (latestRun === null || latestRun.state === "running" || latestRun.state === "superseded") {
    return { state: "pending" };
  }
  if (latestRun.state === "failed") {
    // Terminal analysis failure: company-entry rules (issue 42).
    return { state: "company" };
  }
  return linkedProjectIds.length === 0
    ? { state: "company" }
    : { state: "projects", projectIds: [...linkedProjectIds] };
}

/** The scope one batch summary is about. */
export interface BatchScope {
  readonly kind: "company" | "project";
  readonly projectIds: readonly string[];
}

/**
 * The bucket key one intent batches under, per recipient: company entries
 * group together, each single project conversation groups by itself, and a
 * mixed-project source keeps ONE bucket of its own so it can never be
 * duplicated per project ("zbiorczo dla projektu" + "jedno powiadomienie o
 * źródle"). Deterministic: project ids are sorted.
 */
export function batchBucketOf(scope: BatchScope): string {
  if (scope.kind === "company") {
    return "company";
  }
  const sorted = [...scope.projectIds].sort();
  return sorted.length === 1 ? `project:${sorted[0]}` : `mixed:${sorted.join("|")}`;
}

/** The due instant of one intent accepted/raised at `acceptedAtMs`. */
export function dueAtMsOf(acceptedAtMs: number): number {
  return acceptedAtMs + BATCH_WINDOW_MS;
}

/**
 * Whether an intent accepted at `acceptedAtMs` belongs to the batch firing
 * at `fireAtMs`: the window stays open from the first entry until the
 * batch actually fires, so anything accepted by the fire instant joins the
 * collapsed summary (this is what makes a quiet-hour deferral collapse
 * later arrivals instead of replaying them as separate stale items).
 */
export function joinsBatch(acceptedAtMs: number, fireAtMs: number): boolean {
  return acceptedAtMs <= fireAtMs;
}

/** The shape of the collapsed summary recorded on every delivered intent. */
export interface BatchSummary {
  readonly semanticKind: "source_entry" | "clarification";
  readonly bucket: string;
  readonly scope: BatchScope;
  /** The logical entries this one current summary covers. */
  readonly sourceIds: readonly string[];
  readonly clarificationIds: readonly string[];
  readonly deliveredAtMs: number;
}

/**
 * The closed death-reason vocabulary recorded on suppressed intents. F1's
 * personal-decision suppression reasons are members verbatim (quiet hours
 * never suppress — they defer), so the evaluator records the seam's reason
 * directly.
 */
export const SUPPRESSED_REASONS = [
  "source_no_longer_valid",
  "clarification_resolved",
  "membership_revoked",
  "already_read",
  "own_entry",
  "muted_project",
  "muted_company_entries",
  // F4's reminder mute shares the column; unreachable for this lane's
  // kinds today (the seam only checks it for task reminders).
  "muted_task_reminders",
] as const;
export type SuppressedReason = (typeof SUPPRESSED_REASONS)[number];
