/**
 * B1 focused verification: the registered access policy, the schema
 * registration of the Convex Auth provider tables, and the sign-in UI
 * state machine copy.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { authTables } from "@convex-dev/auth/server";
import { identityTables } from "../../convex/access/identity/schema";
import { liveSessionPolicy } from "../../convex/access/identity/policy";
import { ActorContext } from "@kiero/contracts";
import type { RequestContext } from "@kiero/runtime";
import {
  OUR_ERROR_MARKERS,
  classifySignInError,
  isValidEmail,
  pendingLabel,
  signInCopy,
} from "../../apps/web/src/features/sign-in/state";
import { EMAIL_DELIVERY_FAILED_MARKER } from "../../convex/integrations/email/send";
import { METHOD_CONFLICT_MARKER } from "../../convex/access/identity/userPolicy";
import { googleSignInConfigured, providerAvailabilityFromEnv } from "../../convex/access/identity/providerAvailability";

type IndexableTable = { " indexes"(): { indexDescriptor: string; fields: string[] }[] };

function context(overrides: Partial<Schema.Schema.Type<typeof ActorContext>>): RequestContext {
  return {
    actor: Schema.decodeUnknownSync(ActorContext)({
      userId: "k57u",
      companyId: "k57c",
      membershipRole: "member",
      isGm: false,
      sessionId: "k57s",
      via: "user",
      ...overrides,
    }),
    resolvedAtMs: 1,
  };
}

describe("liveSessionPolicy (registered over membershipPolicy)", () => {
  it("is the B1 registration the seam names", () => {
    expect(liveSessionPolicy.policyId).toBe("access.b1-live-session-v1");
  });

  it("denies null context unauthenticated (a denied session resolves no context)", async () => {
    const decision = await liveSessionPolicy.authorize(null, { intent: "read" });
    expect(decision.allowed).toBe(false);
    if (!decision.allowed) {
      expect(decision.error._tag).toBe("unauthenticated");
    }
  });

  it("keeps platform role semantics: member reads, admin administers", async () => {
    expect((await liveSessionPolicy.authorize(context({}), { intent: "read" })).allowed).toBe(true);
    const denied = await liveSessionPolicy.authorize(context({}), { intent: "administer" });
    expect(denied.allowed).toBe(false);
    const granted = await liveSessionPolicy.authorize(context({ membershipRole: "admin" }), {
      intent: "administer",
    });
    expect(granted.allowed).toBe(true);
  });

  it("keeps GM separation and tenant scope checks", async () => {
    const gm = await liveSessionPolicy.authorize(context({ isGm: true }), { intent: "inspectGm" });
    expect(gm.allowed).toBe(true);
    const notGm = await liveSessionPolicy.authorize(context({}), { intent: "inspectGm" });
    expect(notGm.allowed).toBe(false);
    const scope = await liveSessionPolicy.authorize(context({}), {
      intent: "read",
      companyId: Schema.decodeUnknownSync(
        Schema.String.pipe(Schema.brand("companies")),
      )("k57other"),
    });
    expect(scope.allowed).toBe(false);
  });
});

describe("identity fragment registers the Convex Auth provider tables verbatim", () => {
  const providerTableNames = [
    "authSessions",
    "authAccounts",
    "authRefreshTokens",
    "authVerificationCodes",
    "authVerifiers",
    "authRateLimits",
  ] as const;

  it("registers exactly the six provider tables plus users/sessions", () => {
    expect(Object.keys(identityTables).sort()).toEqual(
      [...providerTableNames, "users", "sessions"].sort(),
    );
  });

  for (const name of providerTableNames) {
    it(`${name} matches the library definition (fields and indexes)`, () => {
      const ours = identityTables[name] as unknown as IndexableTable;
      const theirs = (authTables as Record<string, unknown>)[name] as IndexableTable;
      expect(ours[" indexes"]()).toEqual(theirs[" indexes"]());
    });
  }

  it("keeps the library-required users email index", () => {
    const users = identityTables["users"] as unknown as IndexableTable;
    const indexes = users[" indexes"]();
    expect(indexes.find((index) => index.indexDescriptor === "email")?.fields).toEqual(["email"]);
    expect(indexes.find((index) => index.indexDescriptor === "by_email")?.fields).toEqual([
      "email",
      "createdAtMs",
    ]);
  });

  it("keys the session registry by the mirrored authSession id", () => {
    const sessions = identityTables["sessions"] as unknown as IndexableTable;
    expect(
      sessions[" indexes"]().find((index) => index.indexDescriptor === "by_authSession")?.fields,
    ).toEqual(["authSessionId"]);
  });
});

describe("provider availability (env names only)", () => {
  it("google is configured only when both credential names carry values", () => {
    expect(googleSignInConfigured({})).toBe(false);
    expect(googleSignInConfigured({ AUTH_GOOGLE_ID: "id" })).toBe(false);
    expect(googleSignInConfigured({ AUTH_GOOGLE_ID: "id", AUTH_GOOGLE_SECRET: "" })).toBe(false);
    expect(googleSignInConfigured({ AUTH_GOOGLE_ID: "id", AUTH_GOOGLE_SECRET: "secret" })).toBe(
      true,
    );
  });

  it("email-code is always offered; availability is honest", () => {
    expect(providerAvailabilityFromEnv({})).toEqual({ emailCode: true, google: false });
    expect(
      providerAvailabilityFromEnv({ AUTH_GOOGLE_ID: "id", AUTH_GOOGLE_SECRET: "s" }),
    ).toEqual({ emailCode: true, google: true });
  });
});

describe("sign-in UI state machine (Polish copy, no leaks)", () => {
  it("validates email shape client-side too", () => {
    expect(isValidEmail("szef@firma.pl")).toBe(true);
    expect(isValidEmail("broken")).toBe(false);
    expect(isValidEmail("a@b")).toBe(false);
  });

  it("client and server marker literals are pinned equal (drift breaks classification)", () => {
    expect(OUR_ERROR_MARKERS.emailDeliveryFailed).toBe(EMAIL_DELIVERY_FAILED_MARKER);
    expect(OUR_ERROR_MARKERS.methodConflict).toBe(METHOD_CONFLICT_MARKER);
  });

  it("classifies OUR failures by machine marker, independent of the prose", () => {
    expect(
      classifySignInError(
        new Error(`${EMAIL_DELIVERY_FAILED_MARKER} Kiero nie może teraz wysłać wiadomości.`),
      ),
    ).toBe("email_delivery_failed");
    expect(
      classifySignInError(
        new Error(`${METHOD_CONFLICT_MARKER} Konto z tym adresem używa innej metody logowania.`),
      ),
    ).toBe("method_conflict");
    // Reworded prose still classifies: the marker, not the words, decides.
    expect(
      classifySignInError(new Error(`${EMAIL_DELIVERY_FAILED_MARKER} entirely reworded copy`)),
    ).toBe("email_delivery_failed");
  });

  it("classifies library failures by their stable messages and hides everything else", () => {
    expect(classifySignInError(new Error("Could not verify code"))).toBe("code_wrong_or_expired");
    expect(classifySignInError(new Error("Too many failed attempts to verify code"))).toBe(
      "too_many_attempts",
    );
    expect(classifySignInError(new Error("Failed to fetch"))).toBe("network");
    expect(
      classifySignInError(
        new Error("Kiero nie może teraz wysłać wiadomości: usługa poczty nie jest skonfigurowana."),
      ),
    ).toBe("unknown"); // our prose WITHOUT the marker no longer matches
    expect(classifySignInError(new Error("internal stack trace with token sk-123"))).toBe("unknown");
    expect(classifySignInError("not an error")).toBe("unknown");
  });

  it("pending labels come from the state machine copy", () => {
    expect(pendingLabel({ step: "choose" })).toBeNull();
    expect(pendingLabel({ step: "code-sent", email: "a@b.pl" })).toBeNull();
    expect(pendingLabel({ step: "submitting-email" })).toBe(signInCopy.sending);
    expect(pendingLabel({ step: "submitting-code", email: "a@b.pl" })).toBe(signInCopy.verifying);
    expect(pendingLabel({ step: "google-pending" })).toBe(signInCopy.googlePending);
  });

  it("every failure cause has Polish copy", () => {
    for (const failure of [
      "invalid_email",
      "code_wrong_or_expired",
      "too_many_attempts",
      "email_delivery_failed",
      "method_conflict",
      "network",
      "unknown",
    ] as const) {
      expect(signInCopy.failures[failure].length).toBeGreaterThan(3);
    }
  });
});
