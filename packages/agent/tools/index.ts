/**
 * @kiero/agent/tools: the pure answer-tools surface.
 *
 * Small public interface, Convex-free and model-free by construction:
 *
 * - `AnswerContext` + derivations: the tenant-filtered snapshot one answer
 *   run reads, with the updating gate applied at load;
 * - the seven tool input schemas (`agent_search_evidence`,
 *   `agent_submit_answer`, `agent_ask_clarification`,
 *   `agent_resolve_clarification`, `agent_change_task`,
 *   `agent_change_event`, `agent_validate_extension_value`): the decode
 *   authority for tool arguments coming back through the chat adapter;
 * - `applyAnswerToolCall`: the decoded-not-executed answer-contract
 *   reducer (grounded vs ungrounded, corroboration is a second witness,
 *   the updating gate, ambiguity → clarification);
 * - `decideAnswerFreshness` + the submit gate: the in-flight staleness
 *   recheck decision and its honest handling (refresh, or refuse when
 *   the world vanished, the recheck failed, or the refresh budget is
 *   spent);
 * - `parseTextToolCalls`: the text-encoded tool-call rescue through the
 *   same declared-schemas decode authority;
 * - `tokenize`/`inflectionMatch`/`overlapLocation`: the pure,
 *   inflection-tolerant matching half of the tenant-scoped evidence
 *   search;
 * - the versioned Polish dialogue builders (system prompt, question
 *   message, evidence-result encoding). The former prose tool-round
 *   renderings were deleted when the answer loop switched to replaying
 *   NATIVE tool rounds; the planning copies in
 *   @kiero/agent stay live for text and multimodal analysis.
 *
 * The Convex-coupled half (context loading, tenant-scoped evidence search,
 * checked executions through the memory and work dispatches, the bounded answer
 * loop) lives in convex/agent.
 */

export * from "./versions";
export * from "./context";
export * from "./tools";
export * from "./reducer";
export * from "./prompt";
export * from "./rescue";
export * from "./evidence";
