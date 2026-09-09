#!/usr/bin/env node
/**
 * Deliberate scorer probe (issue E1 focused verification).
 *
 * Four hand-built run reports plant exactly one dangerous error each:
 *   1. wrong-amount.json      T02: 1 200 000 instead of 12 000
 *   2. wrong-project.json     T06: tile color written to Banan instead of Bananowa
 *   3. guessed-vat-basis.json T02: a clear "netto" contract recorded as gross
 *   4. stale-overwrite.json   T13: the delayed S1 analysis republishes 15 000
 *                              over the already-published 12 500 correction;
 *                              beat 1 is correct, the final beat is wrong
 *
 * All four carry HIGH aggregate case scores (0.95 to 1.0) on purpose: the rule
 * must mark each one critical regardless of the score. Probe 4 exists because
 * the first three publish each finding exactly once; without a per-beat final
 * check the stale-overwrite class would be invisible. Two inline controls pin
 * the clarification semantics (required question is success; needless question
 * on clear evidence fails the case).
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
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail && !ok ? `: ${detail}` : ""}`);
  if (!ok) failures++;
};
const runProbe = (name, caseId, wantedCategory, scoreLabel) => {
  const result = evaluateCase(report(name), expected(caseId));
  console.log(`${name} (${caseId}, caseScore ${scoreLabel}) -> outcome=${result.outcome}`);
  check("outcome is fail", result.outcome === "fail", JSON.stringify(result));
  check("a critical error is flagged", result.criticalErrors.length >= 1, JSON.stringify(result.criticalErrors));
  check(`critical category is ${wantedCategory}`, result.criticalErrors.some((e) => e.category === wantedCategory), JSON.stringify(result.criticalErrors));
  for (const e of result.criticalErrors) console.log(`     ${e.detail}`);
  console.log("");
  return result;
};

console.log("Kiero deliberate scorer probe: four planted critical errors");
console.log("");

runProbe("wrong-amount.json", "T02", "amount", "0.95");
runProbe("wrong-project.json", "T06", "project", "0.97");
runProbe("guessed-vat-basis.json", "T02", "source_basis", "0.99");
runProbe("stale-overwrite.json", "T13", "amount", "1.0");

// --- Inline controls (not probe report files): clarification semantics -------
console.log("Inline controls (not probe report files):");

// M03: the ambiguous handwriting requires a question at beat 1; S2 resolves it
// and the final beat lands on Zielińska. Asking correctly is SUCCESS.
const m03asked = {
  caseId: "M03",
  corpusRevision: "2026.09.1",
  run: { runId: "inline-1", attempt: 1, startedAt: "2026-09-09T10:00:00+02:00", finishedAt: "2026-09-09T10:00:30+02:00" },
  configuration: { chat: { provider: "probe", model: "probe/fictional" } },
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
          stageId: "ambiguous-image",
          changes: [
            {
              findingKey: "quoted_price",
              scope: { level: "company", ref: "COMPANY" },
              operation: "set",
              knowledgeState: "unknown",
              value: {
                kind: "financial",
                "role": "quoted_price",
                "precision": "exact",
                "amount": "6500.00",
                "currency": "PLN",
                "currencyOrigin": "firm_default",
                "vatBasis": "not_specified"
              },
              evidence: [{ sourceId: "S1" }]
            }
          ]
        },
        {
          stageId: "final",
          changes: [
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
                vatBasis: "not_specified"
              },
              evidence: [{ sourceId: "S1" }, { sourceId: "S2" }]
            }
          ]
        }
      ]
    },
    clarifications: {
      status: "complete",
      asked: [
        {
          ambiguity: "Kartka mówi tylko ŁAZIENKA, 6 500 zł",
          asksAbout: "Project attribution of the 6 500 quoted price (Kaczmarek vs Zielińska)."
        }
      ]
    }
  },
  caseScore: 1.0,
  caseOutcome: "pass"
};
const c1 = evaluateCase(m03asked, expected("M03"));
console.log(`required-clarification-asked (M03) -> outcome=${c1.outcome}`);
check("correct required clarification is success (no failures)", c1.outcome === "pass" && c1.failures.length === 0, JSON.stringify(c1.failures));
console.log("");

// T01: the date is unambiguous, so asking is needless and fails that expected
// outcome even though every published value is perfect.
const t01needless = {
  caseId: "T01",
  corpusRevision: "2026.09.1",
  run: { runId: "inline-2", attempt: 1, startedAt: "2026-09-09T10:00:00+02:00", finishedAt: "2026-09-09T10:00:30+02:00" },
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
          stageId: "final",
          changes: [
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
                originalExpression: "w przyszły czwartek"
              },
              evidence: [{ sourceId: "S1" }]
            }
          ]
        }
      ]
    },
    clarifications: {
      status: "complete",
      asked: [{ ambiguity: "maybe the Thursday is this week?", asksAbout: "which Thursday the delivery means" }]
    }
  },
  caseScore: 1.0,
  caseOutcome: "pass"
};
const c2 = evaluateCase(t01needless, expected("T01"));
console.log(`needless-clarification (T01, otherwise perfect) -> outcome=${c2.outcome}`);
check("needless clarification fails the case", c2.outcome === "fail", JSON.stringify(c2));
check("flagged as non-critical clarification failure", c2.failures.some((f) => f.category === "clarification"), JSON.stringify(c2.failures));
console.log("");

if (failures > 0) {
  console.error(`PROBE FAILED: ${failures} assertion(s) failed`);
  process.exit(1);
}
console.log("PROBE PASSED: all four planted errors are critical regardless of aggregate score; clarification semantics hold.");
