/**
 * Stage 4 of the `processing.join_multimodal` workflow (E4): the bounded
 * joined agent loop through E2's chat adapter.
 *
 * Decoded tool calls accumulate through the multimodal reducer — never
 * execute. The dialogue encoding (the assistant's serialized tool calls,
 * the `WYNIK NARZĘDZIA` result turns) is E3's own prompt builders
 * (`assistantToolCallsMessage`/`toolResultMessage`), imported rather than
 * inlined: `JOIN_PROMPT_VERSION` claims a versioned dialogue encoding, and
 * sharing the builders is what keeps the join's message bytes in lockstep
 * with E3's when either lane adjusts the format.
 */

import { v } from "convex/values";
import {
  runChatTurn,
  type AnyChatToolSpec,
  type ChatCallResult,
  type OpenRouterCredentials,
} from "@kiero/providers";
import {
  JOIN_TOOLS,
  MAX_JOIN_MODEL_TURNS,
  applyMultimodalCall,
  assistantToolCallsMessage,
  emptyJoinPlanNudge,
  emptyMultimodalState,
  joinAnalysisSystemPrompt,
  joinSourceUserMessage,
  toolResultMessage,
  type MultimodalPlanningState,
} from "@kiero/agent";
import { internalAction, internalMutation } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import {
  JOIN_MODEL_SEQUENCE,
  JOIN_MODEL_STEP_KIND,
  joinStepRow,
  recordJoinStep,
} from "./journal";
import type { LoadedJoinResult } from "./join";

/** Records one provider call's attempts (step row + processingAttempts). */
export const recordJoinModelCall = internalMutation({
  args: {
    runId: v.id("processingRuns"),
    turn: v.number(),
    record: v.any(),
    companyId: v.string(),
  },
  handler: async (ctx, args) => {
    const existing = await joinStepRow(ctx.db, args.runId, JOIN_MODEL_SEQUENCE, JOIN_MODEL_STEP_KIND);
    const stepId =
      existing?._id ??
      (await ctx.db.insert("processingSteps", {
        runId: args.runId,
        stepKind: JOIN_MODEL_STEP_KIND,
        sequence: JOIN_MODEL_SEQUENCE,
        state: "running",
        startedAtMs: Date.now(),
      }));
    const attempts = (args.record as { attempts: Record<string, unknown>[] }).attempts;
    let index = 0;
    let highestAttemptNumber = args.turn * 100;
    for (const attempt of attempts) {
      index += 1;
      let attemptNumber = args.turn * 100 + index;
      while (
        (await ctx.db
          .query("processingAttempts")
          .withIndex("by_step_attempt", (q) => q.eq("stepId", stepId).eq("attempt", attemptNumber))
          .first()) !== null
      ) {
        attemptNumber += 1_000;
      }
      highestAttemptNumber = Math.max(highestAttemptNumber, attemptNumber);
      const outcome = attempt.outcome === "succeeded" ? "succeeded" : "failed";
      const model =
        typeof attempt.observedModel === "string"
          ? attempt.observedModel
          : typeof attempt.requestedModel === "string"
            ? attempt.requestedModel
            : null;
      await ctx.db.insert("processingAttempts", {
        stepId: stepId as Id<"processingSteps">,
        attempt: attemptNumber,
        outcome,
        provider: "openrouter",
        ...(model === null ? {} : { model }),
        ...(outcome === "failed" && typeof attempt.failureKind === "string"
          ? { errorKind: attempt.failureKind }
          : {}),
        startedAtMs: typeof attempt.startedAtMs === "number" ? attempt.startedAtMs : Date.now(),
        finishedAtMs: typeof attempt.finishedAtMs === "number" ? attempt.finishedAtMs : Date.now(),
      });
    }
    const success = attempts.find((a) => a.outcome === "succeeded");
    const failure = [...attempts].reverse().find((a) => a.outcome === "failed");
    const named = success ?? failure;
    await ctx.runMutation(internal.integrations.ai.record.recordProviderCall, {
      companyId: args.companyId,
      routeId: "chat_analysis",
      actualModel:
        (typeof named?.observedModel === "string" ? named.observedModel : undefined) ??
        (typeof named?.requestedModel === "string" ? named.requestedModel : undefined) ??
        "unknown",
      outcome: success !== undefined ? "succeeded" : "failed",
      dedupKey: `integrations.modelCall:e4:${args.runId}:turn${args.turn}:a${highestAttemptNumber}`,
    });
  },
});

