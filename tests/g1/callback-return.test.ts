/**
 * G1/R10 focused verification: the Calendar callback page's return link.
 *
 * The direct Convex callback (`GET /calendar/oauth/callback`) renders a
 * Polish status page served from the Convex HTTP Actions host, so its
 * "Wróć do Kiero" footer link must lead to the CONFIGURED application
 * origin (`KIERO_CALENDAR_APP_BASE_URL`) — never to "/" on the deployment
 * host, and never to anything the caller supplied. These tests pin:
 *
 * - the resolver's strict validation: valid variations accepted and
 *   normalized, absent/invalid configuration refused (null),
 * - the page HTML rendered through the REAL GET handler (invoked over the
 *   wrapped httpAction's `_handler` seam with a stub action context) from
 *   a distinct Convex host, with hostile caller-supplied return inputs
 *   ignored,
 * - the callback protocol itself unchanged by R10: state handling, the
 *   PKCE verifier forwarded to the exchange, the redirect_uri pinned to
 *   the request origin, credential sealing, scope enforcement and the
 *   denial path, all against a clearly-labeled fake Google endpoint.
 *
 * Every Google-side fixture (the local node:http server, the client
 * names, the key material) is generated at run time; no real credential
 * value appears anywhere.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { getFunctionName } from "convex/server";
import type { ActionCtx } from "../../convex/_generated/server";
import {
  CALENDAR_APP_BASE_URL_ENV,
  calendarAppReturnHref,
  calendarCallbackHandler,
} from "../../convex/calendar/connection/http";

// The journey shape under test: the callback is served from the Convex
// HTTP Actions host, the application lives elsewhere (public facts from
// issue #171; no secret either way).
const CONVEX_HOST = "https://fiery-raven-417.eu-west-1.convex.site";
const OTHER_CONVEX_HOST = "https://plausible-mongoose-881.eu-west-1.convex.site";
const PWA_ORIGIN = "https://kiero-staging-web.wojtek-524.workers.dev";

const callbackUrl = (host: string, query: string): string =>
  `${host}/calendar/oauth/callback${query.length === 0 ? "" : `?${query}`}`;

// Every deployment variable the touched paths read; saved and restored
// around each test so no test leaks configuration into another.
const ENV_NAMES = [
  CALENDAR_APP_BASE_URL_ENV,
  "KIERO_ENVIRONMENT",
  "KIERO_CALENDAR_REDIRECT_URI",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "KIERO_G1_PROOF_ENABLED",
  "KIERO_CALENDAR_TOKEN_ENDPOINT_OVERRIDE",
  "KIERO_CALENDAR_GOOGLE_API_BASE_OVERRIDE",
  "KIERO_CALENDAR_TOKEN_KEY",
] as const;

const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const name of ENV_NAMES) {
    savedEnv[name] = process.env[name];
    delete process.env[name];
  }
});

afterEach(() => {
  for (const name of ENV_NAMES) {
    if (savedEnv[name] === undefined) {
      delete process.env[name];
    } else {
      process.env[name] = savedEnv[name];
    }
  }
});

// ---------------------------------------------------------------------------
// A clearly-labeled fake Google endpoint (test fixture, never real).
// ---------------------------------------------------------------------------

interface FakeGoogle {
  server: Server;
  url: string;
  requests: { method: string; path: string; body: string; authorization: string }[];
  behavior: { tokenStatus?: number; grantedScope?: string; idTokenPayload?: object };
}

let fake: FakeGoogle;

/** A generated AES-256 key (base64 of 32 random bytes; a fixture, no secret). */
function generatedTokenKey(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** A syntactically valid id_token whose payload we control. */
function fakeIdToken(payload: object): string {
  const json = JSON.stringify(payload);
  let binary = "";
  for (const byte of new TextEncoder().encode(json)) {
    binary += String.fromCharCode(byte);
  }
  return `fakeheader.${btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "")}.fakesignature`;
}

const FULL_SCOPE =
  "openid email https://www.googleapis.com/auth/calendar.app.created";

beforeAll(async () => {
  const requests: FakeGoogle["requests"] = [];
  const behavior: FakeGoogle["behavior"] = {};
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      const url = new URL(request.url ?? "/", "http://fake.google");
      requests.push({
        method: request.method ?? "",
        path: url.pathname,
        body,
        authorization: request.headers.authorization ?? "",
      });
      if (url.pathname.endsWith("/token")) {
        const status = behavior.tokenStatus ?? 200;
        const payload =
          status === 200
            ? {
                access_token: "fake-access-token",
                refresh_token: "fake-refresh-token",
                expires_in: 3600,
                scope: behavior.grantedScope ?? FULL_SCOPE,
                id_token: fakeIdToken(
                  behavior.idTokenPayload ?? { sub: "fake-google-sub-1", email: "szef@firma-testowa.pl" },
                ),
              }
            : { error: "invalid_grant" };
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
        return;
      }
      // Calendar API paths.
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "fake-calendar-1", summary: "Kiero — test" }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") {
    throw new Error("fake endpoint did not start");
  }
  fake = { server, url: `http://127.0.0.1:${address.port}`, requests, behavior };
});

