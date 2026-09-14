/**
 * B1/R11 focused verification: the email-code sign-in flow at the REAL
 * installed packages (evidence in docs/evidence/access/auth-dependency).
 *
 * The app's real auth entry (convex/access/identity/authEntry.ts —
 * imported WITHOUT the Google client names, so providers are exactly
 * [email_code]) is driven through @convex-dev/auth's real signIn action
 * and store mutations: code issuance runs the app's real OTP generator,
 * issuance throttle and user policy, delivery goes through the real
 * Resend adapter (network answered locally with a fixture key NAME),
 * verification runs the provider's real same-email `authorize` check and
 * mints the library's real session token. Only the Convex platform
 * context (in-memory store) and the network are fixtures.
 *
 * Covered: issuance and delivery wiring, the same-email redemption rule,
 * the explicit refusal to link accounts that share an address across
 * methods (the Kiero policy running inside the real library callback),
 * the session key/issuer contract of the minted token, and the honest
 * absence of the Google routes when the client names are unconfigured.
 */

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { httpRouter } from "convex/server";
import {
  callRoute,
  fetchEnvelope,
  freshPlatform,
  MemoryDb,
  registeredHandler,
  rsaFixture,
  verifyRs256,
  type PlatformCtx,
} from "./helpers/authBoundaryHarness";
import { METHOD_CONFLICT_MARKER } from "../../convex/access/identity/userPolicy";

/** Fixture env names/values — self-generated, never real credentials. */
const FIXTURE_SITE = "https://kiero-fixture.convex.site";
const FIXTURE_RESEND_KEY = "re_fixture_key_not_a_real_credential_000000";

const sessionKey = rsaFixture();

// No AUTH_GOOGLE_ID/AUTH_GOOGLE_SECRET on purpose: this file pins the
// honest unconfigured-Google construction (the barebones deployment
// state the B1 live proof observed on the leased dev deployment).
delete process.env.AUTH_GOOGLE_ID;
delete process.env.AUTH_GOOGLE_SECRET;
process.env.CONVEX_SITE_URL = FIXTURE_SITE;
process.env.SITE_URL = FIXTURE_SITE;
process.env.JWT_PRIVATE_KEY = sessionKey.privateKeyPem;
process.env.JWKS = JSON.stringify({ keys: [sessionKey.publicJwk] });
process.env.RESEND_API_KEY = FIXTURE_RESEND_KEY;

/** One captured application email (delivery side of the boundary). */
interface SentEmail {
  to: string[];
  subject: string;
  text: string;
  authorization: string | null;
}

const sentEmails: SentEmail[] = [];

/** Local Resend stand-in: records the request and accepts the send. */
function resendStub(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const { url, authorization, body } = fetchEnvelope(input, init);
  if (url.href !== "https://api.resend.com/emails") {
    throw new Error(`fixture fetch: unexpected request ${url.href}`);
  }
  return Promise.resolve(body).then((raw) => {
    const payload = JSON.parse(raw) as { to: string[]; subject: string; text: string };
    sentEmails.push({ ...payload, authorization });
    return Response.json({ id: "kiero-fixture-email-id" });
  });
}

// Import the app's real auth entry AFTER the fixture env is in place.
const authEntry = await import("../../convex/access/identity/authEntry");

// The registered-function handler seams (Convex attaches `_handler`;
// the public type hides it — the harness extracts and checks it).
const signInHandler = registeredHandler(authEntry.signIn, "signIn");
const storeHandler = registeredHandler(authEntry.store, "store");
const authRoutes = authEntry.auth;

/** The platform side each test drives: the shared harness fake with the
 * app's real store handler behind the `"auth:store"` seam. */
const platform = () => freshPlatform(storeHandler);

/** Issues a code for `email` through the REAL flow and returns the code
 * extracted from the delivered email (the only place it appears in
 * clear; the store keeps the SHA-256 hash). */
