/**
 * The checked executions of the answer flow (E6): one internal mutation
 * per write tool, each running the SAME checked domain path the UI uses —
 * never a raw write.
 *
 * Identity is the E3 precedent ("Działa w zakresie uprawnień użytkownika i
 * firmy", issue 8): the agent acts through the QUESTION SOURCE AUTHOR's
 * server-resolved session — never client input, never a fabricated
 * identity — so every execution lands inside the asker's firm permissions.
 *
 * - clarifications: `memory.raiseClarification` through the C2 dispatch
 *   (fragment-typed conflicting evidence; publishes `memory.
 *   clarificationRaised`, the event vocabulary F2 consumes);
 * - clarification resolution: `memory.resolveClarification` through the
 *   same dispatch, with author, note and — R1 (issue #126) — the cited
 *   evidence validated against the current ledger (company-owned ACTIVE
 *   source, matching fragment) and persisted with the resolution;
 * - domain changes: C4's `performChangeTask`/`performChangeEvent` cores —
 *   the exact implementations the registered `work.changeTask`/
 *   `work.changeEvent` dispatches run after decode and policy — with the
 *   question source as the recorded evidence basis (`basisSourceId`);
 * - extension values: `memory.validateExtensionValue` through the C3
 *   dispatch (the operation C3 declared "for E6 tools");
 * - the staleness recheck: current revision counters versus the run's
 *   load-time snapshot (`decideAnswerFreshness`).
 *
 * R2 (issue #127) adds the ONE agent-entry rule to every execution above:
 * the question source's accepted LIFECYCLE decides, not row existence — a
 * retained tombstone (permanent deletion) refuses the execution with the
 * typed `question_source_not_active` code before any write or event, and
 * the staleness recheck ABORTS on it so a computed answer can never land
 * over a deleted world. Cited evidence was already lifecycle-checked by R1
 * (`checkResolutionEvidenceReference`); the raise path now refuses an
 * inactive conflicting-evidence source the same way.
 */

import { Schema } from "effect";
import { v } from "convex/values";
import { okResult, type ResultEnvelope } from "@kiero/contracts";
import {
  decideAnswerFreshness,
  type AnswerEvidenceEntry,
  type AnswerFreshnessDecision,
} from "@kiero/agent/tools";
import {
  authorSessionId,
  bridgeIdentity,
  resolveRequestContext,
} from "../platform/context";
import { dispatchMemoryCommand } from "../memory/findings/dispatch";
import {
  checkResolutionEvidenceReference,
  requireActiveSource,
  requireSource,
} from "../memory/findings/references";
import {
  ensureFragment,
  resolveTextExtraction,
} from "../processing/text/journal";
import {
  changeEventEntry,
  changeTaskEntry,
  performChangeEvent,
  performChangeTask,
} from "../work/operations";
import { internalMutation, type MutationCtx } from "../_generated/server";
import type { Doc, Id } from "../_generated/dataModel";
import { currentFindingRevisions } from "./context";

/** One cited evidence reference in wire form (as the loop hands it over). */
interface EvidenceWire {
  readonly sourceId: string;
  readonly fragmentId: string | null;
  readonly startOffset: number | null;
  readonly endOffset: number | null;
}

/**
 * Resolves one evidence reference to a fragment id (ensuring it when new).
 * R2 (issue #127): only an ACTIVE company source can anchor evidence
 * (`requireActiveSource`, the one dead-source predicate) — a retained
 * tombstone is a dead anchor, never a place to ensure a fragment.
 */
async function ensureEvidenceFragment(
  db: MutationCtx["db"],
  companyId: Id<"companies">,
  evidence: EvidenceWire,
): Promise<Id<"sourceFragments"> | null> {
  const source = await requireActiveSource(db, evidence.sourceId, companyId);
  if (source === null) {
    return null;
  }
  if (evidence.fragmentId !== null) {
    const fragmentId = db.normalizeId("sourceFragments", evidence.fragmentId);
    const fragment = fragmentId === null ? null : await db.get(fragmentId);
    if (fragment !== null && fragment.sourceId === source._id) {
      return fragment._id;
    }
  }
  const extractionId = await resolveTextExtraction(db, source._id, null);
  if (extractionId === null) {
    // No text extraction exists for this source (D1 seeds text rows, so
    // this is a genuine anomaly): the evidence cannot be anchored at all.
    throw new Error("agent: text_extraction_missing");
  }
  if (evidence.startOffset === null || evidence.endOffset === null) {
    return ensureFragment(db, source._id, extractionId, { _tag: "whole_source" });
  }
  return ensureFragment(db, source._id, extractionId, {
    _tag: "text_range",
    startOffset: evidence.startOffset,
    endOffset: evidence.endOffset,
  });
}

