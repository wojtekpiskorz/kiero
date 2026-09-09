/**
 * B2 focused verification: the pure linking policy.
 *
 * The load-bearing product rules (issue #21): a link commits only with a
 * FRESH proof from EACH method inside one ceremony; Google's address claim
 * counts only where Google is authoritative; a link that would merge two
 * established accounts is a typed rejection; nothing merges by email text
 * alone.
 */

import { describe, expect, it } from "vitest";
import {
  LINKING_PROOF_FRESHNESS_MS,
  RECENT_AUTH_MS,
  googleAuthoritativeForEmail,
  decideBeginLinking,
  decideConfirmEmailLink,
  decideEmailChangeConfirm,
  decideEmailChangeRequest,
  decideGoogleCallbackLink,
  proofFresh,
  type AccountView,
  type AttemptView,
  type GoogleLinkProfile,
} from "../../convex/access/linking/policy";

const NOW = 1_800_000_000_000;
const EMAIL = "szef@firma.pl";

function account(overrides: Partial<AccountView> = {}): AccountView {
  return { id: "k57user1", email: EMAIL, googleSubject: null, ...overrides };
}

function attempt(overrides: Partial<AttemptView> = {}): AttemptView {
  return {
    userId: "k57user1",
    email: EMAIL,
    targetMethod: "google",
    state: "awaiting_target_proof",
    expiresAtMs: NOW + 60_000,
    firstProofAtMs: NOW - 60_000,
    ...overrides,
  };
}

function googleProfile(overrides: Partial<GoogleLinkProfile> = {}): GoogleLinkProfile {
  return { sub: "g-sub-1", email: EMAIL, email_verified: true, ...overrides };
}

describe("googleAuthoritativeForEmail (research note's two cases)", () => {
  it("accepts a gmail address", () => {
    expect(
      googleAuthoritativeForEmail({ sub: "s", email: "szef@gmail.com" }),
    ).toBe(true);
  });

  it("accepts a verified Workspace address (email_verified + hd)", () => {
    expect(
      googleAuthoritativeForEmail({
        sub: "s",
        email: "szef@firma.pl",
        email_verified: true,
        hd: "firma.pl",
      }),
    ).toBe(true);
  });

  it("rejects an unverified external address", () => {
    expect(
      googleAuthoritativeForEmail({ sub: "s", email: EMAIL, email_verified: false }),
    ).toBe(false);
  });

  it("rejects a verified external address without hd (Google verified only its own account)", () => {
    expect(googleAuthoritativeForEmail(googleProfile())).toBe(false);
  });
});

describe("proof freshness", () => {
  it("accepts a proof just inside the window", () => {
    expect(proofFresh(NOW - LINKING_PROOF_FRESHNESS_MS, NOW, NOW + 1)).toBe(true);
  });

  it("rejects a proof one millisecond beyond the window", () => {
    expect(proofFresh(NOW - LINKING_PROOF_FRESHNESS_MS - 1, NOW, NOW + 1)).toBe(false);
  });

  it("rejects a missing proof and an expired ceremony", () => {
    expect(proofFresh(null, NOW, NOW + 1)).toBe(false);
    expect(proofFresh(NOW, NOW, NOW - 1)).toBe(false);
  });
});

