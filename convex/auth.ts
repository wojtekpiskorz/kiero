/**
 * The Convex Auth module entry (platform convention).
 *
 * The auth client and the Convex platform resolve the sign-in functions
 * under the `auth` module path (`auth:signIn`, `auth:signOut`), so this
 * file must exist at the convex root and re-export the configured
 * functions. All configuration and policy live in the owning lane:
 * convex/access/identity/authEntry.ts (B1).
 */

export { auth, signIn, signOut, store, isAuthenticated } from "./access/identity/authEntry";
