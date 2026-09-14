/**
 * G1/R12 focused verification: the gateway callback page's return link.
 *
 * The gateway Worker's callback (`GET /platform/calendar/oauth/callback`,
 * apps/gateway/src/calendar-oauth/routes.ts) renders a Polish status page
 * served from the WORKER host, so its "Wróć do Kiero" footer link must
 * lead to the CONFIGURED application origin
 * (`KIERO_CALENDAR_APP_BASE_URL` bound on this Worker), resolved by the
 * SAME R10 resolver the direct Convex callback uses, never to "/" on the
 * Worker host, and never to anything the caller supplied. These tests
 * drive the REAL gateway route handler from a distinct gateway host
 * against a clearly-labeled fake Convex site (the same fixture pattern
 * as gateway-client.test.ts) and pin:
 *
 * - the exact rendered href for valid configurations (origin, trailing
 *   slash, subpath) and the honest no-link Polish page for absent or
 *   invalid ones (never "/", never a guess),
 * - the adapter onto the R10 resolver: the Worker's `ENVIRONMENT` label
 *   drives the plain-http-only-in-dev rule,
 * - hostile caller-supplied return inputs and a crafted Referer ignored,
 *   with the bridge still receiving exactly Google's query,
 * - the bridge completion protocol unchanged by R12: the service
 *   credential leg, the typed completion codes through the shared answer
 *   vocabulary, and the closed 503 when the backend is unconfigured.
 *
 * Every Convex-side fixture (the local node:http server, the service
 * credential) is a clearly-labeled fake generated at run time; no real
 * credential value appears anywhere.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { CalendarBridgeEnv } from "../../apps/gateway/src/calendar-oauth/client";
import { calendarOAuthRoutes } from "../../apps/gateway/src/calendar-oauth/routes";
import { CALENDAR_APP_BASE_URL_ENV } from "../../convex/calendar/connection/return";

// The journey shape under test: the callback is served from the gateway
// Worker host, the application lives elsewhere (public facts from
// apps/gateway/wrangler.jsonc and issue #181; no secret either way).
const GATEWAY_HOST = "https://kiero-staging-gateway.wojtek-524.workers.dev";
const OTHER_GATEWAY_HOST = "https://gateway.example";
const PWA_ORIGIN = "https://kiero-staging-web.wojtek-524.workers.dev";
const SERVICE_CREDENTIAL = "service-credential-fixture";

// A clearly-labeled fake Convex site (test fixture, never real).
interface FakeSite {
  server: Server;
  url: string;
  requests: { authorization: string | null; body: string }[];
  respond: { status: number; body: unknown };
}

/** The mutable response the fake site answers with (`let`: the closure reads the binding). */
let respond: { status: number; body: unknown } = { status: 200, body: { _tag: "ok", value: {} } };

let fake: FakeSite;

beforeAll(async () => {
  const requests: FakeSite["requests"] = [];
  const server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk: Buffer) => {
      body += chunk.toString();
    });
    request.on("end", () => {
      requests.push({ authorization: request.headers.authorization ?? null, body });
      response.writeHead(respond.status, { "content-type": "application/json" });
      response.end(JSON.stringify(respond.body));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address !== "object") {
    throw new Error("fake site did not start");
  }
  fake = {
    server,
    url: `http://127.0.0.1:${address.port}`,
    requests,
    get respond() {
      return respond;
    },
    set respond(next) {
      respond = next;
    },
  };
});

afterAll(async () => {
  await new Promise<void>((resolve) => fake.server.close(() => resolve()));
});

beforeEach(() => {
  fake.requests.length = 0;
  fake.respond = { status: 200, body: { _tag: "ok", value: { code: "invalid_state", connected: false } } };
});

/**
 * The configured Worker bindings (lazily: the fake site binds in beforeAll).
 * An explicit `undefined` override means "this binding is absent"; under
 * exactOptionalPropertyTypes the result omits the key entirely instead of
 * carrying an explicit undefined value.
 */
function bridgeEnv(
  overrides: { readonly [K in keyof CalendarBridgeEnv]?: string | undefined } = {},
): CalendarBridgeEnv {
  const env: { -readonly [K in keyof CalendarBridgeEnv]?: string } = {
    CONVEX_SITE_URL: fake.url,
    KIERO_SERVICE_TOKEN: SERVICE_CREDENTIAL,
    ENVIRONMENT: "staging",
  };
  for (const key of Object.keys(overrides) as (keyof CalendarBridgeEnv)[]) {
    const value = overrides[key];
    if (value === undefined) {
      delete env[key];
    } else {
      env[key] = value;
    }
  }
  return env;
}

