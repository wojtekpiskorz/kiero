/**
 * Critical-error rules for Kiero evaluation scoring (issue E1).
 *
 * This module encodes the accepted rule from the alpha-readiness contract:
 * a wrong amount, wrong project attribution, wrong date, wrong commitment
 * or guessed tax basis is CRITICAL regardless of the aggregate case score,
 * and a readable answer with any of those errors is not a success.
 *
 * It consumes the run-report contract (run-report.schema.json) plus the
 * independent answer key (evals/expected/<caseId>.json). It is deliberately
 * runner-agnostic: D6/J3 own producing reports; nothing here calls a model.
 */

/** Normalize decimal strings ("12000.00" -> "12000", "0.50" -> "0.5"). */
function normDecimal(s) {
  if (typeof s !== "string") return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

const CRITICAL_CATEGORIES = ["project", "amount", "date", "commitment", "source_basis"];

/**
 * Compare one expected final-state value against the published value and
 * return discrepancy descriptors with their critical-error categories.
 */
function compareValue(expected, actual, where) {
  const issues = [];
  if (!actual) {
    const cat = expected?.kind === "financial" ? "amount" : expected?.kind === "temporal" ? "date" : "other";
    issues.push({ category: cat, critical: CRITICAL_CATEGORIES.includes(cat), detail: `${where}: expected value not published` });
    return issues;
  }
  if ((expected?.kind ?? "none") !== (actual.kind ?? "none")) {
    issues.push({ category: "other", critical: false, detail: `${where}: value kind ${actual.kind} != expected ${expected.kind}` });
    return issues;
  }
  if (expected.kind === "financial") {
    const expAmt = normDecimal(expected.amount ?? "");
    const actAmt = normDecimal(actual.amount ?? "");
    const expMin = normDecimal(expected.minAmount ?? "");
    const actMin = normDecimal(actual.minAmount ?? "");
    const expMax = normDecimal(expected.maxAmount ?? "");
    const actMax = normDecimal(actual.maxAmount ?? "");
    if (expAmt !== actAmt || expMin !== actMin || expMax !== actMax) {
      issues.push({
        category: "amount",
        critical: true,
        detail: `${where}: amount mismatch (expected ${expected.amount ?? `${expected.minAmount}..${expected.maxAmount}`}, got ${actual.amount ?? `${actual.minAmount}..${actual.maxAmount}`})`,
      });
    }
    if (expected.vatBasis !== actual.vatBasis) {
      issues.push({
        category: "source_basis",
        critical: true,
        detail:
          expected.vatBasis === "not_specified"
            ? `${where}: GUESSED tax basis — evidence says not_specified but system recorded ${actual.vatBasis}`
            : `${where}: tax basis mismatch (expected ${expected.vatBasis}, got ${actual.vatBasis})`,
      });
    }
    if (expected.role !== actual.role) {
      issues.push({ category: "commitment", critical: true, detail: `${where}: commitment role mismatch (expected ${expected.role}, got ${actual.role})` });
    }
    if (expected.precision !== actual.precision) {
      issues.push({
        category: expected.precision === "approximate" || expected.precision === "range" ? "amount" : "other",
        critical: expected.precision === "approximate" || expected.precision === "range",
        detail: `${where}: precision mismatch (expected ${expected.precision}, got ${actual.precision}) — an estimate/range recorded as exact invents commitment-level precision`,
      });
    }
  }
  if (expected.kind === "temporal") {
    for (const field of ["date", "datetime", "fromDate", "toDate", "timeOfDay", "fromTime", "toTime"]) {
      if ((expected[field] ?? null) !== (actual[field] ?? null)) {
        issues.push({
          category: "date",
          critical: true,
          detail: `${where}: temporal ${field} mismatch (expected ${expected[field] ?? "absent"}, got ${actual[field] ?? "absent"})`,
        });
      }
    }
    if (expected.role !== actual.role) {
      issues.push({ category: "commitment", critical: true, detail: `${where}: temporal role mismatch (expected ${expected.role}, got ${actual.role})` });
    }
  }
  return issues;
}

/** Expected clarifications across all stages (a correct required clarification is SUCCESS). */
function expectedClarifications(expected) {
  return (expected.stages ?? []).flatMap((s) => s.clarifications ?? []);
}

/**
 * Evaluate one run report against one answer key.
 * Returns { outcome, criticalErrors, failures }.
 *  - outcome "fail" when any critical error OR any non-critical failure exists.
 *  - caseScore is intentionally ignored: critical errors fail the case regardless.
 *  - provider_unavailable passes through as its own outcome, never mapped to pass.
 */
export function evaluateCase(report, expected) {
  const criticalErrors = [];
  const failures = [];

  if (report.corpusRevision !== expected.corpusRevision) {
    failures.push({
      category: "other",
      critical: false,
      detail: `report revision ${report.corpusRevision} != answer key revision ${expected.corpusRevision} — results not comparable`,
    });
  }
  if (report.caseOutcome === "provider_unavailable") {
    return { outcome: "provider_unavailable", criticalErrors, failures };
  }

  const published = report.stages?.memoryChanges?.published ?? [];
  const stages = expected.stages ?? [];
  const finalStage = stages[stages.length - 1];

  for (const change of finalStage?.memoryChanges ?? []) {
    const matches = published.filter(
      (p) => p.findingKey === change.findingKey && p.scope?.level === change.scope?.level
    );
    if (change.scope?.level === "project") {
      // Any published change of this findingKey under a wrong project scope is critical.
      const expectedRefs = (finalStage?.memoryChanges ?? [])
        .filter((c) => c.findingKey === change.findingKey)
        .map((c) => c.scope?.ref);
      for (const p of matches) {
        if (!expectedRefs.includes(p.scope?.ref)) {
          criticalErrors.push({
            category: "project",
            detail: `${change.findingKey} published under wrong project ${p.scope?.ref} (expected one of ${expectedRefs.join(", ")})`,
          });
        }
      }
    }
    const byScope = matches.find((p) => p.scope?.ref === change.scope?.ref);
    if (!byScope) {
      const cat = change.value?.kind === "financial" ? "amount" : change.value?.kind === "temporal" ? "date" : "other";
      failures.push({
        category: cat,
        critical: CRITICAL_CATEGORIES.includes(cat),
        detail: `expected ${change.findingKey} on ${change.scope?.ref} not published`,
      });
      continue;
    }
    if (change.knowledgeState === "known" && change.value) {
      for (const issue of compareValue(change.value, byScope.value, `${change.findingKey}@${change.scope?.ref}`)) {
        if (issue.critical) criticalErrors.push(issue);
        else failures.push(issue);
      }
    }
  }

  // Clarification semantics.
  const required = expectedClarifications(expected);
  const asked = report.stages?.clarifications?.asked ?? [];
  for (const req of required) {
    const answered = asked.some(
      (a) => req.asksAbout.toLowerCase().split(/\s+/).some((w) => w.length > 4 && a.asksAbout.toLowerCase().includes(w))
    );
    if (!answered) {
      failures.push({
        category: "clarification",
        critical: false,
        detail: `required clarification not asked: ${req.asksAbout} (correct question on ambiguous evidence is the SUCCESS outcome)`,
      });
    }
  }
  if (required.length === 0 && asked.length > 0) {
    for (const a of asked) {
      failures.push({
        category: "clarification",
        critical: false,
        detail: `needless clarification on clear evidence: ${a.asksAbout} — fails that expected outcome`,
      });
    }
  }

  const outcome = criticalErrors.length > 0 || failures.length > 0 ? "fail" : report.caseOutcome === "incomplete" ? "incomplete" : "pass";
  return { outcome, criticalErrors, failures };
}

/** A run passes the corpus-level gate only with zero critical errors in every case. */
export function assertNoCriticalErrors(evaluations) {
  const offenders = evaluations.filter((e) => e.evaluation.criticalErrors.length > 0);
  return { ok: offenders.length === 0, offenders };
}
