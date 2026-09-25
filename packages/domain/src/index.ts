/**
 * @kiero/domain: bootstrap placeholder.
 *
 * This package will own the pure semantic rules for findings, projects,
 * work and Calendar projection (execution charter). No business rules are
 * implemented in this bootstrap.
 */
export const DOMAIN_NOT_IMPLEMENTED: "bootstrap-placeholder" =
  "bootstrap-placeholder";

// Each domain owns its rules in its own directory; the package surface
// re-exports them here, the same way convex/schema.ts gains an import
// spread per fragment.
export * from "../findings/index";

export * from "../work/index";

export * from "../extensions/index";

// Withdrawal recomputation: dependency traversal, updating-until-
// revalidated state, bounded recomputation grouping.
export * from "../provenance/index";

export * from "../calendar/index";
