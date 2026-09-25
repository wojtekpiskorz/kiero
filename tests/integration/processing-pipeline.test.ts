/**
 * The accepted-source pipeline under the real scheduler and workflow
 * component: acceptance -> outbox drain -> extract fragments -> analysis
 * workflow. No AI credentials exist here, so the analysis must end in an
 * honest recorded failure, never a crash, a lost source or a transaction
 * the Convex runtime refuses (e.g. a `fetch` inside a mutation).
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import { backend, ok, seedServiceCompany, type Backend } from "./harness";

let t: Backend;

beforeEach(() => {
  vi.useFakeTimers();
  delete process.env.DEEPSEEK_API_KEY;
  delete process.env.OPENROUTER_API_KEY;
  t = backend();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("accepted text source pipeline without AI credentials", () => {
  it("runs to an honest terminal state and keeps the source", async () => {
    await seedServiceCompany(t);
    const { uploadId } = ok<{ uploadId: string }>(
      await t.action(api.sources.accept.probe.probeSeedUpload, {}),
    );
    const { sourceId } = ok<{ sourceId: string }>(
      await t.action(api.sources.accept.probe.probeAcceptSource, {
        envelope: {
          operation: "sources.acceptSource",
          input: {
            uploadId,
            authorText: "Kaczmarek: wycena łazienki do piątku, 18 000 zł brutto",
            intendedSentAtIso: new Date(Date.now() - 60_000).toISOString(),
            timezoneSnapshot: "Europe/Warsaw",
            projectHints: [],
          },
          expectedRevisions: [],
          idempotencyKey: `idem_${randomUUID()}`,
        },
      }),
    );

    await t.finishAllScheduledFunctions(vi.runAllTimers);

    const state = ok<{
      sources: unknown[];
      runs: { sourceId: string; state: string; kind: string }[];
      jobs: { kind: string; state: string; lastErrorKind?: string }[];
    }>(await t.action(api.sources.accept.probe.probeAcceptanceState, {}));
    const jobState = (kind: string) => state.jobs.find((job) => job.kind === kind);

    expect(state.sources).toHaveLength(2); // the seeded fixture source + this one
    expect(state.runs.find((run) => run.sourceId === sourceId)).toMatchObject({
      kind: "initial_analysis",
      state: "failed",
    });
    expect(jobState("processing.extract_fragments")?.state).toBe("succeeded");
    expect(jobState("processing.join_multimodal")?.state).toBe("succeeded");
    expect(jobState("attention.evaluate_due_intents")?.state).toBe("succeeded");
    expect(jobState("processing.analyze_change_plan")).toMatchObject({
      state: "failed",
      lastErrorKind: "analysis_workflow_failed",
    });
  });
});