// ---------------------------------------------------------------------------
// The one agent-entry preamble (R2, issue #127).
// ---------------------------------------------------------------------------

/** The typed refusals the question-source preamble can return. */
export type QuestionSourceRefusal =
  | "question_source_missing"
  | "question_source_not_active"
  | "actor_session_unavailable";

/** The resolved preamble: the ACTIVE question source and the author session. */
export type QuestionSourceEntry =
  | {
      readonly ok: true;
      readonly source: Doc<"sources">;
      readonly session: NonNullable<Awaited<ReturnType<typeof authorSessionId>>>;
    }
  | { readonly ok: false; readonly error: QuestionSourceRefusal };

/**
 * R2 (issue #127): the ONE preamble every checked execution shares — the
 * question source's accepted LIFECYCLE decides, not row existence (a
 * retained tombstone refuses with the typed `question_source_not_active`
 * code), and the author's server-resolved session must exist. Callers wrap
 * the refusal in their own result envelope; nothing was written.
 */
async function requireQuestionSourceSession(
  db: MutationCtx["db"],
  questionSourceId: Id<"sources">,
): Promise<QuestionSourceEntry> {
  const source = await db.get(questionSourceId);
  if (source === null) {
    return { ok: false, error: "question_source_missing" };
  }
  if (source.lifecycle !== "active") {
    return { ok: false, error: "question_source_not_active" };
  }
  const session = await authorSessionId(db, source.authorUserId);
  if (session === null) {
    return { ok: false, error: "actor_session_unavailable" };
  }
  return { ok: true, source, session };
}

// ---------------------------------------------------------------------------
// Clarifications (Sprawa do wyjaśnienia, source-backed through C2).
// ---------------------------------------------------------------------------

/** The checked raise execution's input (exported for the deterministic tests). */
export interface ExecuteClarificationInput {
  readonly questionSourceId: Id<"sources">;
  readonly question: string;
  readonly scopeKind: "company" | "project";
  readonly projectId?: Id<"projects">;
  readonly evidence?: readonly {
    sourceId: Id<"sources">;
    fragmentId?: Id<"sourceFragments">;
    startOffset?: number;
    endOffset?: number;
  }[];
}

/**
 * The checked raise execution body (R2): the QUESTION source must be
 * ACTIVE (a retained tombstone refuses with a typed code — late work
 * publishes nothing), every conflicting-evidence source must be active
 * too, and the final command runs the C2 dispatch whose own fragment
 * checks re-verify the same lifecycle (each layer checks end to end).
 */
export async function executeClarificationCore(
  ctx: MutationCtx,
  args: ExecuteClarificationInput,
): Promise<ResultEnvelope> {
  const entry = await requireQuestionSourceSession(ctx.db, args.questionSourceId);
  if (!entry.ok) {
    // R2 (issue #127): a tombstone between model work and commit is a typed
    // refusal — no row, no event, nothing published over the deleted world.
    return okResult({ outcome: "failed", error: entry.error });
  }
  const { source, session } = entry;
  const fragmentIds: Id<"sourceFragments">[] = [];
  for (const evidence of args.evidence ?? []) {
    const evidenceSource = await requireSource(ctx.db, evidence.sourceId, source.companyId);
    if (evidenceSource !== null && evidenceSource.lifecycle !== "active") {
      // An inactive cited source is a REFUSAL, not a silent drop: a raise
      // computed against a world that included the now-deleted source must
      // not publish a narrower case over that deletion.
      return okResult({ outcome: "failed", error: "conflicting_evidence_source_not_active" });
    }
    const fragmentId = await ensureEvidenceFragment(ctx.db, source.companyId, {
      sourceId: evidence.sourceId,
      fragmentId: evidence.fragmentId ?? null,
      startOffset: evidence.startOffset ?? null,
      endOffset: evidence.endOffset ?? null,
    });
    if (fragmentId !== null) {
      fragmentIds.push(fragmentId);
    }
  }
  if (fragmentIds.length === 0) {
    return okResult({ outcome: "failed", error: "conflicting_evidence_unresolvable" });
  }
  const result = await dispatchMemoryCommand(
    ctx,
    {
      operation: "memory.raiseClarification",
      input: {
        question: args.question,
        conflictingEvidence: fragmentIds,
        scope:
          args.scopeKind === "company"
            ? { _tag: "company" }
            : { _tag: "project", projectId: args.projectId },
      },
      expectedRevisions: [],
    },
    session,
  );
  if (result._tag !== "ok") {
    return okResult({ outcome: "failed", error: result.error.code });
  }
  const receipt = result.value as { clarificationId: Id<"clarifications"> };
  return okResult({ outcome: "raised", clarificationId: receipt.clarificationId });
}

