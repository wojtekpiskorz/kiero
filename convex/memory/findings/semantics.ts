/**
 * The findings lane's typed authority surface (C2): the contract entries it
 * implements, the input types their handlers consume, the one proved
 * encode/decode set for the semantic values crossing this lane's persisted
 * rows, and the pre-insert template id every writing core shares.
 *
 * The dispatch decodes untrusted input through these entries exactly once
 * and hands handlers the DECODED value; the transaction cores re-encode
 * through the same codecs when staging rows (BigDecimal and friends are not
 * Convex-serializable, so rows always carry the encoded wire form).
 */

import { Schema } from "effect";
import {
  FindingValue,
  KnowledgeState,
  TemporalValue,
  memoryOperations,
} from "@kiero/contracts";

// ---------------------------------------------------------------------------
// Contract entries (decode/typed authority for this lane's operations).
// ---------------------------------------------------------------------------

export const readCurrentFindingsEntry = memoryOperations["memory.readCurrentFindings"];
export const prepareChangeSetEntry = memoryOperations["memory.prepareChangeSet"];
export const publishChangeSetEntry = memoryOperations["memory.publishChangeSet"];
export const correctFindingEntry = memoryOperations["memory.correctFinding"];
export const raiseClarificationEntry = memoryOperations["memory.raiseClarification"];
export const resolveClarificationEntry = memoryOperations["memory.resolveClarification"];

export type PrepareChangeSetInput = Schema.Schema.Type<typeof prepareChangeSetEntry.input>;
export type PublishChangeSetInput = Schema.Schema.Type<typeof publishChangeSetEntry.input>;
export type CorrectFindingInput = Schema.Schema.Type<typeof correctFindingEntry.input>;
export type RaiseClarificationInput = Schema.Schema.Type<typeof raiseClarificationEntry.input>;
export type ResolveClarificationInput = Schema.Schema.Type<
  typeof resolveClarificationEntry.input
>;
export type ReadCurrentFindingsInput = Schema.Schema.Type<
  typeof readCurrentFindingsEntry.input
>;

// ---------------------------------------------------------------------------
// The one proved conversion set (decoded <-> encoded wire form).
// ---------------------------------------------------------------------------

export const encodeFindingValue = Schema.encodeSync(FindingValue);
export const encodeKnowledgeState = Schema.encodeSync(KnowledgeState);
export const encodeTemporalValue = Schema.encodeSync(TemporalValue);
export const decodeFindingValue = Schema.decodeUnknownSync(FindingValue);
export const decodeKnowledgeState = Schema.decodeUnknownSync(KnowledgeState);
export const decodeTemporalValue = Schema.decodeUnknownSync(TemporalValue);

/**
 * A representative table id used only by the pre-insert decode templates
 * (D1's pattern): proves the result/event schemas still accept the exact
 * shapes this transaction constructs, BEFORE anything is written.
 */
export const TEMPLATE_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f";
