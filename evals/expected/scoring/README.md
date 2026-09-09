# Scoring contract (E1): runner input, critical-error rules, probe

This directory defines the **scorer INPUT contract** consumed by D6 and the E2–E6/J3 proof owners. E1 did not run any model, did not produce benchmark results, and owns no runner: the real runs belong to D6 (STT tooling/audio assets), J3 (quality qualification) and later proof tickets. Nothing here can rewrite the answer keys, which live outside any provider implementation path.

## Inputs

- **Answer key**: `../<caseId>.json` (one per corpus case, human-authored, `answerKeyAuthoring: human_independent_of_model_output`).
- **Run report**: one per case per run, produced by the future runner against `run-report.schema.json`. The report records:
  - `run` (runId, attempt, timestamps, environment, exact code revision),
  - `configuration` per component (chat/STT/vision/embedding: provider, model, route, prompt and schema versions),
  - `latencyMs` (first useful output + total), `attempts`, `cost` (metered USD),
  - `stages` with separate outcomes for `stt`, `vision`, `retrieval`, `memoryChanges` (published changes with values, scopes and evidence) and `clarifications` (asked questions),
  - `caseScore` (aggregate) and `caseOutcome` (`pass`/`fail`/`incomplete`/`provider_unavailable`).

Stage outcomes are reported separately on purpose: an aggregate can never conceal a stage failure or a critical error. Missing STT segments and unprocessed images stay explicitly `partial`/`incomplete`.

## Critical-error rule encoding (`critical-rules.mjs`)

The rule is encoded in `evaluateCase(report, expected)` and asserted by `probe/probe.mjs`:

1. **Wrong amount** — published decimal amount/range differs from the key → critical `amount`.
2. **Wrong project attribution** — a finding published under a project scope the key does not name for that finding → critical `project`.
3. **Wrong date** — any resolved date/datetime/range/time field differs → critical `date`.
4. **Wrong commitment** — business role differs (estimate recorded as agreed, proposal as agreement; also temporal roles proposal/internal_plan/agreed/actual/deadline) → critical `commitment`.
5. **Guessed tax basis** — VAT basis differs from the key. Two flavors: changing a stated net/gross basis, and recording net/gross where the key says `not_specified` (never-infer-VAT) → critical `source_basis`.

Any critical error forces case outcome `fail` **regardless of `caseScore`**. A readable, well-formed answer with a critical error is not a success.

## Clarification semantics

- A **correct required clarification** (the key demands a question because evidence is genuinely ambiguous) counts as **success** — not asking is a failure.
- A **needless clarification on clear evidence** fails that expected outcome (non-critical `clarification` failure; the case fails but is not in the critical classes).
- `provider_unavailable` passes through as its own outcome; provider outage is recorded separately from incorrect reasoning.

## Qualification gate (owned by J3, restated here for precision)

Pre-alpha acceptance: at least **48/50 correct case outcomes in each of three complete runs**, with **zero critical errors** (project, amount, date, commitment, source basis). This corpus supplies the fixed cases and keys; no such run has happened.

## Runner obligations when using this corpus

1. **Reset state per case.** Every case starts from its own `case.json` tenant (firm, bosses, contacts, projects, `existingFindings`). No case may inherit findings, aliases, projects or corrections from another case — not even within one run. Re-run of the corpus means re-instantiation, not continuation.
2. **Anchor time to the fixture clock.** Relative dates resolve against `sources[0].sentAt` in Europe/Warsaw, never against wall-clock processing time.
3. **Honor `timeline` beats.** Delayed `run_completion` entries model in-flight stale plans; `source_withdrawn`/`source_deleted` model lifecycle ops. Stage expectations in the key follow these beats.
4. **Record the corpus revision.** Reports carry `corpusRevision`; results are only comparable within one revision.

## Files

- `run-report.schema.json` — per-case report contract.
- `critical-rules.mjs` — rule encoding (pure functions, no model calls).
- `probe/probe.mjs` — deliberate probe; run with `node evals/expected/scoring/probe/probe.mjs`.
- `probe/wrong-amount.json`, `probe/wrong-project.json`, `probe/guessed-vat-basis.json` — hand-built reports, each with a high aggregate score (0.95–0.99) and exactly one planted critical error, plus two inline controls pinning clarification semantics.
