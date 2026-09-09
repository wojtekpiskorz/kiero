# Scoring contract (E1): runner input, critical-error rules, probe

This directory defines the **scorer INPUT contract** consumed by D6 and the E2–E6/J3 proof owners. E1 did not run any model, did not produce benchmark results, and owns no runner: the real runs belong to D6 (STT tooling/audio assets), J3 (quality qualification) and later proof tickets. Nothing here can rewrite the answer keys, which live outside any provider implementation path.

## Inputs

- **Answer key**: `../<caseId>.json` (one per corpus case, human-authored, `answerKeyAuthoring: human_independent_of_model_output`).
- **Run report**: one per case per run, produced by the future runner against `run-report.schema.json`. The report records:
  - `run` (runId, attempt, timestamps, environment, exact code revision),
  - `configuration` per component (chat/STT/vision/embedding: provider, model, route, prompt and schema versions),
  - `latencyMs` (first useful output + total), `attempts`, `cost` (metered USD),
  - `stages` with separate outcomes for `stt`, `vision`, `retrieval`, `memoryChanges` and `clarifications`,
  - `caseScore` (aggregate) and `caseOutcome` (`pass`/`fail`/`incomplete`/`provider_unavailable`).

Stage outcomes are reported separately on purpose: an aggregate can never conceal a stage failure or a critical error. Missing STT segments and unprocessed images stay explicitly `partial`/`incomplete`.

## Published semantics (binding)

`stages.memoryChanges.published` is an **ordered list of per-beat snapshots mirroring the answer key's `stages` array**:

- One snapshot per expected stage, same order, each carrying the `stageId` copied from the key. Missing or reordered snapshots fail scoring.
- Each snapshot lists the full current state at that beat of every finding the run touched: exactly one entry per `findingKey`+`scope` (multiple entries for the same key+scope in one beat are ambiguous publication and fail).
- The last snapshot is the final state after the whole case timeline (all sources processed, all `run_completion` beats done, lifecycle ops applied).
- Entries matching no expected change at any stage are **extra writes** and fail.

This is what makes in-flight stale overwrites visible: in the T13/V13/M02 class the delayed older analysis republishes its superseded value at a later beat, so the final snapshot carries the wrong current value (see probe 4). A final-state-only report cannot hide it, because beats are mandatory whenever the key has stages.

## Critical-error rule encoding (`critical-rules.mjs`)

The rule is encoded in `evaluateCase(report, expected)` and asserted by `probe/probe.mjs`:

1. **Wrong amount**: published decimal amount/range differs from the key at any beat. Critical `amount`.
2. **Wrong project attribution**: a finding published under a project scope the key does not name for that finding. Critical `project`.
3. **Wrong date**: any resolved date/datetime/range/time field differs. Critical `date`.
4. **Wrong commitment**: business role differs (estimate recorded as agreed, proposal as agreement; also temporal roles proposal/internal_plan/agreed/actual/deadline). Critical `commitment`.
5. **Guessed tax basis**: VAT basis differs from the key. Two flavors: changing a stated net/gross basis, and recording net/gross where the key says `not_specified` (never-infer-VAT). Critical `source_basis`.
6. **Unsupported information presented as established**: expected knowledgeState `unknown`/`not_applicable`/`conflicted` (withdrawal, deletion, retraction) but the run publishes `known`. Critical `source_basis`.
7. **Extra writes**: a published entry no expected stage asks for. Critical when the fabricated value is financial (`amount`) or temporal (`date`); otherwise a non-critical failure.

Additionally verified per beat: `knowledgeState` (mismatches fail; the dangerous direction is critical per rule 6) and state-changing `operation`s (`mark_unknown`, `mark_conflicted`, `mark_not_applicable`, `create_project` must be recorded as such). `set` vs `supersede` labeling is not enforced since the correction history is verified through beat values, knowledgeState and evidence instead.

Any critical error forces case outcome `fail` **regardless of `caseScore`**. A readable, well-formed answer with a critical error is not a success.

## Prohibited writes

Prohibited writes from every key stage are consumed by the scorer:

- `clarification`-category writes drive the needless-question check directly (see below) and are cited in the failure detail.
- Every fired discrepancy is annotated with the matching prohibited write (by wrong-value number, then by findingKey mention), so each prohibited sentence is a live enforcement target rather than documentation.
- Behavior a prohibited write forbids but that appears in the report surfaces as a critical discrepancy (rules 1-7) or as an extra write.

## Clarification semantics

- A **correct required clarification** (any key stage demands a question because evidence is genuinely ambiguous) counts as **success**; not asking is a failure.
- A **needless clarification on clear evidence** fails that expected outcome (non-critical `clarification` failure; the case fails but is not in the critical classes).
- `provider_unavailable` passes through as its own outcome; provider outage is recorded separately from incorrect reasoning.

## Qualification gate (owned by J3, restated here for precision)

Pre-alpha acceptance: at least **48/50 correct case outcomes in each of three complete runs**, with **zero critical errors** (project, amount, date, commitment, source basis). This corpus supplies the fixed cases and keys; no such run has happened.

## Runner obligations when using this corpus

1. **Reset state per case.** Every case starts from its own `case.json` tenant (firm, bosses, contacts, projects, `existingFindings`). No case may inherit findings, aliases, projects or corrections from another case, not even within one run. Re-run of the corpus means re-instantiation, not continuation.
2. **Anchor time to the fixture clock.** Relative dates resolve against `sources[0].sentAt` in Europe/Warsaw, never against wall-clock processing time.
3. **Honor `timeline` beats.** Delayed `run_completion` entries model in-flight stale plans; `source_withdrawn`/`source_deleted` model lifecycle ops. Snapshot `published` state at each key-stage boundary.
4. **Record the corpus revision.** Reports carry `corpusRevision`; results are only comparable within one revision.

## Files

- `run-report.schema.json`: per-case report contract, including the binding `published` semantics.
- `critical-rules.mjs`: rule encoding (pure functions, no model calls).
- `probe/probe.mjs`: deliberate probe; run with `node evals/expected/scoring/probe/probe.mjs`.
- Probe reports, each with a high aggregate score (0.95 to 1.0) and exactly one planted error:
  - `wrong-amount.json` (T02, 1 200 000 instead of 12 000),
  - `wrong-project.json` (T06, tile color on Banan instead of Bananowa),
  - `guessed-vat-basis.json` (T02, clear "netto" recorded as gross),
  - `stale-overwrite.json` (T13, delayed S1 analysis republishes 15 000 over the published 12 500 correction; beat 1 is correct, the final beat is wrong, caseScore 1.0).
- Two inline controls in `probe.mjs` pin the clarification semantics (M03 required question is success; T01 needless question fails).
