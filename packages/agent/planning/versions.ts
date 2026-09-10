/**
 * Version labels of the text-analysis planning surface (E3).
 *
 * Every processing run records its workflow, prompt, schema and
 * model/route configuration version (issue #37: "Every run records
 * workflow, prompt, schema, model/route and input-revision versions with
 * resumable stage status"). These constants are the single source the
 * Convex-side executor copies onto the `processingRuns` row; bumping any
 * of them is a deliberate, reviewable change because recorded runs stay
 * interpretable against the version that produced them.
 */

/** The text-analysis pipeline version (workflow shape, stage order). */
export const TEXT_ANALYSIS_PIPELINE_VERSION = "e3.text/1" as const;

/** The Polish analysis system prompt version (packages/agent/planning/prompt.ts). */
export const PLANNING_PROMPT_VERSION = "e3.prompt-pl/2" as const;

/** The tool/input schema version the model's arguments decode against. */
export const PLANNING_SCHEMA_VERSION = "e3.schema/1" as const;

/** Bounded model turns per analysis run (single-digit provider requests). */
export const MAX_MODEL_TURNS = 3;

/** Bounded characters of author text handed to the model per turn. */
export const MAX_PROMPT_SOURCE_CHARS = 6_000;

/** Bounded findings rows exposed in the analysis context. */
export const MAX_CONTEXT_FINDINGS = 40;

/** Bounded projects exposed in the analysis context. */
export const MAX_CONTEXT_PROJECTS = 20;

/** Bounded recent sources (previews) exposed in the analysis context. */
export const MAX_CONTEXT_RECENT_SOURCES = 10;

/** Bounded characters of one recent source preview. */
export const MAX_RECENT_SOURCE_PREVIEW_CHARS = 160;

/** Bounded proposals one run may accumulate (a plan stays reviewable). */
export const MAX_PROPOSALS = 24;

/** Bounded clarifications one run may raise. */
export const MAX_CLARIFICATIONS = 4;
