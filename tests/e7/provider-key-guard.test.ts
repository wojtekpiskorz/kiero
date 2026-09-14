/**
 * R14 focused verification (issue #187): the DEEPSEEK_API_KEY missing-key
 * guard at the AI dispatch boundary, and the no-silent-route-change
 * discipline on the missing-key path.
 *
 * The dispatch module is driven directly with a FAKE ActionCtx (the
 * tests/e2 dispatch pattern): the A3 checked path runs for real offline
 * and the seams around provider execution are pinned:
 *
 * - a chat/vision route (whose frozen e8.0 order starts at the direct
 *   DeepSeek primary) refuses when DEEPSEEK_API_KEY is absent, after pure
 *   payload validation but before any provider call: the honest typed
 *   `unavailable` refusal mirroring the OpenRouter guard, with no
 *   completion event published;
 * - the refusal names the absent credential's provider in its
 *   machine-readable code (`provider_deepseek_key_not_configured`; the
 *   closed ErrorCode contract is snake_case, unlike the raw error the
 *   answer loop throws), while the OpenRouter guard's pinned code is
 *   unchanged;
 * - OpenRouter-only routes (STT, embeddings) never demand the DeepSeek
 *   key: execution proceeds past the guard into payload validation;
 * - at the runner boundary, a direct DeepSeek target with no resolvable
 *   credential classifies TERMINALLY (`unauthenticated`, not
 *   fallback-eligible), so a missing primary key can never silently
 *   activate the authorized OpenRouter fallback (the 401-rejected analog
 *   is pinned in tests/e2/fallback.test.ts);
 * - both label consumers (E3's analyze, E6's loop) compose the identical
 *   `e2.routing/<version>#chat_analysis` label from the frozen routing
 *   version, which the unbounded-string persistence columns carry whole;
 * - the per-attempt supplier on `processingAttempts` rows comes from the
 *   call record's provider column (a DeepSeek-direct walk records
 *   `deepseek` and `openrouter` distinctly; a legacy pre-split record
 *   without the optional column defaults to `openrouter`).
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  chatAttempt,
  ROUTING_CONFIG_VERSION,
  type ChatAttemptRequest,
  type ChatTurnCredentials,
  type RouteTarget,
} from "@kiero/providers";
import {
  dispatchAiCommand,
  type AiBridgeCtx,
} from "../../convex/integrations/ai/dispatch";
import {
  MODEL_CONFIGURATION_VERSION,
  recordModelCallHandler,
} from "../../convex/processing/text/analyze";
import { ANSWER_MODEL_CONFIGURATION_VERSION } from "../../convex/agent/loop";
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
function fakeBridgeContext() {
  const mutations: { args: Record<string, unknown> }[] = [];
  const ctx = {
    action: {
      runQuery: async () => resolvedContext,
      runMutation: async (_ref: unknown, args: Record<string, unknown>) => {
        mutations.push({ args });
      },
    },
    serviceSessionId: "sessions_fixture",
  };
  return { ctx: ctx as unknown as AiBridgeCtx, mutations };
}

/** Builds a command envelope for the model-call operation. */
function envelope(input: unknown): unknown {
  return {
    operation: "integrations.executeModelCall",
    input,
    expectedRevisions: [],
  };
}

function errorOf(result: ResultEnvelope): { _tag: string; code?: string } {
  if (result._tag !== "error") {
    throw new Error("expected an error envelope");
  }
  return { _tag: result.error._tag, code: result.error.code };
}

// Fixture credential strings, never real keys; only presence matters.
const FIXTURE_OPENROUTER_KEY = "test-only-not-a-real-key";
const FIXTURE_DEEPSEEK_KEY = "test-only-not-a-real-key";

const savedOpenRouterKey = process.env.OPENROUTER_API_KEY;
const savedDeepSeekKey = process.env.DEEPSEEK_API_KEY;

function setKeys(openRouter: string | undefined, deepSeek: string | undefined): void {
  if (openRouter === undefined) {
    delete process.env.OPENROUTER_API_KEY;
  } else {
    process.env.OPENROUTER_API_KEY = openRouter;
  }
  if (deepSeek === undefined) {
    delete process.env.DEEPSEEK_API_KEY;
  } else {
    process.env.DEEPSEEK_API_KEY = deepSeek;
  }
}

afterEach(() => {
  setKeys(savedOpenRouterKey, savedDeepSeekKey);
});

