/**
 * B1 focused verification: the issuance throttle core, the reserved
 * proof-fixture domain, email case normalization at the policy boundary,
 * and the machine-marker pins for classification. R26: the structured
 * refusal codes and the data-first client classification.
 */

import { describe, expect, it } from "vitest";
import {
  ISSUANCE_MAX_ATTEMPTS,
  ISSUANCE_RATE_LIMITED_MARKER,
  ISSUANCE_RECOVERY_INTERVAL_MS,
  decideIssuance,
} from "../../convex/access/identity/issuanceLimit";
import { isProofFixtureEmail } from "../../convex/access/identity/proofDomain";
import { wrapLibraryVerificationRefusal } from "../../convex/access/identity/authEntry";
import {
  decideCreateOrUpdateUser,
  normalizeEmail,
  type UserPolicyUser,
} from "../../convex/access/identity/userPolicy";
import {
  SIGN_IN_REFUSAL_CODES,
  accessRefusalData,
  decodeAccessRefusalCode,
} from "../../convex/access/errorCodes";
import {
  OUR_ERROR_MARKERS,
  classifySignInError,
  sessionDeniedView,
  signInCopy,
} from "../../apps/web/src/features/sign-in/state";

const MINUTE = 60 * 1000;
const NOW = 1_800_000_000_000;

describe("decideIssuance (send-side throttle)", () => {
  it("allows a first request and starts a full budget", () => {
    expect(decideIssuance(null, NOW)).toEqual({
      allowed: true,
      next: { lastAttemptTime: NOW, attemptsLeft: ISSUANCE_MAX_ATTEMPTS - 1 },
    });
  });

  it("exhausts after the budget without recovery", () => {
    let row = decideIssuance(null, NOW).next;
    for (let i = 1; i < ISSUANCE_MAX_ATTEMPTS; i++) {
      const decision = decideIssuance(row, NOW + i * MINUTE);
      expect(decision.allowed, `attempt ${i + 1}`).toBe(true);
      row = decision.next;
    }
    // Budget spent within one recovery interval: blocked.
    expect(decideIssuance(row, NOW + (ISSUANCE_MAX_ATTEMPTS + 1) * MINUTE).allowed).toBe(false);
  });

  it("recovers one slot per interval (blocked callers cannot starve it)", () => {
    const spent = { lastAttemptTime: NOW, attemptsLeft: 0 };
    expect(decideIssuance(spent, NOW + ISSUANCE_RECOVERY_INTERVAL_MS - 1).allowed).toBe(false);
    const recovered = decideIssuance(spent, NOW + ISSUANCE_RECOVERY_INTERVAL_MS);
    expect(recovered.allowed).toBe(true);
    expect(recovered.next.attemptsLeft).toBe(0); // the recovered slot is consumed
  });

  it("caps the budget at the maximum across long idle periods", () => {
    const idle = { lastAttemptTime: NOW, attemptsLeft: 1 };
    const decision = decideIssuance(idle, NOW + 24 * 60 * MINUTE);
    expect(decision.next.attemptsLeft).toBe(ISSUANCE_MAX_ATTEMPTS - 1);
  });
});

describe("reserved proof-fixture domain", () => {
  it("accepts only @kiero.invalid addresses (case-insensitive)", () => {
    expect(isProofFixtureEmail("b1-proof@kiero.invalid")).toBe(true);
    expect(isProofFixtureEmail(" B1-Proof@KIERO.INVALID ")).toBe(true);
  });

  it("refuses every real-looking target", () => {
    expect(isProofFixtureEmail("victim@example.com")).toBe(false);
    expect(isProofFixtureEmail("victim@kiero.invalid.evil.com")).toBe(false);
    expect(isProofFixtureEmail("victim@notkiero.invalid")).toBe(false);
    expect(isProofFixtureEmail("")).toBe(false);
  });
});