afterAll(async () => {
  await new Promise<void>((resolve) => fake.server.close(() => resolve()));
});

// ---------------------------------------------------------------------------
// The stub action context: routes the protocol's internal calls and
// records every leg. Mirrors the real transactions' contracts: prepare
// echoes the caller's redirectUri back in the flow (the same
// operations.ts behavior), companyNameFor answers the company read,
// completeCallbackTransaction answers the terminal write.
// ---------------------------------------------------------------------------

interface RecordedLeg {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

type PrepareAnswer =
  | { readonly status: "invalid_state" }
  | { readonly status: "finish_error"; readonly reason: string }
  | { readonly status: "proceed" };

function makeStubCtx(options: {
  readonly prepare: PrepareAnswer;
  readonly companyName?: string;
  readonly completeResult?: { ok: boolean; state: string };
}): { ctx: ActionCtx; legs: RecordedLeg[] } {
  const legs: RecordedLeg[] = [];
  const referenceName = (reference: unknown): string =>
    getFunctionName(reference as Parameters<typeof getFunctionName>[0]);
  const ctx = {
    auth: { getUserIdentity: async () => null },
    runQuery: async (reference: unknown, args: Record<string, unknown>) => {
      const name = referenceName(reference);
      legs.push({ name, args });
      if (name.endsWith("companyNameFor")) {
        return options.companyName ?? "Firma Testowa";
      }
      throw new Error(`unexpected query in test: ${name}`);
    },
    runMutation: async (reference: unknown, args: Record<string, unknown>) => {
      const name = referenceName(reference);
      legs.push({ name, args });
      if (name.endsWith("prepareCallbackTransaction")) {
        if (options.prepare.status === "proceed") {
          return {
            status: "proceed",
            flow: {
              connectionId: "kconn-fixture",
              companyId: "kco-fixture",
              userId: "ku-fixture",
              verifier: "fake-verifier-fixture",
              mode: "connect",
              redirectUri: args.redirectUri,
              knownCalendarId: null,
              knownGoogleSubject: null,
            },
          };
        }
        return options.prepare.status === "invalid_state"
          ? { status: "invalid_state" }
          : { status: "finish_error", reason: options.prepare.reason };
      }
      if (name.endsWith("completeCallbackTransaction")) {
        return options.completeResult ?? { ok: true, state: "connected" };
      }
      throw new Error(`unexpected mutation in test: ${name}`);
    },
  } as unknown as ActionCtx;
  return { ctx, legs };
}

type HttpHandlerFn = (ctx: ActionCtx, request: Request) => Promise<Response>;

/** Unwraps the httpAction's raw handler (the module's own function seam). */
function callbackHandler(): HttpHandlerFn {
  return (calendarCallbackHandler as unknown as { _handler: HttpHandlerFn })._handler;
}

async function invokeCallback(
  stub: { ctx: ActionCtx; legs: RecordedLeg[] },
  url: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; html: string }> {
  const response = await callbackHandler()(stub.ctx, new Request(url, { headers }));
  return { status: response.status, html: await response.text() };
}

/** Points the OAuth configuration at the fake endpoint (fake names only). */
function configureFakeGoogle(): void {
  process.env.AUTH_GOOGLE_ID = "fake-client-id";
  process.env.AUTH_GOOGLE_SECRET = "fake-client-secret";
  process.env.KIERO_G1_PROOF_ENABLED = "1";
  process.env.KIERO_CALENDAR_TOKEN_ENDPOINT_OVERRIDE = `${fake.url}/token`;
  process.env.KIERO_CALENDAR_GOOGLE_API_BASE_OVERRIDE = fake.url;
  process.env.KIERO_CALENDAR_TOKEN_KEY = generatedTokenKey();
}

beforeEach(() => {
  fake.requests.length = 0;
  delete fake.behavior.tokenStatus;
  delete fake.behavior.grantedScope;
  delete fake.behavior.idTokenPayload;
});

// ---------------------------------------------------------------------------
// The resolver (pure configuration validation).
// ---------------------------------------------------------------------------

describe("calendarAppReturnHref (server-side configuration only)", () => {
  it("accepts a plain https origin and normalizes it without a trailing slash", () => {
    expect(calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: PWA_ORIGIN })).toBe(PWA_ORIGIN);
    expect(calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: `${PWA_ORIGIN}/` })).toBe(PWA_ORIGIN);
  });

  it("preserves a configured subpath (with and without the trailing slash)", () => {
    expect(calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: "https://app.example.com/kiero" })).toBe(
      "https://app.example.com/kiero",
    );
    expect(calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: "https://app.example.com/kiero/" })).toBe(
      "https://app.example.com/kiero",
    );
  });

  it("keeps an explicit port", () => {
    expect(calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: "https://app.example.com:8443/" })).toBe(
      "https://app.example.com:8443",
    );
  });

  it("allows plain http only in the dev environment", () => {
    const local = "http://localhost:5173";
    expect(calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: local, KIERO_ENVIRONMENT: "dev" })).toBe(local);
    // An absent or unknown label honestly means dev (the house rule the
    // telemetry cron and the backups boundary apply).
    expect(calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: local })).toBe(local);
    expect(
      calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: local, KIERO_ENVIRONMENT: "production" }),
    ).toBe(local);
    expect(
      calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: local, KIERO_ENVIRONMENT: "staging" }),
    ).toBe(null);
    expect(
      calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: local, KIERO_ENVIRONMENT: "alpha-production" }),
    ).toBe(null);
  });

  it("refuses an absent, empty or blank configuration", () => {
    expect(calendarAppReturnHref({})).toBe(null);
    expect(calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: "" })).toBe(null);
    expect(calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: "   " })).toBe(null);
  });

  it("refuses a value that is not a URL", () => {
    expect(calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: "not a url" })).toBe(null);
    expect(
      calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: "kiero-staging-web.wojtek-524.workers.dev" }),
    ).toBe(null);
    expect(calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: "//app.example.com" })).toBe(null);
  });

  it("refuses non-web schemes", () => {
    expect(calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: "javascript:alert(1)" })).toBe(null);
    expect(calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: "javascript://app.example.com/" })).toBe(null);
    expect(calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: "data:text/html,hi" })).toBe(null);
    expect(calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: "ftp://app.example.com/" })).toBe(null);
  });

  it("refuses embedded userinfo", () => {
    expect(
      calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: "https://user:pass@app.example.com/" }),
    ).toBe(null);
    expect(calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: "https://user@app.example.com/" })).toBe(null);
  });

  it("refuses a query or fragment in the configuration", () => {
    expect(calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: `${PWA_ORIGIN}/?next=evil` })).toBe(null);
    expect(calendarAppReturnHref({ [CALENDAR_APP_BASE_URL_ENV]: `${PWA_ORIGIN}/#return` })).toBe(null);
  });
});

