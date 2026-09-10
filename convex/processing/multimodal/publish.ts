/**
 * Stage 6 of the `processing.join_multimodal` workflow (E4): one bounded
 * joined publication group through C1 + C2.
 *
 * The completeness gate runs against a FRESH coverage read (a mid-run
 * re-normalization refuses the group — coordinates never move beneath a
 * published finding), then the mid-run staleness guard, per-evidence
 * fragment ensuring (text ranges, audio intervals, image regions — the
 * evidence carries the anchor coordinates in the fragment-anchor shape,
 * flat for image regions), then C2 prepare + publish with the analysis
 * revisions as caller expectations.
 */

import { Schema } from "effect";
import { v } from "convex/values";
import { okResult, type ResultEnvelope } from "@kiero/contracts";
import {
  decideGroupPublish,
  joinCoverage as joinCoverageOf,
  mediaClaimsBackedByCompleteInputs,
  validateImageRegion,
  type LocatedEvidence,
} from "@kiero/agent";
import { bridgeIdentity, authorSessionId, resolveRequestContext } from "../../platform/context";
import { dispatchMemoryCommand } from "../../memory/findings/dispatch";
import { identifyProjectEntry, performIdentifyProject } from "../../projects/operations";
import { internalMutation, type MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import {
  JOIN_GROUP_BASE,
  JOIN_PUBLISH_STEP_KIND,
  anchorOfEvidence,
  ensureAnchorFragment,
  joinFailureMarkerArmed,
  joinOutcomeMarkerArmed,
  recordJoinStep,
} from "./journal";
import { loadCoverageSourceView } from "./coverageLoader";

/** The wire shape of one joined proposal as the workflow hands it over. */
export interface JoinGroupProposalWire {
  readonly intent: "record" | "correct";
  readonly semanticKey: string;
  /**
   * Located evidence EXACTLY as the reducer accumulated it (the
   * LocatedEvidence union: image items carry the region coordinates FLAT,
   * in the fragment-anchor shape — the coordinate-space authority).
   */
  readonly evidence: readonly LocatedEvidence[];
  readonly replacesFindingId: string | null;
  readonly derivesFromFindingIds: readonly string[];
  readonly readConfidence: number;
  readonly valueWire: unknown;
}

/** One bounded joined group handed to the publish stage. */
export interface JoinGroupStageInput {
  readonly key: { kind: "company" | "project"; projectId: string | null };
  readonly proposals: JoinGroupProposalWire[];
  readonly analysisRevisions: { findingId: string; revision: number }[];
  readonly waitForMedia: boolean;
  readonly bindingDisplayName?: string | null;
}

export const publishJoinGroupStage = internalMutation({
  args: { runId: v.id("processingRuns"), index: v.number(), group: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> =>
    publishJoinGroupTransaction(ctx, {
      runId: args.runId,
      index: args.index,
      group: args.group,
    }),
});

/** The publish transaction (idempotent by step sequence; testable). */
export async function publishJoinGroupTransaction(
  ctx: MutationCtx,
  params: { runId: Id<"processingRuns">; index: number; group: unknown },
): Promise<ResultEnvelope> {
  const group = params.group as JoinGroupStageInput;
  const sequence = JOIN_GROUP_BASE + params.index;
  const run = await ctx.db.get(params.runId);
  if (run === null) {
    throw new Error("join: run row missing");
  }
  const source = await ctx.db.get(run.sourceId);
  if (source === null) {
    throw new Error("join: source row missing");
  }
  const finish = async (state: "succeeded" | "failed", output: unknown) => {
    await recordJoinStep(ctx.db, params.runId, sequence, JOIN_PUBLISH_STEP_KIND, { state, output });
    return okResult({ outcome: output });
  };

  // The deterministic group-isolation proof hook (E3's pattern).
  if (await joinOutcomeMarkerArmed(ctx.db, params.runId, sequence)) {
    return finish("failed", { outcome: "failed", error: "probe_injected_group_failure" });
  }

  // Partial-safe bounding: a group whose evidence waits for unresolved
  // media claims inspection of nothing — recorded pending, never published.
  if (group.waitForMedia) {
    return finish("succeeded", { outcome: "pending_segments", key: group.key });
  }

  // Defensive honesty against a FRESH coverage read: every evidence
  // extraction must still be a complete input (a mid-run re-normalization
  // or a superseded transcript version refuses the group — coordinates
  // never move beneath a published finding; the recovery is a linked
  // reanalysis, which re-joins onto the newer versions).
  const freshView = await loadCoverageSourceView(ctx.db, source._id);
  const freshCoverage = joinCoverageOf(freshView);
  if (!mediaClaimsBackedByCompleteInputs(group, freshCoverage)) {
    return finish("succeeded", { outcome: "pending_segments", key: group.key, fresh: true });
  }

  // --- resolve the group's scope (C1 identification for `new:N`) -------
  let scopeProjectId: Id<"projects"> | null = null;
  if (group.key.kind === "project") {
    const handle = group.key.projectId ?? "";
    if (handle.startsWith("new:")) {
      const displayName = group.bindingDisplayName ?? null;
      if (displayName === null || displayName.trim().length === 0) {
        return finish("failed", { outcome: "failed", error: "project_binding_missing" });
      }
      const session = await authorSessionId(ctx.db, source.authorUserId);
      if (session === null) {
        return finish("failed", { outcome: "failed", error: "actor_session_unavailable" });
      }
      const bridgeContext = await resolveRequestContext(
        ctx.db,
        bridgeIdentity(session, Date.now()),
      );
      if (bridgeContext === null) {
        return finish("failed", { outcome: "failed", error: "actor_context_unresolved" });
      }
      const input = Schema.decodeUnknownSync(identifyProjectEntry.input)({
        displayName,
        initialStage: "inquiry",
        clientId: null,
      });
      const identified = await performIdentifyProject(ctx, bridgeContext, input);
      if (identified._tag !== "ok") {
        return finish("failed", { outcome: "failed", error: identified.error.code });
      }
      const created = identified.value as { projectId: string };
      const normalized = ctx.db.normalizeId("projects", created.projectId);
      if (normalized === null) {
        return finish("failed", { outcome: "failed", error: "project_id_unresolvable" });
      }
      scopeProjectId = normalized;
    } else {
      const normalized = ctx.db.normalizeId("projects", handle);
      if (normalized === null) {
        return finish("failed", { outcome: "failed", error: "project_scope_invalid" });
      }
      const project = await ctx.db.get(normalized);
      if (project === null || project.companyId !== source.companyId) {
        return finish("failed", { outcome: "failed", error: "project_scope_not_found" });
      }
      scopeProjectId = normalized;
    }
  }

  // --- the mid-run staleness guard (E3's rule, joined) ------------------
  const currentRevisions: Record<string, number> = {};
  for (const expectation of group.analysisRevisions) {
    const findingId = ctx.db.normalizeId("findings", expectation.findingId);
    const finding = findingId === null ? null : await ctx.db.get(findingId);
    if (finding === null || finding.companyId !== source.companyId) {
      continue;
    }
    currentRevisions[finding._id] = finding.revisionCounter;
  }
  const decision = decideGroupPublish({
    analysisRevisions: group.analysisRevisions,
    currentRevisions,
  });
  if (decision.decision === "refuse") {
    return finish("succeeded", {
      outcome: "stale_refused",
      key: group.key,
      code: decision.code,
    });
  }

  // --- build the source-linked planned revisions with mixed anchors ----
  const plannedRevisions: unknown[] = [];
  for (const proposal of group.proposals) {
    const evidence: {
      sourceId: string;
      fragmentId: string | null;
      supportKind: string;
      extractionId: string;
    }[] = [];
    for (const item of proposal.evidence) {
      const extractionId = ctx.db.normalizeId("extractions", item.extractionId);
      if (extractionId === null) {
        return finish("failed", { outcome: "failed", error: "extraction_id_invalid" });
      }
      const extraction = await ctx.db.get(extractionId);
      if (extraction === null || extraction.sourceId !== source._id) {
        // Cross-tenant or foreign-source extraction: typed refusal.
        return finish("failed", { outcome: "failed", error: "extraction_not_in_source" });
      }
      if (item._tag === "image_region") {
        // The coordinate-space authority: the region must lie inside the
        // representation the extraction row pins.
        const representationId = extraction.representationId;
        if (representationId === undefined) {
          return finish("failed", { outcome: "failed", error: "vision_extraction_unpinned" });
        }
        const representation = await ctx.db.get(representationId);
        if (representation === null) {
          return finish("failed", { outcome: "failed", error: "representation_row_missing" });
        }
        const check = validateImageRegion(item, {
          width: representation.width ?? 0,
          height: representation.height ?? 0,
        });
        if (!check.valid) {
          return finish("failed", {
            outcome: "failed",
            error: `image_region_invalid:${check.reason}`,
          });
        }
      }
      const fragmentId = await ensureAnchorFragment(
        ctx.db,
        source._id,
        extractionId,
        anchorOfEvidence(item),
      );
      evidence.push({
        sourceId: source._id,
        fragmentId,
        supportKind: "support",
        extractionId,
      });
    }
    plannedRevisions.push({
      findingId: proposal.replacesFindingId,
      scope:
        scopeProjectId === null
          ? { _tag: "company" }
          : { _tag: "project", projectId: scopeProjectId },
      semanticKey: proposal.semanticKey,
      value: proposal.valueWire,
      knowledgeState: { _tag: "known" },
      effectiveFrom: null,
      evidence,
      derivesFrom: proposal.derivesFromFindingIds,
    });
  }

  // --- C2 prepare + publish through the checked dispatch ---------------
  const session = await authorSessionId(ctx.db, source.authorUserId);
  if (session === null) {
    return finish("failed", { outcome: "failed", error: "actor_session_unavailable" });
  }
  const prepared = await dispatchMemoryCommand(
    ctx,
    {
      operation: "memory.prepareChangeSet",
      input: { sourceId: source._id, plannedRevisions },
      expectedRevisions: [],
    },
    session,
  );
  if (prepared._tag !== "ok") {
    return finish("failed", { outcome: "failed", error: prepared.error.code });
  }
  const changeSet = prepared.value as { changeSetId: Id<"changeSets"> };
  const published = await dispatchMemoryCommand(
    ctx,
    {
      operation: "memory.publishChangeSet",
      input: {
        changeSetId: changeSet.changeSetId,
        expectedRevisions: group.analysisRevisions,
      },
      expectedRevisions: [],
    },
    session,
  );
  if (published._tag !== "ok") {
    const kind = published.error.code;
    const stale = kind === "stale_plan" || kind === "caller_expectation_mismatch";
    return finish(stale ? "succeeded" : "failed", {
      outcome: stale ? "stale_refused" : "failed",
      key: group.key,
      error: kind,
    });
  }
  const receipt = published.value as { publishedRevisionIds: Id<"findingRevisions">[] };

  // --- crash-proof hook: the armed marker throws AFTER the writes ------
  if (await joinFailureMarkerArmed(ctx.db, params.runId, sequence)) {
    throw new Error("join: injected failure after group publication");
  }
  return finish("succeeded", {
    outcome: "published",
    key: group.key,
    changeSetId: changeSet.changeSetId,
    revisions: receipt.publishedRevisionIds.length,
    ...(scopeProjectId !== null ? { projectId: scopeProjectId } : {}),
  });
}
