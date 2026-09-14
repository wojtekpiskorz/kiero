/**
 * B1/R11 focused verification: the auth dependency boundary at the REAL
 * installed packages (R11: @auth/core 0.41.3 pinned under
 * @convex-dev/auth 0.0.95; evidence in docs/evidence/access/auth-dependency).
 *
 * This file drives the app's actual construction path — convex/access/
 * identity/authEntry.ts, imported for real with fixture Google client
 * names — through @convex-dev/auth's real store mutations and real HTTP
 * routes, over the real @auth/core Google provider and oauth4webapi's
 * PKCE/OIDC validation. Only the Convex platform context (in-memory
 * store) and the network (locally answered, with Google's own checks
 * enforced by the stub) are fixtures; every credential is self-generated.
 *
 * Covered: the resolved dependency pins, the session key/issuer surface
 * (openid-configuration, JWKS, the RS256 session token minted by the
 * library), Google provider construction and the full authorization-code
 * callback (sub-keyed identity through the app's real profile decode and
 * real createOrUpdateUser policy), and the PKCE refusal without the
 * sign-in cookie.
 */

import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { httpRouter } from "convex/server";
import {
  callRoute,
  cookieHeaderFrom,
  MemoryDb,
  platformCtx,
  rsaFixture,
  s256,
  signRs256,
  verifyRs256,
  type PlatformCtx,
} from "./helpers/authBoundaryHarness";

/** Fixture env names/values — self-generated, never real credentials. */
const FIXTURE_SITE = "https://kiero-fixture.convex.site";
const FIXTURE_GOOGLE_CLIENT_ID = "kiero-fixture-client-id.apps.googleusercontent.com";
const FIXTURE_GOOGLE_CLIENT_SECRET = "kiero-fixture-client-secret-not-real";
const FIXTURE_AUTH_CODE = "kiero-fixture-authorization-code";
const FIXTURE_GOOGLE_SUB = "kiero-fixture-google-sub-424242";
const FIXTURE_GOOGLE_EMAIL = "szef.google@firma.pl";

/** Google's public discovery document content (public data, abbreviated
 * to the fields oauth4webapi consumes; S256 advertised so the PKCE path
 * stays active, like Google's real metadata). */
const GOOGLE_DISCOVERY = {
  issuer: "https://accounts.google.com",
  authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
  token_endpoint: "https://oauth2.googleapis.com/token",
  jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
  userinfo_endpoint: "https://openidconnect.googleapis.com/v1/userinfo",
  response_types_supported: ["code"],
  subject_types_supported: ["public"],
  id_token_signing_alg_values_supported: ["RS256"],
  code_challenge_methods_supported: ["S256"],
};

// --- fixture environment, before the real app module is imported --------

const sessionKey = rsaFixture();
const googleKey = rsaFixture();

process.env.CONVEX_SITE_URL = FIXTURE_SITE;
process.env.SITE_URL = FIXTURE_SITE;
process.env.JWT_PRIVATE_KEY = sessionKey.privateKeyPem;
process.env.JWKS = JSON.stringify({ keys: [sessionKey.publicJwk] });
process.env.AUTH_GOOGLE_ID = FIXTURE_GOOGLE_CLIENT_ID;
process.env.AUTH_GOOGLE_SECRET = FIXTURE_GOOGLE_CLIENT_SECRET;

/** The Google-side view of one flow: captured stub requests and the S256
 * challenge the sign-in route bound (for the stub's own enforcement). */
interface CapturedFlow {
  codeChallenge: string | undefined;
  tokenRequest: { form: URLSearchParams; authorization: string | null } | null;
}

const captured: CapturedFlow = { codeChallenge: undefined, tokenRequest: null };