// ---------------------------------------------------------------------------
// The rendered page through the real GET handler.
// ---------------------------------------------------------------------------

describe("the callback page from the distinct Convex host (valid configuration)", () => {
  it("links back to the configured PWA origin, never to / on the deployment host", async () => {
    process.env[CALENDAR_APP_BASE_URL_ENV] = PWA_ORIGIN;
    const stub = makeStubCtx({ prepare: { status: "invalid_state" } });
    const page = await invokeCallback(stub, callbackUrl(CONVEX_HOST, "state=used-once"));
    expect(page.status).toBe(400);
    expect(page.html).toContain(
      `<p><a href="${PWA_ORIGIN}">Wróć do Kiero</a></p>`,
    );
    expect(page.html).not.toContain('href="/"');
    // The honest typed page is preserved under the link.
    expect(page.html).toContain("Nieprawidłowe połączenie.");
    expect(page.html).toContain("Ten link wygasł albo został już użyty.");
  });

  it("ignores the request host entirely: another Convex host, the same link", async () => {
    process.env[CALENDAR_APP_BASE_URL_ENV] = PWA_ORIGIN;
    const stub = makeStubCtx({ prepare: { status: "invalid_state" } });
    const page = await invokeCallback(stub, callbackUrl(OTHER_CONVEX_HOST, "state=used-once"));
    expect(page.html).toContain(`<a href="${PWA_ORIGIN}">Wróć do Kiero</a>`);
  });

  it("normalizes a trailing-slash configuration to the same target", async () => {
    process.env[CALENDAR_APP_BASE_URL_ENV] = `${PWA_ORIGIN}/`;
    const stub = makeStubCtx({ prepare: { status: "invalid_state" } });
    const page = await invokeCallback(stub, callbackUrl(CONVEX_HOST, "state=used-once"));
    expect(page.html).toContain(`<a href="${PWA_ORIGIN}">Wróć do Kiero</a>`);
    expect(page.html).not.toContain(`${PWA_ORIGIN}/"`);
  });

  it("ignores every hostile caller-supplied return input", async () => {
    process.env[CALENDAR_APP_BASE_URL_ENV] = PWA_ORIGIN;
    const stub = makeStubCtx({ prepare: { status: "invalid_state" } });
    const page = await invokeCallback(
      stub,
      callbackUrl(
        CONVEX_HOST,
        "state=used-once" +
          "&return=https://evil.example.net/catch" +
          "&redirect_uri=https://evil.example.net/oauth" +
          "&continue=javascript:alert(document.domain)" +
          "&next=//evil.example.net",
      ),
      { referer: "https://evil.example.net/calendar" },
    );
    // Only the configured origin is ever embedded.
    expect(page.html).toContain(`<a href="${PWA_ORIGIN}">Wróć do Kiero</a>`);
    expect(page.html).not.toContain("evil.example.net");
    expect(page.html).not.toContain("javascript:");
    expect(page.html).not.toContain('href="/"');
    // The hostile query never reached the protocol either.
    expect(stub.legs.map((leg) => leg.name).every((name) => name.endsWith("prepareCallbackTransaction"))).toBe(true);
    expect(stub.legs[0]?.args["state"]).toBe("used-once");
    expect(stub.legs[0]?.args["redirectUri"]).toBe(`${CONVEX_HOST}/calendar/oauth/callback`);
  });
});

