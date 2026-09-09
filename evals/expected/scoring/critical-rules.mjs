/**
 * Critical-error rules for Kiero evaluation scoring (issue E1).
 *
 * Encodes the accepted rule from the alpha-readiness contract: a wrong amount,
 * wrong project attribution, wrong date, wrong commitment or guessed tax basis
 * is CRITICAL regardless of the aggregate case score, and a readable answer
 * with any of those errors is not a success.
 *
 * PUBLISHED SEMANTICS (mirrors run-report.schema.json): the report's
 * stages.memoryChanges.published is an ordered list of per-beat snapshots
 * mirroring the answer key's stages. Every expected stage is verified against
 * its snapshot: values, knowledgeState, state-changing operations and project
 * scopes. Entries matching no expected change at any stage are extra writes
 * and fail. This is what makes in-flight stale overwrites (T13/V13/M02 class)
 * visible: the final beat carries the overwritten value and mismatches the key.
 *
 * Consumes the run-report contract plus the independent answer key
 * (evals/expected/<caseId>.json). Runner-agnostic: no model calls happen here.
 */

/** Normalize decimal strings ("12000.00" -> "12000", "0.50" -> "0.5"). */
function normDecimal(s) {
  if (typeof s !== "string") return s;
  return s.replace(/0+$/, "").replace(/\.$/, "");
}

const CRITICAL_CATEGORIES = ["project", "amount", "date", "commitment", "source_basis"];
const STATE_OPERATIONS = ["mark_unknown", "mark_conflicted", "mark_not_applicable", "create_project"];
const kindCategory = (value) =>
  value?.kind === "financial" ? "amount" : value?.kind === "temporal" ? "date" : "other";

/**
 * Compare one expected value against the published value; returns discrepancy
 * descriptors with their critical-error categories.
 */
