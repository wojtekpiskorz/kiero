/**
 * G1 focused verification: the gateway's Calendar OAuth bridge client.
 *
 * The Worker routes (apps/gateway/src/calendar-oauth) forward to the
 * deployment's verified HTTP boundary; what MUST hold structurally is
 * pinned here against a clearly-labeled fake site (the same fixture
 * pattern as exchange.test.ts): the start forwards the USER's bearer and
 * never fabricates a URL without it, both legs fail closed and sanitized
 * when the backend is unconfigured/unreachable or answers garbage, and the
 * callback completion carries exactly the service credential + Google's
 * query — no token values are echoed into errors.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import { calendarComplete, calendarStart } from "../../apps/gateway/src/calendar-oauth/client";

/** A clearly-labeled fake Convex site (test fixture, never real). */
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
  fake.respond = { status: 200, body: { _tag: "ok", value: {} } };
});

/** The configured bindings (lazily: the fake site binds in beforeAll). */
const configured = (): { CONVEX_SITE_URL: string; KIERO_SERVICE_TOKEN: string } => ({
  CONVEX_SITE_URL: fake.url,
  KIERO_SERVICE_TOKEN: "service-credential",
});

describe("calendarStart (the user-token leg)", () => {
  it("fails closed and sanitized without a configured backend", async () => {
    const result = await calendarStart({}, "Bearer user-token");
    if (result.ok) {
      throw new Error("expected the closed unavailable failure");
    }
    if (result.result._tag === "error") {
      expect(result.result.error._tag).toBe("unavailable");
      expect(JSON.stringify(result.result)).not.toContain("user-token");
    }
  });

  it("refuses to call the backend without the user's bearer", async () => {
    const result = await calendarStart(configured(), null);
    expect(result.ok).toBe(false);
    expect(fake.requests).toHaveLength(0);
  });

  it("forwards the user's bearer verbatim and decodes the URL envelope", async () => {
    fake.respond = {
      status: 200,
      body: {
        _tag: "ok",
        value: {
          authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s",
          expiresAtMs: 123,
        },
      },
    };
    const result = await calendarStart(configured(), "Bearer user-token");
    expect(result).toEqual({
      ok: true,
      start: {
        authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth?state=s",
        expiresAtMs: 123,
      },
    });
    expect(fake.requests[0]?.authorization).toBe("Bearer user-token");
    fake.respond = { status: 200, body: { _tag: "ok", value: {} } };
  });

  it("passes a backend error envelope through untouched", async () => {
    fake.respond = {
      status: 409,
      body: { _tag: "error", error: { _tag: "conflict", code: "already_connected", message: "m" } },
    };
    const result = await calendarStart(configured(), "Bearer user-token");
    if (result.ok) {
      throw new Error("expected the backend conflict to pass through");
    }
    if (result.result._tag === "error") {
      expect(result.result.error._tag).toBe("conflict");
    }
    fake.respond = { status: 200, body: { _tag: "ok", value: {} } };
  });

  it("treats a non-envelope answer as the closed unreachable error", async () => {
    fake.respond = { status: 200, body: { nonsense: true } };
    const result = await calendarStart(configured(), "Bearer user-token");
    if (result.ok) {
      throw new Error("expected the closed unreachable failure");
    }
    if (result.result._tag === "error") {
      expect(result.result.error._tag).toBe("unavailable");
    }
    fake.respond = { status: 200, body: { _tag: "ok", value: {} } };
  });
});

describe("calendarComplete (the service-credential leg)", () => {
  it("fails closed without backend URL or service credential", async () => {
    const noUrl = await calendarComplete(
      { KIERO_SERVICE_TOKEN: "service-credential" },
      { state: "s", code: "c", error: null },
    );
    const noToken = await calendarComplete(
      { CONVEX_SITE_URL: fake.url },
      { state: "s", code: "c", error: null },
    );
    expect(noUrl.ok).toBe(false);
    expect(noToken.ok).toBe(false);
    expect(fake.requests).toHaveLength(0);
  });

  it("forwards exactly the service credential and Google's query", async () => {
    fake.respond = { status: 200, body: { _tag: "ok", value: { code: "connected", connected: true } } };
    const result = await calendarComplete(
      configured(),
      { state: "the-state", code: "the-code", error: null },
    );
    expect(result.ok).toBe(true);
    expect(fake.requests[0]?.authorization).toBe("Bearer service-credential");
    expect(JSON.parse(fake.requests[0]?.body ?? "{}")).toEqual({
      state: "the-state",
      code: "the-code",
    });
    if (result.ok) {
      expect(result.result._tag).toBe("ok");
    }
  });

  it("forwards the error parameter when Google reported a denial", async () => {
    await calendarComplete(configured(), { state: "s2", code: null, error: "access_denied" });
    expect(JSON.parse(fake.requests[0]?.body ?? "{}")).toEqual({
      state: "s2",
      error: "access_denied",
    });
  });
});