function fixtureTokenResponse(): Response {
  const claims = {
    iss: "https://accounts.google.com",
    aud: FIXTURE_GOOGLE_CLIENT_ID,
    sub: FIXTURE_GOOGLE_SUB,
    email: FIXTURE_GOOGLE_EMAIL,
    email_verified: true,
    name: "Szef Google",
    iat: Math.floor(Date.now() / 1000) - 10,
    exp: Math.floor(Date.now() / 1000) + 600,
  };
  return Response.json({
    access_token: "kiero-fixture-access-token",
    token_type: "Bearer",
    expires_in: 3599,
    scope: "openid email profile",
    id_token: signRs256(googleKey.privateKeyPem, claims),
  });
}

/** Local Google stand-in: answers discovery, JWKS and the token endpoint,
 * enforcing the checks Google itself would (client_secret_basic
 * credentials, the exact redirect_uri, and the S256 PKCE challenge bound
 * at sign-in). Accepts raw (URL, init) fetch arguments, which is how
 * oauth4webapi and the @auth/core customFetch wrapper call it. */
function googleStub(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url =
    typeof input === "string"
      ? new URL(input)
      : input instanceof URL
        ? input
        : new URL(input.url);
  const request = typeof input === "string" || input instanceof URL ? null : input;
  const method = (init?.method ?? request?.method ?? "GET").toUpperCase();
  const authorization =
    init?.headers instanceof Headers
      ? init.headers.get("authorization")
      : typeof init?.headers === "object" && init.headers !== null
        ? (init.headers as Record<string, string>)["authorization"] ?? null
        : request?.headers.get("authorization") ?? null;

  if (
    method === "GET" &&
    url.href === GOOGLE_DISCOVERY.issuer + "/.well-known/openid-configuration"
  ) {
    return Promise.resolve(Response.json(GOOGLE_DISCOVERY));
  }
  if (method === "GET" && url.href === GOOGLE_DISCOVERY.jwks_uri) {
    return Promise.resolve(Response.json({ keys: [googleKey.publicJwk] }));
  }
  if (method === "POST" && url.href === GOOGLE_DISCOVERY.token_endpoint) {
    const raw =
      typeof init?.body === "string"
        ? init.body
        : request !== null
          ? request.text()
          : String(init?.body ?? "");
    return Promise.resolve(raw).then((body) => {
      const form = new URLSearchParams(body);
      captured.tokenRequest = { form, authorization };
      const expectedBasic = `Basic ${Buffer.from(
        `${FIXTURE_GOOGLE_CLIENT_ID}:${FIXTURE_GOOGLE_CLIENT_SECRET}`,
      ).toString("base64")}`;
      const okAuth = authorization === expectedBasic;
      const okRedirect =
        form.get("redirect_uri") === `${FIXTURE_SITE}/api/auth/callback/google`;
      const verifier = form.get("code_verifier");
      const okVerifier =
        captured.codeChallenge !== undefined &&
        verifier !== null &&
        s256(verifier) === captured.codeChallenge;
      if (okAuth && okRedirect && okVerifier && form.get("code") === FIXTURE_AUTH_CODE) {
        return fixtureTokenResponse();
      }
      return Response.json(
        { error: "invalid_grant", error_description: "kiero fixture check failed" },
        { status: 400 },
      );
    });
  }
  throw new Error(`fixture fetch: unexpected request ${method} ${url.href}`);
}

// Import the app's real auth entry AFTER the fixture env is in place.
const authEntry = await import("../../convex/access/identity/authEntry");

/** The registered-function `handler` seam (Convex attaches it as
 * `_handler`; the public type hides it). */
type Handler = (ctx: unknown, args: unknown) => Promise<unknown>;
const signInHandler = (authEntry as unknown as { signIn: { _handler: Handler } }).signIn._handler;
const storeHandler = (authEntry as unknown as { store: { _handler: Handler } }).store._handler;
const authRoutes = authEntry.auth;

/** The platform side each test drives: a fresh in-memory store, with the
 * library's `"auth:store"` mutation calls routed into the REAL store
 * handler of the app's auth entry. */
function freshPlatform(): { ctx: PlatformCtx; db: MemoryDb } {
  const db = new MemoryDb();
  return { ctx: platformCtx(db, (c, args) => storeHandler(c, args)), db };
}

