/**
 * @kiero/agent: source-grounded planning and tools (execution charter).
 *
 * The planning surface for text analysis lives in ./planning and is
 * re-exported here as the package's public interface. It is pure: the
 * bounded agent loop, the durable executors and the checked publication
 * path compose it from convex/processing/text.
 */

export * from "../planning/index.js";
// The pure multimodal-join surface composed over the planning
// package (extraction owns it; planning stays the unchanged shape).
export * from "../extraction/index.js";
