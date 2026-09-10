/**
 * Google Calendar Events API protocol (G3): pure request construction and
 * bounded executors for the per-copy create / read / update / delete legs,
 * with G1's uncertainty vocabulary (see ../connection/protocol.ts):
 *
 * - a 2xx answer with a readable body is a CONFIRMATION;
 * - 401/403 (revoked or inaccessible token) and a 404 at the CALENDAR
 *   scope (list/insert answering notFound) are the ambiguous-gone shapes
 *   the caller must escalate to `calendar_access_lost` — the explicit
 *   recreate path, never an automatic one;
 * - a 404 on a specific event (get/patch/delete) is AMBIGUOUS between a
 *   user-deleted event and a gone calendar: the caller disambiguates with
 *   ONE bounded `observe_list` (the calendar answering the list proves it
 *   exists, so the event is gone);
 * - a 5xx, a deadline hit or an unreadable body is UNCERTAIN: the effect
 *   may have happened (a created event, an applied patch, a deletion) and
 *   only reconciliation by observation may resolve it.
 *
 * No Convex imports: the whole protocol is testable without Google (the
 * focused tests run it against a clearly-labeled local fake, the G1
 * tests/g1/exchange.test.ts pattern).
 */

/** Bounded HTTP deadline for the event legs (echo: 2s class). */
export const EVENTS_HTTP_TIMEOUT_MS = 4_000;

/** The Events.list filter for our private extended property (documented). */
export function privatePropertyFilter(key: string, value: string): string {
  return `${key}=${value}`;
}

// ---------------------------------------------------------------------------
// Outcome unions (the closed vocabulary the decisions consume).
// ---------------------------------------------------------------------------

/** What an observation leg (list/get) definitely learned. */
export type EventObserveOutcome =
  | {
      readonly kind: "present";
      readonly eventId: string;
      readonly status: "confirmed" | "cancelled";
      readonly body: Record<string, unknown>;
    }
  | { readonly kind: "empty" }
  | { readonly kind: "gone" }
  | { readonly kind: "calendar_gone" }
  | { readonly kind: "unknown"; readonly failure: EventFailureKind };

export type EventCreateOutcome =
  | { readonly kind: "created"; readonly eventId: string }
  | { readonly kind: "calendar_gone" }
  | { readonly kind: "definitely_failed" }
  | { readonly kind: "unknown"; readonly failure: EventFailureKind };

export type EventMutateOutcome =
  | { readonly kind: "applied" }
  | { readonly kind: "gone" }
  | { readonly kind: "calendar_gone" }
  | { readonly kind: "definitely_failed" }
  | { readonly kind: "unknown"; readonly failure: EventFailureKind };

/** The failure kinds (G1's TokenFailureKind vocabulary, event legs). */
export type EventFailureKind =
  | "unknown_status"
  | "unknown_timeout"
  | "unknown_body"
  | "definite_network";

// ---------------------------------------------------------------------------
// Shared plumbing.
// ---------------------------------------------------------------------------

function apiRoot(apiBase: string, calendarId: string): string {
  return `${apiBase.replace(/\/$/, "")}/calendars/${encodeURIComponent(calendarId)}/events`;
}

/** One bounded fetch with the echo abort-deadline; never throws. */
async function boundedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: unknown; failure?: EventFailureKind }> {
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;
  try {
    response = await fetch(url, { ...init, signal: controller.signal });
  } catch (cause) {
    clearTimeout(deadline);
    if (cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError")) {
      return { status: 0, body: null, failure: "unknown_timeout" };
    }
    return { status: 0, body: null, failure: "definite_network" };
  }
  clearTimeout(deadline);
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

/** Parses one event body into the observe-outcome shape. */
function parseEventBody(
  status: number,
  body: unknown,
): { eventId: string; eventStatus: string } | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (typeof record.id !== "string" || record.id.length === 0) {
    return null;
  }
  if (typeof record.status !== "string") {
    return null;
  }
  if (status !== 200) {
    return null;
  }
  return { eventId: record.id, eventStatus: record.status };
}

// ---------------------------------------------------------------------------
// Observation legs.
// ---------------------------------------------------------------------------

