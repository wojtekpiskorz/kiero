/**
 * The platform auth provider declaration (Convex convention).
 *
 * Convex Auth issues its own JWTs for this deployment (issuer
 * CONVEX_SITE_URL, audience "convex"); this file tells the Convex
 * platform to accept them in `ctx.auth.getUserIdentity()`. The signing
 * key material (JWT_PRIVATE_KEY, JWKS) is deployment configuration set
 * through the Convex env CLI — values never live in the repository.
 */

export default {
  providers: [
    {
      domain: process.env.CONVEX_SITE_URL,
      applicationID: "convex",
    },
  ],
};
