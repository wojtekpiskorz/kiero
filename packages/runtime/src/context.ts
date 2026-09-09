/**
 * Actor/session/tenant request context and the authorization seam.
 *
 * The request context is always RESOLVED from a verified identity, never
 * accepted from client input (architecture "Deep modules": the server resolves
 * the actor and firm). Two identity sources exist and only two:
 *
 * - `convex-auth`: the authenticated user identity from `ctx.auth` (Convex
 *   Auth; B1 owns the sign-in product that produces it).
 * - `service-bridge`: the Worker service identity, verified server-side by a
 *   bearer credential check at the bridge HTTP boundary.
 *
 * Both feed the SAME canonical resolution (session row -> user -> active
 * membership -> ActorContext) and the SAME canonical access check. There is no
 * development-auth shortcut: no code path constructs an ActorContext from
 * unverified input, and absent identities fail `unauthenticated`.
 *
 * B1/B3 supply the authoritative access rules by registering a policy through
 * this seam; until then the platform default policy (`membershipPolicy`)
 * decides from the resolved membership role and GM flag alone.
 */

import type {
  ActorContext,
  ClosedError,
  CompanyId,
  DurableJobKind,
} from "@kiero/contracts";
import { forbiddenError, unauthenticatedError } from "./errors";

/** Where a verified identity came from. */
export type IdentityIssuer = "convex-auth" | "service-bridge";

/**
 * A verified identity claim. Constructed ONLY by the identity sources above;
 * carrying one of these is a statement that verification already happened.
 */
export interface VerifiedIdentity {
  readonly issuer: IdentityIssuer;
  /** Subject: the `sessions` row id for both issuers. */
  readonly subject: string;
  readonly verifiedAtMs: number;
}

/** The resolved request context handed to every checked operation. */
export interface RequestContext {
  readonly actor: ActorContext;
  readonly resolvedAtMs: number;
}

/** What a command wants to do, at the granularity the policy decides on. */
export type AccessIntent =
  | "read"
  | "write"
  | "execute"
  | "administer"
  /** Audited GM inspection; separate from company membership (CONTEXT.md "GM"). */
  | "inspectGm";

/** A policy decision request: the intent plus the company scope it targets. */
export interface AccessRequest {
  readonly intent: AccessIntent;
  /** When present, must equal the actor's resolved company (tenant check). */
  readonly companyId?: CompanyId;
  /** The durable job kind an `execute` intent wants to run. */
  readonly jobKind?: DurableJobKind;
}

/** The decision: allowed, or denied with a sanitized closed error. */
export type AuthorizationDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly error: ClosedError };

/**
 * The authorization seam. B1/B3 register the authoritative implementation;
 * the platform always consults exactly one policy per command.
 */
export interface AccessPolicy {
  readonly policyId: string;
  authorize(
    context: RequestContext | null,
    request: AccessRequest,
  ): Promise<AuthorizationDecision>;
}

/**
 * The platform default policy: membership-role semantics over the RESOLVED
 * context. `null` context (no verified identity) always denies. A requested
 * company scope must equal the resolved tenant scope. This is a real check
 * over real session/membership rows; it is not, and cannot be, faked from
 * client input. B1/B3 replace it with the authoritative rule set.
 */
export const membershipPolicy: AccessPolicy = {
  policyId: "platform.membership-default",
  authorize: async (context, request) => {
    if (context === null) {
      return { allowed: false, error: unauthenticatedError() };
    }
    if (request.companyId !== undefined && request.companyId !== context.actor.companyId) {
      return {
        allowed: false,
        error: forbiddenError("tenant_scope_mismatch", "company"),
      };
    }
    switch (request.intent) {
      case "read":
      case "write":
      case "execute":
        return { allowed: true };
      case "administer":
        return context.actor.membershipRole === "admin"
          ? { allowed: true }
          : { allowed: false, error: forbiddenError("requires_admin", "company") };
      case "inspectGm":
        return context.actor.isGm
          ? { allowed: true }
          : { allowed: false, error: forbiddenError("requires_gm", "gm") };
    }
  },
};
