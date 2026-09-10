/**
 * G3 focused verification, part 2: the Google Calendar Events protocol
 * halves against a FAKE endpoint (a local node:http server in this file,
 * clearly labeled — real Google credentials are absent, owner action; the
 * same pattern as tests/g1/exchange.test.ts).
 *
 * The protocol returns the DECISION CORES' vocabulary directly
 * (MutationReport / ObservationResult), so these tests pin that contract:
 *
 * - bounded deadlines: a stalling endpoint yields `unknown`, and the
 *   protocol layer issues NO second call after an uncertain outcome
 *   (the no-blind-retry property is pinned by counting requests);
 * - outcome classification: 2xx confirms (with a readable id), 401/403
 *   and calendar-scoped 404 are the access-lost shapes, event-scoped 404
 *   on patch/delete is `gone`, 5xx is uncertain;
 * - list filters by the documented `privateExtendedProperty` parameter
 *   and includes cancelled remnants (`showDeleted=true`);
 * - observeEventById resolves the get-404 ambiguity inline with ONE
 *   bounded disambiguating list;
 * - update legs send EXACTLY the managed fields they were given (never
 *   reminders, never transparency — personally captured settings survive).
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import {
  createCalendarEvent,
  deleteCalendarEvent,
  listEventsBySemanticId,
  observeEventById,
  updateCalendarEvent,
} from "../../convex/calendar/sync/protocol";

/** A clearly-labeled fake Google endpoint (test fixture, never real). */
interface FakeGoogle {
  server: Server;
  url: string;
  requests: { method: string; path: string; query: URLSearchParams; body: string }[];
  behavior: {
    status?: number;
    /** Per-request status overrides, consumed in order (get/list sequences). */
    script?: number[];
    delayMs?: number;
    listItems?: unknown[];
    body?: unknown;
  };
}

let fake: FakeGoogle;

const SHORT_TIMEOUT_MS = 150;

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
        query: url.searchParams,
        body,
      });
      const answer = (): void => {
        const scripted = behavior.script?.shift();
        const status = scripted ?? behavior.status ?? 200;
        const payload =
          behavior.body ??
          (status >= 400
            ? { error: { code: status, message: "fixture" } }
            : url.pathname.endsWith("/events")
              ? behavior.listItems === undefined
                ? { items: [] }
                : { items: behavior.listItems }
              : {
                  id: "fake-evt-1",
                  status: "confirmed",
                  summary: "Zadanie: Beton",
                  start: { date: "2031-05-04" },
                  end: { date: "2031-05-05" },
                });
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(payload));
      };
      if (behavior.delayMs !== undefined) {
        setTimeout(answer, behavior.delayMs);
        return;
      }
      answer();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("fake google: no port");
  }
  fake = { server, url: `http://127.0.0.1:${address.port}`, requests, behavior };
});

afterAll(async () => {
  await new Promise<void>((resolve) => fake.server.close(() => resolve()));
});

const base = () => ({
  apiBase: `${fake.url}`,
  accessToken: "fake-access",
  calendarId: "cal-1",
  timeoutMs: SHORT_TIMEOUT_MS,
});