export const executeClarification = internalMutation({
  args: {
    questionSourceId: v.id("sources"),
    question: v.string(),
    scopeKind: v.union(v.literal("company"), v.literal("project")),
    projectId: v.optional(v.id("projects")),
    evidence: v.array(
      v.object({
        sourceId: v.id("sources"),
        fragmentId: v.optional(v.id("sourceFragments")),
        startOffset: v.optional(v.float64()),
        endOffset: v.optional(v.float64()),
      }),
    ),
  },
  handler: (ctx, args) => executeClarificationCore(ctx, args),
});

/**
 * One normalized resolution-evidence reference the checked memory command
 * receives: the source plus the fragment the citation anchored to (every
 * reference resolves to a durable fragment; the nullable type mirrors
 * ensureEvidenceFragment's contract).
 */
interface NormalizedEvidenceReference {
  readonly sourceId: Id<"sources">;
  readonly fragmentId: Id<"sourceFragments"> | null;
}

/**
 * R1 (issue #126): validates the run's resolve evidence against the
 * CURRENT ledger state and normalizes it to durable references. Pass 1
 * validates every reference BEFORE anything is ensured or written, through
 * the ONE shared per-reference rule (../memory/findings/references —
 * existence, company, active lifecycle, fragment ownership; an invalid
 * reference refuses the whole execution); pass 2 anchors fragment-less
 * references through the extraction journal (whole-source or text-range
 * fragments) and collapses duplicates AFTER anchoring (a pre-anchor key
 * cannot see that two offset citations anchor onto the same fragment).
 */
async function resolveEvidenceReferences(
  db: MutationCtx["db"],
  companyId: Id<"companies">,
  evidence: readonly EvidenceWire[],
): Promise<
  | { readonly ok: true; readonly references: readonly NormalizedEvidenceReference[] }
  | { readonly ok: false; readonly error: string }
> {
  for (const reference of evidence) {
    const refusal = await checkResolutionEvidenceReference(db, companyId, reference);
    if (refusal !== null) {
      return { ok: false, error: refusal };
    }
  }
  const references: NormalizedEvidenceReference[] = [];
  const seen = new Set<string>();
  for (const reference of evidence) {
    const sourceId = db.normalizeId("sources", reference.sourceId);
    if (sourceId === null) {
      return { ok: false, error: "resolution_source_not_found" };
    }
    // ensureEvidenceFragment re-reads the (already validated) source and
    // anchors the citation as a durable fragment when none was cited.
    const fragmentId = await ensureEvidenceFragment(db, companyId, reference);
    const deduplicationKey = `${sourceId}#${fragmentId ?? ""}`;
    if (seen.has(deduplicationKey)) {
      continue;
    }
    seen.add(deduplicationKey);
    references.push({ sourceId, fragmentId });
  }
  return { ok: true, references };
}

/** One cited evidence reference in the FINAL wire shape the executor takes. */
export interface ResolveEvidenceHandleReference {
  readonly sourceId: Id<"sources">;
  readonly fragmentId?: Id<"sourceFragments">;
  readonly startOffset?: number;
  readonly endOffset?: number;
}

/** The loop-side handle mapping's result: the references, or the first gap. */
export interface ResolvedEvidenceHandles {
  /**
   * Deduplicated, first-occurrence-order wire references (final shape).
   * A mutable array: the generated mutation args take one as-is.
   */
  readonly references: ResolveEvidenceHandleReference[];
  /** The first cited handle absent from the ledger, when one is. */
  readonly missingHandle: string | null;
}

/**
 * R1 (issue #126): maps cited ledger handles to the FINAL wire references
 * `executeResolveClarification` receives — deduplicated, first-occurrence
 * order, the optional-spread shape produced ONCE (no intermediate
 * nulls-shaped pass to re-map). Pure over the run's evidence ledger; the
 * reducer has already refused unresolved handles by dispatch time, so
 * `missingHandle` (one that vanished anyway) lets the loop refuse honestly
 * instead of silently dropping the evidence it cited.
 */