async function issueCode(ctx: PlatformCtx, email: string): Promise<string> {
  const before = sentEmails.length;
  const result = (await signInHandler(ctx, {
    provider: "email_code",
    params: { email },
  })) as { started?: boolean };
  expect(result.started).toBe(true);
  const email2 = sentEmails[before];
  expect(email2).toBeDefined();
  const match = email2!.text.match(/\b\d{8}\b/);
  expect(match).not.toBeNull();
  return match![0]!;
}

async function redeemCode(
  ctx: PlatformCtx,
  email: string,
  code: string,
): Promise<{ tokens?: { token?: string } | null }> {
  return (await signInHandler(ctx, {
    provider: "email_code",
    params: { email, code },
  })) as { tokens?: { token?: string } | null };
}

describe("email-code issuance at the real package boundary", () => {
  let ctx: PlatformCtx;
  let db: MemoryDb;

  beforeAll(() => {
    vi.stubGlobal("fetch", resendStub);
    ({ ctx, db } = platform());
  });
  afterAll(() => {
    vi.unstubAllGlobals();
  });

  it("issues a one-time code through the real policy and adapter", async () => {
    const code = await issueCode(ctx, "szef@firma.pl");

    // The delivery: Polish copy, the address, the code — through the
    // app's real render + Resend adapter, with the fixture key name.
    const sent = sentEmails.at(-1)!;
    expect(sent.to).toEqual(["szef@firma.pl"]);
    expect(sent.subject).toBe("Kiero — kod do logowania");
    expect(sent.text).toContain(code);
    expect(sent.text).toContain("zignoruj tę wiadomość");
    expect(sent.authorization).toBe(`Bearer ${FIXTURE_RESEND_KEY}`);

    // The store: a person row (barebones display name from the local
    // part), an email_code account keyed by the address, and the code
    // row carrying the hash with the app's 15-minute validity.
    const users = db.rows("users");
    expect(users).toHaveLength(1);
    expect(users[0]?.email).toBe("szef@firma.pl");
    expect(users[0]?.displayName).toBe("szef");
    expect(users[0]?.googleSubject).toBeUndefined();

    const accounts = db.rows("authAccounts");
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.provider).toBe("email_code");
    expect(accounts[0]?.providerAccountId).toBe("szef@firma.pl");

    const codes = db.rows("authVerificationCodes");
    expect(codes).toHaveLength(1);
    expect(codes[0]?.code).not.toBe(code); // stored as SHA-256, not clear
    const delta = (codes[0]?.expirationTime as number) - Date.now();
    const fifteenMinutesMs = 15 * 60 * 1000;
    expect(delta).toBeGreaterThan(fifteenMinutesMs - 5_000);
    expect(delta).toBeLessThan(fifteenMinutesMs + 5_000);
  });

  it("redeems the code with the SAME address into a session", async () => {
    const code = await issueCode(ctx, "kontakt@firma.pl");
    const signedIn = await redeemCode(ctx, "kontakt@firma.pl", code);

    const token = signedIn.tokens?.token;
    expect(token).toBeDefined();
    // The real library-minted token: RS256, issuer = deployment site
    // URL, audience "convex", subject "<userId>|<sessionId>".
    const payload = verifyRs256(sessionKey.publicJwk, token!);
    expect(payload.iss).toBe(FIXTURE_SITE);
    expect(payload.aud).toBe("convex");
    const users = db.rows("users");
    const user = users.find((row) => row.email === "kontakt@firma.pl");
    const authSession = db.rows("authSessions").at(-1);
    expect(user).toBeDefined();
    expect(authSession).toBeDefined();
    expect(payload.sub).toBe(`${user!._id}|${authSession!._id}`);
  });

  it("refuses the code redeemed with a different address (the provider's real same-email check)", async () => {
    const code = await issueCode(ctx, "pierwszy@firma.pl");
    await expect(redeemCode(ctx, "drugi@firma.pl", code)).rejects.toThrow(
      "Could not verify code",
    );
  });

  it("refuses a wrong code with the library's stable message", async () => {
    await issueCode(ctx, "kod@firma.pl");
    await expect(redeemCode(ctx, "kod@firma.pl", "00000000")).rejects.toThrow(
      "Could not verify code",
    );
  });
});

