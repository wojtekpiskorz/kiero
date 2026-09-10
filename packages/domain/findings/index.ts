/**
 * @kiero/domain findings surface (C2): the PURE semantic rules for atomic
 * findings, revisions, provenance and corrections. No I/O, no Convex — the
 * transaction layer in convex/memory/findings runs these decisions inside
 * its own transaction; tests run them directly.
 */

export * from "./temporal";
export * from "./provenance";
export * from "./plan";
export * from "./knowledge";
export * from "./labels";