describe("decideBeginLinking", () => {
  it("begins a google ceremony for an email person", () => {
    expect(
      decideBeginLinking({
        account: account(),
        targetMethod: "google",
        targetCredentialOwner: null,
        activeAttemptsAtEmail: [],
        nowMs: NOW,
      }),
    ).toEqual({ action: "begin" });
  });

  it("rejects when the method is already attached (google subject)", () => {
    expect(
      decideBeginLinking({
        account: account({ googleSubject: "g-sub-1" }),
        targetMethod: "google",
        targetCredentialOwner: null,
        activeAttemptsAtEmail: [],
        nowMs: NOW,
      }),
    ).toEqual({ action: "reject", reason: "method_already_attached" });
  });

  it("rejects when the email credential already belongs to the actor", () => {
    expect(
      decideBeginLinking({
        account: account({ googleSubject: "g-sub-1" }),
        targetMethod: "email_code",
        targetCredentialOwner: "k57user1",
        activeAttemptsAtEmail: [],
        nowMs: NOW,
      }),
    ).toEqual({ action: "reject", reason: "method_already_attached" });
  });

  it("rejects when the email credential belongs to another established account", () => {
    expect(
      decideBeginLinking({
        account: account({ googleSubject: "g-sub-1" }),
        targetMethod: "email_code",
        targetCredentialOwner: "k57user2",
        activeAttemptsAtEmail: [],
        nowMs: NOW,
      }),
    ).toEqual({ action: "reject", reason: "target_account_established" });
  });

  it("rejects a second concurrent ceremony for the same address", () => {
    expect(
      decideBeginLinking({
        account: account(),
        targetMethod: "google",
        targetCredentialOwner: null,
        activeAttemptsAtEmail: [attempt()],
        nowMs: NOW,
      }),
    ).toEqual({ action: "reject", reason: "ceremony_in_progress" });
  });

  it("allows a begin after the previous ceremony expired", () => {
    expect(
      decideBeginLinking({
        account: account(),
        targetMethod: "google",
        targetCredentialOwner: null,
        activeAttemptsAtEmail: [attempt({ expiresAtMs: NOW - 1 })],
        nowMs: NOW,
      }),
    ).toEqual({ action: "begin" });
  });
});

describe("decideGoogleCallbackLink (email person adds Google)", () => {
  const base = {
    profile: googleProfile({ email_verified: true, hd: "firma.pl" }),
    usersWithEmail: [account()],
    attemptsAtEmail: [attempt()],
    googleSubCredentialOwner: null,
    usersWithGoogleSub: [],
    nowMs: NOW,
  };

  it("commits when both proofs are fresh and the registry is clean", () => {
    expect(decideGoogleCallbackLink(base)).toEqual({
      action: "commit",
      userId: "k57user1",
      googleSub: "g-sub-1",
    });
  });

  it("rejects without an active ceremony (same-email sign-in never merges)", () => {
    expect(decideGoogleCallbackLink({ ...base, attemptsAtEmail: [] })).toEqual({
      action: "reject",
      reason: "no_active_ceremony",
    });
  });

  it("rejects a stale first proof", () => {
    expect(
      decideGoogleCallbackLink({
        ...base,
        attemptsAtEmail: [attempt({ firstProofAtMs: NOW - LINKING_PROOF_FRESHNESS_MS - 1 })],
      }),
    ).toEqual({ action: "reject", reason: "proof_stale" });
  });

  it("rejects a mismatched address", () => {
    expect(
      decideGoogleCallbackLink({
        ...base,
        attemptsAtEmail: [attempt({ email: "inny@firma.pl" })],
      }),
    ).toEqual({ action: "reject", reason: "mismatched_address" });
  });

  it("rejects a Google claim Google is not authoritative for", () => {
    expect(decideGoogleCallbackLink({ ...base, profile: googleProfile() })).toEqual({
      action: "reject",
      reason: "google_email_unproven",
    });
  });

  it("rejects when the Google subject already belongs to an established account", () => {
    expect(
      decideGoogleCallbackLink({ ...base, googleSubCredentialOwner: "k57user2" }),
    ).toEqual({ action: "reject", reason: "target_account_established" });
    expect(decideGoogleCallbackLink({ ...base, usersWithGoogleSub: ["k57user2"] })).toEqual({
      action: "reject",
      reason: "target_account_established",
    });
  });

  it("rejects an ambiguous registry (two rows at the address)", () => {
    expect(
      decideGoogleCallbackLink({ ...base, usersWithEmail: [account(), account({ id: "k57user2" })] }),
    ).toEqual({ action: "reject", reason: "ambiguous_registry" });
  });

  it("rejects when the only row already carries a google subject", () => {
    expect(
      decideGoogleCallbackLink({
        ...base,
        usersWithEmail: [account({ googleSubject: "g-other" })],
      }),
    ).toEqual({ action: "reject", reason: "method_already_attached" });
  });
});

