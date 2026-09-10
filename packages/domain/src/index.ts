/**
 * @kiero/domain: bootstrap placeholder.
 *
 * This package will own the pure semantic rules for findings, projects,
 * work and Calendar projection (execution charter). No business rules are
 * implemented in this bootstrap.
 */
export const DOMAIN_NOT_IMPLEMENTED: "bootstrap-placeholder" =
  "bootstrap-placeholder";

// C2 coordinated addition (flagged): the findings domain owns its rules in
// packages/domain/findings/**; the package surface re-exports them here the
// same way convex/schema.ts gains an import spread per fragment. Later
// domains (projects, work, calendar) repeat this one-line pattern.
export * from "../findings/index";

// C4 coordinated addition (flagged, the same one-line pattern): the work
// domain owns its rules in packages/domain/work/**.
export * from "../work/index";

// C3 coordinated addition (flagged): the extensions domain (versioned typed
// extensions and catalog reuse) follows the same one-line pattern.
export * from "../extensions/index";
