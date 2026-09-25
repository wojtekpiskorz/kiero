/**
 * Company memory on the in-process backend: a published finding keeps its
 * source-backed history, an explicit correction adds a revision instead of
 * rewriting, a stale expectation refuses, and a plan prepared before a
 * newer correction cannot overwrite it ("Korekta ustalenia", CONTEXT.md).
 */

import { beforeEach, describe, expect, it } from "vitest";
import { api } from "../../convex/_generated/api";
import { backend, ok, seedServiceCompany, type Backend } from "./harness";

let t: Backend;
let sourceId: string;
let fragmentId: string;

beforeEach(async () => {
  t = backend();
  await seedServiceCompany(t);
  const fixtures = ok<{ sourceId: string; fragmentId: string }>(
    await t.action(api.memory.findings.probe.probeSeedMemoryFixtures, {}),
  );
  sourceId = fixtures.sourceId;
  fragmentId = fixtures.fragmentId;
});

const money = (taxBasis: "not_specified" | "net" | "gross") => ({
  _tag: "money",
  money: {
    role: "agreed_price",
    amount: { _tag: "exact", value: "18000" },
    currency: "PLN",
    currencyOrigin: "stated",
    taxBasis,
    certainty: "exact",
  },
});
const known = { _tag: "known" };

function memory(operation: string, input: unknown, sessionId?: string) {
  return t.action(api.memory.findings.probe.probeMemoryCommand, {
    envelope: { operation, input, expectedRevisions: [] },
    ...(sessionId === undefined ? {} : { sessionId }),
  });
}

function pricePlan(findingId: string | null, taxBasis: "not_specified" | "net" | "gross") {
  return {
    sourceId,
    plannedRevisions: [
      {
        findingId,
        scope: { _tag: "company" },
        semanticKey: "cena.ustalona",
        value: money(taxBasis),
        knowledgeState: known,
        effectiveFrom: null,
        evidence: [{ sourceId, fragmentId, supportKind: "support" }],
        derivesFrom: [],
      },
    ],
  };
}

async function publish(plan: unknown): Promise<void> {
  const { changeSetId } = ok<{ changeSetId: string }>(await memory("memory.prepareChangeSet", plan));
  ok(await memory("memory.publishChangeSet", { changeSetId, expectedRevisions: [] }));
}

async function priceFinding() {
  const state = ok<{
    findings: { findingId: string; semanticKey: string; revisionCounter: number }[];
    revisions: {
      findingId: string;
      revision: number;
      origin: string;
      value: { money: { taxBasis: string } };
    }[];
  }>(await t.action(api.memory.findings.probe.probeMemoryState, {}));
  const finding = state.findings.find((row) => row.semanticKey === "cena.ustalona");
  if (finding === undefined) throw new Error("price finding missing");
  const history = state.revisions
    .filter((row) => row.findingId === finding.findingId)
    .sort((a, b) => a.revision - b.revision);
  return { finding, history };
}

describe("company memory", () => {
  it("publishes a source-backed finding without inventing the tax basis", async () => {
    await publish(pricePlan(null, "not_specified"));

    const { finding, history } = await priceFinding();
    expect(finding.revisionCounter).toBe(1);
    expect(history.map((row) => row.value.money.taxBasis)).toEqual(["not_specified"]);
  });

  it("records a correction as a new revision and keeps the old one", async () => {
    await publish(pricePlan(null, "not_specified"));
    const { finding } = await priceFinding();

    ok(
      await memory("memory.correctFinding", {
        findingId: finding.findingId,
        expectedRevision: 1,
        value: money("net"),
        knowledgeState: known,
        reason: "Szef potwierdził kwotę netto",
      }),
    );

    const { history } = await priceFinding();
    expect(history.map((row) => [row.origin, row.value.money.taxBasis])).toEqual([
      ["publication", "not_specified"],
      ["correction", "net"],
    ]);
  });

  it("refuses a correction against a stale revision", async () => {
    await publish(pricePlan(null, "not_specified"));
    const { finding } = await priceFinding();
    ok(
      await memory("memory.correctFinding", {
        findingId: finding.findingId,
        expectedRevision: 1,
        value: money("net"),
        knowledgeState: known,
        reason: "Pierwsza korekta",
      }),
    );

    const stale = (await memory("memory.correctFinding", {
      findingId: finding.findingId,
      expectedRevision: 1,
      value: money("gross"),
      knowledgeState: known,
      reason: "Spóźniona korekta",
    })) as { _tag: string; error?: { _tag: string } };

    expect(stale._tag).toBe("error");
    expect(stale.error?._tag).toBe("conflict");
  });

  it("never lets a plan prepared before a newer correction overwrite it", async () => {
    await publish(pricePlan(null, "not_specified"));
    const { finding } = await priceFinding();
    const { changeSetId } = ok<{ changeSetId: string }>(
      await memory("memory.prepareChangeSet", pricePlan(finding.findingId, "gross")),
    );
    ok(
      await memory("memory.correctFinding", {
        findingId: finding.findingId,
        expectedRevision: 1,
        value: money("net"),
        knowledgeState: known,
        reason: "Nowsza jawna korekta",
      }),
    );

    const late = (await memory("memory.publishChangeSet", { changeSetId, expectedRevisions: [] })) as {
      _tag: string;
    };

    const { history } = await priceFinding();
    expect(late._tag).toBe("error");
    expect(history.at(-1)?.value.money.taxBasis).toBe("net");
  });

  it("keeps another company's memory separate", async () => {
    await publish(pricePlan(null, "not_specified"));
    const isolation = ok<{ sessionId: string }>(
      await t.action(api.memory.findings.probe.probeSeedMemoryIsolation, {}),
    );

    const foreign = ok<{ rows: unknown[] }>(
      await t.action(api.memory.findings.probe.probeReadCurrentFindings, {
        scope: { _tag: "company" },
        sessionId: isolation.sessionId,
      }),
    );

    expect(foreign.rows).toHaveLength(0);
  });
});