/**
 * Events.list filtered by our private extended property, with cancelled
 * remnants included (`showDeleted=true`): the ONE documented way to find a
 * copy whose create outcome was unknown, or a stray created by a stale
 * attempt. An empty answer on a 200 proves the calendar exists AND no
 * matching event does — the definite absence that alone re-arms a create.
 */
export async function listEventsBySemanticId(input: {
  readonly apiBase: string;
  readonly accessToken: string;
  readonly calendarId: string;
  readonly semanticId: string;
  readonly propertyKey?: string;
  readonly timeoutMs?: number;
}): Promise<EventObserveOutcome> {
  const key = input.propertyKey ?? "kiero.semanticId";
  const params = new URLSearchParams({
    privateExtendedProperty: privatePropertyFilter(key, input.semanticId),
    showDeleted: "true",
  });
  const answer = await boundedFetch(
    `${apiRoot(input.apiBase, input.calendarId)}?${params.toString()}`,
    { method: "GET", headers: { authorization: `Bearer ${input.accessToken}` } },
    input.timeoutMs ?? EVENTS_HTTP_TIMEOUT_MS,
  );
  if (answer.status === 200) {
    if (typeof answer.body !== "object" || answer.body === null) {
      return { kind: "unknown", failure: "unknown_body" };
    }
    const items = (answer.body as Record<string, unknown>).items;
    if (!Array.isArray(items)) {
      return { kind: "unknown", failure: "unknown_body" };
    }
    const found = items.find(
      (item): item is Record<string, unknown> =>
        typeof item === "object" && item !== null && typeof (item as Record<string, unknown>).id === "string",
    );
    if (found === undefined) {
      return { kind: "empty" };
    }
    const status = found.status;
    return {
      kind: "present",
      eventId: found.id as string,
      status: status === "cancelled" ? "cancelled" : "confirmed",
      body: found,
    };
  }
  if (answer.status === 401 || answer.status === 403 || answer.status === 404) {
    // The LIST is calendar-scoped: any of these means the dedicated
    // calendar itself is gone or inaccessible (Google documents 404 for
    // both nonexistent and inaccessible calendars).
    return { kind: "calendar_gone" };
  }
  return { kind: "unknown", failure: answer.failure ?? "unknown_status" };
}

/**
 * Events.get: observes one known remote id. A 404 here is AMBIGUOUS (the
 * event was deleted, or the calendar is gone) — the runner disambiguates
 * with ONE bounded `listEventsBySemanticId` (a read; it cannot duplicate
 * an effect), which is also why `gone` is a distinct outcome.
 */
export async function getCalendarEvent(input: {
  readonly apiBase: string;
  readonly accessToken: string;
  readonly calendarId: string;
  readonly eventId: string;
  readonly timeoutMs?: number;
}): Promise<EventObserveOutcome> {
  const answer = await boundedFetch(
    `${apiRoot(input.apiBase, input.calendarId)}/${encodeURIComponent(input.eventId)}`,
    { method: "GET", headers: { authorization: `Bearer ${input.accessToken}` } },
    input.timeoutMs ?? EVENTS_HTTP_TIMEOUT_MS,
  );
  if (answer.status === 200) {
    const parsed = parseEventBody(answer.status, answer.body);
    if (parsed === null) {
      return { kind: "unknown", failure: "unknown_body" };
    }
    return {
      kind: "present",
      eventId: parsed.eventId,
      status: parsed.eventStatus === "cancelled" ? "cancelled" : "confirmed",
      body:
        typeof answer.body === "object" && answer.body !== null
          ? (answer.body as Record<string, unknown>)
          : {},
    };
  }
  if (answer.status === 404) {
    return { kind: "gone" };
  }
  if (answer.status === 401 || answer.status === 403) {
    return { kind: "calendar_gone" };
  }
  return { kind: "unknown", failure: answer.failure ?? "unknown_status" };
}

// ---------------------------------------------------------------------------
// Mutation legs.
// ---------------------------------------------------------------------------

