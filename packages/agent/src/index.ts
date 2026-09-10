/**
 * @kiero/agent: source-grounded planning and tools (execution charter).
 *
 * The planning surface for text analysis (E3) lives in ./planning and is
 * re-exported here as the package's public interface. It is pure: the
 * bounded agent loop, the durable executors and the checked publication
 * path compose it from convex/processing/text.
 */

export * from "../planning/index.js";