describe("email case normalization at the policy boundary", () => {
  function user(overrides: Partial<UserPolicyUser>): UserPolicyUser {
    return { id: "k57u1", email: "szef@firma.pl", googleSubject: null, ...overrides };
  }

  it("normalizes for storage and comparison", () => {
    expect(normalizeEmail(" Szef@Firma.PL ")).toBe("szef@firma.pl");
    const decision = decideCreateOrUpdateUser({
      existingUserId: null,
      input: { method: "email_code", profile: { email: "Szef@Firma.pl" } },
      usersWithEmail: [],
    });
    expect(decision.action).toBe("create");
    if (decision.action === "create") {
      expect(decision.input.email).toBe("szef@firma.pl");
    }
  });

  it("mixed-case Google sign-in collides with a stored email person (no silent second row)", () => {
    const decision = decideCreateOrUpdateUser({
      existingUserId: null,
      input: {
        method: "google",
        profile: { sub: "google-1", email: "Szef@Firma.pl", emailVerified: true },
      },
      usersWithEmail: [user({ email: "szef@firma.pl", googleSubject: null })],
    });
    expect(decision).toEqual({ action: "reject", reason: "method_conflict" });
  });

  it("mixed-case email-code sign-in resumes the stored person (no duplicate row)", () => {
    const decision = decideCreateOrUpdateUser({
      existingUserId: null,
      input: { method: "email_code", profile: { email: "Szef@Firma.pl" } },
      usersWithEmail: [user({ email: "szef@firma.pl", googleSubject: null })],
    });
    expect(decision).toEqual({ action: "resume", userId: "k57u1" });
  });

  it("keeps rows whose stored case differs out of unrelated lookups", () => {
    const decision = decideCreateOrUpdateUser({
      existingUserId: null,
      input: { method: "email_code", profile: { email: "szef@firma.pl" } },
      usersWithEmail: [user({ email: "inny@firma.pl" })],
    });
    expect(decision.action).toBe("create"); // the different address does not collide
  });
});

describe("marker pins and denial copy", () => {
  it("the issuance marker is pinned client/server and classifies", () => {
    expect(classifySignInError(new Error(`${ISSUANCE_RATE_LIMITED_MARKER} zbyt wiele`))).toBe(
      "too_many_attempts",
    );
    expect(ISSUANCE_RATE_LIMITED_MARKER).toBe("[kiero:issuance_rate_limited]");
  });

  it("session denial reasons map to distinct honest copy", () => {
    expect(sessionDeniedView("auth_session_missing")).toEqual({
      notice: signInCopy.signedOutNotice,
      requiresSignIn: true,
    });
    expect(sessionDeniedView("inactive").notice).toBe(signInCopy.sessionInactiveNotice);
    expect(sessionDeniedView("revoked").notice).toBe(signInCopy.sessionEndedNotice);
    expect(sessionDeniedView("registry_missing").requiresSignIn).toBe(false);
    expect(sessionDeniedView("subject_mismatch").requiresSignIn).toBe(true);
  });

  it("OUR_ERROR_MARKERS covers every marker we throw", () => {
    expect(OUR_ERROR_MARKERS.issuanceRateLimited).toBe(ISSUANCE_RATE_LIMITED_MARKER);
  });
});