// --- one complete real flow, executed once, asserted facet by facet ------

interface FlowResult {
  actionRedirect: string;
  verifier: string;
  signinLocation: URL;
  cookies: Record<string, string>;
  callbackLocation: URL;
  verificationCode: string | null;
  sessionToken: string;
}

let flow: FlowResult;
let flowDb: MemoryDb;

/** The flow's single user and auth session, narrowed non-undefined. */
function flowRowsOf(): {
  user: { _id: string } & Record<string, unknown>;
  authSession: { _id: string } & Record<string, unknown>;
} {
  const [user] = flowDb.rows("users");
  const [authSession] = flowDb.rows("authSessions");
  if (user === undefined || authSession === undefined) {
    throw new Error("google flow rows missing");
  }
  return { user, authSession };
}

beforeAll(async () => {
  vi.stubGlobal("fetch", googleStub);
  const { ctx, db } = freshPlatform();
  const router = httpRouter();
  authRoutes.addHttpRoutes(router);

  // 1. The client asks the real signIn action for a Google redirect.
  const started = (await signInHandler(ctx, { provider: "google" })) as {
    redirect?: string;
    verifier?: string;
  };
  expect(started.redirect).toBeDefined();
  expect(started.verifier).toBeDefined();

  // 2. The browser follows the HTTP sign-in route, binding the check
  //    signature to the verifier row the action created.
  const signin = await callRoute(
    router,
    "GET",
    `${FIXTURE_SITE}/api/auth/signin/google?code=${encodeURIComponent(started.verifier!)}`,
    ctx,
  );
  expect(signin).not.toBeNull();
  expect(signin!.status).toBe(302);
  const location = new URL(signin!.headers.get("location")!);
  captured.codeChallenge = location.searchParams.get("code_challenge") ?? undefined;
  const cookies = cookieHeaderFrom(signin!);

  // 3. Google redirects back with the authorization code.
  const callback = await callRoute(
    router,
    "GET",
    `${FIXTURE_SITE}/api/auth/callback/google?code=${encodeURIComponent(FIXTURE_AUTH_CODE)}`,
    ctx,
    { Cookie: Object.entries(cookies).map(([k, v]) => `${k}=${v}`).join("; ") },
  );
  expect(callback).not.toBeNull();
  const callbackLocation = new URL(callback!.headers.get("location")!);
  const verificationCode = callbackLocation.searchParams.get("code");

  // 4. The client redeems the verification code for a session.
  const signedIn = (await signInHandler(ctx, {
    params: { code: verificationCode },
    verifier: started.verifier,
  })) as { tokens?: { token?: string } | null };

  flow = {
    actionRedirect: started.redirect!,
    verifier: started.verifier!,
    signinLocation: location,
    cookies,
    callbackLocation,
    verificationCode,
    sessionToken: signedIn.tokens?.token ?? "",
  };
  flowDb = db;
});

afterAll(() => {
  vi.unstubAllGlobals();
});

