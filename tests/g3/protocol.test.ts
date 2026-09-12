/**
 * G3 focused verification, part 2: the Google Calendar Events protocol
 * halves against a FAKE endpoint (a local node:http server in this file,
 * clearly labeled — real Google credentials are absent, owner action; the
 * same pattern as tests/g1/exchange.test.ts).
 *
 * The protocol returns the DECISION CORES' vocabulary directly
 * (MutationReport / ObservationResult), so these tests pin that contract:
 *
 * - bounded deadlines: a stalling endpoint yields the uncertain `unknown`
 *   with the distinct `timeout` cause (the A3 word the attempt rows and
 *   the job outcome record), and the protocol layer issues NO second call
 *   after an uncertain outcome (the no-blind-retry property is pinned by
 *   counting requests);
 * - outcome classification: 2xx confirms (with a readable id), 401/403
 *   and calendar-scoped 404 are the access-lost shapes, event-scoped 404
 *   on patch/delete is `gone`, 5xx is uncertain;
 * - list filters by the documented `privateExtendedProperty` parameter
 *   and includes cancelled remnants (`showDeleted=true`);
 * - observeEventById resolves the get-404 ambiguity inline with ONE
 *   bounded disambiguating list;
 * - update legs send EXACTLY the managed fields they were given (never
 *   reminders, never transparency — personally captured settings survive).
 *
 * Two SEPARATE harness budgets keep ordinary calls tolerant of machine
 * load without weakening the deadline proofs (a one-off map review saw an
 * ordinary first request miss a shared 150 ms budget under load):
 *
 * - NORMAL_LOCAL_TIMEOUT_MS gives every success/status case room for CI
 *   scheduling of a localhost round trip; the fake answers immediately,
 *   so the headroom costs no runtime and a genuine hang still fails;
 * - DELIBERATE_TIMEOUT_MS is passed EXPLICITLY by each deadline test,
 *   which stalls the fake far beyond that small deadline and first parks
 *   a request-received barrier: the deadline provably hits with the
 *   request ALREADY at the server (timeout-after-request), not during
 *   connection startup. If the barrier never resolves the test fails on
 *   the runner timeout — a visible failure, never a hidden pass.
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
  /** Resolves once the NEXT request has reached the fake (the barrier). */
  requestReceived: () => Promise<void>;
}

let fake: FakeGoogle;

/** Ordinary local round trips: room for CI scheduling, no cost when fast. */
const NORMAL_LOCAL_TIMEOUT_MS = 2_000;

/** The small explicit deadline the deliberate timeout tests pass per call. */
const DELIBERATE_TIMEOUT_MS = 150;

/** The fake stalls its answer far beyond the deliberate deadline. */
const STALL_BEYOND_DEADLINE_MS = 10 * DELIBERATE_TIMEOUT_MS;

beforeAll(async () => {
  const requests: FakeGoogle["requests"] = [];
  const behavior: FakeGoogle["behavior"] = {};
  const requestWaiters: Array<() => void> = [];
  const requestReceived = (): Promise<void> =>
    new Promise<void>((resolve) => {
      requestWaiters.push(resolve);
    });
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
      // Request-received barrier: release waiters BEFORE the answer, so a
      // deadline test can prove the timeout hit with the request delivered.
      for (const resolve of requestWaiters.splice(0)) {
        resolve();
      }
      // Snapshot the scripted answer at RECEIVE time: a delayed answer for
      // a client that already aborted must never consume behavior (or a
      // script slot) that a LATER test has set by then.
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
      const answer = (): void => {
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
  fake = { server, url: `http://127.0.0.1:${address.port}`, requests, behavior, requestReceived };
});

afterAll(async () => {
  await new Promise<void>((resolve) => fake.server.close(() => resolve()));
});

/** Ordinary calls use the generous local budget; deadline tests pass theirs. */
const base = (timeoutMs: number = NORMAL_LOCAL_TIMEOUT_MS) => ({
  apiBase: `${fake.url}`,
  accessToken: "fake-access",
  calendarId: "cal-1",
  timeoutMs,
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

  it("keeps a deadline-hit create uncertain with the timeout word (the timeout-after-success case)", async () => {
    fake.requests.length = 0;
    fake.behavior.delayMs = STALL_BEYOND_DEADLINE_MS;
    const received = fake.requestReceived();
    const report = await createCalendarEvent({
      ...base(DELIBERATE_TIMEOUT_MS),
      body: { summary: "Z" },
    });
    // The stall, not connection startup, produced this timeout: the fake
    // had the request in hand before the deadline expired.
    await received;
    expect(report).toEqual({ kind: "unknown", cause: "timeout" });
    expect(fake.requests).toHaveLength(1);
    delete fake.behavior.delayMs;
  });

  it("keeps a 5xx create uncertain WITHOUT the timeout word (a server error is not a deadline)", async () => {
    fake.requests.length = 0;
    fake.behavior.status = 500;
    const report = await createCalendarEvent({ ...base(), body: { summary: "Z" } });
    expect(report).toEqual({ kind: "unknown" });
    expect(fake.requests).toHaveLength(1);
    fake.behavior.status = 200;
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

  it("a deadline-hit list is uncertain with the timeout word", async () => {
    fake.requests.length = 0;
    fake.behavior.delayMs = STALL_BEYOND_DEADLINE_MS;
    const received = fake.requestReceived();
    const observation = await listEventsBySemanticId({
      ...base(DELIBERATE_TIMEOUT_MS),
      semanticId: "sem-9",
    });
    await received;
    expect(observation).toEqual({ kind: "unknown", cause: "timeout" });
    expect(fake.requests).toHaveLength(1);
    delete fake.behavior.delayMs;
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

  it("keeps a deadline-hit get uncertain with the timeout word (ONE request, no disambiguating list)", async () => {
    // An uncertain get must NOT fall into the 404 disambiguation path:
    // the timeout word plus a single recorded request pins that.
    fake.requests.length = 0;
    fake.behavior.delayMs = STALL_BEYOND_DEADLINE_MS;
    const received = fake.requestReceived();
    const observation = await observeEventById({
      ...base(DELIBERATE_TIMEOUT_MS),
      eventId: "evt-3",
      semanticId: "sem-9",
    });
    await received;
    expect(observation).toEqual({ kind: "unknown", cause: "timeout" });
    expect(fake.requests).toHaveLength(1);
    delete fake.behavior.delayMs;
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

  it("keeps a deadline-hit update uncertain with the timeout word (the patch may have applied)", async () => {
    fake.requests.length = 0;
    fake.behavior.delayMs = STALL_BEYOND_DEADLINE_MS;
    const received = fake.requestReceived();
    const report = await updateCalendarEvent({
      ...base(DELIBERATE_TIMEOUT_MS),
      eventId: "evt-3",
      body: { summary: "Nowy" },
    });
    await received;
    expect(report).toEqual({ kind: "unknown", cause: "timeout" });
    expect(fake.requests).toHaveLength(1);
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
