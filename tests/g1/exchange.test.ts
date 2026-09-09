/**
 * G1 focused verification: protocol-level token exchange, refresh and
 * calendar find-or-create against a FAKE endpoint.
 *
 * The fixture is a local node:http server in this file, clearly labeled:
 * real Google credentials are absent (owner action), so these tests prove
 * the executor halves (bounded deadline, single POST, outcome
 * classification) against the documented wire shapes. Counting received
 * requests pins the no-blind-retry property: one uncertain outcome, and no
 * second call is ever issued by the protocol layer.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import {
  createDedicatedCalendar,
  exchangeCodeForTokens,
  readKnownCalendar,
  refreshAccessToken,
} from "../../convex/calendar/connection/protocol";

/** A clearly-labeled fake Google endpoint (test fixture, never real). */
interface FakeGoogle {
  server: Server;
  url: string;
  requests: { method: string; path: string; body: string }[];
  behavior: { tokenStatus?: number; calendarStatus?: number; delayMs?: number };
}

let fake: FakeGoogle;

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
      requests.push({ method: request.method ?? "", path: url.pathname, body });
      const answer = (): void => {
        if (url.pathname.endsWith("/token")) {
          const status = behavior.tokenStatus ?? 200;
          const payload =
            status === 200
              ? {
                  access_token: "fake-access",
                  refresh_token: "fake-refresh",
                  expires_in: 3600,
                  scope: "openid email https://www.googleapis.com/auth/calendar.app.created",
                  id_token: "h.p.s",
                }
              : { error: status === 400 || status === 401 ? "invalid_grant" : "server_error" };
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(payload));
          return;
        }
        // Calendar API paths.
        const status = behavior.calendarStatus ?? 200;
        if (status === 200) {
          response.writeHead(200, { "content-type": "application/json" });
          response.end(JSON.stringify({ id: "fake-cal-1", summary: "Kiero — test" }));
          return;
        }
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: status === 404 ? "notFound" : "backendError" }));
      };
      if (behavior.delayMs !== undefined) {
        // Longer than every caller deadline: the uncertain case.
        setTimeout(answer, behavior.delayMs);
        return;
      }
      answer();
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

beforeEach(() => {
  fake.requests.length = 0;
  delete fake.behavior.tokenStatus;
  delete fake.behavior.calendarStatus;
  delete fake.behavior.delayMs;
});

const exchange = (endpoint: string) =>
  exchangeCodeForTokens({
    tokenEndpoint: endpoint,
    clientId: "fake-client",
    clientSecret: "fake-secret",
    code: "fake-code",
    redirectUri: "https://example.convex.cloud/calendar/oauth/callback",
    verifier: "fake-verifier",
  });

describe("token exchange against the fake endpoint", () => {
  it("decodes a granted response", async () => {
    const outcome = await exchange(`${fake.url}/token`);
    expect(outcome.kind).toBe("granted");
    // The request carried the PKCE verifier and the client secret.
    const body = new URLSearchParams(fake.requests[0]?.body ?? "");
    expect(body.get("code_verifier")).toBe("fake-verifier");
    expect(body.get("client_secret")).toBe("fake-secret");
    expect(body.get("grant_type")).toBe("authorization_code");
  });

  it("classifies a 400 refusal as definite failure", async () => {
    fake.behavior.tokenStatus = 400;
    const outcome = await exchange(`${fake.url}/token`);
    expect(outcome).toEqual({ kind: "failed", failure: "definite_invalid_request" });
  });

  it("classifies a 5xx as uncertain (the code may be consumed)", async () => {
    fake.behavior.tokenStatus = 500;
    const outcome = await exchange(`${fake.url}/token`);
    expect(outcome).toEqual({ kind: "failed", failure: "unknown_status" });
  });

  it("records a deadline hit as uncertain and never re-sends", async () => {
    fake.behavior.delayMs = 9_000;
    const outcome = await exchange(`${fake.url}/token`);
    expect(outcome).toEqual({ kind: "failed", failure: "unknown_timeout" });
    expect(fake.requests.length).toBe(1);
  }, 15_000);
});

describe("refresh against the fake endpoint", () => {
  it("decodes a refreshed grant and classifies loss", async () => {
    const ok = await refreshAccessToken({
      tokenEndpoint: `${fake.url}/token`,
      clientId: "fake-client",
      clientSecret: "fake-secret",
      refreshToken: "fake-refresh",
    });
    expect(ok.kind).toBe("granted");
    fake.behavior.tokenStatus = 400;
    const lost = await refreshAccessToken({
      tokenEndpoint: `${fake.url}/token`,
      clientId: "fake-client",
      clientSecret: "fake-secret",
      refreshToken: "fake-refresh",
    });
    expect(lost).toEqual({ kind: "failed", failure: "definite_invalid_request" });
  });
});

describe("calendar find-or-create against the fake endpoint", () => {
  it("creates and returns the dedicated calendar id", async () => {
    const outcome = await createDedicatedCalendar({
      apiBase: fake.url,
      accessToken: "fake-access",
      summary: "Kiero — test",
    });
    expect(outcome).toEqual({ kind: "created", calendarId: "fake-cal-1" });
    expect(fake.requests[0]?.path).toBe("/calendars");
  });

  it("classifies a 400 create as definite failure", async () => {
    fake.behavior.calendarStatus = 400;
    const outcome = await createDedicatedCalendar({
      apiBase: fake.url,
      accessToken: "fake-access",
      summary: "Kiero — test",
    });
    expect(outcome).toEqual({ kind: "definitely_failed", failure: "definite_invalid_request" });
  });

  it("records a timeout AFTER the create POST as unknown with exactly one POST", async () => {
    // The fixture received (and conceptually processed) the creation, then
    // stalled past the deadline: the calendar may exist with an unknown id.
    fake.behavior.delayMs = 9_000;
    const outcome = await createDedicatedCalendar({
      apiBase: fake.url,
      accessToken: "fake-access",
      summary: "Kiero — test",
    });
    expect(outcome).toEqual({ kind: "unknown", failure: "unknown_timeout" });
    // The load-bearing count: no blind second POST ever happened.
    expect(fake.requests.filter((r) => r.path === "/calendars")).toHaveLength(1);
  }, 15_000);

  it("treats 401/403/404 reads as ambiguous-gone and 5xx as unknown", async () => {
    for (const status of [401, 403, 404]) {
      fake.behavior.calendarStatus = status;
      const outcome = await readKnownCalendar({
        apiBase: fake.url,
        accessToken: "fake-access",
        calendarId: "fake-cal-1",
      });
      expect(outcome).toEqual({ kind: "ambiguous_gone" });
    }
    fake.behavior.calendarStatus = 500;
    const unknown = await readKnownCalendar({
      apiBase: fake.url,
      accessToken: "fake-access",
      calendarId: "fake-cal-1",
    });
    expect(unknown).toEqual({ kind: "unknown", failure: "unknown_status" });
  });

  it("confirms a reachable known calendar", async () => {
    const outcome = await readKnownCalendar({
      apiBase: fake.url,
      accessToken: "fake-access",
      calendarId: "fake-cal-1",
    });
    expect(outcome).toEqual({ kind: "reachable" });
    expect(fake.requests[0]?.path).toBe(`/calendars/${encodeURIComponent("fake-cal-1")}`);
  });
});