describe("resolved dependency pins (R11)", () => {
  // The root node_modules copies are the single resolutions (proven by
  // the lockfile test below; npm hoists the workspace graph).
  function installedPackage(name: string): { version: string; peerDependencies: Record<string, string> } {
    return JSON.parse(
      readFileSync(new URL(`../../node_modules/${name}/package.json`, import.meta.url), "utf8"),
    );
  }

  it("@auth/core is the R11 resolution 0.41.3, installed", () => {
    expect(installedPackage("@auth/core").version).toBe("0.41.3");
  });

  it("@convex-dev/auth stays pinned at 0.0.95", () => {
    expect(installedPackage("@convex-dev/auth").version).toBe("0.0.95");
  });

  it("the root package.json pins the exact versions (no range drift)", () => {
    const root = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
    );
    expect(root.dependencies["@auth/core"]).toBe("0.41.3");
    expect(root.dependencies["@convex-dev/auth"]).toBe("0.0.95");
  });

  it("0.41.3 satisfies @convex-dev/auth 0.0.95's declared @auth/core peer range", () => {
    const peers = installedPackage("@convex-dev/auth").peerDependencies;
    expect(peers["@auth/core"]).toBe("^0.41.1");
    // ^0.41.1 means >=0.41.1 <0.42.0 for 0.x versions; 0.41.3 is inside.
    const version = [0, 41, 3];
    const lower = [0, 41, 1];
    const upper = [0, 42, 0];
    const aboveLower = version.join(".") >= lower.join(".");
    const belowUpper = version.join(".") < upper.join(".");
    expect(aboveLower && belowUpper).toBe(true);
  });

  it("the lockfile resolves @auth/core exactly once, at 0.41.3 (deduped)", () => {
    const lock = JSON.parse(
      readFileSync(new URL("../../package-lock.json", import.meta.url), "utf8"),
    );
    const entries = Object.keys(lock.packages).filter((k) =>
      k.endsWith("node_modules/@auth/core"),
    );
    expect(entries).toEqual(["node_modules/@auth/core"]);
    expect(lock.packages["node_modules/@auth/core"].version).toBe("0.41.3");
  });
});

describe("session key/issuer surface (real HTTP handlers)", () => {
  const router = httpRouter();
  const { ctx } = freshPlatform();
  authRoutes.addHttpRoutes(router);

  it("openid-configuration binds the issuer to the deployment site URL", async () => {
    const res = await callRoute(
      router,
      "GET",
      `${FIXTURE_SITE}/.well-known/openid-configuration`,
      ctx,
    );
    const body = (await res!.json()) as { issuer: string; jwks_uri: string };
    expect(body.issuer).toBe(FIXTURE_SITE);
    expect(body.jwks_uri).toBe(`${FIXTURE_SITE}/.well-known/jwks.json`);
  });

  it("jwks.json serves the deployment key set verbatim", async () => {
    const res = await callRoute(router, "GET", `${FIXTURE_SITE}/.well-known/jwks.json`, ctx);
    const body = (await res!.json()) as { keys: unknown[] };
    expect(body).toEqual({ keys: [sessionKey.publicJwk] });
  });
});