describe("decideConfirmEmailLink (google person adds email-code)", () => {
  const googlePerson = account({ googleSubject: "g-sub-1" });
  const base = {
    attempt: { ...attempt({ targetMethod: "email_code" }), pendingCodeExpiresAtMs: NOW + 60_000 },
    account: googlePerson,
    providedCodeHash: "hash-ok",
    pendingCodeHash: "hash-ok",
    emailCredentialOwner: null,
    nowMs: NOW,
  };

  it("commits with a fresh google proof and a matching unexpired code", () => {
    expect(decideConfirmEmailLink(base)).toEqual({ action: "commit" });
  });

  it("rejects a wrong or expired code", () => {
    expect(decideConfirmEmailLink({ ...base, providedCodeHash: "hash-bad" })).toEqual({
      action: "reject",
      reason: "code_wrong_or_expired",
    });
    expect(
      decideConfirmEmailLink({
        ...base,
        attempt: { ...base.attempt, pendingCodeExpiresAtMs: NOW - 1 },
      }),
    ).toEqual({ action: "reject", reason: "code_wrong_or_expired" });
  });

  it("rejects a stale google first proof", () => {
    expect(
      decideConfirmEmailLink({
        ...base,
        attempt: { ...base.attempt, firstProofAtMs: NOW - LINKING_PROOF_FRESHNESS_MS - 1 },
      }),
    ).toEqual({ action: "reject", reason: "proof_stale" });
  });

  it("rejects when the address's email credential belongs to another account", () => {
    expect(decideConfirmEmailLink({ ...base, emailCredentialOwner: "k57user2" })).toEqual({
      action: "reject",
      reason: "target_account_established",
    });
  });

  it("rejects a ceremony not awaiting its target proof", () => {
    expect(
      decideConfirmEmailLink({
        ...base,
        attempt: { ...base.attempt, state: "awaiting_first_proof" },
      }),
    ).toEqual({ action: "reject", reason: "no_active_ceremony" });
  });
});

describe("email change decisions", () => {
  it("requests only with recent authentication and a distinct well-formed address", () => {
    expect(
      decideEmailChangeRequest({
        account: account(),
        newEmail: "nowy@firma.pl",
        sessionStartedAtMs: NOW - 60_000,
        pendingRequestExists: false,
        nowMs: NOW,
      }),
    ).toEqual({ action: "request" });
    expect(
      decideEmailChangeRequest({
        account: account(),
        newEmail: "nowy@firma.pl",
        sessionStartedAtMs: NOW - RECENT_AUTH_MS - 1,
        pendingRequestExists: false,
        nowMs: NOW,
      }),
    ).toEqual({ action: "reject", reason: "proof_stale" });
    expect(
      decideEmailChangeRequest({
        account: account(),
        newEmail: EMAIL,
        sessionStartedAtMs: NOW,
        pendingRequestExists: false,
        nowMs: NOW,
      }),
    ).toEqual({ action: "reject", reason: "mismatched_address" });
    expect(
      decideEmailChangeRequest({
        account: account(),
        newEmail: "not-an-email",
        sessionStartedAtMs: NOW,
        pendingRequestExists: false,
        nowMs: NOW,
      }),
    ).toEqual({ action: "reject", reason: "mismatched_address" });
    expect(
      decideEmailChangeRequest({
        account: account(),
        newEmail: "nowy@firma.pl",
        sessionStartedAtMs: NOW,
        pendingRequestExists: true,
        nowMs: NOW,
      }),
    ).toEqual({ action: "reject", reason: "ceremony_in_progress" });
  });

  it("confirms only with the matching unexpired code, once", () => {
    const request = { newEmail: "nowy@firma.pl", codeHash: "hash-ok", expiresAtMs: NOW + 60_000, confirmedAtMs: null };
    expect(
      decideEmailChangeConfirm({
        account: account(),
        request,
        providedCodeHash: "hash-ok",
        nowMs: NOW,
      }),
    ).toEqual({ action: "commit" });
    expect(
      decideEmailChangeConfirm({
        account: account(),
        request,
        providedCodeHash: "hash-bad",
        nowMs: NOW,
      }),
    ).toEqual({ action: "reject", reason: "code_wrong_or_expired" });
    expect(
      decideEmailChangeConfirm({
        account: account(),
        request: { ...request, expiresAtMs: NOW - 1 },
        providedCodeHash: "hash-ok",
        nowMs: NOW,
      }),
    ).toEqual({ action: "reject", reason: "code_wrong_or_expired" });
    expect(
      decideEmailChangeConfirm({
        account: account(),
        request: null,
        providedCodeHash: "hash-ok",
        nowMs: NOW,
      }),
    ).toEqual({ action: "reject", reason: "no_active_ceremony" });
  });
});
