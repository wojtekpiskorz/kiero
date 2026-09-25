/**
 * @kiero/domain/projects: the pure semantic rules for the projects half of
 * the "Projects and work" deep module.
 *
 * Everything here is total functions over small row views: no db, no
 * Convex, no clock. The transaction halves in `convex/projects/` adapt these
 * decisions to single-mutation writes; tests/c1 prove the boundaries
 * (stage vocabulary and transitions, pause/stage separation, codename
 * reservation across retained history, role multiplicity) without a
 * deployment.
 *
 * Consumers reach this folder through explicit relative imports; it is not
 * re-exported from `src/index.ts`.
 */

export * from "./stages";
export * from "./pause";
export * from "./aliases";
export * from "./contacts";
export * from "./project";
export type { Validated } from "./result";
