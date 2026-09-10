/**
 * Version labels and bounds of the answer-tools surface (E6).
 *
 * The answer flow records which prompt, tool schema and model/route
 * configuration produced an answer, so every recorded answer stays
 * interpretable against the versions that produced it (the E3 precedent:
 * wording changes are version bumps, never silent edits). Bounds keep one
 * answer run single-digit provider requests with a reviewable shape.
 */

/** The answer-tool surface version (tool set shape, ledger contract). */
export const ANSWER_TOOLS_VERSION = "e6.tools/1" as const;

/** The Polish answer system prompt version (./prompt.ts). */
export const ANSWER_PROMPT_VERSION = "e6.prompt-pl/4" as const;

/** The tool/input schema version the model's arguments decode against. */
export const ANSWER_SCHEMA_VERSION = "e6.schema/1" as const;

/** Bounded model turns per answer run. */
export const MAX_ANSWER_TURNS = 6;

/** Bounded characters of the question text handed to the model. */
export const MAX_PROMPT_QUESTION_CHARS = 4_000;

/** Bounded findings rows exposed in the answer context. */
export const MAX_ANSWER_CONTEXT_FINDINGS = 40;

/** Bounded projects exposed in the answer context. */
export const MAX_ANSWER_CONTEXT_PROJECTS = 20;

/** Bounded recent sources (previews + processing state) in the context. */
export const MAX_ANSWER_RECENT_SOURCES = 12;

/** Bounded tasks and events (domain-change targets) in the context. */
export const MAX_ANSWER_CONTEXT_WORK = 30;

/** Bounded catalog contacts (executor candidates) in the context. */
export const MAX_ANSWER_CONTEXT_CONTACTS = 30;

/** Bounded boss memberships (coordinator candidates) in the context. */
export const MAX_ANSWER_CONTEXT_MEMBERSHIPS = 20;

/** Bounded characters of one recent source preview. */
export const MAX_ANSWER_SOURCE_PREVIEW_CHARS = 200;

/** Bounded evidence entries one search returns (candidates, never truth). */
export const MAX_EVIDENCE_SEARCH_RESULTS = 8;

/** Bounded evidence entries the whole run's ledger may accumulate. */
export const MAX_EVIDENCE_LEDGER = 32;

/** Bounded characters of one evidence quote. */
export const MAX_EVIDENCE_QUOTE_CHARS = 400;

/** Bounded statements one answer may carry (reviewable shape). */
export const MAX_ANSWER_STATEMENTS = 12;

/** Bounded characters of the boss-facing answer text. */
export const MAX_ANSWER_TEXT_CHARS = 4_000;

/** Bounded clarifications one answer run may raise. */
export const MAX_ANSWER_CLARIFICATIONS = 2;

/** Bounded mid-run context refreshes after a staleness recheck. */
export const MAX_ANSWER_REFRESHES = 1;
