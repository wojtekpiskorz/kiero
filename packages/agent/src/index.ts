/**
 * @kiero/agent: source-grounded planning and tools (execution charter).
 *
 * The planning surface for text analysis (E3) lives in ./planning and is
 * re-exported here as the package's public interface. It is pure: the
 * bounded agent loop, the durable executors and the checked publication
 * path compose it from convex/processing/text.
 */

export * from "../planning/index.js";
// E4 amendment: the pure multimodal-join surface composed over the planning
// package (extraction owns it; planning stays E3's unchanged shape).
export * from "../extraction/index.js";
