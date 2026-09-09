/**
 * Knowledge-state explicitness rules (C2, "Value contracts").
 *
 * Knowledge is `known`, `unknown` with a reason, `conflicted` or
 * `not_applicable` — an EPISTEMIC vocabulary, deliberately separate from
 * business progress (task/event/project states) and from extraction
 * confidence (how sure the reader was about the bytes, which lives on
 * extraction records). Clearing, conflicting and marking not-applicable are
 * EXPLICIT constructions with a stated reason; a model-emitted `null` has no
 * path into any of them because the contract schemas make the fields
 * required and the constructors below always name their reason.
 */

import { Schema } from "effect";
import { KnowledgeState } from "@kiero/contracts";

/** Constructs the explicit clear: unknown, with the reason it is unknown. */
export function explicitUnknown(reason: string): KnowledgeState {
  return Schema.decodeUnknownSync(KnowledgeState)({
    _tag: "unknown",
    reason,
  });
}

/** Constructs the explicit conflict marking (a clarification owns the detail). */
export function explicitConflicted(): KnowledgeState {
  return Schema.decodeUnknownSync(KnowledgeState)({ _tag: "conflicted" });
}

/** Constructs the explicit not-applicable marking, with its reason. */
export function explicitNotApplicable(): KnowledgeState {
  return Schema.decodeUnknownSync(KnowledgeState)({ _tag: "not_applicable" });
}

/** The reason recorded when a withdrawn source was the only support left. */
export function sourceWithdrawnReason(detail: string): string {
  return `source_withdrawn: ${detail}`;
}
