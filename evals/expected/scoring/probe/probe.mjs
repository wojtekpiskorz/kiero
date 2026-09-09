#!/usr/bin/env node
/**
 * Deliberate scorer probe (issue E1 focused verification).
 *
 * Three hand-built run reports plant exactly one dangerous error each:
 *   1. wrong-amount.json      — T02 with 1 200 000 instead of 12 000
 *   2. wrong-project.json     — T06 with the tile color written to Banan (not Bananowa)
 *   3. guessed-vat-basis.json — T02 with a clear "netto" contract recorded as gross
 *
 * All three carry HIGH aggregate case scores on purpose: the rule must mark
 * each one critical regardless of the score. Two inline controls additionally
 * pin the clarification semantics (required question = success; needless
 * question on clear evidence = failure).
 *
 * Usage: node evals/expected/scoring/probe/probe.mjs   (exit 0 = probe passes)
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { evaluateCase } from "../critical-rules.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const EXPECTED_DIR = join(HERE, "..", "..");

const expected = (id) => JSON.parse(readFileSync(join(EXPECTED_DIR, `${id}.json`), "utf8"));
const report = (name) => JSON.parse(readFileSync(join(HERE, name), "utf8"));

let failures = 0;
const check = (label, condition, detail = "") => {
  const ok = Boolean(condition);
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail && !ok ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
};

console.log("Kiero deliberate scorer probe: three planted critical errors");
console.log("");

// --- Probe 1: wrong amount, high aggregate score -----------------------------
const p1 = evaluateCase(report("wrong-amount.json"), expected("T02"));
console.log(`1. wrong-amount (T02, caseScore 0.95) -> outcome=${p1.outcome}`);
check("outcome is fail", p1.outcome === "fail", JSON.stringify(p1));
check("a critical error is flagged", p1.criticalErrors.length >= 1, JSON.stringify(p1.criticalErrors));
check("critical category is amount", p1.criticalErrors.some((e) => e.category === "amount"), JSON.stringify(p1.criticalErrors));
console.log(`     ${p1.criticalErrors.map((e) => e.detail).join(" | ")}`);
console.log("");

// --- Probe 2: wrong project attribution, high aggregate score ----------------
const p2 = evaluateCase(report("wrong-project.json"), expected("T06"));
console.log(`2. wrong-project (T06, caseScore 0.97) -> outcome=${p2.outcome}`);
check("outcome is fail", p2.outcome === "fail", JSON.stringify(p2));
check("a critical error is flagged", p2.criticalErrors.length >= 1, JSON.stringify(p2.criticalErrors));
check("critical category is project", p2.criticalErrors.some((e) => e.category === "project"), JSON.stringify(p2.criticalErrors));
console.log(`     ${p2.criticalErrors.map((e) => e.detail).join(" | ")}`);
console.log("");

// --- Probe 3: guessed VAT basis on a clear net/gross case --------------------
const p3 = evaluateCase(report("guessed-vat-basis.json"), expected("T02"));
console.log(`3. guessed-vat-basis (T02, caseScore 0.99) -> outcome=${p3.outcome}`);
check("outcome is fail", p3.outcome === "fail", JSON.stringify(p3));
check("a critical error is flagged", p3.criticalErrors.length >= 1, JSON.stringify(p3.criticalErrors));
check("critical category is source_basis", p3.criticalErrors.some((e) => e.category === "source_basis"), JSON.stringify(p3.criticalErrors));
console.log(`     ${p3.criticalErrors.map((e) => e.detail).join(" | ")}`);
console.log("");

// --- Inline controls: clarification semantics --------------------------------
console.log("Inline controls (not probe report files):");

// A correct report with the required question asked is a SUCCESS (M03: ambiguous
// handwriting asks in stage 1, S2 resolves it, final state lands on Zielińska).
const m03asked = {
  caseId: "M03",
  corpusRevision: "2026.09.1",
  run: { runId: "inline-1", attempt: 1, startedAt: "2026-09-09T10:00:00+02:00", "finishedAt": "2026-09-09T10:00:30+02:00" },
  configuration: { chat: { provider: "probe", "model": "probe/fictional" } },
  latencyMs: { firstUsefulOutputMs: 500, totalMs: 30000 },
  attempts: 1,
  cost: { amountUsd: "0.0000", metered: false },
  stages: {
    stt: { status: "skipped" },
    vision: { status: "complete" },
    retrieval: { status: "complete", evidenceReturned: ["S1", "S2"] },
    memoryChanges: {
      status: "complete",
      published: [
        {
          findingKey: "quoted_price",
          scope: { level: "project", ref: "P-ZIELINSKA" },
          operation: "set",
          knowledgeState: "known",
          value: {
            kind: "financial",
            role: "quoted_price",
            precision: "exact",
            amount: "6500.00",
            currency: "PLN",
            currencyOrigin: "firm_default",
            vatBasis: "not_specified",
          },
          evidence: [{ "sourceId": "S1" }, { "sourceId": "S2" }],
        },
      ],
    },
    clarifications: {
      status: "complete",
      asked: [{ ambiguity: "Kartka mówi tylko ŁAZIENKA — 6 500 zł", asksAbout: "Project attribution of the 6 500 zł quoted price (Kaczmarek vs Zielińska)." }],
    },
  },
  caseScore: 1.0,
  caseOutcome: "pass",
};
const c1 = evaluateCase(m03asked, expected("M03"));
console.log(`4. required-clarification-asked (M03) -> outcome=${c1.outcome}`);
check("correct required clarification is success (no failures)", c1.outcome === "pass" && c1.failures.length === 0, JSON.stringify(c1.failures));
console.log("");

// A needless question on clear evidence FAILS that expected outcome (T01 date is unambiguous).
const t01needless = {
  caseId: "T01",
  corpusRevision: "2026.09.1",
  run: { runId: "inline-2", attempt: 1, startedAt: "2026-09-09T10:00:00+02:00", "finishedAt": "2026-09-09T10:00:30+02:00" },
  configuration: { chat: { provider: "probe", model: "probe/fictional" } },
  latencyMs: { firstUsefulOutputMs: 500, totalMs: 30000 },
  attempts: 1,
  cost: { amountUsd: "0.0000", metered: false },
  stages: {
    stt: { status: "skipped" },
    vision: { status: "skipped" },
    retrieval: { status: "complete", evidenceReturned: ["S1"] },
    memoryChanges: {
      status: "complete",
      published: [
        {
          findingKey: "delivery_date",
          scope: { level: "project", ref: "P-BANAN" },
          operation: "set",
          knowledgeState: "known",
          value: {
            kind: "temporal",
            precision: "date",
            role: "agreed",
            date: "2026-09-24",
            originalExpression: "w przyszły czwartek",
          },
          evidence: [{ sourceId: "S1" }],
        },
      ],
    },
    clarifications: {
      status: "complete",
      asked: [{ ambiguity: "maybe the Thursday is this week?", asksAbout: "which Thursday the delivery means" }],
    },
  },
  caseScore: 1.0,
  caseOutcome: "pass",
};
const c2 = evaluateCase(t01needless, expected("T01"));
console.log(`5. needless-clarification (T01, otherwise perfect) -> outcome=${c2.outcome}`);
check("needless clarification fails the case", c2.outcome === "fail", JSON.stringify(c2));
check("flagged as non-critical clarification failure", c2.failures.some((f) => f.category === "clarification"), JSON.stringify(c2.failures));
console.log("");

if (failures > 0) {
  console.error(`PROBE FAILED: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("PROBE PASSED: all three planted errors are critical regardless of aggregate score; clarification semantics hold.");
