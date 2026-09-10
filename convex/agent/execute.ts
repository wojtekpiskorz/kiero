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
 *   same dispatch, with author and note;
 * - domain changes: C4's `performChangeTask`/`performChangeEvent` cores —
 *   the exact implementations the registered `work.changeTask`/
 *   `work.changeEvent` dispatches run after decode and policy — with the
 *   question source as the recorded evidence basis (`basisSourceId`);
 * - extension values: `memory.validateExtensionValue` through the C3
 *   dispatch (the operation C3 declared "for E6 tools");
 * - the staleness recheck: current revision counters versus the run's
 *   load-time snapshot (`decideAnswerFreshness`).
 */

import { Schema } from "effect";
import { v } from "convex/values";
import { okResult, type ResultEnvelope } from "@kiero/contracts";
import {
  decideAnswerFreshness,
  type AnswerFreshnessDecision,
} from "@kiero/agent/tools";
import { bridgeIdentity, resolveRequestContext } from "../platform/context";
import { dispatchMemoryCommand } from "../memory/findings/dispatch";
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
import type { Id } from "../_generated/dataModel";
import { currentFindingRevisions } from "./context";

/**
 * The author session: the agent acts within the question author's firm
 * permissions through a server-resolved session row (the E3 pattern).
 */
async function authorSessionId(
  db: MutationCtx["db"],
  authorUserId: Id<"users">,
): Promise<Id<"sessions"> | null> {
  const session = await db
    .query("sessions")
    .withIndex("by_user_started", (q) => q.eq("userId", authorUserId))
    .order("desc")
    .filter((q) => q.eq(q.field("revokedAtMs"), undefined))
    .first();
  return session?._id ?? null;
}

/** One cited evidence reference in wire form (as the loop hands it over). */
interface EvidenceWire {
  readonly sourceId: string;
  readonly fragmentId: string | null;
  readonly startOffset: number | null;
  readonly endOffset: number | null;
}

/** Resolves one evidence reference to a fragment id (ensuring it when new). */
async function ensureEvidenceFragment(
  db: MutationCtx["db"],
  companyId: Id<"companies">,
  evidence: EvidenceWire,
): Promise<Id<"sourceFragments"> | null> {
  const sourceId = db.normalizeId("sources", evidence.sourceId);
  const source = sourceId === null ? null : await db.get(sourceId);
  if (source === null || source.companyId !== companyId) {
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
    // Whole-source basis when no reliable fragment/extraction exists.
    return ensureFragment(db, source._id, await requireWholeSourceExtraction(db, source._id), {
      _tag: "whole_source",
    });
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

/** The fallback extraction for whole-source evidence (D1 seeds text rows). */
async function requireWholeSourceExtraction(
  db: MutationCtx["db"],
  sourceId: Id<"sources">,
): Promise<Id<"extractions">> {
  const resolved = await resolveTextExtraction(db, sourceId, null);
  if (resolved !== null) {
    return resolved;
  }
  throw new Error("agent: text_extraction_missing");
}

// ---------------------------------------------------------------------------
// Clarifications (Sprawa do wyjaśnienia, source-backed through C2).
// ---------------------------------------------------------------------------

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
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const source = await ctx.db.get(args.questionSourceId);
    if (source === null) {
      return okResult({ outcome: "failed", error: "question_source_missing" });
    }
    const session = await authorSessionId(ctx.db, source.authorUserId);
    if (session === null) {
      return okResult({ outcome: "failed", error: "actor_session_unavailable" });
    }
    const fragmentIds: Id<"sourceFragments">[] = [];
    for (const evidence of args.evidence) {
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
  },
});

export const executeResolveClarification = internalMutation({
  args: {
    questionSourceId: v.id("sources"),
    clarificationId: v.id("clarifications"),
    resolutionNote: v.string(),
  },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const source = await ctx.db.get(args.questionSourceId);
    if (source === null) {
      return okResult({ outcome: "failed", error: "question_source_missing" });
    }
    const session = await authorSessionId(ctx.db, source.authorUserId);
    if (session === null) {
      return okResult({ outcome: "failed", error: "actor_session_unavailable" });
    }
    const result = await dispatchMemoryCommand(
      ctx,
      {
        operation: "memory.resolveClarification",
        input: {
          clarificationId: args.clarificationId,
          resolutionNote: args.resolutionNote,
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
  },
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
    const source = await ctx.db.get(args.questionSourceId);
    if (source === null) {
      return okResult({ outcome: "failed", error: "question_source_missing" });
    }
    const session = await authorSessionId(ctx.db, source.authorUserId);
    if (session === null) {
      return okResult({ outcome: "failed", error: "actor_session_unavailable" });
    }
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
    const source = await ctx.db.get(args.questionSourceId);
    if (source === null) {
      return okResult({ outcome: "failed", error: "question_source_missing" });
    }
    const session = await authorSessionId(ctx.db, source.authorUserId);
    if (session === null) {
      return okResult({ outcome: "failed", error: "actor_session_unavailable" });
    }
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

export const stalenessRecheck = internalMutation({
  args: {
    questionSourceId: v.id("sources"),
    loadRevisions: v.array(
      v.object({ findingId: v.id("findings"), revision: v.float64() }),
    ),
  },
  handler: async (ctx, args): Promise<{ decision: AnswerFreshnessDecision }> => {
    const source = await ctx.db.get(args.questionSourceId);
    if (source === null) {
      return {
        decision: {
          decision: "refresh",
          moved: args.loadRevisions.map((expectation) => ({
            findingId: expectation.findingId,
            loadRevision: expectation.revision,
            currentRevision: expectation.revision,
          })),
        },
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
  },
});