describe("the DEEPSEEK_API_KEY missing-key guard (AI dispatch, offline)", () => {
  it("refuses a chat_analysis call up front when the direct key is absent (no provider call)", async () => {
    setKeys(FIXTURE_OPENROUTER_KEY, undefined);
    const { ctx, mutations } = fakeBridgeContext();
    const result = await dispatchAiCommand(
      ctx,
      envelope({
        routeId: "chat_analysis",
        payload: { kind: "chat_analysis", messages: [{ role: "user", text: "pytanie" }] },
      }),
    );
    expect(errorOf(result)).toEqual({
      _tag: "unavailable",
      code: "provider_deepseek_key_not_configured",
    });
    // Nothing executed, so no providerCallCompleted event was published.
    expect(mutations).toEqual([]);
  });

  it("refuses a vision_extraction call the same way (its frozen order also starts at the direct primary)", async () => {
    setKeys(FIXTURE_OPENROUTER_KEY, undefined);
    const { ctx, mutations } = fakeBridgeContext();
    // A well-formed vision payload: the guard runs after pure payload
    // validation, so the refusal proves the key check, not a decode skip.
    const result = await dispatchAiCommand(
      ctx,
      envelope({
        routeId: "vision_extraction",
        payload: {
          kind: "vision_extraction",
          instruction: "odczytaj kwotę z dokumentu",
          images: [{ base64: "Zm9vYmFyYmF6cXV1eDEy", mimeType: "image/png" }],
        },
      }),
    );
    expect(errorOf(result)).toEqual({
      _tag: "unavailable",
      code: "provider_deepseek_key_not_configured",
    });
    expect(mutations).toEqual([]);
  });

  it("never demands the direct key for the OpenRouter-only routes (STT, embeddings)", async () => {
    setKeys(FIXTURE_OPENROUTER_KEY, undefined);
    const { ctx, mutations } = fakeBridgeContext();
    // An undecodable payload proves execution got PAST the key guards and
    // into payload validation: the DeepSeek guard must not have fired.
    const embedding = await dispatchAiCommand(
      ctx,
      envelope({ routeId: "embedding", payload: { kind: "nonsense" } }),
    );
    expect(errorOf(embedding)).toEqual({
      _tag: "validation",
      code: "provider_payload_invalid",
    });
    const stt = await dispatchAiCommand(
      ctx,
      envelope({ routeId: "speech_to_text", payload: { kind: "nonsense" } }),
    );
    expect(errorOf(stt)).toEqual({
      _tag: "validation",
      code: "provider_payload_invalid",
    });
    expect(mutations).toEqual([]);
  });

  it("keeps the mirrored OpenRouter guard and its pinned code unchanged", async () => {
    setKeys(undefined, FIXTURE_DEEPSEEK_KEY);
    const { ctx, mutations } = fakeBridgeContext();
    const result = await dispatchAiCommand(
      ctx,
      envelope({
        routeId: "chat_analysis",
        payload: { kind: "chat_analysis", messages: [{ role: "user", text: "pytanie" }] },
      }),
    );
    expect(errorOf(result)).toEqual({
      _tag: "unavailable",
      code: "provider_key_not_configured",
    });
    expect(mutations).toEqual([]);
  });

  it("requires only presence: an empty direct key value refuses like an absent one", async () => {
    setKeys(FIXTURE_OPENROUTER_KEY, "");
    const { ctx, mutations } = fakeBridgeContext();
    const result = await dispatchAiCommand(
      ctx,
      envelope({
        routeId: "chat_analysis",
        payload: { kind: "chat_analysis", messages: [{ role: "user", text: "pytanie" }] },
      }),
    );
    expect(errorOf(result)).toEqual({
      _tag: "unavailable",
      code: "provider_deepseek_key_not_configured",
    });
    expect(mutations).toEqual([]);
  });
});

describe("no fallback activation on the missing-key path (runner boundary)", () => {
  it("classifies a direct DeepSeek target without any credential terminal, never fallback-eligible", async () => {
    setKeys(undefined, undefined);
    const target: RouteTarget = { provider: "deepseek", model: "deepseek-flash" };
    const credentials: ChatTurnCredentials = { apiKey: FIXTURE_OPENROUTER_KEY };
    const request: ChatAttemptRequest = {
      messages: [{ role: "user", content: [{ kind: "text", text: "pytanie" }] }],
    };
    const attempt = await chatAttempt(credentials, target, request);
    // The honest terminal classification: a missing PRIMARY credential is
    // a configuration problem; the OpenRouter fallback positions stay
    // untouched (chat.ts `chatAttempt`, pinned here from the dispatch
    // lane's perspective).
    expect(attempt.ok).toBe(false);
    if (!attempt.ok) {
      expect(attempt.failure.kind).toBe("unauthenticated");
      expect(attempt.failure.fallbackEligible).toBe(false);
    }
  });
});

