/**
 * Google Calendar Events API protocol (G3): pure request construction and
 * bounded executors for the per-copy create / read / update / delete legs.
 *
 * The executors return the DECISION CORES' vocabulary directly
 * (`MutationReport`, `ObservationResult` — ./cores.ts): this module and
 * the cores are both pure (no Convex imports), so there is no adapter
 * layer and no second type family between the wire and the decision
 * table. The uncertainty semantics are G1's (../connection/protocol.ts):
 *
 * - a 2xx answer with a readable body is a CONFIRMATION;
 * - 401/403 (revoked or inaccessible token) and a 404 at the CALENDAR
 *   scope (list/insert answering notFound) are the ambiguous-gone shapes
 *   the caller must escalate to `calendar_access_lost` — the explicit
 *   recreate path, never an automatic one;
 * - a 404 on a specific event (get/patch/delete) is AMBIGUOUS between a
 *   user-deleted event and a gone calendar: `observeEventById` resolves
 *   it with ONE bounded list (the calendar answering the list proves it
 *   exists, so the event is gone — a read cannot duplicate an effect);
 * - a 5xx, a deadline hit or an unreadable body is UNCERTAIN: the effect
 *   may have happened (a created event, an applied patch, a deletion) and
 *   only reconciliation by observation may resolve it.
 *
 * Testable without Google: the focused tests run it against a
 * clearly-labeled local fake (the G1 tests/g1/exchange.test.ts pattern).
 */

import type { ManagedFields, MutationReport, ObservationResult } from "./cores";

/** Bounded HTTP deadline for the event legs (echo: 2s class). */
export const EVENTS_HTTP_TIMEOUT_MS = 4_000;

/** The Events.list filter for our private extended property (documented). */
export function privatePropertyFilter(key: string, value: string): string {
  return `${key}=${value}`;
}

// ---------------------------------------------------------------------------
// Shared plumbing.
// ---------------------------------------------------------------------------

function apiRoot(apiBase: string, calendarId: string): string {
  return `${apiBase.replace(/\/$/, "")}/calendars/${encodeURIComponent(calendarId)}/events`;
}

/** Why a bounded fetch did not produce a clean answer (internal only). */
type FetchFailure = "unknown_status" | "unknown_timeout" | "unknown_body" | "definite_network";

/** One bounded fetch with the echo abort-deadline; never throws. */
async function boundedFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<{ status: number; body: unknown; failure?: FetchFailure }> {
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

/** The event id + status of one 2xx event body, when both are readable. */
function eventIdStatusOf(body: unknown): { eventId: string; status: string } | null {
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
  return { eventId: record.id, status: record.status };
}

// ---------------------------------------------------------------------------
// Mutation legs (Events.insert / patch / delete -> MutationReport).
// ---------------------------------------------------------------------------

/** Events.insert: the one POST that can land unseen (timeout-after-create). */
export async function createCalendarEvent(input: {
  readonly apiBase: string;
  readonly accessToken: string;
  readonly calendarId: string;
  readonly body: Record<string, unknown>;
  readonly timeoutMs?: number;
}): Promise<MutationReport> {
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
    const parsed = eventIdStatusOf(answer.body);
    if (parsed === null) {
      // Created but no readable id: uncertain, never a re-POST.
      return { kind: "unknown" };
    }
    return { kind: "applied", eventId: parsed.eventId };
  }
  if (answer.status === 401 || answer.status === 403 || answer.status === 404) {
    // insert is calendar-scoped: the calendar is gone or inaccessible.
    return { kind: "calendar_gone" };
  }
  if (answer.status === 400) {
    return { kind: "definitely_failed" };
  }
  return { kind: "unknown" };
}

/**
 * Events.patch: carries MANAGED FIELDS ONLY. The body is the caller's
 * `updateEventBody` output — this executor sends exactly what it is given
 * and never adds reminders/transparency back. A 404 is the ambiguous
 * event-gone shape (the event was deleted, or the calendar is gone).
 */
export async function updateCalendarEvent(input: {
  readonly apiBase: string;
  readonly accessToken: string;
  readonly calendarId: string;
  readonly eventId: string;
  readonly body: Record<string, unknown>;
  readonly timeoutMs?: number;
}): Promise<MutationReport> {
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
  return mutateOutcomeOf(answer.status);
}

