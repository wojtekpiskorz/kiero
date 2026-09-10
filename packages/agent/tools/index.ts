/**
 * @kiero/agent/tools: the pure answer-tools surface (E6).
 *
 * Small public interface, Convex-free and model-free by construction:
 *
 * - `AnswerContext` + derivations: the tenant-filtered snapshot one answer
 *   run reads, with the C5 updating gate applied at load;
 * - the seven tool input schemas (`agent_search_evidence`,
 *   `agent_submit_answer`, `agent_ask_clarification`,
 *   `agent_resolve_clarification`, `agent_change_task`,
 *   `agent_change_event`, `agent_validate_extension_value`): the decode
 *   authority for tool arguments coming back through E2's chat adapter;
 * - `applyAnswerToolCall`: the decoded-not-executed answer-contract
 *   reducer (grounded vs ungrounded, corroboration is a second witness,
 *   the updating gate, ambiguity → clarification);
 * - `decideAnswerFreshness`: the in-flight staleness recheck decision;
 * - the versioned Polish dialogue builder (system prompt, question
 *   message, tool-result encodings).
 *
 * The Convex-coupled half (context loading, tenant-scoped evidence search,
 * checked executions through the C2-C4 dispatches, the bounded answer
 * loop) lives in convex/agent.
 */

export * from "./versions";
export * from "./context";
export * from "./tools";
export * from "./reducer";
export * from "./prompt";
