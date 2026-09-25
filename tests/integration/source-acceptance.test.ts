/**
 * Source acceptance end to end on the in-process backend: one accepted
 * "Wiadomość źródłowa" commits its row, project links, processing run,
 * canonical event and durable job in one transaction, a retry with the
 * same key is idempotent, and another company never sees it.
 */

import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "../../convex/_generated/api";
import { backend, ok, seedServiceCompany, type Backend } from "./harness";

let t: Backend;

beforeEach(() => {
  vi.useFakeTimers();
  t = backend();
});

afterEach(() => {
  vi.useRealTimers();
});

const idempotencyKey = (): string => `idem_${randomUUID()}`;

async function draftUpload(): Promise<string> {
  return ok<{ uploadId: string }>(await t.action(api.sources.accept.probe.probeSeedUpload, {})).uploadId;
}

function acceptEnvelope(uploadId: string, idempotencyKey: string, projectHints: string[] = []) {
  return {
    operation: "sources.acceptSource",
    input: {
      uploadId,
      authorText: "Dowóz płytek na Buniewice w czwartek rano; Kaczmarek potwierdza odbiór",
      intendedSentAtIso: new Date(Date.now() - 60_000).toISOString(),
      timezoneSnapshot: "Europe/Warsaw",
      projectHints,
    },
    expectedRevisions: [],
    idempotencyKey,
  };
}

describe("source acceptance", () => {
  it("commits the source, run, event and durable job atomically", async () => {
    await seedServiceCompany(t);
    const uploadId = await draftUpload();
    const key = idempotencyKey();

    const accepted = ok<{ sourceId: string }>(
      await t.action(api.sources.accept.probe.probeAcceptSource, {
        envelope: acceptEnvelope(uploadId, key),
      }),
    );

    const state = ok<{
      sources: { sourceId?: string; _id?: string; acceptanceKey?: string }[];
      runs: { sourceId: string; state: string }[];
      events: { eventName: string }[];
      jobs: { kind: string }[];
    }>(await t.action(api.sources.accept.probe.probeAcceptanceState, {}));

    expect(state.sources.filter((row) => row.acceptanceKey === key)).toHaveLength(1);
    expect(state.runs.filter((run) => run.sourceId === accepted.sourceId)).toHaveLength(1);
    expect(state.events.map((event) => event.eventName)).toContain("sources.sourceAccepted");
    expect(state.jobs.map((job) => job.kind)).toContain("processing.extract_fragments");
  });

  it("treats a retry with the same key as the same source", async () => {
    await seedServiceCompany(t);
    const uploadId = await draftUpload();
    const envelope = acceptEnvelope(uploadId, idempotencyKey());

    const first = ok<{ sourceId: string }>(
      await t.action(api.sources.accept.probe.probeAcceptSource, { envelope }),
    );
    const second = ok<{ sourceId: string }>(
      await t.action(api.sources.accept.probe.probeAcceptSource, { envelope }),
    );

    expect(second.sourceId).toBe(first.sourceId);
  });

  it("keeps another company's conversation empty", async () => {
    await seedServiceCompany(t);
    const isolation = ok<{ sessionId: string }>(
      await t.action(api.sources.accept.probe.probeSeedIsolation, {}),
    );
    const uploadId = await draftUpload();
    ok(await t.action(api.sources.accept.probe.probeAcceptSource, { envelope: acceptEnvelope(uploadId, idempotencyKey()) }));

    const own = ok<{ page: unknown[] }>(
      await t.action(api.sources.read.probe.probeCompanyConversation, { numItems: 10 }),
    );
    const foreign = ok<{ page: unknown[] }>(
      await t.action(api.sources.read.probe.probeCompanyConversation, {
        numItems: 10,
        sessionId: isolation.sessionId,
      }),
    );

    expect(own.page.length).toBeGreaterThan(0);
    expect(foreign.page).toHaveLength(0);
  });
});
