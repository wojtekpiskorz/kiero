/**
 * The answer-context shape (E6): the tenant-filtered, bounded snapshot one
 * answer run reads, plus the evidence ledger the answer's citations must
 * resolve against.
 *
 * The Convex loader (convex/agent/context.ts) builds it from
 * company-scoped reads only — current findings through the same read the
 * checked `memory.readCurrentFindings` serves, their current witnesses as
 * ledger entries, projects, and recent sources with their processing
 * state ("Relevant newer sources still processing must be disclosed in an
 * answer; unrelated backlog does not block independent confirmed
 * information", protocol step 6).
 *
 * The UPDATING GATE (C5) is applied at load: a finding whose knowledge
 * state is `updating` is carried with `updating: true`, and every evidence
 * entry grounding it is flagged `groundsUpdating`. The reducer refuses to
 * ground an established statement on such evidence — an answer never
 * presents an updating finding as established truth; it discloses it.
 */

/** One project the answer may reference. */
export interface AnswerProject {
  readonly projectId: string;
  readonly displayName: string;
  /** The active codename, when one exists ("Banan"); null while only `#n`. */
  readonly codename: string | null;
}

/** The scope of one finding: firm-wide memory or one project. */
export type AnswerScope =
  | { readonly kind: "company" }
  | { readonly kind: "project"; readonly projectId: string };

/** The knowledge-state tag of one finding's current revision. */
export type AnswerKnowledgeTag =
  | "known"
  | "unknown"
  | "conflicted"
  | "updating"
  | "not_applicable";

/** One current finding as the answer flow sees it (wire value form). */
export interface AnswerFinding {
  readonly findingId: string;
  readonly scope: AnswerScope;
  readonly semanticKey: string;
  /**
   * The revision counter AT LOAD TIME: the input-revision version the
   * staleness recheck compares against before an answer or change lands.
   */
  readonly revisionCounter: number;
  /** Encoded (wire) FindingValue; opaque here, shown to the model. */
  readonly value: unknown;
  readonly knowledgeTag: AnswerKnowledgeTag;
  /**
   * THE updating gate (C5): true when the current revision is the
   * updating-until-revalidated marking — value preserved, excluded from
   * established statements and automation until revalidated.
   */
  readonly updating: boolean;
  /** Ledger handles of this finding's current witnesses. */
  readonly evidenceIds: readonly string[];
}

/** One recent source with its honest processing state. */
export interface AnswerSourceStatus {
  readonly sourceId: string;
  readonly sentAtMs: number;
  readonly preview: string;
  readonly lifecycle: "active" | "withdrawn" | "purged";
  /** Whether the source still has an incomplete processing run. */
  readonly processing: "complete" | "processing" | "none";
}

/** One current task as the answer flow sees it (a domain-change target). */
export interface AnswerTask {
  readonly taskId: string;
  readonly projectId: string;
  readonly title: string;
  /** Do zrobienia / W toku / Czeka / Wykonane / Anulowane. */
  readonly state: "todo" | "in_progress" | "waiting" | "done" | "cancelled";
  readonly revisionCounter: number;
}

/** One current event as the answer flow sees it (a domain-change target). */
export interface AnswerEvent {
  readonly eventId: string;
  readonly projectId: string;
  readonly title: string;
  /** Planowane / Odbyło się / Anulowane. */
  readonly state: "planned" | "occurred" | "cancelled";
  readonly revisionCounter: number;
}

/** One open clarification (Sprawa do wyjaśnienia) the answer may resolve. */
export interface AnswerClarification {
  readonly clarificationId: string;
  readonly question: string;
  readonly scopeKind: "company" | "project";
  readonly scopeProjectId: string | null;
}

/** One catalog contact the answer may name as an executor ("Wykonawca zadania"). */
export interface AnswerContact {
  readonly contactId: string;
  readonly displayName: string;
}

/** One boss membership of the company ("Koordynator zadania" candidates). */
export interface AnswerMembership {
  readonly membershipId: string;
  readonly bossName: string;
}

/**
 * One ledger entry: an inspectable piece of evidence the answer may cite.
 * Entries come from two places only: a finding's current witnesses
 * (loaded with the context) and the run's tenant-scoped evidence search
 * (`fromFindingId: null`). Similarity never establishes truth — an entry
 * is a citation target, never a truth claim.
 */
export interface AnswerEvidenceEntry {
  /** Stable in-run handle ("ev1", "ev2", ...). */
  readonly evidenceId: string;
  readonly sourceId: string;
  readonly sourceSentAtMs: number;
  /** The fragment when one is reliably identifiable; null = whole source. */
  readonly fragmentId: string | null;
  /** Verbatim bounded quote of the evidence. */
  readonly quote: string;
  /** Text-range offsets, when the anchor is a text range; null otherwise. */
  readonly startOffset: number | null;
  readonly endOffset: number | null;
  /** The finding whose witnesses introduced this entry; null for search. */
  readonly groundsFindingId: string | null;
  /** C5 gate: the grounded finding is updating — citable only as disclosure. */
  readonly groundsUpdating: boolean;
}

