/**
 * E2 focused verification: the Convex AI dispatch wiring.
 *
 * The dispatch module is driven directly with a FAKE ActionCtx (runQuery
 * answers a fixed resolved context; runMutation records its arguments), so
 * the A3 checked path (envelope decode -> context resolution -> policy ->
 * contract decode -> handler) runs for real offline: no network, no
 * deployment. Provider execution itself is proven by the package-level
 * runner/decode tests and the live-gated smoke; here the seams around it
 * are pinned: the missing-key path, the payload-kind/route-id agreement,
 * the pure event-outcome mapping, and the call summary fallbacks.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  dispatchAiCommand,
  eventOutcome,
  summarize,
  type AiBridgeCtx,
} from "../../convex/integrations/ai/dispatch";
import type { ResultEnvelope } from "@kiero/contracts";

/** A resolved bridge context fixture (structural ActorContext + company). */
const resolvedContext = {
  actor: {
    userId: "users_fixture",
    companyId: "companies_fixture",
    membershipRole: "member",
    isGm: false,
    sessionId: "sessions_fixture",
    via: "user",
  },
  resolvedAtMs: 0,
  normalizedCompanyId: "companies_fixture",
};

/** Builds a fake bridge ctx capturing runMutation calls. */
function fakeBridgeContext(context: unknown) {
  const mutations: { args: Record<string, unknown> }[] = [];
  const ctx = {
    action: {
      runQuery: async () => context,
      runMutation: async (_ref: unknown, args: Record<string, unknown>) => {
        mutations.push({ args });
      },
    },
    serviceSessionId: "sessions_fixture",
  };
  return { ctx: ctx as unknown as AiBridgeCtx, mutations };
}

/** Builds a command envelope for the model-call operation. */
function envelope(input: unknown, idempotencyKey?: string): unknown {
  return {
    operation: "integrations.executeModelCall",
    input,
    expectedRevisions: [],
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  };
}

const savedKey = process.env.OPENROUTER_API_KEY;

afterEach(() => {
  if (savedKey === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = savedKey;
  }
});

function errorOf(result: ResultEnvelope): { _tag: string; code?: string } {
  if (result._tag !== "error") {
    throw new Error("expected an error envelope");
  }
  return { _tag: result.error._tag, code: result.error.code };
}

describe("event outcome mapping (echo uncertain-outcome template)", () => {
  it("maps uncertain external outcomes to timeout_unknown", () => {
    expect(eventOutcome(undefined)).toBe("succeeded");
    expect(eventOutcome("deadline_exceeded")).toBe("timeout_unknown");
    expect(eventOutcome("connection_failed")).toBe("timeout_unknown");
  });

  it("maps definite and incompatible failures to failed", () => {
    expect(eventOutcome("rate_limited")).toBe("failed");
    expect(eventOutcome("provider_unavailable")).toBe("failed");
    expect(eventOutcome("output_rejected")).toBe("failed");
    expect(eventOutcome("internal_error")).toBe("failed");
    expect(eventOutcome("unauthenticated")).toBe("failed");
  });
});