describe("explicit refusal to link accounts sharing an address (the app policy inside the real callback)", () => {
  it("rejects an email-code sign-in onto a Google person, without issuing or sending", async () => {
    vi.stubGlobal("fetch", resendStub);
    const { ctx, db } = platform();

    // A Google person already exists for the address (seeded rows — the
    // state a Google sign-in under the same config would have created).
    const googleSubject = "kiero-fixture-google-sub-777";
    const userId = db.insert("users", {
      email: "wspolny@firma.pl",
      displayName: "Wspólny",
      googleSubject,
      createdAtMs: Date.now() - 1000,
    });
    db.insert("authAccounts", {
      userId,
      provider: "google",
      providerAccountId: googleSubject,
    });

    // Mixed-case variant of the same address: the policy normalizes, so
    // the collision must still be caught.
    const before = sentEmails.length;
    await expect(
      signInHandler(ctx, {
        provider: "email_code",
        params: { email: "Wspolny@Firma.pl" },
      }),
    ).rejects.toThrow(METHOD_CONFLICT_MARKER);

    // No code row, no email, no second person row — the refusal is
    // total, not a fallback issuance.
    expect(db.rows("authVerificationCodes")).toHaveLength(0);
    expect(sentEmails.length).toBe(before);
    expect(db.rows("users")).toHaveLength(1);
    expect(db.rows("authAccounts")).toHaveLength(1);
    vi.unstubAllGlobals();
  });

  it("the rejection copy is the accepted Polish text with no identity detail", async () => {
    vi.stubGlobal("fetch", resendStub);
    const { ctx, db } = platform();
    const userId = db.insert("users", {
      email: "drugi@firma.pl",
      displayName: "Drugi",
      googleSubject: "kiero-fixture-google-sub-778",
      createdAtMs: Date.now() - 1000,
    });
    db.insert("authAccounts", {
      userId,
      provider: "google",
      providerAccountId: "kiero-fixture-google-sub-778",
    });

    const rejection = await signInHandler(ctx, {
      provider: "email_code",
      params: { email: "drugi@firma.pl" },
    }).catch((error: unknown) => String((error as Error).message));
    expect(rejection).toBe(
      `${METHOD_CONFLICT_MARKER} Konto z tym adresem e-mail używa innej metody logowania. Zaloguj się pierwotną metodą; metody połączysz w ustawieniach konta, potwierdzając obie.`,
    );
    // No detail about the existing identity leaks into the refusal.
    expect(rejection).not.toContain("google");
    expect(rejection).not.toContain("Google");
    vi.unstubAllGlobals();
  });
});

describe("unconfigured Google construction is honestly absent", () => {
  it("registers no OAuth routes (the browser-facing surface B1 proved live)", async () => {
    const router = httpRouter();
    const { ctx } = platform();
    authRoutes.addHttpRoutes(router);
    expect(
      await callRoute(router, "GET", `${FIXTURE_SITE}/api/auth/signin/google?code=x`, ctx),
    ).toBeNull();
    expect(
      await callRoute(router, "GET", `${FIXTURE_SITE}/api/auth/callback/google?code=x`, ctx),
    ).toBeNull();
  });

  it("still serves the session key/issuer surface (email-code deployments included)", async () => {
    const router = httpRouter();
    const { ctx } = platform();
    authRoutes.addHttpRoutes(router);
    const config = await callRoute(
      router,
      "GET",
      `${FIXTURE_SITE}/.well-known/openid-configuration`,
      ctx,
    );
    expect(((await config!.json()) as { issuer: string }).issuer).toBe(FIXTURE_SITE);
  });
});