/** The boss's question, as one immutable accepted source. */
export interface AnswerQuestion {
  readonly sourceId: string;
  readonly authorText: string;
  readonly sentAtMs: number;
  readonly sentAtTimezone: string;
}

/** The full answer context: everything the run legitimately knows. */
export interface AnswerContext {
  readonly question: AnswerQuestion;
  readonly projects: readonly AnswerProject[];
  readonly findings: readonly AnswerFinding[];
  readonly sources: readonly AnswerSourceStatus[];
  readonly tasks: readonly AnswerTask[];
  readonly events: readonly AnswerEvent[];
  /** Open clarifications of the company (resolvable by a new basis). */
  readonly clarifications: readonly AnswerClarification[];
  /** Catalog contacts (executor candidates; no Kiero account needed). */
  readonly contacts: readonly AnswerContact[];
  /** Active boss memberships (coordinator candidates). */
  readonly memberships: readonly AnswerMembership[];
  /** The initial evidence ledger (witnesses of the loaded findings). */
  readonly evidence: readonly AnswerEvidenceEntry[];
  readonly run: {
    /** The answer-run identity linking tool executions and records. */
    readonly runId: string;
    readonly nowMs: number;
  };
}

/** Finds one answer context project by id (the attribution validation). */
export function findAnswerProject(
  context: AnswerContext,
  projectId: string,
): AnswerProject | undefined {
  return context.projects.find((project) => project.projectId === projectId);
}

/** Finds one loaded finding by id. */
export function findAnswerFinding(
  context: AnswerContext,
  findingId: string,
): AnswerFinding | undefined {
  return context.findings.find((finding) => finding.findingId === findingId);
}

/** Finds one loaded task by id (a domain-change target). */
export function findAnswerTask(
  context: AnswerContext,
  taskId: string,
): AnswerTask | undefined {
  return context.tasks.find((task) => task.taskId === taskId);
}

/** Finds one loaded event by id (a domain-change target). */
export function findAnswerEvent(
  context: AnswerContext,
  eventId: string,
): AnswerEvent | undefined {
  return context.events.find((event) => event.eventId === eventId);
}

/** Finds one open clarification by id. */
export function findAnswerClarification(
  context: AnswerContext,
  clarificationId: string,
): AnswerClarification | undefined {
  return context.clarifications.find(
    (clarification) => clarification.clarificationId === clarificationId,
  );
}

/** Finds one catalog contact by id (the executor validation). */
export function findAnswerContact(
  context: AnswerContext,
  contactId: string,
): AnswerContact | undefined {
  return context.contacts.find((contact) => contact.contactId === contactId);
}

/** Finds one boss membership by id (the coordinator validation). */
export function findAnswerMembership(
  context: AnswerContext,
  membershipId: string,
): AnswerMembership | undefined {
  return context.memberships.find(
    (membership) => membership.membershipId === membershipId,
  );
}

/**
 * Whether one finding is ESTABLISHED: current, `known` and not updating.
 * Everything else (conflicted, unknown, updating) is honest EXCLUSION
 * material: disclosed, never asserted. The single home of the predicate
 * (the answer reducer's inference-basis check runs it per finding).
 */
export function isEstablishedFinding(finding: AnswerFinding): boolean {
  return !finding.updating && finding.knowledgeTag === "known";
}

/**
 * The disclosures the context itself owes: findings still updating, and
 * sources newer than the run that are still processing. Both lists are
 * bounded, tenant-filtered and load-bearing for the honest answer.
 */
export function owedDisclosures(context: AnswerContext): {
  readonly updatingFindingIds: readonly string[];
  readonly processingSourceIds: readonly string[];
} {
  return {
    updatingFindingIds: context.findings
      .filter((finding) => finding.updating)
      .map((finding) => finding.findingId),
    processingSourceIds: context.sources
      .filter(
        (source) =>
          source.processing === "processing" &&
          source.sourceId !== context.question.sourceId,
      )
      .map((source) => source.sourceId),
  };
}

/**
 * The load-time revision snapshot the staleness recheck compares against
 * (the answer-flow twin of E3's `revisionSnapshotOf`).
 */
export function answerRevisionSnapshotOf(
  context: AnswerContext,
): { readonly findingId: string; readonly revision: number }[] {
  return context.findings.map((finding) => ({
    findingId: finding.findingId,
    revision: finding.revisionCounter,
  }));
}