function compareValue(expected, actual, where) {
  const issues = [];
  if (!actual) {
    const cat = kindCategory(expected);
    issues.push({ category: cat, critical: CRITICAL_CATEGORIES.includes(cat), detail: `${where}: expected value not published` });
    return issues;
  }
  if ((expected?.kind ?? "none") !== (actual.kind ?? "none")) {
    issues.push({ category: "other", critical: false, detail: `${where}: value kind ${actual.kind} != expected ${expected.kind}` });
    return issues;
  }
  if (expected.kind === "financial") {
    const fields = [
      ["amount", expected.amount, actual.amount],
      ["minAmount", expected.minAmount, actual.minAmount],
      ["maxAmount", expected.maxAmount, actual.maxAmount],
    ];
    for (const [name, exp, act] of fields) {
      if (normDecimal(exp ?? "") !== normDecimal(act ?? "") && (exp ?? "") !== (act ?? "")) {
        if (exp !== undefined || act !== undefined) {
          issues.push({
            category: "amount",
            critical: true,
            detail: `${where}: ${name} mismatch (expected ${exp ?? "absent"}, got ${act ?? "absent"})`,
          });
        }
      }
    }
    if (expected.vatBasis !== actual.vatBasis) {
      issues.push({
        category: "source_basis",
        critical: true,
        detail:
          expected.vatBasis === "not_specified"
            ? `${where}: GUESSED tax basis, evidence says not_specified but system recorded ${actual.vatBasis}`
            : `${where}: tax basis mismatch (expected ${expected.vatBasis}, got ${actual.vatBasis})`,
      });
    }
    if (expected.role !== actual.role) {
      issues.push({ category: "commitment", critical: true, detail: `${where}: commitment role mismatch (expected ${expected.role}, got ${actual.role})` });
    }
    if (expected.precision !== actual.precision) {
      const dangerous = expected.precision === "approximate" || expected.precision === "range";
      issues.push({
        category: dangerous ? "amount" : "other",
        critical: dangerous,
        detail: `${where}: precision mismatch (expected ${expected.precision}, got ${actual.precision}); an estimate or range recorded as exact invents commitment-level precision`,
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
  if (expected.kind === "quantity") {
    if (expected.value !== actual.value || expected.unit !== actual.unit || (expected.secondValue ?? null) !== (actual.secondValue ?? null)) {
      issues.push({
        category: "other",
        critical: false,
        detail: `${where}: quantity mismatch (expected ${expected.value}${expected.secondValue ? `x${expected.secondValue}` : ""} ${expected.unit}, got ${actual.value}${actual.secondValue ? `x${actual.secondValue}` : ""} ${actual.unit})`,
      });
    }
  }
  if (expected.kind === "text" && expected.value !== actual.value) {
    issues.push({ category: "other", critical: false, detail: `${where}: text mismatch (expected "${expected.value}", got "${actual.value}")` });
  }
  return issues;
}

/** Compare knowledgeState; presenting unsupported info as known is critical. */
function compareKnowledgeState(expected, actual, where, fallbackCategory) {
  if (expected === actual) return [];
  if (["unknown", "not_applicable", "conflicted"].includes(expected) && actual === "known") {
    return [
      {
        category: "source_basis",
        critical: true,
        detail: `${where}: knowledgeState mismatch (expected ${expected}, got known); information without valid support presented as established`,
      },
    ];
  }
  if (expected === "known" && ["unknown", "not_applicable"].includes(actual)) {
    return [
      {
        category: fallbackCategory,
        critical: CRITICAL_CATEGORIES.includes(fallbackCategory),
        detail: `${where}: knowledgeState mismatch (expected known, got ${actual}); an established fact was lost or erased`,
      },
    ];
  }
  return [{ category: "other", critical: false, detail: `${where}: knowledgeState mismatch (expected ${expected}, got ${actual})` }];
}

/** Extract findingKey tokens mentioned in a prohibited-write sentence. */
function mentionedFindingKeys(text, knownKeys) {
  return knownKeys.filter((k) => text.includes(k));
}

function annotateProhibitedWrites(issue, prohibitedWrites, knownKeys) {
  // Prefer a prohibited write that names the actual wrong value (e.g. the
  // stale 15 000 overwrite sentence), then fall back to findingKey mentions.
  // Digit forms are compared with trailing zeros stripped so "15000.00" and
  // "15 000" can match.
  const strip = (s) => s.replace(/\D/g, "").replace(/0+$/, "");
  const gotMatch = issue.detail.match(/got ([\d .,]+)/);
  const gotDigits = gotMatch ? strip(gotMatch[1]) : null;
  const candidates = prohibitedWrites.filter((pw) => pw.category === issue.category);
  const byValue =
    gotDigits && gotDigits.length >= 2
      ? candidates.find((pw) => {
          const pwDigits = strip(pw.mustNot);
          return pwDigits.length >= 2 && (pwDigits.includes(gotDigits) || gotDigits.includes(pwDigits));
        })
      : undefined;
  if (byValue) return { ...issue, detail: `${issue.detail} [prohibited write: ${byValue.mustNot}]` };
  const keysInDetail = knownKeys.filter((k) => issue.detail.includes(k));
  if (keysInDetail.length === 0) return issue;
  const byKey = candidates.find((pw) => mentionedFindingKeys(pw.mustNot, keysInDetail).length > 0);
  if (byKey) return { ...issue, detail: `${issue.detail} [prohibited write: ${byKey.mustNot}]` };
  return issue;
}

/**
 * Evaluate one run report against one answer key.
 * Returns { outcome, criticalErrors, failures }.
 *  - outcome "fail" when any critical error OR any non-critical failure exists.
 *  - caseScore is intentionally ignored: critical errors fail the case regardless.
 *  - provider_unavailable passes through as its own outcome, never mapped to pass or fail.
 */
export function evaluateCase(report, expected) {
  const criticalErrors = [];
  const failures = [];
  const record = (issue) => {
    if (issue.critical) criticalErrors.push(issue);
    else failures.push(issue);
  };

  if (report.corpusRevision !== expected.corpusRevision) {
    failures.push({
      category: "other",
      critical: false,
      detail: `report revision ${report.corpusRevision} != answer key revision ${expected.corpusRevision}; results are not comparable`,
    });
  }
  if (report.caseOutcome === "provider_unavailable") {
    return { outcome: "provider_unavailable", criticalErrors, failures };
  }

  const keyStages = expected.stages ?? [];
  const snapshots = report.stages?.memoryChanges?.published ?? [];
  const prohibitedWrites = keyStages.flatMap((s) => s.prohibitedWrites ?? []);
  const allExpectedChanges = keyStages.flatMap((s) => s.memoryChanges ?? []);
  const knownKeys = [...new Set(allExpectedChanges.map((c) => c.findingKey))];

  // Per-beat structural check: snapshots must mirror the key's stages exactly.
  const keyStageIds = keyStages.map((s) => s.stageId);
  const snapshotIds = snapshots.map((s) => s.stageId);
  if (JSON.stringify(keyStageIds) !== JSON.stringify(snapshotIds)) {
    failures.push({
      category: "other",
      critical: false,
      detail: `beat snapshots [${snapshotIds.join(", ")}] do not mirror the key's stages [${keyStageIds.join(", ")}]`,
    });
  }

  for (const stage of keyStages) {
    const snapshot = snapshots.find((s) => s.stageId === stage.stageId);
    if (!snapshot) {
      failures.push({ category: "other", critical: false, detail: `beat snapshot missing for stage "${stage.stageId}" (${stage.when})` });
      continue;
    }
    const changes = snapshot.changes ?? [];

    // Ambiguous publication: more than one entry for the same findingKey+scope in one beat.
    const seen = new Set();
    for (const c of changes) {
      const id = `${c.findingKey}|${c.scope?.level}|${c.scope?.ref}`;
      if (seen.has(id)) {
        failures.push({ category: "other", critical: false, detail: `stage "${stage.stageId}": ambiguous publication, multiple entries for ${id.replace(/\|/g, "/")}` });
      }
      seen.add(id);
    }

    for (const change of stage.memoryChanges ?? []) {
      const matches = changes.filter((p) => p.findingKey === change.findingKey && p.scope?.level === change.scope?.level);
      if (change.scope?.level === "project") {
        const expectedRefs = (stage.memoryChanges ?? [])
          .filter((c) => c.findingKey === change.findingKey)
          .map((c) => c.scope?.ref);
        for (const p of matches) {
          if (!expectedRefs.includes(p.scope?.ref)) {
            record({
              category: "project",
              critical: true,
              detail: `${change.findingKey} published under wrong project ${p.scope?.ref} at stage "${stage.stageId}" (expected one of ${expectedRefs.join(", ")})`,
            });
          }
        }
      }
      const byScope = matches.filter((p) => p.scope?.ref === change.scope?.ref);
      const where = `${change.findingKey}@${change.scope?.ref} [${stage.stageId}]`;
      if (byScope.length === 0) {
        const cat = kindCategory(change.value);
        record({
          category: cat,
          critical: CRITICAL_CATEGORIES.includes(cat),
          detail: `expected ${change.findingKey} on ${change.scope?.ref} not published at stage "${stage.stageId}"`,
        });
        continue;
      }
      for (const entry of byScope) {
        for (const issue of compareKnowledgeState(change.knowledgeState, entry.knowledgeState, where, kindCategory(change.value))) {
          record(issue);
        }
        if (STATE_OPERATIONS.includes(change.operation) && entry.operation !== change.operation) {
          failures.push({
            category: "other",
            critical: false,
            detail: `${where}: state-changing operation ${change.operation} not recorded (got ${entry.operation ?? "none"})`,
          });
        }
        if (change.knowledgeState === "known" && change.value) {
          for (const issue of compareValue(change.value, entry.value, where)) record(issue);
        }
      }
    }
  }

  // Extra writes: entries matching no expected change at any stage.
  const expectedIds = new Set(allExpectedChanges.map((c) => `${c.findingKey}|${c.scope?.level}|${c.scope?.ref}`));
  for (const snapshot of snapshots) {
    for (const entry of snapshot.changes ?? []) {
      const id = `${entry.findingKey}|${entry.scope?.level}|${entry.scope?.ref}`;
      if (!expectedIds.has(id)) {
        const cat = kindCategory(entry.value);
        record({
          category: cat,
          critical: CRITICAL_CATEGORIES.includes(cat),
          detail: `extra write at stage "${snapshot.stageId}": ${id.replace(/\|/g, "/")} is not expected at any stage`,
        });
      }
    }
  }

  // Clarification semantics. Required questions come from any stage; asking
  // beyond them is a needless clarification and consumes every clarification-
  // category prohibited write.
  const required = keyStages.flatMap((s) => s.clarifications ?? []);
  const asked = report.stages?.clarifications?.asked ?? [];
  const clarificationProhibited = prohibitedWrites.filter((p) => p.category === "clarification");
  for (const req of required) {
    const answered = asked.some((a) =>
      req.asksAbout
        .toLowerCase()
        .split(/\s+/)
        .some((w) => w.length > 4 && a.asksAbout.toLowerCase().includes(w))
    );
    if (!answered) {
      failures.push({
        category: "clarification",
        critical: false,
        detail: `required clarification not asked: ${req.asksAbout} (a correct question on ambiguous evidence is the SUCCESS outcome)`,
      });
    }
  }
  if (required.length === 0 && asked.length > 0) {
    for (const a of asked) {
      const cite = clarificationProhibited.length > 0 ? ` [prohibited write: ${clarificationProhibited[0].mustNot}]` : "";
      failures.push({
        category: "clarification",
        critical: false,
        detail: `needless clarification on clear evidence: ${a.asksAbout}; fails that expected outcome${cite}`,
      });
    }
  }

  // Consume prohibited writes as annotations: every fired issue of a matching
  // category that involves a findingKey named in the prohibited sentence gets
  // cited, so each prohibited write is a live enforcement target.
  const annotate = (issue) => annotateProhibitedWrites(issue, prohibitedWrites, knownKeys);
  return {
    outcome:
      criticalErrors.length > 0 || failures.length > 0
        ? "fail"
        : report.caseOutcome === "incomplete"
          ? "incomplete"
          : "pass",
    criticalErrors: criticalErrors.map(annotate),
    failures: failures.map(annotate),
  };
}

/** A run passes the corpus-level gate only with zero critical errors in every case. */
export function assertNoCriticalErrors(evaluations) {
  const offenders = evaluations.filter((e) => e.evaluation.criticalErrors.length > 0);
  return { ok: offenders.length === 0, offenders };
}