describe("structured refusal codes (R26: data, never the message)", () => {
  /**
   * The sanitized production shape: a Convex deployment replaces the
   * message with "Server Error" (wrapped by the client transport), while
   * `error.data` survives — every classification below must hold with
   * the message carrying NO classification signal at all.
   */
  function sanitizedRefusal(code: string): Error {
    const error = new Error("[CONVEX Action(auth:signIn)] Server Error\n  Called by client");
    return Object.assign(error, { data: { code, message: "Server Error" } });
  }

  it("classifies every sign-in refusal code from data with a sanitized message", () => {
    expect(classifySignInError(sanitizedRefusal("email_delivery_failed"))).toBe(
      "email_delivery_failed",
    );
    expect(classifySignInError(sanitizedRefusal("method_conflict"))).toBe("method_conflict");
    expect(classifySignInError(sanitizedRefusal("issuance_rate_limited"))).toBe(
      "too_many_attempts",
    );
    expect(classifySignInError(sanitizedRefusal("code_wrong_or_expired"))).toBe(
      "code_wrong_or_expired",
    );
    expect(classifySignInError(sanitizedRefusal("too_many_attempts"))).toBe("too_many_attempts");
  });

  it("each classified code renders its exact fixture copy (the honest texts D1 lost)", () => {
    expect(signInCopy.failures.too_many_attempts).toBe(
      "Zbyt wiele prób. Odczekaj kilka minut i spróbuj ponownie.",
    );
    expect(signInCopy.failures.code_wrong_or_expired).toBe(
      "Kod jest nieprawidłowy lub wygasł. Poproś o nowy kod.",
    );
    expect(signInCopy.failures.method_conflict).toBe(
      "Konto z tym adresem e-mail używa innej metody logowania. Zaloguj się pierwotną metodą; metody połączysz w ustawieniach konta, potwierdzając obie.",
    );
    expect(signInCopy.failures.email_delivery_failed).toBe(
      "Nie udało się wysłać wiadomości z kodem. Spróbuj ponownie za chwilę.",
    );
  });

  it("data wins over a contradictory message (the message is not load-bearing)", () => {
    const error = Object.assign(new Error("Too many failed attempts"), {
      data: accessRefusalData("method_conflict", "irrelevant"),
    });
    expect(classifySignInError(error)).toBe("method_conflict");
  });

  it("a linking-layer code reaching this surface fails closed to unknown", () => {
    expect(classifySignInError(sanitizedRefusal("proof_stale"))).toBe("unknown");
    expect(classifySignInError(sanitizedRefusal("ambiguous_registry"))).toBe("unknown");
  });

  it("falls back without data: generic copy for the sanitized message, network for fetch", () => {
    expect(classifySignInError(new Error("Server Error"))).toBe("unknown");
    expect(classifySignInError(new Error("Failed to fetch"))).toBe("network");
  });

  it("the closed vocabulary decodes only its own codes", () => {
    expect(decodeAccessRefusalCode(accessRefusalData("issuance_rate_limited", "x"))).toBe(
      "issuance_rate_limited",
    );
    expect(decodeAccessRefusalCode(undefined)).toBeNull();
    expect(decodeAccessRefusalCode("issuance_rate_limited")).toBeNull();
    expect(decodeAccessRefusalCode({ code: "not_a_code" })).toBeNull();
    expect(decodeAccessRefusalCode({ code: 42 })).toBeNull();
    expect(decodeAccessRefusalCode(null)).toBeNull();
  });

  it("the sign-in refusal set is the closed list R26 pinned", () => {
    expect([...SIGN_IN_REFUSAL_CODES]).toEqual([
      "email_delivery_failed",
      "issuance_rate_limited",
      "method_conflict",
      "code_wrong_or_expired",
      "too_many_attempts",
    ]);
  });
});

describe("the library verification-leg wrapper (the budget must not wear the wrong-code copy)", () => {
  const wrap = (message: string) =>
    wrapLibraryVerificationRefusal(new Error(message)) as {
      readonly data: { readonly code?: unknown; readonly message?: unknown };
    };

  it("the per-address verification budget classifies as too_many_attempts with the real message", () => {
    const wrapped = wrap("Too many failed attempts");
    expect(wrapped.data.code).toBe("too_many_attempts");
    expect(wrapped.data.message).toBe("Too many failed attempts");
  });

  it("the wrong/expired-code literal keeps its accepted classification", () => {
    const wrapped = wrap("Could not verify code");
    expect(wrapped.data.code).toBe("code_wrong_or_expired");
    expect(wrapped.data.message).toBe("Could not verify code");
  });

  it("the budget code maps to the too_many_attempts failure the UI renders (never the wrong-code advice)", () => {
    expect(classifySignInError(wrap("Too many failed attempts"))).toBe("too_many_attempts");
  });

  it("a genuine crash on the leg propagates UNCHANGED (no refusal mask)", () => {
    const crash = new TypeError("ctx.runQuery is not a function");
    expect(wrapLibraryVerificationRefusal(crash)).toBe(crash);
  });
});
