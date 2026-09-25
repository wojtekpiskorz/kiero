/**
 * @kiero/agent/extraction: the pure multimodal-join surface.
 *
 * Small public interface, Convex-free and model-free by construction,
 * composed over the planning surface (../planning) rather than forked
 * from it:
 *
 * - the joined coverage snapshot (`joinCoverage`, `decideJoinedCompleteness`):
 *   names EVERY required input of a mixed source — the author's text plus
 *   every accepted audio and image attachment — with its honest status
 *   (complete / pending / externally blocked / failed / superseded by a
 *   newer extraction version);
 * - the typed vision-extraction contract (`VisionExtractionOutput`) with
 *   the representation-pinned coordinate-space validation
 *   (`validateImageRegion`);
 * - multimodal grounding (`locateTranscriptQuote`,
 *   `resolveObservationReference`): transcript quotes anchor ORIGINAL-TIME
 *   intervals, image evidence anchors regions of the EXACT retained
 *   representation;
 * - the joined tool schemas and reducer (`JOIN_TOOLS`,
 *   `applyMultimodalCall`): decoded-not-executed accumulation with the
 *   validation discipline carried over every modality;
 * - completeness-based bounding (`boundMultimodalGroups`) and the
 *   inspection-honesty invariant (`mediaClaimsBackedByCompleteInputs`);
 * - the versioned Polish joined-dialogue builder.
 *
 * The Convex-coupled halves (the join workflow, vision orders, provider
 * calls, findings publication) live in convex/processing/multimodal.
 */

export * from "./versions";
export * from "./coverage";
export * from "./vision";
export * from "./grounding";
export * from "./tools";
export * from "./reducer";
export * from "./bounding";
export * from "./prompt";
