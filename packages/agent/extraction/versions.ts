/**
 * Version labels and bounds of the multimodal join surface (E4).
 *
 * The join composes E3's text planning with D5's retained image
 * representations and D6's transcript versions into partial-safe analysis
 * (architecture protocol steps 5-6: "Run versioned STT/vision and prepare
 * bounded source-linked information groups. A missing required segment is
 * pending, not a complete transcript. Text-only fallback cannot claim to
 * have inspected a pending image").
 *
 * Like {@link TEXT_ANALYSIS_PIPELINE_VERSION}, these constants are the
 * single source the Convex-side executor copies onto the `processingRuns`
 * row; bumping any of them is a deliberate, reviewable change.
 */

/** The multimodal-join pipeline version (workflow shape, stage order). */
export const MULTIMODAL_JOIN_PIPELINE_VERSION = "e4.join/1" as const;

/** The Polish joined-analysis system prompt version (./prompt.ts). */
export const JOIN_PROMPT_VERSION = "e4.prompt-pl/1" as const;

/** The tool/input schema version the join's arguments decode against. */
export const JOIN_SCHEMA_VERSION = "e4.schema/1" as const;

/** The vision-extraction pipeline version (the E4 vision order row). */
export const VISION_EXTRACTION_PIPELINE_VERSION = "e4.vision/1" as const;

/** Bounded model turns per joined-analysis run. */
export const MAX_JOIN_MODEL_TURNS = 4;

/** Bounded characters of assembled transcript text handed to the model. */
export const MAX_TRANSCRIPT_PROMPT_CHARS = 8_000;

/** Bounded characters of vision-observation text handed to the model. */
export const MAX_VISION_PROMPT_CHARS = 4_000;

/** Bounded vision observations recorded per image extraction. */
export const MAX_VISION_OBSERVATIONS = 16;

/** Bounded characters of one vision observation's text. */
export const MAX_VISION_OBSERVATION_CHARS = 400;

/** Bounded evidence quotes per proposal across every modality. */
export const MAX_EVIDENCE_QUOTES = 8;

/**
 * The bounded wall-clock wait the join grants actively-progressing media
 * (photo normalization still running, STT segments still transcribing)
 * before it proceeds partial-safe: independent text groups publish, the
 * media-dependent conclusions stay pending. Blocked media (a planning
 * transcript with a sanitized error kind) never waits — it is externally
 * blocked and resumable, not progressing.
 */
export const MEDIA_WAIT_BUDGET_MS = 240_000;
