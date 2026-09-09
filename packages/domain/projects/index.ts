/**
 * @kiero/domain/projects: the pure semantic rules for the projects half of
 * the "Projects and work" deep module (C1).
 *
 * Everything here is total functions over small row views: no db, no
 * Convex, no clock. The transaction halves in `convex/projects/` adapt these
 * decisions to single-mutation writes; tests/c1 prove the boundaries
 * (stage vocabulary and transitions, pause/stage separation, codename
 * reservation across retained history, role multiplicity) without a
 * deployment.
 *
 * Consumers reach this folder through explicit relative imports until the
 * coordinated package exports amendment lands (a shared-file need reported
 * by C1: `packages/domain/package.json` exports and `src/index.ts`
 * re-exports are bootstrap-owned, not lane-owned).
 */

export * from "./stages";
export * from "./pause";
export * from "./aliases";
export * from "./contacts";
export * from "./project";
export type { Validated } from "./result";
