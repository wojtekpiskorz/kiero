/**
 * @kiero/domain calendar surface (G2): the PURE projection rules for the
 * "Kalendarz Kiero w Google" deep module — personal eligibility (selected
 * projects, coordinated-by-me or unassigned, open tasks and planned
 * events), the deterministic term mapping (all-day / interval /
 * five-minute marker), Polish copy text free of private source material,
 * stable copy identities, personal-hide persistence, idempotent
 * desired-state diffing, and the per-pass connection suspension rules.
 *
 * No I/O, no Convex, no clock: every function is total over small row
 * views. The transaction halves in convex/calendar/projection adapt these
 * decisions to single-mutation writes; tests/g2 prove the boundaries
 * without a deployment.
 */

export * from "./projection";
export * from "./hide";
export * from "./diff";
export * from "./pass";
