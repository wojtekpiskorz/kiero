/**
 * The joined-analysis tool surface (E4): E3's three tools with the
 * multimodal evidence extensions.
 *
 * The tool NAMES are unchanged (`memory_upsert_finding`,
 * `projects_identify`, `memory_ask_clarification`) — the model-facing
 * vocabulary is one thing; the DECODE AUTHORITY for the join's arguments is
 * this module's schemas (`JOIN_SCHEMA_VERSION`), which extend E3's with:
 *
 * - `transcriptQuotes`: verbatim quotes from the ASSEMBLED TRANSCRIPT
 *   section of the context (D6's completed segments); the server locates
 *   them inside one segment and anchors the original-time interval;
 * - `imageObservationIds`: handles (`obs:<attachmentId>:<index>`) of vision
 *   observations printed in the context's IMAGES section. Observations
 *   exist there only for COMPLETED vision extractions, so a text-only run
 *   has no handle to claim image inspection with — and a hallucinated
 *   handle is refused by the reducer.
 *
 * `quotes` keeps E3's meaning: verbatim fragments of the author's typed
 * text.
 */

import { Schema } from "effect";
import {
  AskClarificationArgs,
  IDENTIFY_PROJECT_TOOL,
  IdentifyProjectArgs,
  PLANNING_TOOL_DESCRIPTIONS,
  UPSERT_FINDING_TOOL,
  UpsertFindingArgs,
  ASK_CLARIFICATION_TOOL,
} from "../planning/tools";
import { MAX_EVIDENCE_QUOTES } from "./versions";

/** The multimodal extension of `memory_upsert_finding` arguments. */
export const JoinUpsertFindingArgs = Schema.Struct({
  ...UpsertFindingArgs.fields,
  /** Verbatim quotes from the assembled transcript (audio evidence). */
  transcriptQuotes: Schema.Array(Schema.NonEmptyString).pipe(
    Schema.check(Schema.isMaxLength(MAX_EVIDENCE_QUOTES)),
  ),
  /** Observation handles from the context's IMAGES section (image evidence). */
  imageObservationIds: Schema.Array(Schema.NonEmptyString).pipe(
    Schema.check(Schema.isMaxLength(MAX_EVIDENCE_QUOTES)),
  ),
});
export type JoinUpsertFindingArgs = Schema.Schema.Type<typeof JoinUpsertFindingArgs>;

/** The clarification tool keeps its text shape (transcript quotes ride `quotes`). */
export const JoinAskClarificationArgs = AskClarificationArgs;

/** One declared tool for E2's `ChatToolSpec` (name + description + codec). */
export interface JoinToolSpec {
  readonly name: string;
  readonly description: string;
  readonly input:
    | typeof JoinUpsertFindingArgs
    | typeof IdentifyProjectArgs
    | typeof JoinAskClarificationArgs;
}

/** The Polish description additions for the multimodal evidence channels. */
export const JOIN_TOOL_DESCRIPTION_ADDENDUM = [
  "Dowody z nagrania podawaj w transcriptQuotes (dosłowne fragmenty transkrypcji z kontekstu),",
  "a dowody ze zdjęć jako imageObservationIds (uchwyty obs z sekcji ZDJĘCIA).",
  "Nie wolno wymyślać uchwytów obs ani cytować fragmentów, których nie ma w kontekście.",
].join(" ");

/** The three declared join tools, in declaration order. */
export const JOIN_TOOLS: readonly JoinToolSpec[] = [
  {
    name: UPSERT_FINDING_TOOL,
    description: `${PLANNING_TOOL_DESCRIPTIONS.upsertFinding} ${JOIN_TOOL_DESCRIPTION_ADDENDUM}`,
    input: JoinUpsertFindingArgs,
  },
  {
    name: IDENTIFY_PROJECT_TOOL,
    description: PLANNING_TOOL_DESCRIPTIONS.identifyProject,
    input: IdentifyProjectArgs,
  },
  {
    name: ASK_CLARIFICATION_TOOL,
    description: PLANNING_TOOL_DESCRIPTIONS.askClarification,
    input: JoinAskClarificationArgs,
  },
];