async function renderCallback(
  env: CalendarBridgeEnv,
  host: string,
  query: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; html: string }> {
  const route = calendarOAuthRoutes.find(
    (candidate) => candidate.path === "/platform/calendar/oauth/callback",
  );
  if (route === undefined) {
    throw new Error("callback route not registered");
  }
  const response = (await route.handle(
    new Request(`${host}/platform/calendar/oauth/callback${query.length === 0 ? "" : `?${query}`}`, {
      headers,
    }),
    env,
  )) as Response;
  return { status: response.status, html: await response.text() };
}

// ---------------------------------------------------------------------------
// The env type and the resolver linkage (compile-checked names).
// ---------------------------------------------------------------------------

describe("the bridge env type exposes the return configuration", () => {
  it("carries the R12 variable names (read through the exported constant)", () => {
    expect(CALENDAR_APP_BASE_URL_ENV).toBe("KIERO_CALENDAR_APP_BASE_URL");
    const env: CalendarBridgeEnv = {
      CONVEX_SITE_URL: fake.url,
      KIERO_SERVICE_TOKEN: SERVICE_CREDENTIAL,
      [CALENDAR_APP_BASE_URL_ENV]: PWA_ORIGIN,
      ENVIRONMENT: "staging",
    };
    // Reading through the exported constant compiles only while the env
    // type carries the same variable name: drift breaks the typecheck.
    expect(env[CALENDAR_APP_BASE_URL_ENV]).toBe(PWA_ORIGIN);
    expect(env.ENVIRONMENT).toBe("staging");
  });
});

// ---------------------------------------------------------------------------
// Valid configuration: the link targets the configured PWA origin.
// ---------------------------------------------------------------------------

