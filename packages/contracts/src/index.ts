/**
 * @kiero/contracts: candidate typed contracts for Kiero core.
 *
 * Defined by A2 ("Define candidate typed contracts and modular schema
 * ownership"). This package owns:
 *
 * - the semantic value contracts (knowledge state, temporal values, money,
 *   typed extension values) decoded with Effect Schema 4;
 * - the actor context, command/result envelopes, closed sanitized errors,
 *   event/outbox envelopes, durable job envelopes and staged media/
 *   publication states;
 * - the typed id convention (per-table branded document ids, generated ids);
 * - the module surface declarations (operation/event names per module) and
 *   the feature/executor/event-consumer registration entries.
 *
 * These are CANDIDATES until A3 proves the actual validation and runtime
 * conversion and certifies this baseline; production consumers start only
 * behind that gate. Nothing here implements business work: dispatching an
 * unimplemented operation fails closed with the `unsupported` closed error.
 */

// Typed ids and generated identifiers.
export * from "./tableIds";

// Envelopes and closed errors.
export * from "./errors";
export * from "./actor";
export * from "./events";
export * from "./jobs";
export * from "./media";

// Semantic value contracts.
export * from "./values/knowledge";
export * from "./values/temporal";
export * from "./values/money";
export * from "./values/extension";

// Module surfaces and registration.
export * from "./modules/registration";
export * from "./modules/access";
export * from "./modules/sources";
export * from "./modules/memory";
export * from "./modules/projects";
export * from "./modules/work";
export * from "./modules/attention";
export * from "./modules/calendar";
export * from "./modules/operations";
export * from "./modules/search";
export * from "./modules/integrations";
export * from "./modules/registry";