describe("the callback page without usable configuration (explicit safe behavior)", () => {
  const absentOrInvalid: readonly [string, string | undefined][] = [
    ["absent", undefined],
    ["empty", ""],
    ["not a URL", "kiero-staging-web.wojtek-524.workers.dev"],
    ["http outside dev", "http://app.example.com/"],
    ["javascript scheme", "javascript:alert(1)"],
    ["embedded userinfo", "https://user:pass@app.example.com/"],
    ["fragment", `${PWA_ORIGIN}/#x`],
    ["query", `${PWA_ORIGIN}/?next=evil`],
  ];

  for (const [label, value] of absentOrInvalid) {
    it(`renders the honest page without a link when the configuration is ${label}`, async () => {
      if (value !== undefined) {
        process.env[CALENDAR_APP_BASE_URL_ENV] = value;
        process.env.KIERO_ENVIRONMENT = "staging";
      }
      const stub = makeStubCtx({ prepare: { status: "invalid_state" } });
      const page = await invokeCallback(stub, callbackUrl(CONVEX_HOST, "state=used-once"));
      expect(page.status).toBe(400);
      // No anchor at all: never "/", never a guess.
      expect(page.html).not.toContain("<a ");
      expect(page.html).not.toContain("href=");
      // The Polish note explains the return is unavailable.
      expect(page.html).toContain("Powrót do Kiero jest niedostępny. Otwórz aplikację bezpośrednio.");
      // The typed answer itself is untouched.
      expect(page.html).toContain("Nieprawidłowe połączenie.");
      expect(page.html).toContain("Ten link wygasł albo został już użyty.");
    });
  }

  it("keeps the incomplete-link page safe without configuration too", async () => {
    const stub = makeStubCtx({ prepare: { status: "invalid_state" } });
    const page = await invokeCallback(stub, callbackUrl(CONVEX_HOST, ""));
    expect(page.status).toBe(400);
    expect(page.html).toContain("Ten link jest niekompletny.");
    expect(page.html).not.toContain("<a ");
    expect(page.html).toContain("Powrót do Kiero jest niedostępny.");
    // Nothing ran: an incomplete link never touches the protocol.
    expect(stub.legs).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Regression: the callback protocol is unchanged by R10.
// ---------------------------------------------------------------------------

describe("the full callback protocol through the GET handler (unchanged)", () => {
  it("completes a connection and renders the success page linked to the PWA", async () => {
    configureFakeGoogle();
    process.env[CALENDAR_APP_BASE_URL_ENV] = PWA_ORIGIN;
    process.env.KIERO_ENVIRONMENT = "staging";
    const stub = makeStubCtx({ prepare: { status: "proceed" } });
    const page = await invokeCallback(stub, callbackUrl(CONVEX_HOST, "state=fresh&code=fake-code"));

    expect(page.status).toBe(200);
    expect(page.html).toContain("Kalendarz Kiero jest połączony.");
    expect(page.html).toContain("Utworzono kalendarz Kiero na koncie szef@firma-testowa.pl.");
    expect(page.html).toContain(`<a href="${PWA_ORIGIN}">Wróć do Kiero</a>`);

    // The PKCE verifier from the consumed flow reached the exchange, with
    // the redirect_uri derived from the request origin.
    expect(fake.requests).toHaveLength(2);
    const tokenForm = new URLSearchParams(fake.requests[0]?.body ?? "");
    expect(fake.requests[0]?.path).toBe("/token");
    expect(tokenForm.get("code_verifier")).toBe("fake-verifier-fixture");
    expect(tokenForm.get("redirect_uri")).toBe(`${CONVEX_HOST}/calendar/oauth/callback`);
    expect(tokenForm.get("grant_type")).toBe("authorization_code");
    expect(tokenForm.get("code")).toBe("fake-code");

    // The dedicated-calendar create ran once with the granted access token.
    expect(fake.requests[1]?.path).toBe("/calendars");
    expect(fake.requests[1]?.method).toBe("POST");
    expect(fake.requests[1]?.authorization).toBe("Bearer fake-access-token");
    expect(JSON.parse(fake.requests[1]?.body ?? "{}").summary).toBe("Kiero — Firma Testowa");

    // The terminal write recorded a SEALED credential, not the raw tokens.
    const completion = stub.legs.find((leg) => leg.name.endsWith("completeCallbackTransaction"));
    expect(completion?.args["completion"]).toEqual({
      kind: "connected",
      calendarId: "fake-calendar-1",
      calendarReused: false,
    });
    expect(completion?.args["credentialStorage"]).toBe("encrypted_aesgcm");
    const ciphertext = completion?.args["credentialCiphertext"];
    expect(typeof ciphertext).toBe("string");
    expect(ciphertext).not.toContain("fake-access-token");
    expect(ciphertext).not.toContain("fake-refresh-token");
    expect(completion?.args["grantedScope"]).toBe(FULL_SCOPE);
    expect(completion?.args["googleAccountEmail"]).toBe("szef@firma-testowa.pl");

    // The page itself never leaks token material.
    expect(page.html).not.toContain("fake-access-token");
    expect(page.html).not.toContain("fake-refresh-token");
  });

  it("records a user denial without any exchange and keeps the Polish page", async () => {
    configureFakeGoogle();
    process.env[CALENDAR_APP_BASE_URL_ENV] = PWA_ORIGIN;
    const stub = makeStubCtx({ prepare: { status: "proceed" } });
    const page = await invokeCallback(
      stub,
      callbackUrl(CONVEX_HOST, "state=fresh&error=access_denied"),
    );

    expect(page.status).toBe(400);
    expect(page.html).toContain("Nie udostępniono kalendarza.");
    expect(page.html).toContain("Zgoda w Google nie została udzielona.");
    expect(page.html).toContain(`<a href="${PWA_ORIGIN}">Wróć do Kiero</a>`);
    // No Google leg ever ran.
    expect(fake.requests).toHaveLength(0);
    const completion = stub.legs.find((leg) => leg.name.endsWith("completeCallbackTransaction"));
    expect(completion?.args["completion"]).toEqual({ kind: "error", reason: "authorization_denied" });
  });

  it("enforces the required scopes before touching the calendar API", async () => {
    configureFakeGoogle();
    fake.behavior.grantedScope = "openid email";
    process.env[CALENDAR_APP_BASE_URL_ENV] = PWA_ORIGIN;
    const stub = makeStubCtx({ prepare: { status: "proceed" } });
    const page = await invokeCallback(stub, callbackUrl(CONVEX_HOST, "state=fresh&code=fake-code"));

    expect(page.status).toBe(400);
    expect(page.html).toContain("Brak wymaganych uprawnień.");
    // The exchange ran; the calendar create never did.
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.path).toBe("/token");
    const completion = stub.legs.find((leg) => leg.name.endsWith("completeCallbackTransaction"));
    expect(completion?.args["completion"]).toEqual({ kind: "error", reason: "scopes_missing" });
  });

  it("refuses a replayed or unknown state and renders the honest page", async () => {
    configureFakeGoogle();
    process.env[CALENDAR_APP_BASE_URL_ENV] = PWA_ORIGIN;
    const stub = makeStubCtx({ prepare: { status: "invalid_state" } });
    const page = await invokeCallback(stub, callbackUrl(CONVEX_HOST, "state=replayed"));
    expect(page.status).toBe(400);
    expect(page.html).toContain("Nieprawidłowe połączenie.");
    expect(fake.requests).toHaveLength(0);
    // The state was consumed exactly once, with the derived redirect URI.
    expect(stub.legs).toHaveLength(1);
    expect(stub.legs[0]?.args["state"]).toBe("replayed");
  });
});