/** Marks the join model step finished with its bounded summary. */
export const finalizeJoinModelStep = internalMutation({
  args: { runId: v.id("processingRuns"), summary: v.any() },
  handler: async (ctx, args) => {
    await recordJoinStep(ctx.db, args.runId, JOIN_MODEL_SEQUENCE, JOIN_MODEL_STEP_KIND, {
      state: "succeeded",
      output: args.summary,
    });
  },
});

/** The bounded joined agent loop: decoded tool calls accumulate, never execute. */
export const modelJoinStage = internalAction({
  args: { runId: v.id("processingRuns"), loaded: v.any() },
  returns: v.any(),
  handler: async (ctx, args): Promise<MultimodalPlanningState & { turns: number }> => {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (apiKey === undefined || apiKey === "") {
      throw new Error("join: provider_key_not_configured");
    }
    const credentials: OpenRouterCredentials = { apiKey };
    const loaded = args.loaded as LoadedJoinResult;
    const context = loaded.context;
    const tools: AnyChatToolSpec[] = JOIN_TOOLS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      input: tool.input,
    }));
    let state = emptyMultimodalState();
    const messages: {
      role: "user" | "assistant";
      content: { kind: "text"; text: string }[];
    }[] = [
      {
        role: "user",
        content: [{ kind: "text", text: joinSourceUserMessage(context) }],
      },
    ];
    let turns = 0;
    let finalText = "";
    const turnLog: { turn: number; text: string; calls: string[]; results: string[] }[] = [];
    while (turns < MAX_JOIN_MODEL_TURNS) {
      turns += 1;
      const call: ChatCallResult = await runChatTurn(credentials, {
        messages,
        tools,
        systemPrompt: joinAnalysisSystemPrompt(),
      });
      await ctx.runMutation(internal.processing.multimodal.modelStage.recordJoinModelCall, {
        runId: args.runId,
        turn: turns,
        record: call.record,
        companyId: loaded.companyId,
      });
      if (call.outcome.outcome === "failed") {
        const kind = call.outcome.failure.kind;
        const hasValidatedWork =
          state.proposals.length > 0 || state.clarifications.length > 0;
        if ((kind === "output_rejected" || kind === "unknown_tool") && hasValidatedWork) {
          break; // keep the validated partial plan (E3's semantics)
        }
        throw new Error(`join: provider_failed:${kind}`);
      }
      const turn = call.outcome.value;
      finalText = turn.text.slice(0, 600);
      if (turn.toolCalls.length === 0) {
        const empty =
          state.proposals.length === 0 &&
          state.clarifications.length === 0 &&
          state.projectBindings.length === 0;
        if (empty && turns < MAX_JOIN_MODEL_TURNS) {
          messages.push({
            role: "user",
            content: [{ kind: "text", text: emptyJoinPlanNudge() }],
          });
          continue;
        }
        break;
      }
      messages.push({
        role: "assistant",
        content: [{ kind: "text", text: assistantToolCallsMessage(turn.toolCalls) }],
      });
      const turnResults: string[] = [];
      for (const toolCall of turn.toolCalls) {
        const outcome = applyMultimodalCall(
          state,
          context,
          { id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments },
          loaded.companyDefaultCurrency,
        );
        state = outcome.state;
        turnResults.push(outcome.toolResult.slice(0, 200));
        messages.push({
          role: "user",
          content: [{ kind: "text", text: toolResultMessage(toolCall.name, outcome.toolResult) }],
        });
      }
      turnLog.push({
        turn: turns,
        text: turn.text.slice(0, 300),
        calls: turn.toolCalls.map((call_) => call_.name),
        results: turnResults,
      });
    }
    await ctx.runMutation(internal.processing.multimodal.modelStage.finalizeJoinModelStep, {
      runId: args.runId,
      summary: {
        turns,
        proposals: state.proposals.length,
        clarifications: state.clarifications.length,
        projects: state.projectBindings.length,
        finalText,
        turnLog,
      },
    });
    return { ...state, turns };
  },
});