describe("the callback page from the distinct gateway host (valid configuration)", () => {
  it("links back to the configured PWA origin, never to / on the Worker host", async () => {
    fake.respond = { status: 200, body: { _tag: "ok", value: { code: "connected", connected: true } } };
    const page = await renderCallback(
      bridgeEnv({ [CALENDAR_APP_BASE_URL_ENV]: PWA_ORIGIN }),
      GATEWAY_HOST,
      "state=used-once&code=fresh-code",
    );
    expect(page.status).toBe(200);
    expect(page.html).toContain("Kalendarz Kiero jest połączony.");
    expect(page.html).toContain(
      `<p><a href="${PWA_ORIGIN}">Wróć do Kiero</a></p>`,
    );
    expect(page.html).not.toContain('href="/"');
    // The bridge leg ran with the service credential and exactly Google's
    // query; the completion protocol is untouched by the footer change.
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.authorization).toBe(`Bearer ${SERVICE_CREDENTIAL}`);
    expect(JSON.parse(fake.requests[0]?.body ?? "{}")).toEqual({
      state: "used-once",
      code: "fresh-code",
    });
  });

  it("ignores the request host entirely: another gateway host, the same link", async () => {
    const page = await renderCallback(
      bridgeEnv({ [CALENDAR_APP_BASE_URL_ENV]: PWA_ORIGIN }),
      OTHER_GATEWAY_HOST,
      "state=used-once",
    );
    expect(page.status).toBe(400);
    expect(page.html).toContain(`<a href="${PWA_ORIGIN}">Wróć do Kiero</a>`);
    expect(page.html).not.toContain(OTHER_GATEWAY_HOST);
  });

  it("normalizes a trailing-slash configuration to the same target", async () => {
    const page = await renderCallback(
      bridgeEnv({ [CALENDAR_APP_BASE_URL_ENV]: `${PWA_ORIGIN}/` }),
      GATEWAY_HOST,
      "state=used-once",
    );
    expect(page.html).toContain(`<a href="${PWA_ORIGIN}">Wróć do Kiero</a>`);
    expect(page.html).not.toContain(`${PWA_ORIGIN}/"`);
  });

  it("preserves a configured subpath (with and without the trailing slash)", async () => {
    for (const configured of ["https://app.example.com/kiero", "https://app.example.com/kiero/"]) {
      const page = await renderCallback(
        bridgeEnv({ [CALENDAR_APP_BASE_URL_ENV]: configured }),
        GATEWAY_HOST,
        "state=used-once",
      );
      expect(page.html).toContain(`<a href="https://app.example.com/kiero">Wróć do Kiero</a>`);
    }
  });

  it("renders the typed invalid_state page with the link under it", async () => {
    const page = await renderCallback(
      bridgeEnv({ [CALENDAR_APP_BASE_URL_ENV]: PWA_ORIGIN }),
      GATEWAY_HOST,
      "state=used-once",
    );
    expect(page.status).toBe(400);
    expect(page.html).toContain("Nieprawidłowe połączenie.");
    expect(page.html).toContain("Ten link wygasł albo został już użyty.");
    expect(page.html).toContain(`<a href="${PWA_ORIGIN}">Wróć do Kiero</a>`);
  });

  it("keeps the incomplete-link page linked without calling the backend", async () => {
    const page = await renderCallback(
      bridgeEnv({ [CALENDAR_APP_BASE_URL_ENV]: PWA_ORIGIN }),
      GATEWAY_HOST,
      "",
    );
    expect(page.status).toBe(400);
    expect(page.html).toContain("Ten link jest niekompletny.");
    expect(page.html).toContain(`<a href="${PWA_ORIGIN}">Wróć do Kiero</a>`);
    expect(fake.requests).toHaveLength(0);
  });

  it("ignores every hostile caller-supplied return input", async () => {
    const page = await renderCallback(
      bridgeEnv({ [CALENDAR_APP_BASE_URL_ENV]: PWA_ORIGIN }),
      GATEWAY_HOST,
      "state=used-once" +
        "&return=https://evil.example.net/catch" +
        "&redirect_uri=https://evil.example.net/oauth" +
        "&continue=javascript:alert(document.domain)" +
        "&next=//evil.example.net",
      { referer: "https://evil.example.net/calendar" },
    );
    // Only the configured origin is ever embedded.
    expect(page.html).toContain(`<a href="${PWA_ORIGIN}">Wróć do Kiero</a>`);
    expect(page.html).not.toContain("evil.example.net");
    expect(page.html).not.toContain("javascript:");
    expect(page.html).not.toContain('href="/"');
    // The hostile query never reached the bridge either.
    expect(fake.requests).toHaveLength(1);
    expect(JSON.parse(fake.requests[0]?.body ?? "{}")).toEqual({
      state: "used-once",
    });
  });
});

// ---------------------------------------------------------------------------
// The environment label adapter (plain http stays a dev-only allowance).
// ---------------------------------------------------------------------------

describe("the Worker's ENVIRONMENT label drives the http rule", () => {
  const local = "http://localhost:5173";

  it("allows plain http when the Worker self-describes as dev", async () => {
    for (const environment of ["dev", undefined]) {
      const page = await renderCallback(
        bridgeEnv({ [CALENDAR_APP_BASE_URL_ENV]: local, ENVIRONMENT: environment }),
        GATEWAY_HOST,
        "state=used-once",
      );
      expect(page.html).toContain(`<a href="${local}">Wróć do Kiero</a>`);
    }
  });

  it("refuses plain http on labeled environments", async () => {
    for (const environment of ["staging", "alpha-production"]) {
      const page = await renderCallback(
        bridgeEnv({ [CALENDAR_APP_BASE_URL_ENV]: local, ENVIRONMENT: environment }),
        GATEWAY_HOST,
        "state=used-once",
      );
      expect(page.html).not.toContain("<a ");
      expect(page.html).toContain("Powrót do Kiero jest niedostępny.");
    }
  });
});

// ---------------------------------------------------------------------------
// Absent or invalid configuration: the honest page, without a link.
// ---------------------------------------------------------------------------