/** Events.insert: the one POST that can land unseen (timeout-after-create). */
export async function createCalendarEvent(input: {
  readonly apiBase: string;
  readonly accessToken: string;
  readonly calendarId: string;
  readonly body: Record<string, unknown>;
  readonly timeoutMs?: number;
}): Promise<EventCreateOutcome> {
  const answer = await boundedFetch(
    apiRoot(input.apiBase, input.calendarId),
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.body),
    },
    input.timeoutMs ?? EVENTS_HTTP_TIMEOUT_MS,
  );
  if (answer.status === 200 || answer.status === 201) {
    const parsed = parseEventBody(answer.status, answer.body);
    if (parsed === null) {
      // Created but no readable id: uncertain, never a re-POST.
      return { kind: "unknown", failure: "unknown_body" };
    }
    return { kind: "created", eventId: parsed.eventId };
  }
  if (answer.status === 401 || answer.status === 403 || answer.status === 404) {
    // insert is calendar-scoped: the calendar is gone or inaccessible.
    return { kind: "calendar_gone" };
  }
  if (answer.status === 400) {
    return { kind: "definitely_failed" };
  }
  return { kind: "unknown", failure: answer.failure ?? "unknown_status" };
}

/**
 * Events.patch: carries MANAGED FIELDS ONLY. The body is the caller's
 * `updateEventBody` output — this executor sends exactly what it is given
 * and never adds reminders/transparency back.
 */
export async function updateCalendarEvent(input: {
  readonly apiBase: string;
  readonly accessToken: string;
  readonly calendarId: string;
  readonly eventId: string;
  readonly body: Record<string, unknown>;
  readonly timeoutMs?: number;
}): Promise<EventMutateOutcome> {
  const answer = await boundedFetch(
    `${apiRoot(input.apiBase, input.calendarId)}/${encodeURIComponent(input.eventId)}`,
    {
      method: "PATCH",
      headers: {
        authorization: `Bearer ${input.accessToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(input.body),
    },
    input.timeoutMs ?? EVENTS_HTTP_TIMEOUT_MS,
  );
  if (answer.status === 200 || answer.status === 204) {
    return { kind: "applied" };
  }
  if (answer.status === 404) {
    return { kind: "gone" };
  }
  if (answer.status === 401 || answer.status === 403) {
    return { kind: "calendar_gone" };
  }
  if (answer.status === 400) {
    return { kind: "definitely_failed" };
  }
  return { kind: "unknown", failure: answer.failure ?? "unknown_status" };
}

/** Events.delete: 404 is the idempotent already-gone answer. */
export async function deleteCalendarEvent(input: {
  readonly apiBase: string;
  readonly accessToken: string;
  readonly calendarId: string;
  readonly eventId: string;
  readonly timeoutMs?: number;
}): Promise<EventMutateOutcome> {
  const answer = await boundedFetch(
    `${apiRoot(input.apiBase, input.calendarId)}/${encodeURIComponent(input.eventId)}`,
    { method: "DELETE", headers: { authorization: `Bearer ${input.accessToken}` } },
    input.timeoutMs ?? EVENTS_HTTP_TIMEOUT_MS,
  );
  if (answer.status === 200 || answer.status === 204) {
    return { kind: "applied" };
  }
  if (answer.status === 404) {
    return { kind: "gone" };
  }
  if (answer.status === 401 || answer.status === 403) {
    return { kind: "calendar_gone" };
  }
  if (answer.status === 400) {
    return { kind: "definitely_failed" };
  }
  return { kind: "unknown", failure: answer.failure ?? "unknown_status" };
}

/** Extracts the managed fields one observed event body carries. */
export function managedFieldsOfBody(
  body: Record<string, unknown>,
): { summary: string; description: string; start: { date?: string; dateTime?: string }; end: { date?: string; dateTime?: string } } {
  const pick = (value: unknown): { date?: string; dateTime?: string } => {
    if (typeof value !== "object" || value === null) {
      return {};
    }
    const record = value as Record<string, unknown>;
    return {
      ...(typeof record.date === "string" ? { date: record.date } : {}),
      ...(typeof record.dateTime === "string" ? { dateTime: record.dateTime } : {}),
    };
  };
  return {
    summary: typeof body.summary === "string" ? body.summary : "",
    description: typeof body.description === "string" ? body.description : "",
    start: pick(body.start),
    end: pick(body.end),
  };
}
