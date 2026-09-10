/**
 * @kiero/domain work surface (C4): the PURE semantic rules for the work
 * half of the "Projects and work" deep module — task states (Czeka with a
 * saved reason), the one-level checklist whose completion is independent
 * of the parent task, event states (a passed date proves nothing), the
 * executor/coordinator split with effective coordination derived from
 * membership lifecycle, temporal bindings by finding reference, and the
 * derived dueness ("Zadanie po terminie" in the company timezone).
 *
 * No I/O, no Convex, no clock: every function is total over small row
 * views. The transaction halves in convex/work adapt these decisions to
 * single-mutation writes; tests/c4 prove the boundaries without a
 * deployment.
 */

export * from "./taskState";
export * from "./checklist";
export * from "./eventState";
export * from "./dueness";
export * from "./coordination";