describe("Google sign-in at the real package boundary", () => {
  it("the signIn action returns the site's own sign-in route with the verifier", () => {
    const url = new URL(flow.actionRedirect);
    expect(url.origin).toBe(FIXTURE_SITE);
    expect(url.pathname).toBe("/api/auth/signin/google");
    expect(url.searchParams.get("code")).toBe(flow.verifier);
  });

  it("the HTTP sign-in route 302s with an S256 PKCE challenge and a provider-scoped cookie", () => {
    expect(flow.signinLocation.origin).toBe("https://accounts.google.com");
    expect(flow.signinLocation.searchParams.get("code_challenge_method")).toBe("S256");
    expect(flow.signinLocation.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9-_]{43}$/);
    // The ConvexAuth cookie names carry the provider id (the
    // GHSA-x445-f3h2-j279 pattern does not arise at this boundary:
    // another provider's callback would read a differently-named cookie).
    expect(Object.keys(flow.cookies)).toEqual(["__Host-googleOAuthpkce"]);
  });

  it("the token exchange passed the stub's Google-side checks", () => {
    expect(captured.tokenRequest?.form.get("code")).toBe(FIXTURE_AUTH_CODE);
    expect(captured.tokenRequest?.form.get("redirect_uri")).toBe(
      `${FIXTURE_SITE}/api/auth/callback/google`,
    );
    // client_secret_basic: Basic scheme crossed the seam (the stub
    // verified the exact fixture credential pair).
    expect(captured.tokenRequest?.authorization).toMatch(/^Basic /);
  });

  it("the callback completes into the app policy: identity keyed on Google sub", () => {
    expect(flow.callbackLocation.origin).toBe(FIXTURE_SITE);
    expect(flow.verificationCode).toMatch(/^\d{8}$/);

    const users = flowDb.rows("users");
    expect(users).toHaveLength(1);
    // The app's real profile decode kept Google's stable sub as the
    // account identity (never the email address alone).
    expect(users[0]?.googleSubject).toBe(FIXTURE_GOOGLE_SUB);
    expect(users[0]?.email).toBe(FIXTURE_GOOGLE_EMAIL);
    expect(users[0]?.displayName).toBe("Szef Google");

    const accounts = flowDb.rows("authAccounts");
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.provider).toBe("google");
    expect(accounts[0]?.providerAccountId).toBe(FIXTURE_GOOGLE_SUB);
  });

  it("redeeming the verification code mints a verifiable session token", () => {
    expect(flow.sessionToken).not.toBe("");
    const payload = verifyRs256(sessionKey.publicJwk, flow.sessionToken);
    const flowRows = flowRowsOf();
    // The library's token contract: issuer = deployment site URL,
    // audience "convex", subject "<userId>|<sessionId>" (RS256; the
    // library's TOKEN_SUB_CLAIM_DIVIDER is "|").
    expect(payload.iss).toBe(FIXTURE_SITE);
    expect(payload.aud).toBe("convex");
    expect(payload.sub).toBe(`${flowRows.user._id}|${flowRows.authSession._id}`);
  });

  it("the library's exported id helpers split the verified subject", async () => {
    const { getAuthSessionId, getAuthUserId } = await import("@convex-dev/auth/server");
    const { user, authSession } = flowRowsOf();
    const identityCtx = {
      auth: {
        getUserIdentity: async () => ({
          subject: `${user._id}|${authSession._id}`,
          issuer: FIXTURE_SITE,
        }),
      },
    };
    expect(await getAuthUserId(identityCtx as never)).toBe(user._id);
    expect(await getAuthSessionId(identityCtx as never)).toBe(authSession._id);
  });

  it("the session duration is the app's accepted 30-day rule", () => {
    const { authSession } = flowRowsOf();
    const thirtyDaysMs = 30 * 24 * 60 * 60 * 1000;
    const delta = (authSession.expirationTime as number) - Date.now();
    // The pinned rule is 30 days (scheduling slack allowed, hours are not).
    expect(delta).toBeGreaterThan(thirtyDaysMs - 60_000);
    expect(delta).toBeLessThan(thirtyDaysMs + 60_000);
  });
});

describe("Google callback refuses without the sign-in cookie (PKCE)", () => {
  it("redirects back without a verification code and creates nothing", async () => {
    vi.stubGlobal("fetch", googleStub);
    const { ctx, db } = freshPlatform();
    const router = httpRouter();
    authRoutes.addHttpRoutes(router);

    const started = (await signInHandler(ctx, { provider: "google" })) as {
      redirect?: string;
      verifier?: string;
    };
    // Bind the challenge via a first sign-in round (the stub records it).
    await callRoute(
      router,
      "GET",
      `${FIXTURE_SITE}/api/auth/signin/google?code=${encodeURIComponent(started.verifier!)}`,
      ctx,
    );
    const before = db.rows("users").length + db.rows("authAccounts").length;

    // A callback from a browser WITHOUT the pkce cookie: the stub's
    // challenge check (what Google enforces server-side) fails the
    // exchange, and the route fails honestly (redirect, no code).
    const callback = await callRoute(
      router,
      "GET",
      `${FIXTURE_SITE}/api/auth/callback/google?code=${encodeURIComponent(FIXTURE_AUTH_CODE)}`,
      ctx,
    );
    expect(callback!.status).toBe(302);
    const location = new URL(callback!.headers.get("location")!);
    expect(location.searchParams.get("code")).toBeNull();
    const after = db.rows("users").length + db.rows("authAccounts").length;
    expect(after).toBe(before);
    expect(ctx.storeCalls.some((call) => call.type === "userOAuth")).toBe(false);
    vi.unstubAllGlobals();
  });
});