describe("call summary (record -> contract metadata + event record)", () => {
  const base = {
    routeId: "chat_analysis" as const,
    routingConfigVersion: "e2.0",
  };

  it("reports the observed model, tokens and duration on success", () => {
    const outcome = summarize("chat_analysis", {
      record: {
        ...base,
        attempts: [
          {
            ...base,
            requestedModel: "z-ai/glm-5.3-flash",
            observedModel: "z-ai/glm-5.3-flash",
            outcome: "succeeded" as const,
            startedAtMs: 1_000,
            finishedAtMs: 2_000,
            usage: { totalTokens: 41, costUsd: 0.00001 },
          },
        ],
      },
    });
    expect(outcome.kind).toBe("executed");
    if (outcome.kind === "executed") {
      expect(outcome.ok).toBe(true);
      expect(outcome.metadata).toEqual({
        actualModel: "z-ai/glm-5.3-flash",
        usageTokens: 41,
        durationMs: 1_000,
      });
      expect(outcome.summary).toEqual({
        routeId: "chat_analysis",
        actualModel: "z-ai/glm-5.3-flash",
      });
    }
  });

  it("falls back observed -> requested -> unknown for the reported model", () => {
    const withObserved = summarize("chat_analysis", {
      record: {
        ...base,
        attempts: [
          { ...base, requestedModel: "requested/a", outcome: "succeeded" as const, startedAtMs: 0, finishedAtMs: 1 },
        ],
      },
    });
    if (withObserved.kind !== "executed" || withObserved.ok !== true) {
      throw new Error("expected success");
    }
    expect(withObserved.metadata?.actualModel).toBe("requested/a");

    const failed = summarize("speech_to_text", {
      record: {
        routeId: "speech_to_text",
        routingConfigVersion: "e2.0",
        attempts: [
          {
            routeId: "speech_to_text",
            routingConfigVersion: "e2.0",
            requestedModel: "microsoft/mai-transcribe-2",
            observedModel: "microsoft/mai-transcribe-2",
            outcome: "failed" as const,
            failureKind: "rate_limited" as const,
            fallbackEligible: true,
            startedAtMs: 0,
            finishedAtMs: 1,
          },
        ],
      },
    });
    if (failed.kind !== "executed" || failed.ok !== false) {
      throw new Error("expected failure");
    }
    expect(failed.summary).toEqual({
      routeId: "speech_to_text",
      actualModel: "microsoft/mai-transcribe-2",
      failureKind: "rate_limited",
    });
  });
});

describe("dispatchAiCommand (fake ActionCtx, offline)", () => {
  it("denies unauthenticated when the bridge session resolves no context", async () => {
    const { ctx } = fakeBridgeContext(null);
    const result = await dispatchAiCommand(
      ctx,
      envelope({ routeId: "chat_analysis", payload: { kind: "chat_analysis", messages: [] } }),
    );
    expect(errorOf(result)).toMatchObject({ _tag: "unauthenticated" });
  });

  it("fails closed when the provider key is not configured (no provider call)", async () => {
    delete process.env.OPENROUTER_API_KEY;
    const { ctx, mutations } = fakeBridgeContext(resolvedContext);
    const result = await dispatchAiCommand(
      ctx,
      envelope({
        routeId: "chat_analysis",
        payload: { kind: "chat_analysis", messages: [{ role: "user", text: "pytanie" }] },
      }),
    );
    expect(errorOf(result)).toMatchObject({
      _tag: "unavailable",
      code: "provider_key_not_configured",
    });
    expect(mutations).toEqual([]);
  });

  it("rejects an undecodable payload before any provider call", async () => {
    process.env.OPENROUTER_API_KEY = "test-only-not-a-real-key";
    const { ctx, mutations } = fakeBridgeContext(resolvedContext);
    const result = await dispatchAiCommand(
      ctx,
      envelope({ routeId: "chat_analysis", payload: { kind: "nonsense" } }),
    );
    expect(errorOf(result)).toMatchObject({
      _tag: "validation",
      code: "provider_payload_invalid",
    });
    expect(mutations).toEqual([]);
  });

  it("rejects a payload kind that disagrees with the requested route id", async () => {
    process.env.OPENROUTER_API_KEY = "test-only-not-a-real-key";
    const { ctx, mutations } = fakeBridgeContext(resolvedContext);
    // A chat payload must never execute (and be reported) as the embedding
    // route, in either direction.
    const mismatch = await dispatchAiCommand(
      ctx,
      envelope({
        routeId: "embedding",
        payload: { kind: "chat_analysis", messages: [{ role: "user", text: "pytanie" }] },
      }),
    );
    expect(errorOf(mismatch)).toMatchObject({
      _tag: "validation",
      code: "provider_payload_route_mismatch",
    });
    const reverse = await dispatchAiCommand(
      ctx,
      envelope({
        routeId: "chat_analysis",
        payload: { kind: "embedding", text: "wycena", inputKind: "search_document" },
      }),
    );
    expect(errorOf(reverse)).toMatchObject({
      _tag: "validation",
      code: "provider_payload_route_mismatch",
    });
    expect(mutations).toEqual([]);
  });
});