export function resolveEvidenceHandles(
  evidence: readonly AnswerEvidenceEntry[],
  handles: readonly string[],
): ResolvedEvidenceHandles {
  const references: ResolveEvidenceHandleReference[] = [];
  const seen = new Set<string>();
  for (const handle of handles) {
    if (seen.has(handle)) {
      continue;
    }
    seen.add(handle);
    const entry = evidence.find((candidate) => candidate.evidenceId === handle);
    if (entry === undefined) {
      return { references, missingHandle: handle };
    }
    references.push({
      sourceId: entry.sourceId as Id<"sources">,
      ...(entry.fragmentId === null
        ? {}
        : { fragmentId: entry.fragmentId as Id<"sourceFragments"> }),
      ...(entry.startOffset === null ? {} : { startOffset: entry.startOffset }),
      ...(entry.endOffset === null ? {} : { endOffset: entry.endOffset }),
    });
  }
  return { references, missingHandle: null };
}

/** The checked resolve execution's input (exported for the deterministic tests). */
export interface ExecuteResolveClarificationInput {
  readonly questionSourceId: Id<"sources">;
  readonly clarificationId: Id<"clarifications">;
  readonly resolutionNote: string;
  readonly evidence?: readonly ResolveEvidenceHandleReference[];
}

/**
 * The checked resolve execution body (R1): resolves the cited evidence
 * against the current ledger, refuses atomically on any invalid reference,
 * and runs `memory.resolveClarification` with the normalized references so
 * the resolution transaction persists them with its basis.
 */
export async function executeResolveClarificationCore(
  ctx: MutationCtx,
  args: ExecuteResolveClarificationInput,
): Promise<ResultEnvelope> {
  const entry = await requireQuestionSourceSession(ctx.db, args.questionSourceId);
  if (!entry.ok) {
    // R2 (issue #127): the accepted lifecycle, not row existence — a late
    // resolve over a tombstoned question world refuses, publishes nothing.
    return okResult({ outcome: "failed", error: entry.error });
  }
  const { source, session } = entry;
  const evidence: EvidenceWire[] = (args.evidence ?? []).map((reference) => ({
    sourceId: reference.sourceId,
    fragmentId: reference.fragmentId ?? null,
    startOffset: reference.startOffset ?? null,
    endOffset: reference.endOffset ?? null,
  }));
  // Current-ledger validation FIRST: any invalid reference refuses the
  // whole execution before a fragment is ensured or the command runs.
  const normalized = await resolveEvidenceReferences(ctx.db, source.companyId, evidence);
  if (!normalized.ok) {
    return okResult({ outcome: "failed", error: normalized.error });
  }
  const result = await dispatchMemoryCommand(
    ctx,
    {
      operation: "memory.resolveClarification",
      input: {
        clarificationId: args.clarificationId,
        resolutionNote: args.resolutionNote,
        evidence: normalized.references.map((reference) => ({
          sourceId: reference.sourceId,
          fragmentId: reference.fragmentId,
        })),
      },
      expectedRevisions: [],
    },
    session,
  );
  if (result._tag !== "ok") {
    return okResult({ outcome: "failed", error: result.error.code });
  }
  const receipt = result.value as { clarificationId: Id<"clarifications"> };
  return okResult({ outcome: "resolved", clarificationId: receipt.clarificationId });
}

export const executeResolveClarification = internalMutation({
  args: {
    questionSourceId: v.id("sources"),
    clarificationId: v.id("clarifications"),
    resolutionNote: v.string(),
    evidence: v.optional(
      v.array(
        v.object({
          sourceId: v.id("sources"),
          fragmentId: v.optional(v.id("sourceFragments")),
          startOffset: v.optional(v.float64()),
          endOffset: v.optional(v.float64()),
        }),
      ),
    ),
  },
  handler: (ctx, args) => executeResolveClarificationCore(ctx, args),
});

// ---------------------------------------------------------------------------
// Domain changes through C4's checked cores (the question source = basis).
// ---------------------------------------------------------------------------

