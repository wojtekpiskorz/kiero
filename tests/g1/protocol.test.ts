/**
 * G1 focused verification: the Google OAuth protocol builders and parsers.
 *
 * The authorization URL, PKCE S256 derivation, scope enforcement and token
 * response classification are pure: they must match the REAL endpoints'
 * protocol before any live Google leg can run (the live legs themselves
 * stay BLOCKED-owner-action without the OAuth client credentials).
 */

import { describe, expect, it } from "vitest";
import {
  REQUIRED_CALENDAR_SCOPES,
  buildAuthorizationUrl,
  decodeIdTokenClaims,
  dedicatedCalendarSummary,
  deriveCodeChallenge,
  generateAuthorizationChallenge,
  parseTokenResponseBody,
  scopesSatisfied,
  splitScopes,
} from "../../convex/calendar/connection/protocol";

describe("PKCE S256 derivation (RFC 7636 appendix B)", () => {
  it("reproduces the published test vector", async () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    const challenge = await deriveCodeChallenge(verifier);
    expect(challenge).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  it("generates 43-character url-safe state and verifier material", async () => {
    const challenge = await generateAuthorizationChallenge();
    expect(challenge.state).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge.verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(challenge.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // The state hash is what the row stores; the raw state never is.
    expect(challenge.stateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(challenge.stateHash).not.toContain(challenge.state);
  });
});

describe("authorization URL construction", () => {
  it("builds the Web-Server flow URL with state, S256 PKCE and the least scopes", () => {
    const url = new URL(
      buildAuthorizationUrl({
        clientId: "client-1.apps.googleusercontent.com",
        redirectUri: "https://example.convex.cloud/calendar/oauth/callback",
        state: "STATEVALUE",
        codeChallenge: "CHALLENGE",
      }),
    );
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const params = url.searchParams;
    expect(params.get("client_id")).toBe("client-1.apps.googleusercontent.com");
    expect(params.get("redirect_uri")).toBe("https://example.convex.cloud/calendar/oauth/callback");
    expect(params.get("response_type")).toBe("code");
    expect(params.get("scope")).toBe(REQUIRED_CALENDAR_SCOPES.join(" "));
    expect(params.get("scope")).toContain("https://www.googleapis.com/auth/calendar.app.created");
    expect(params.get("state")).toBe("STATEVALUE");
    expect(params.get("code_challenge")).toBe("CHALLENGE");
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("access_type")).toBe("offline");
    expect(params.get("prompt")).toBe("consent");
  });
});

describe("scope enforcement", () => {
  it("requires every scope in the granted set", () => {
    const all = "openid email https://www.googleapis.com/auth/calendar.app.created";
    expect(scopesSatisfied(splitScopes(all))).toBe(true);
    expect(scopesSatisfied(splitScopes("openid email"))).toBe(false);
    expect(scopesSatisfied(splitScopes(""))).toBe(false);
    expect(splitScopes("  openid   email ")).toEqual(["openid", "email"]);
  });
});

describe("token response classification", () => {
  const goodBody = {
    access_token: "at",
    refresh_token: "rt",
    expires_in: 3600,
    scope: "openid email https://www.googleapis.com/auth/calendar.app.created",
    id_token: "x.y.z",
  };

  it("decodes a 200 grant with all fields", () => {
    const outcome = parseTokenResponseBody(200, goodBody);
    expect(outcome).toEqual({
      kind: "granted",
      grant: {
        accessToken: "at",
        refreshToken: "rt",
        expiresInSeconds: 3600,
        grantedScope: goodBody.scope,
        idToken: "x.y.z",
      },
    });
  });

  it("treats an unreadable 200 body as uncertain, not success", () => {
    expect(parseTokenResponseBody(200, null)).toEqual({ kind: "failed", failure: "unknown_body" });
    expect(parseTokenResponseBody(200, { access_token: "at" })).toEqual({
      kind: "failed",
      failure: "unknown_body",
    });
  });

  it("maps 400/401 to definite failure and 5xx to uncertain", () => {
    expect(parseTokenResponseBody(400, { error: "invalid_grant" })).toEqual({
      kind: "failed",
      failure: "definite_invalid_request",
    });
    expect(parseTokenResponseBody(401, { error: "invalid_client" })).toEqual({
      kind: "failed",
      failure: "definite_invalid_request",
    });
    expect(parseTokenResponseBody(500, { error: "server_error" })).toEqual({
      kind: "failed",
      failure: "unknown_status",
    });
    expect(parseTokenResponseBody(503, null)).toEqual({ kind: "failed", failure: "unknown_status" });
  });
});

describe("id_token payload decode (transport-trusted)", () => {
  function fixtureJwt(payload: unknown): string {
    const encode = (value: unknown): string =>
      btoa(JSON.stringify(value)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return [encode({ alg: "none" }), encode(payload), "sig"].join(".");
  }

  it("extracts sub and email", () => {
    expect(decodeIdTokenClaims(fixtureJwt({ sub: "sub-7", email: "szef@gmail.com" }))).toEqual({
      subject: "sub-7",
      email: "szef@gmail.com",
    });
    expect(decodeIdTokenClaims(fixtureJwt({ sub: "sub-7" }))).toEqual({
      subject: "sub-7",
      email: null,
    });
  });

  it("rejects malformed tokens without throwing", () => {
    expect(decodeIdTokenClaims("not-a-jwt")).toBeNull();
    expect(decodeIdTokenClaims(fixtureJwt({ email: "no-sub@gmail.com" }))).toBeNull();
  });
});

describe("dedicated calendar summary", () => {
  it("names the calendar for the company and bounds its length", () => {
    expect(dedicatedCalendarSummary("Budowa Kowalscy")).toBe("Kiero — Budowa Kowalscy");
    expect(dedicatedCalendarSummary("   ")).toBe("Kiero");
    const long = dedicatedCalendarSummary("X".repeat(200));
    expect(long.length).toBeLessThanOrEqual(100);
  });
});