/** Events.delete: 404 is the idempotent already-gone answer. */
export async function deleteCalendarEvent(input: {
  readonly apiBase: string;
  readonly accessToken: string;
  readonly calendarId: string;
  readonly eventId: string;
  readonly timeoutMs?: number;
}): Promise<MutationReport> {
  const answer = await boundedFetch(
    `${apiRoot(input.apiBase, input.calendarId)}/${encodeURIComponent(input.eventId)}`,
    { method: "DELETE", headers: { authorization: `Bearer ${input.accessToken}` } },
    input.timeoutMs ?? EVENTS_HTTP_TIMEOUT_MS,
  );
  return mutateOutcomeOf(answer.status);
}

/** The status->report mapping the patch/delete legs share. */
function mutateOutcomeOf(status: number): MutationReport {
  if (status === 200 || status === 204) {
    return { kind: "applied" };
  }
  if (status === 404) {
    return { kind: "gone" };
  }
  if (status === 401 || status === 403) {
    return { kind: "calendar_gone" };
  }
  if (status === 400) {
    return { kind: "definitely_failed" };
  }
  return { kind: "unknown" };
}

// ---------------------------------------------------------------------------
// Observation legs (Events.list / get -> ObservationResult).
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
}): Promise<ObservationResult> {
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
      return { kind: "unknown" };
    }
    const items = (answer.body as Record<string, unknown>).items;
    if (!Array.isArray(items)) {
      return { kind: "unknown" };
    }
    const found = items.find(
      (item): item is Record<string, unknown> =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as Record<string, unknown>).id === "string",
    );
    if (found === undefined) {
      return { kind: "empty" };
    }
    const status = found.status;
    return {
      kind: "present",
      eventId: found.id as string,
      status: status === "cancelled" ? "cancelled" : "confirmed",
      managed: managedFieldsOfBody(found),
    };
  }
  if (answer.status === 401 || answer.status === 403 || answer.status === 404) {
    // The LIST is calendar-scoped: any of these means the dedicated
    // calendar itself is gone or inaccessible (Google documents 404 for
    // both nonexistent and inaccessible calendars).
    return { kind: "calendar_gone" };
  }
  return { kind: "unknown" };
}

/**
 * Events.get on one known remote id, with the 404 ambiguity resolved
 * inline by ONE bounded list (a read; it cannot duplicate an effect):
 * the calendar answering the list proves the EVENT is gone; the list
 * itself 404ing escalates to `calendar_gone`.
 */
export async function observeEventById(input: {
  readonly apiBase: string;
  readonly accessToken: string;
  readonly calendarId: string;
  readonly eventId: string;
  /** The copy's semantic id (the disambiguating list's filter). */
  readonly semanticId: string;
  readonly timeoutMs?: number;
}): Promise<ObservationResult> {
  const answer = await boundedFetch(
    `${apiRoot(input.apiBase, input.calendarId)}/${encodeURIComponent(input.eventId)}`,
    { method: "GET", headers: { authorization: `Bearer ${input.accessToken}` } },
    input.timeoutMs ?? EVENTS_HTTP_TIMEOUT_MS,
  );
  if (answer.status === 200) {
    const parsed = eventIdStatusOf(answer.body);
    if (parsed === null) {
      return { kind: "unknown" };
    }
    return {
      kind: "present",
      eventId: parsed.eventId,
      status: parsed.status === "cancelled" ? "cancelled" : "confirmed",
      managed: managedFieldsOfBody(
        typeof answer.body === "object" && answer.body !== null
          ? (answer.body as Record<string, unknown>)
          : {},
      ),
    };
  }
  if (answer.status === 404) {
    return await listEventsBySemanticId({
      apiBase: input.apiBase,
      accessToken: input.accessToken,
      calendarId: input.calendarId,
      semanticId: input.semanticId,
      ...(input.timeoutMs === undefined ? {} : { timeoutMs: input.timeoutMs }),
    });
  }
  if (answer.status === 401 || answer.status === 403) {
    return { kind: "calendar_gone" };
  }
  return { kind: "unknown" };
}

/** Extracts the managed fields one observed event body carries. */
export function managedFieldsOfBody(body: Record<string, unknown>): ManagedFields {
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