describe("the composed routing label both consumers record", () => {
  it("composes the identical e2.routing label from the frozen routing version", () => {
    expect(MODEL_CONFIGURATION_VERSION).toBe(
      `e2.routing/${ROUTING_CONFIG_VERSION}#chat_analysis`,
    );
    expect(ANSWER_MODEL_CONFIGURATION_VERSION).toBe(
      `e2.routing/${ROUTING_CONFIG_VERSION}#chat_analysis`,
    );
    // The observed format at the e8.0 split (29 characters; every
    // persistence boundary is an unbounded string, so it carries whole).
    expect(MODEL_CONFIGURATION_VERSION).toBe("e2.routing/e8.0#chat_analysis");
    expect(ANSWER_MODEL_CONFIGURATION_VERSION).toBe("e2.routing/e8.0#chat_analysis");
    expect(MODEL_CONFIGURATION_VERSION).toHaveLength(29);
  });
});

describe("per-provider attempt recording (analyze.ts recordModelCall, offline)", () => {
  /**
   * Builds a fake MutationCtx recording every insert (the fake-ctx
   * pattern): both indexed lookups (an existing model step, an occupied
   * attempt slot) find nothing, so the handler allocates fresh rows.
   */
  function fakeRecordCtx() {
    const steps: (Record<string, unknown> & { _id: string })[] = [];
    const attemptRows: (Record<string, unknown> & { _id: string })[] = [];
    const eventCalls: Record<string, unknown>[] = [];
    const db = {
      query: (_table: string) => ({
        withIndex: (_index: string, _range: unknown) => ({ first: async () => null }),
      }),
      insert: async (table: string, doc: Record<string, unknown>) => {
        const id =
          table === "processingSteps"
            ? `steps_s${steps.length + 1}`
            : `attempts_a${attemptRows.length + 1}`;
        const row = { _id: id, ...doc };
        if (table === "processingSteps") {
          steps.push(row);
        } else {
          attemptRows.push(row);
        }
        return id;
      },
      get: async (id: string) => steps.find((row) => row._id === id) ?? null,
    };
    const ctx = {
      db,
      runMutation: async (_ref: unknown, args: Record<string, unknown>) => {
        eventCalls.push(args);
      },
    };
    return { ctx, attemptRows, eventCalls };
  }

  /** The mutation handler driven directly (offline; fake db + runMutation). */
  const runRecordModelCall = recordModelCallHandler as unknown as (
    ctx: unknown,
    args: { runId: string; turn: number; record: unknown; companyId: string },
  ) => Promise<void>;

  it("records the supplier per attempt: a DeepSeek-direct walk keeps deepseek and openrouter distinct", async () => {
    const { ctx, attemptRows, eventCalls } = fakeRecordCtx();
    await runRecordModelCall(ctx, {
      runId: "processingRuns_r1",
      turn: 1,
      companyId: "companies_fixture",
      record: {
        routeId: "chat_analysis",
        routingConfigVersion: "e8.0",
        attempts: [
          {
            provider: "deepseek",
            requestedModel: "deepseek-flash",
            observedModel: "deepseek-flash",
            outcome: "failed",
            failureKind: "rate_limited",
            fallbackEligible: true,
            startedAtMs: 0,
            finishedAtMs: 1,
          },
          {
            provider: "openrouter",
            requestedModel: "z-ai/glm-5.3-flash",
            observedModel: "z-ai/glm-5.3-flash",
            outcome: "succeeded",
            startedAtMs: 2,
            finishedAtMs: 3,
          },
        ],
      },
    });
    // Per-provider accounting (I11) reads these columns: the failed direct
    // attempt and the successful fallback must never collapse into one
    // supplier.
    expect(attemptRows.map((row) => row.provider)).toEqual(["deepseek", "openrouter"]);
    expect(attemptRows.map((row) => row.model)).toEqual([
      "deepseek-flash",
      "z-ai/glm-5.3-flash",
    ]);
    // One sanitized completion event for the call, as before.
    expect(eventCalls).toHaveLength(1);
  });

  it("defaults a legacy pre-split record without the provider column to openrouter", async () => {
    const { ctx, attemptRows } = fakeRecordCtx();
    await runRecordModelCall(ctx, {
      runId: "processingRuns_r2",
      turn: 1,
      companyId: "companies_fixture",
      record: {
        routeId: "chat_analysis",
        routingConfigVersion: "e2.0",
        attempts: [
          {
            requestedModel: "z-ai/glm-5.3-flash",
            observedModel: "z-ai/glm-5.3-flash",
            outcome: "succeeded",
            startedAtMs: 0,
            finishedAtMs: 1,
          },
        ],
      },
    });
    expect(attemptRows).toHaveLength(1);
    expect(attemptRows[0]?.provider).toBe("openrouter");
  });
});