describe("create legs (MutationReport)", () => {
  it("confirms with the readable remote id", async () => {
    fake.requests.length = 0;
    fake.behavior.status = 200;
    fake.behavior.body = { id: "evt-7", status: "confirmed" };
    const report = await createCalendarEvent({
      ...base(),
      body: { summary: "Z", transparency: "transparent" },
    });
    expect(report).toEqual({ kind: "applied", eventId: "evt-7" });
    expect(fake.requests[0]?.path).toBe("/calendars/cal-1/events");
    delete fake.behavior.body;
  });

  it("records a 2xx WITHOUT a readable id as unknown — never a re-POST", async () => {
    fake.behavior.body = { status: "confirmed" };
    const report = await createCalendarEvent({ ...base(), body: { summary: "Z" } });
    expect(report).toEqual({ kind: "unknown" });
    delete fake.behavior.body;
  });

  it("maps calendar-scoped 401/403/404 to the access-lost shape", async () => {
    for (const status of [401, 403, 404]) {
      fake.behavior.status = status;
      const report = await createCalendarEvent({ ...base(), body: { summary: "Z" } });
      expect(report).toEqual({ kind: "calendar_gone" });
    }
    fake.behavior.status = 200;
  });

  it("keeps a deadline-hit create UNKNOWN (the timeout-after-success case)", async () => {
    fake.requests.length = 0;
    fake.behavior.delayMs = 10 * SHORT_TIMEOUT_MS;
    const report = await createCalendarEvent({ ...base(), body: { summary: "Z" } });
    expect(report).toEqual({ kind: "unknown" });
    expect(fake.requests).toHaveLength(1);
    delete fake.behavior.delayMs;
  });

  it("never issues a second call after the uncertain outcome (protocol layer)", async () => {
    // The runner's observe-before-retry rule is decided in the cores; the
    // protocol layer's own contribution is that IT does not retry: one
    // invocation, one request, whatever the outcome.
    fake.requests.length = 0;
    fake.behavior.status = 500;
    const report = await createCalendarEvent({ ...base(), body: { summary: "Z" } });
    expect(report).toEqual({ kind: "unknown" });
    expect(fake.requests).toHaveLength(1);
    fake.behavior.status = 200;
  });
});

describe("list legs (ObservationResult, the observation filter)", () => {
  it("filters by the documented privateExtendedProperty parameter with remnants", async () => {
    fake.requests.length = 0;
    fake.behavior.status = 200;
    fake.behavior.listItems = [{ id: "evt-2", status: "cancelled", summary: "przeniesione" }];
    const observation = await listEventsBySemanticId({ ...base(), semanticId: "sem-9" });
    expect(observation).toMatchObject({
      kind: "present",
      eventId: "evt-2",
      status: "cancelled",
      managed: { summary: "przeniesione" },
    });
    expect(fake.requests[0]?.path).toBe("/calendars/cal-1/events");
    expect(fake.requests[0]?.query.get("privateExtendedProperty")).toBe("kiero.semanticId=sem-9");
    expect(fake.requests[0]?.query.get("showDeleted")).toBe("true");
    delete fake.behavior.listItems;
  });

  it("an empty 200 answer is the definite absence that alone re-arms a create", async () => {
    fake.behavior.listItems = [];
    const observation = await listEventsBySemanticId({ ...base(), semanticId: "sem-9" });
    expect(observation).toEqual({ kind: "empty" });
    delete fake.behavior.listItems;
  });

  it("a missing items array is uncertain, not empty", async () => {
    fake.behavior.body = { something: "else" };
    const observation = await listEventsBySemanticId({ ...base(), semanticId: "sem-9" });
    expect(observation).toEqual({ kind: "unknown" });
    delete fake.behavior.body;
  });

  it("calendar-scoped refusals on list are the access-lost shape", async () => {
    for (const status of [401, 403, 404]) {
      fake.behavior.status = status;
      const observation = await listEventsBySemanticId({ ...base(), semanticId: "sem-9" });
      expect(observation).toEqual({ kind: "calendar_gone" });
    }
    fake.behavior.status = 200;
  });
});

