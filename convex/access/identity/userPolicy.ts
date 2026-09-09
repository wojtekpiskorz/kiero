/**
 * The sign-in user policy: which person identity a provider sign-in
 * creates or resumes (B1).
 *
 * Kiero rule (accepted in the identity research and the issue #4 grilling):
 * a provider token identifies a person, but NEVER links methods by email
 * equality. Email-code proof controls the mailbox; Google proof controls
 * the Google account (stable `sub`, per Google's guidance). Linking the
 * two requires both proofs and is B2's explicit operation.
 *
 * Therefore this policy, which replaces Convex Auth's default
 * `createOrUpdateUser` (whose default would implicitly link by verified
 * email — `allowDangerousEmailAccountLinking` semantics):
 *
 * - a sign-in into an EXISTING account (same email-code account or same
 *   Google `sub`) resumes that account's user;
 * - otherwise a user may be created fresh, or resumed by email ONLY when
 *   that user has no other-method identity attached (an orphaned email
 *   person whose account row is gone);
 * - any address collision with another method's identity REJECTS the
 *   sign-in: no silent linking, no duplicate person rows.
 *
 * The decision half is pure (unit-tested); the Convex db half is a thin
 * adapter in ./authEntry.ts.
 */

import { Schema } from "effect";

/** Google profile as decoded from the OAuth callback (pinned Effect schema). */
export const GoogleProfile = Schema.Struct({
  /** Google's stable account id; the only authoritative Google identity. */
  sub: Schema.String,
  email: Schema.String,
  emailVerified: Schema.optional(Schema.Boolean),
  name: Schema.optional(Schema.String),
});
export type GoogleProfile = Schema.Schema.Type<typeof GoogleProfile>;

/** Email-code profile (issuance and verification callbacks). */
export const EmailCodeProfile = Schema.Struct({
  email: Schema.String,
});
export type EmailCodeProfile = Schema.Schema.Type<typeof EmailCodeProfile>;

/** One provider sign-in, narrowed so the profile matches the method. */
export type UserPolicyInput =
  | { readonly method: "google"; readonly profile: GoogleProfile }
  | { readonly method: "email_code"; readonly profile: EmailCodeProfile };

/** The read view of users the policy needs (satisfied by a Convex db). */
export interface UserPolicyUser {
  readonly id: string;
  readonly email: string;
  readonly googleSubject: string | null;
}

/** What the policy decided, before any write happens. */
export type UserPolicyDecision =
  | { readonly action: "resume"; readonly userId: string }
  | { readonly action: "create"; readonly input: CreateUserInput }
  | { readonly action: "reject"; readonly reason: "method_conflict" };

/**
 * Machine marker prefixing the method-conflict error the auth entry
 * throws, so client classification keys on it instead of Polish prose.
 * The web feature's twin literal is pinned equal by tests/b1.
 */
export const METHOD_CONFLICT_MARKER = "[kiero:method_conflict]";

export interface CreateUserInput {
  readonly email: string;
  readonly displayName: string;
  readonly googleSubject?: string;
  readonly emailVerified: boolean;
}

/** A display name for a fresh person (barebones: local part of the address). */
export function displayNameFromEmail(email: string): string {
  const local = email.split("@")[0] ?? email;
  return local.length > 0 ? local : email;
}

/**
 * Normalizes an address at the policy boundary: identities are stored and
 * compared case-insensitively (the local part of an address is technically
 * case-sensitive in RFC terms, but no major provider treats it so, and
 * mixed-case addresses MUST collide in the no-implicit-linking check —
 * otherwise `Szef@Firma.pl` and `szef@firma.pl` would silently create two
 * person rows).
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Decides the identity outcome of one provider sign-in.
 *
 * `existingUserId` is the library's "sign-in into this existing account"
 * signal (the authAccounts row was found); `usersWithEmail` is every user
 * row carrying the profile address (the policy refuses to touch users
 * that belong to another method).
 */
export function decideCreateOrUpdateUser(args: {
  existingUserId: string | null;
  input: UserPolicyInput;
  usersWithEmail: readonly UserPolicyUser[];
}): UserPolicyDecision {
  const { existingUserId, input } = args;

  if (existingUserId !== null) {
    return { action: "resume", userId: existingUserId };
  }

  // Case-insensitive at the boundary: the profile address is normalized
  // once here, and pre-fetched rows are kept only when their stored
  // address matches the normalized form (defensive against legacy rows).
  const normalizedEmail = normalizeEmail(input.profile.email);
  const usersWithEmail = args.usersWithEmail.filter(
    (user) => normalizeEmail(user.email) === normalizedEmail,
  );

  if (input.method === "google") {
    if (usersWithEmail.length > 0) {
      // The address belongs to another person identity (an email-code
      // person, or a different Google account). Neither links silently.
      return { action: "reject", reason: "method_conflict" };
    }
    return {
      action: "create",
      input: {
        email: normalizedEmail,
        displayName: input.profile.name ?? displayNameFromEmail(input.profile.email),
        googleSubject: input.profile.sub,
        emailVerified: input.profile.emailVerified === true,
      },
    };
  }

  if (usersWithEmail.length === 1) {
    const only = usersWithEmail[0];
    if (only !== undefined && only.googleSubject === null) {
      // An email person whose account row is gone: re-proving the same
      // mailbox resumes the same person (this is not cross-method linking).
      return { action: "resume", userId: only.id };
    }
    return { action: "reject", reason: "method_conflict" };
  }
  if (usersWithEmail.length > 1) {
    // Ambiguous registry state: fail closed rather than guess a person.
    return { action: "reject", reason: "method_conflict" };
  }
  return {
    action: "create",
    input: {
      email: normalizedEmail,
      displayName: displayNameFromEmail(input.profile.email),
      emailVerified: false,
    },
  };
}
