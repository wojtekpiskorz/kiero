/**
 * B1 focused verification: the sign-in user policy.
 *
 * The load-bearing product rule: provider sign-ins create or resume the
 * correct person identity and NEVER link methods by email equality
 * (docs/research/auth-identity-facts.md; verified linking is B2's).
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import {
  GoogleProfile,
  EmailCodeProfile,
  decideCreateOrUpdateUser,
  displayNameFromEmail,
  type UserPolicyUser,
} from "../../convex/access/identity/userPolicy";

const googleProfile = {
  sub: "google-sub-123",
  email: "szef@firma.pl",
  emailVerified: true,
  name: "Szef Firma",
};

const emailProfile = { email: "szef@firma.pl" };

function user(overrides: Partial<UserPolicyUser>): UserPolicyUser {
  return { id: "k57u1", email: "szef@firma.pl", googleSubject: null, ...overrides };
}

describe("email-code sign-ins", () => {
  it("creates a fresh person when the address is unknown", () => {
    const decision = decideCreateOrUpdateUser({
      existingUserId: null,
      input: { method: "email_code", profile: emailProfile },
      usersWithEmail: [],
    });
    expect(decision).toEqual({
      action: "create",
      input: {
        email: "szef@firma.pl",
        displayName: "szef",
        emailVerified: false,
      },
    });
  });

  it("resumes the account's user on a repeated sign-in", () => {
    const decision = decideCreateOrUpdateUser({
      existingUserId: "k57u9",
      input: { method: "email_code", profile: emailProfile },
      usersWithEmail: [user({ id: "k57u9" })],
    });
    expect(decision).toEqual({ action: "resume", userId: "k57u9" });
  });

  it("resumes an orphaned email person (no cross-method identity)", () => {
    const decision = decideCreateOrUpdateUser({
      existingUserId: null,
      input: { method: "email_code", profile: emailProfile },
      usersWithEmail: [user({ id: "k57u1", googleSubject: null })],
    });
    expect(decision).toEqual({ action: "resume", userId: "k57u1" });
  });

  it("rejects email-code sign-in when the address belongs to a Google identity", () => {
    const decision = decideCreateOrUpdateUser({
      existingUserId: null,
      input: { method: "email_code", profile: emailProfile },
      usersWithEmail: [user({ googleSubject: "google-sub-9" })],
    });
    expect(decision).toEqual({ action: "reject", reason: "method_conflict" });
  });

  it("fails closed on ambiguous registry state (two users, one address)", () => {
    const decision = decideCreateOrUpdateUser({
      existingUserId: null,
      input: { method: "email_code", profile: emailProfile },
      usersWithEmail: [user({ id: "a" }), user({ id: "b" })],
    });
    expect(decision).toEqual({ action: "reject", reason: "method_conflict" });
  });
});

describe("Google sign-ins", () => {
  it("creates a fresh person keyed by the stable Google subject", () => {
    const decision = decideCreateOrUpdateUser({
      existingUserId: null,
      input: { method: "google", profile: googleProfile },
      usersWithEmail: [],
    });
    expect(decision).toEqual({
      action: "create",
      input: {
        email: "szef@firma.pl",
        displayName: "Szef Firma",
        googleSubject: "google-sub-123",
        emailVerified: true,
      },
    });
  });

  it("derives the display name from the address when Google sends none", () => {
    const decision = decideCreateOrUpdateUser({
      existingUserId: null,
      input: {
        method: "google",
        profile: { sub: "s", email: "kontakt@firma.pl", emailVerified: false },
      },
      usersWithEmail: [],
    });
    expect(decision.action).toBe("create");
    if (decision.action === "create") {
      expect(decision.input.displayName).toBe("kontakt");
      expect(decision.input.emailVerified).toBe(false);
    }
  });

  it("rejects Google sign-in when the address belongs to an email-code person", () => {
    const decision = decideCreateOrUpdateUser({
      existingUserId: null,
      input: { method: "google", profile: googleProfile },
      usersWithEmail: [user({ googleSubject: null })],
    });
    expect(decision).toEqual({ action: "reject", reason: "method_conflict" });
  });

  it("rejects Google sign-in when another Google account holds the address", () => {
    const decision = decideCreateOrUpdateUser({
      existingUserId: null,
      input: { method: "google", profile: googleProfile },
      usersWithEmail: [user({ googleSubject: "different-sub" })],
    });
    expect(decision).toEqual({ action: "reject", reason: "method_conflict" });
  });

  it("resumes the account's user (same Google subject) regardless of address collisions", () => {
    const decision = decideCreateOrUpdateUser({
      existingUserId: "k57u7",
      input: { method: "google", profile: googleProfile },
      usersWithEmail: [user({ id: "k57u7" })],
    });
    expect(decision).toEqual({ action: "resume", userId: "k57u7" });
  });
});

describe("profile schemas reject malformed provider data", () => {
  it("GoogleProfile rejects missing or mistyped sub/email", () => {
    const bad: unknown[] = [{ email: "x@y.pl" }, { sub: "s" }, { sub: 1, email: "x@y.pl" }];
    for (const input of bad) {
      expect(() => Schema.decodeUnknownSync(GoogleProfile)(input)).toThrow();
    }
  });

  it("decodes well-formed profiles", () => {
    expect(Schema.decodeUnknownSync(GoogleProfile)(googleProfile)).toEqual(googleProfile);
    expect(Schema.decodeUnknownSync(EmailCodeProfile)(emailProfile)).toEqual(emailProfile);
  });
});

describe("displayNameFromEmail", () => {
  it("uses the local part", () => {
    expect(displayNameFromEmail("jan.kowalski@firma.pl")).toBe("jan.kowalski");
  });
  it("survives addresses without an @", () => {
    expect(displayNameFromEmail("broken")).toBe("broken");
  });
});