describe("observeEventById (the get leg with inline 404 disambiguation)", () => {
  it("observes one known id with its managed fields (ONE request)", async () => {
    fake.requests.length = 0;
    fake.behavior.status = 200;
    fake.behavior.body = {
      id: "evt-3",
      status: "confirmed",
      summary: "Z",
      start: { date: "2031-06-01" },
      end: { date: "2031-06-02" },
    };
    const observation = await observeEventById({ ...base(), eventId: "evt-3", semanticId: "sem-9" });
    expect(observation).toEqual({
      kind: "present",
      eventId: "evt-3",
      status: "confirmed",
      managed: {
        summary: "Z",
        description: "",
        start: { date: "2031-06-01" },
        end: { date: "2031-06-02" },
      },
    });
    expect(fake.requests[0]?.path).toBe("/calendars/cal-1/events/evt-3");
    expect(fake.requests).toHaveLength(1);
    delete fake.behavior.body;
  });

  it("resolves a get-404 with ONE list: the calendar answers -> the event is gone (empty)", async () => {
    fake.requests.length = 0;
    fake.behavior.script = [404, 200];
    fake.behavior.listItems = [];
    const observation = await observeEventById({ ...base(), eventId: "evt-3", semanticId: "sem-9" });
    expect(observation).toEqual({ kind: "empty" });
    expect(fake.requests).toHaveLength(2);
    expect(fake.requests[1]?.path).toBe("/calendars/cal-1/events");
    delete fake.behavior.script;
    delete fake.behavior.listItems;
  });

  it("the disambiguating list finding the stray resolves to present", async () => {
    fake.behavior.script = [404, 200];
    fake.behavior.listItems = [{ id: "evt-4", status: "confirmed", summary: "S" }];
    const observation = await observeEventById({ ...base(), eventId: "evt-3", semanticId: "sem-9" });
    expect(observation).toMatchObject({ kind: "present", eventId: "evt-4" });
    delete fake.behavior.script;
    delete fake.behavior.listItems;
  });

  it("escalates to calendar_gone when the disambiguating list 404s", async () => {
    fake.requests.length = 0;
    fake.behavior.status = 404;
    const observation = await observeEventById({ ...base(), eventId: "evt-3", semanticId: "sem-9" });
    expect(observation).toEqual({ kind: "calendar_gone" });
    expect(fake.requests).toHaveLength(2);
    fake.behavior.status = 200;
  });
});

describe("update legs (the managed-fields contract on the wire)", () => {
  it("sends EXACTLY the managed fields it was given — nothing else", async () => {
    fake.requests.length = 0;
    fake.behavior.status = 200;
    fake.behavior.body = { id: "evt-3", status: "confirmed" };
    const report = await updateCalendarEvent({
      ...base(),
      eventId: "evt-3",
      body: {
        summary: "Nowy",
        description: "Opis",
        start: { date: "2031-06-01" },
        end: { date: "2031-06-02" },
      },
    });
    expect(report).toEqual({ kind: "applied" });
    const sent = JSON.parse(fake.requests[0]?.body ?? "{}");
    expect(Object.keys(sent).sort()).toEqual(["description", "end", "start", "summary"]);
    expect(fake.requests[0]?.method).toBe("PATCH");
    delete fake.behavior.body;
  });

  it("reports the ambiguous event-scoped 404 as gone", async () => {
    fake.behavior.status = 404;
    const report = await updateCalendarEvent({
      ...base(),
      eventId: "evt-3",
      body: { summary: "Nowy" },
    });
    expect(report).toEqual({ kind: "gone" });
    fake.behavior.status = 200;
  });

  it("keeps an unknown update unknown (the patch may have applied)", async () => {
    fake.behavior.delayMs = 10 * SHORT_TIMEOUT_MS;
    const report = await updateCalendarEvent({
      ...base(),
      eventId: "evt-3",
      body: { summary: "Nowy" },
    });
    expect(report).toEqual({ kind: "unknown" });
    delete fake.behavior.delayMs;
  });
});

describe("delete legs", () => {
  it("confirms 204", async () => {
    fake.requests.length = 0;
    fake.behavior.status = 204;
    const report = await deleteCalendarEvent({ ...base(), eventId: "evt-3" });
    expect(report).toEqual({ kind: "applied" });
    expect(fake.requests[0]?.method).toBe("DELETE");
    fake.behavior.status = 200;
  });

  it("treats 404 as the idempotent already-gone answer", async () => {
    fake.behavior.status = 404;
    const report = await deleteCalendarEvent({ ...base(), eventId: "evt-3" });
    expect(report).toEqual({ kind: "gone" });
    fake.behavior.status = 200;
  });
});