describe("the callback page without usable configuration (explicit safe behavior)", () => {
  const absentOrInvalid: readonly [string, string | undefined][] = [
    ["absent", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["not a URL", "kiero-staging-web.wojtek-524.workers.dev"],
    ["http outside dev", "http://app.example.com/"],
    ["javascript scheme", "javascript:alert(1)"],
    ["data scheme", "data:text/html,hi"],
    ["embedded userinfo", "https://user:pass@app.example.com/"],
    ["query", `${PWA_ORIGIN}/?next=evil`],
    ["fragment", `${PWA_ORIGIN}/#return`],
  ];

  for (const [label, value] of absentOrInvalid) {
    it(`renders the honest page without a link when the configuration is ${label}`, async () => {
      const page = await renderCallback(
        bridgeEnv({ [CALENDAR_APP_BASE_URL_ENV]: value }),
        GATEWAY_HOST,
        "state=used-once",
      );
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
    const page = await renderCallback(bridgeEnv(), GATEWAY_HOST, "");
    expect(page.status).toBe(400);
    expect(page.html).toContain("Ten link jest niekompletny.");
    expect(page.html).not.toContain("<a ");
    expect(page.html).toContain("Powrót do Kiero jest niedostępny.");
    // Nothing ran: an incomplete link never touches the bridge.
    expect(fake.requests).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Regression: the bridge completion protocol is unchanged by R12.
// ---------------------------------------------------------------------------

describe("the bridge completion protocol through the route (unchanged)", () => {
  it("fails closed with the sanitized 503 when the service credential is missing", async () => {
    const page = await renderCallback(
      bridgeEnv({ [CALENDAR_APP_BASE_URL_ENV]: PWA_ORIGIN, KIERO_SERVICE_TOKEN: undefined }),
      GATEWAY_HOST,
      "state=used-once&code=c",
    );
    expect(page.status).toBe(503);
    expect(page.html).toContain('"_tag":"error"');
    expect(page.html).toContain("calendar_backend_not_configured");
    expect(fake.requests).toHaveLength(0);
  });

  it("fails closed with the sanitized 503 when the backend URL is missing", async () => {
    const page = await renderCallback(
      bridgeEnv({ [CALENDAR_APP_BASE_URL_ENV]: PWA_ORIGIN, CONVEX_SITE_URL: undefined }),
      GATEWAY_HOST,
      "state=used-once&code=c",
    );
    expect(page.status).toBe(503);
    expect(page.html).toContain("calendar_backend_not_configured");
    expect(fake.requests).toHaveLength(0);
  });

  it("maps the typed codes through the shared answer vocabulary, under the link", async () => {
    fake.respond = { status: 200, body: { _tag: "ok", value: { code: "scopes_missing", connected: false } } };
    const page = await renderCallback(
      bridgeEnv({ [CALENDAR_APP_BASE_URL_ENV]: PWA_ORIGIN }),
      GATEWAY_HOST,
      "state=s&code=c",
    );
    expect(page.status).toBe(400);
    expect(page.html).toContain("Brak wymaganych uprawnień.");
    expect(page.html).toContain(`<a href="${PWA_ORIGIN}">Wróć do Kiero</a>`);
  });

  it("keeps the upstream statuses (an uncertain creation is a 200 page)", async () => {
    fake.respond = { status: 200, body: { _tag: "ok", value: { code: "creation_unknown", connected: false } } };
    const page = await renderCallback(
      bridgeEnv({ [CALENDAR_APP_BASE_URL_ENV]: PWA_ORIGIN }),
      GATEWAY_HOST,
      "state=s&code=c",
    );
    expect(page.status).toBe(200);
    expect(page.html).toContain("niepewny");
    expect(page.html).toContain(`<a href="${PWA_ORIGIN}">Wróć do Kiero</a>`);
  });

  it("falls back to the honest generic page for an unknown code", async () => {
    fake.respond = { status: 200, body: { _tag: "ok", value: { code: "something_new", connected: false } } };
    const page = await renderCallback(
      bridgeEnv({ [CALENDAR_APP_BASE_URL_ENV]: PWA_ORIGIN }),
      GATEWAY_HOST,
      "state=s&code=c",
    );
    expect(page.status).toBe(400);
    expect(page.html).toContain("Połączenie kalendarza nie zostało ukończone.");
    expect(page.html).toContain(`<a href="${PWA_ORIGIN}">Wróć do Kiero</a>`);
  });

  it("forwards Google's denial parameter through the service-credential leg", async () => {
    const page = await renderCallback(
      bridgeEnv({ [CALENDAR_APP_BASE_URL_ENV]: PWA_ORIGIN }),
      GATEWAY_HOST,
      "state=s&error=access_denied",
    );
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]?.authorization).toBe(`Bearer ${SERVICE_CREDENTIAL}`);
    expect(JSON.parse(fake.requests[0]?.body ?? "{}")).toEqual({
      state: "s",
      error: "access_denied",
    });
    expect(page.html).not.toContain("access_denied");
  });
});