export const executeWorkChange = internalMutation({
  args: {
    questionSourceId: v.id("sources"),
    kind: v.union(v.literal("task"), v.literal("event")),
    input: v.any(),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const entry = await requireQuestionSourceSession(ctx.db, args.questionSourceId);
    if (!entry.ok) {
      // R2 (issue #127): one agent-entry rule — every checked execution
      // refuses a tombstoned question source (existence alone lies).
      return okResult({ outcome: "failed", error: entry.error });
    }
    const { source, session } = entry;
    const context = await resolveRequestContext(
      ctx.db,
      bridgeIdentity(session, Date.now()),
    );
    if (context === null) {
      return okResult({ outcome: "failed", error: "actor_context_unresolved" });
    }
    // The question source is the recorded evidence basis of the change
    // ("Każda zmiana zachowuje autora, czas i podstawę").
    const wire = { ...(args.input as Record<string, unknown>), basisSourceId: source._id };
    if (args.kind === "task") {
      const decoded = Schema.decodeUnknownSync(changeTaskEntry.input)(wire);
      const result = await performChangeTask(ctx, context, decoded);
      if (result._tag !== "ok") {
        return okResult({ outcome: "failed", error: result.error.code });
      }
      const receipt = result.value as { taskId: Id<"tasks"> };
      const task = await ctx.db.get(receipt.taskId);
      return okResult({
        outcome: "changed",
        entityId: receipt.taskId,
        revision: task?.revisionCounter ?? 1,
      });
    }
    const decoded = Schema.decodeUnknownSync(changeEventEntry.input)(wire);
    const result = await performChangeEvent(ctx, context, decoded);
    if (result._tag !== "ok") {
      return okResult({ outcome: "failed", error: result.error.code });
    }
    const receipt = result.value as { eventId: Id<"events"> };
    const event = await ctx.db.get(receipt.eventId);
    return okResult({
      outcome: "changed",
      entityId: receipt.eventId,
      revision: event?.revisionCounter ?? 1,
    });
  },
});

// ---------------------------------------------------------------------------
// Extension values: C3's validate-value operation for E6 tools.
// ---------------------------------------------------------------------------

export const executeExtensionValidate = internalMutation({
  args: {
    questionSourceId: v.id("sources"),
    versionId: v.id("extensionVersions"),
    value: v.any(),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const entry = await requireQuestionSourceSession(ctx.db, args.questionSourceId);
    if (!entry.ok) {
      // R2 (issue #127): the one agent-entry rule (see executeWorkChange).
      return okResult({ outcome: "failed", error: entry.error });
    }
    const { session } = entry;
    const result = await dispatchMemoryCommand(
      ctx,
      {
        operation: "memory.validateExtensionValue",
        input: { versionId: args.versionId, value: args.value },
        expectedRevisions: [],
      },
      session,
    );
    if (result._tag !== "ok") {
      return okResult({ outcome: "failed", error: result.error.code });
    }
    return okResult({ outcome: "valid", ...(result.value as object) });
  },
});

// ---------------------------------------------------------------------------
// The staleness recheck (in-flight answer/change guard).
// ---------------------------------------------------------------------------

/** The staleness recheck's input (exported for the deterministic tests). */
export interface StalenessRecheckInput {
  readonly questionSourceId: Id<"sources">;
  readonly loadRevisions: readonly { findingId: Id<"findings">; revision: number }[];
}

/** The staleness recheck body (exported for the deterministic tests). */
export async function stalenessRecheckCore(
  ctx: MutationCtx,
  args: StalenessRecheckInput,
): Promise<{ decision: AnswerFreshnessDecision }> {
  const source = await ctx.db.get(args.questionSourceId);
  if (source === null) {
    // The question source vanished mid-run: the honest decision is an
    // ABORT (never a fabricated refresh shape decideAnswerFreshness
    // cannot produce). The loop REFUSES the submit, so the answer
    // never lands over a world whose question no longer exists.
    return {
      decision: { decision: "abort", reason: "question_source_missing" },
    };
  }
  if (source.lifecycle !== "active") {
    // R2 (issue #127): I4 RETAINS a tombstone row, so existence alone
    // would let a computed answer land over a permanently deleted world.
    // The accepted lifecycle decides: a tombstone never counts as active.
    return {
      decision: { decision: "abort", reason: "question_source_not_active" },
    };
  }
  const current = await currentFindingRevisions(
    ctx.db,
    source.companyId,
    args.loadRevisions,
  );
  return {
    decision: decideAnswerFreshness({
      loadRevisions: args.loadRevisions,
      currentRevisions: current,
    }),
  };
}

export const stalenessRecheck = internalMutation({
  args: {
    questionSourceId: v.id("sources"),
    loadRevisions: v.array(
      v.object({ findingId: v.id("findings"), revision: v.float64() }),
    ),
  },
  handler: (ctx, args) => stalenessRecheckCore(ctx, args),
});
