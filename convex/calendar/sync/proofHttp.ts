/**
 * The G3 guarded proof-fixture HTTP surface (dev deployment only): G1's
 * clearly-labeled fake Google, extended with the Calendar EVENTS API and
 * a user-action simulator.
 *
 * Everything the evidence script (tests/g3/live-proof.mjs) needs beyond
 * the production routes lives HERE, in G3's owned module, beside its
 * proof vocabulary — G1's fixture files are not edited. The same guard as
 * G1's fake (`KIERO_G1_PROOF_ENABLED === "1"`): these are HTTP actions
 * that check the deployment variable; on any other deployment every entry
 * fails closed 404. Fixture values are constants, never secrets.
 *
 * The fake RECORDS ITS EFFECTS in `externalEffects` before answering (the
 * A3 echo pattern), so the no-duplicate-effect proofs count rows per
 * dedup key: a create that stalls past the caller deadline EXISTS while
 * the caller can only record `unknown` — exactly the load-bearing
 * uncertainty case. Event state lives in the `calendarProofEvents` table
 * (G3's proof-only store).
 *
 * Behavior selectors ride the ACCESS TOKEN (G1's pattern:
 * `proof-code-<run>-<account>!e-…`): `e-create_timeout`,
 * `e-update_timeout`, `e-delete_timeout`, `e-observe_timeout`,
 * `e-calendar_gone`. The boss acting IN Google (edit/delete/move) is
 * simulated by the guarded admin route.
 *
 * Routes (wired by the sanctioned append in convex/http.ts):
 * - `POST   /calendar/oauth/proof/fake-google/api/calendars/kiero-proof-calendar/events`
 * - `GET    /calendar/oauth/proof/fake-google/api/calendars/kiero-proof-calendar/events`
 * - `GET|PATCH|DELETE …/kiero-proof-calendar/events/{eventId}` (pathPrefix)
 * - `POST   /calendar/oauth/proof/fake-google/admin/event`
 * - `POST   /calendar/oauth/proof/sync-state` (G3's guarded evidence read)
 */

import { v } from "convex/values";
import { httpAction, internalMutation, internalQuery } from "../../_generated/server";
import type { ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { errorResult, okResult } from "@kiero/contracts";
import { notFoundError, unsupportedError, validationError } from "@kiero/runtime";
import {
  PROOF_CALENDAR_ID,
  PROOF_TIMEOUT_DELAY_MS,
  parseProofCode,
  proofAccountForCode,
  proofEnabled,
} from "../connection/proof";
import { KIERO_SEMANTIC_PROPERTY } from "./cores";

const EVENTS_PREFIX = `/calendar/oauth/proof/fake-google/api/calendars/${PROOF_CALENDAR_ID}/events`;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Guard response for disabled fixtures. */
function proofDisabled(): Response {
  return jsonResponse(404, errorResult(unsupportedError("calendar.g3Proof", "proof_guard_disabled")));
}

/** The fake-account + behavior context one request derives from its token. */
function proofEventContext(authorization: string | null): {
  accountSubject: string;
  behaviors: Set<string>;
} {
  const token = (authorization ?? "").replace(/^Bearer\s+/i, "").replace(/^proof-access-/, "");
  const parsed = parseProofCode(token);
  const account = proofAccountForCode(parsed.base);
  return {
    accountSubject: account.subject,
    behaviors: new Set(
      token
        .split("!")
        .filter((segment) => segment.startsWith("e-")),
    ),
  };
}

/** Records one observable fake-Google effect BEFORE answering (echo). */
async function recordEffect(
  ctx: ActionCtx,
  dedupKey: string,
  payload: unknown,
): Promise<void> {
  await ctx.runMutation(internal.calendar.connection.proofHttp.recordProofEffect, {
    dedupKey,
    serviceName: "g3-proof-fake-google-events",
    payload: JSON.stringify(payload),
  });
}

// ---------------------------------------------------------------------------
// The store (internal functions the HTTP actions call).
// ---------------------------------------------------------------------------

/** Creates one event row; returns the minted proof event id. */
export const proofCreateEvent = internalMutation({
  args: {
    accountSubject: v.string(),
    kieroSemanticId: v.string(),
    eventJson: v.string(),
  },
  handler: async (ctx, args): Promise<string> => {
    const eventId = `proof-evt-${crypto.randomUUID()}`;
    await ctx.db.insert("calendarProofEvents", {
      accountSubject: args.accountSubject,
      calendarId: PROOF_CALENDAR_ID,
      eventId,
      kieroSemanticId: args.kieroSemanticId,
      status: "confirmed",
      eventJson: args.eventJson,
      updatedAtMs: Date.now(),
    });
    return eventId;
  },
});

/** Finds one account's events carrying the semantic id (cancelled included). */
export const proofFindSemantic = internalQuery({
  args: { accountSubject: v.string(), kieroSemanticId: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("calendarProofEvents")
      .withIndex("by_account_semantic", (q) =>
        q.eq("accountSubject", args.accountSubject).eq("kieroSemanticId", args.kieroSemanticId),
      )
      .collect();
    return rows.map((row) => ({
      eventId: row.eventId,
      status: row.status,
      eventJson: row.eventJson,
    }));
  },
});

/** Finds one event row by id. */
export const proofFindEvent = internalQuery({
  args: { eventId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("calendarProofEvents")
      .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
      .first();
    return row === null
      ? null
      : {
          eventId: row.eventId,
          accountSubject: row.accountSubject,
          kieroSemanticId: row.kieroSemanticId,
          status: row.status,
          eventJson: row.eventJson,
        };
  },
});

/** Merges a patch into one event (PATCH semantics; personal fields kept). */
export const proofPatchEvent = internalMutation({
  args: { eventId: v.string(), patchJson: v.string(), status: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("calendarProofEvents")
      .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
      .first();
    if (row === null) {
      return null;
    }
    const merged = { ...JSON.parse(row.eventJson), ...JSON.parse(args.patchJson) };
    await ctx.db.patch(row._id, {
      eventJson: JSON.stringify(merged),
      ...(args.status === undefined ? {} : { status: args.status as "confirmed" | "cancelled" }),
      updatedAtMs: Date.now(),
    });
    return { eventId: row.eventId };
  },
});

/** Deletes one event row (hard delete: the user-delete simulation). */
export const proofDeleteEvent = internalMutation({
  args: { eventId: v.string() },
  handler: async (ctx, args) => {
    const row = await ctx.db
      .query("calendarProofEvents")
      .withIndex("by_event", (q) => q.eq("eventId", args.eventId))
      .first();
    if (row === null) {
      return null;
    }
    await ctx.db.delete(row._id);
    return { eventId: row.eventId };
  },
});

// ---------------------------------------------------------------------------
// The fake Events API.
// ---------------------------------------------------------------------------

/** POST …/events — Events.insert. */
export const proofFakeEventCreate = httpAction(async (ctx, request) => {
  if (!proofEnabled(process.env)) {
    return proofDisabled();
  }
  const { accountSubject, behaviors } = proofEventContext(request.headers.get("authorization"));
  if (behaviors.has("e-calendar_gone")) {
    return jsonResponse(404, { error: { code: 404, message: "Not Found" } });
  }
  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const semanticId = readSemanticProperty(body);
  const eventJson = JSON.stringify({ ...body, status: "confirmed" });
  // The effect (the created event) happens BEFORE the answer — including
  // the timeout behaviors, where the caller can only record `unknown`.
  const eventId = await ctx.runMutation(internal.calendar.sync.proofHttp.proofCreateEvent, {
    accountSubject,
    kieroSemanticId: semanticId,
    eventJson,
  });
  await recordEffect(ctx, `g3-proof-event-create:${accountSubject}:${semanticId}`, {
    eventId,
    behavior: behaviors.has("e-create_timeout") ? "create_timeout" : "ok",
  });
  if (behaviors.has("e-create_timeout")) {
    await new Promise((resolve) => setTimeout(resolve, PROOF_TIMEOUT_DELAY_MS));
    return jsonResponse(200, { status: "recorded", slow: true });
  }
  return jsonResponse(200, { ...body, id: eventId, status: "confirmed" });
});

/** GET …/events?privateExtendedProperty=kiero.semanticId=X — Events.list. */
export const proofFakeEventList = httpAction(async (ctx, request) => {
  if (!proofEnabled(process.env)) {
    return proofDisabled();
  }
  const { accountSubject, behaviors } = proofEventContext(request.headers.get("authorization"));
  if (behaviors.has("e-observe_timeout")) {
    await new Promise((resolve) => setTimeout(resolve, PROOF_TIMEOUT_DELAY_MS));
    return jsonResponse(200, { status: "recorded", slow: true });
  }
  if (behaviors.has("e-calendar_gone")) {
    return jsonResponse(404, { error: { code: 404, message: "Not Found" } });
  }
  const url = new URL(request.url);
  const filter = url.searchParams.get("privateExtendedProperty") ?? "";
  const semanticId = filter.startsWith(`${KIERO_SEMANTIC_PROPERTY}=`)
    ? filter.slice(KIERO_SEMANTIC_PROPERTY.length + 1)
    : "";
  if (semanticId === "") {
    return jsonResponse(400, { error: { code: 400, message: "Bad Request" } });
  }
  const rows = await ctx.runQuery(internal.calendar.sync.proofHttp.proofFindSemantic, {
    accountSubject,
    kieroSemanticId: semanticId,
  });
  await recordEffect(ctx, `g3-proof-event-list:${accountSubject}:${semanticId}`, {
    matches: rows.length,
  });
  return jsonResponse(200, {
    items: rows.map((row) => ({ ...JSON.parse(row.eventJson), id: row.eventId, status: row.status })),
  });
});

/** GET …/events/{eventId} — Events.get (pathPrefix route). */
export const proofFakeEventGet = httpAction(async (ctx, request) => {
  if (!proofEnabled(process.env)) {
    return proofDisabled();
  }
  const { behaviors } = proofEventContext(request.headers.get("authorization"));
  if (behaviors.has("e-observe_timeout")) {
    await new Promise((resolve) => setTimeout(resolve, PROOF_TIMEOUT_DELAY_MS));
    return jsonResponse(200, { status: "recorded", slow: true });
  }
  const eventId = eventIdOf(request.url);
  if (eventId === null) {
    return jsonResponse(400, { error: { code: 400, message: "Bad Request" } });
  }
  const row = await ctx.runQuery(internal.calendar.sync.proofHttp.proofFindEvent, { eventId });
  if (row === null) {
    return jsonResponse(404, { error: { code: 404, message: "Not Found" } });
  }
  return jsonResponse(200, { ...JSON.parse(row.eventJson), id: row.eventId, status: row.status });
});

/** PATCH …/events/{eventId} — Events.patch (pathPrefix route). */
export const proofFakeEventPatch = httpAction(async (ctx, request) => {
  if (!proofEnabled(process.env)) {
    return proofDisabled();
  }
  const { accountSubject, behaviors } = proofEventContext(request.headers.get("authorization"));
  const eventId = eventIdOf(request.url);
  if (eventId === null) {
    return jsonResponse(400, { error: { code: 400, message: "Bad Request" } });
  }
  let patch: Record<string, unknown> = {};
  try {
    patch = (await request.json()) as Record<string, unknown>;
  } catch {
    patch = {};
  }
  // The merge (managed fields, or the boss's personal edits) happens
  // BEFORE the answer; the timeout behavior applies it and stalls.
  const patched = await ctx.runMutation(internal.calendar.sync.proofHttp.proofPatchEvent, {
    eventId,
    patchJson: JSON.stringify(patch),
  });
  if (patched === null) {
    return jsonResponse(404, { error: { code: 404, message: "Not Found" } });
  }
  await recordEffect(ctx, `g3-proof-event-patch:${accountSubject}:${eventId}`, {
    behavior: behaviors.has("e-update_timeout") ? "update_timeout" : "ok",
    fields: Object.keys(patch).sort(),
  });
  if (behaviors.has("e-update_timeout")) {
    await new Promise((resolve) => setTimeout(resolve, PROOF_TIMEOUT_DELAY_MS));
    return jsonResponse(200, { status: "recorded", slow: true });
  }
  return jsonResponse(200, { id: eventId, status: "confirmed" });
});

/** DELETE …/events/{eventId} — Events.delete (pathPrefix route). */
export const proofFakeEventDelete = httpAction(async (ctx, request) => {
  if (!proofEnabled(process.env)) {
    return proofDisabled();
  }
  const { accountSubject, behaviors } = proofEventContext(request.headers.get("authorization"));
  const eventId = eventIdOf(request.url);
  if (eventId === null) {
    return jsonResponse(400, { error: { code: 400, message: "Bad Request" } });
  }
  const deleted = await ctx.runMutation(internal.calendar.sync.proofHttp.proofDeleteEvent, {
    eventId,
  });
  await recordEffect(ctx, `g3-proof-event-delete:${accountSubject}:${eventId}`, {
    behavior: behaviors.has("e-delete_timeout") ? "delete_timeout" : deleted === null ? "already_gone" : "ok",
  });
  if (deleted === null) {
    // Idempotent already-gone answer (Google's documented 404).
    return jsonResponse(404, { error: { code: 404, message: "Not Found" } });
  }
  if (behaviors.has("e-delete_timeout")) {
    await new Promise((resolve) => setTimeout(resolve, PROOF_TIMEOUT_DELAY_MS));
    return jsonResponse(200, { status: "recorded", slow: true });
  }
  return jsonResponse(204, "");
});

// ---------------------------------------------------------------------------
// The user-action simulator (the boss acting in Google's UI).
// ---------------------------------------------------------------------------

/**
 * POST /calendar/oauth/proof/fake-google/admin/event — simulates the boss
 * editing, deleting or moving ONE copy inside Google. The SAME guard as
 * the fake API (dev proof deployments only); it is the evidence script's
 * stand-in for a human hand in Google Calendar:
 *
 * - `edit`: merges `patch` into the event (e.g. a changed summary, or
 *   personally captured reminders the managed update must NOT clobber);
 * - `delete`: removes the event entirely (hard delete, no remnant);
 * - `move`: sets the cancelled remnant — the documented signature of a
 *   copy moved outside the dedicated calendar
 *   (docs/research/google-calendar-reconnect-facts.md).
 */
export const proofFakeAdminEvent = httpAction(async (ctx, request) => {
  if (!proofEnabled(process.env)) {
    return proofDisabled();
  }
  let body: { eventId?: unknown; action?: unknown; patch?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  if (typeof body.eventId !== "string" || typeof body.action !== "string") {
    return jsonResponse(400, errorResult(validationError("event_id_missing")));
  }
  const eventId = body.eventId;
  if (body.action === "edit") {
    const patch =
      typeof body.patch === "object" && body.patch !== null ? (body.patch as Record<string, unknown>) : {};
    const patched = await ctx.runMutation(internal.calendar.sync.proofHttp.proofPatchEvent, {
      eventId,
      patchJson: JSON.stringify(patch),
    });
    if (patched === null) {
      return jsonResponse(404, errorResult(notFoundError("calendarProofEvents")));
    }
    await recordEffect(ctx, `g3-proof-admin-edit:${eventId}`, { fields: Object.keys(patch).sort() });
    return jsonResponse(200, okResult({ eventId, action: "edit" }));
  }
  if (body.action === "delete") {
    const deleted = await ctx.runMutation(internal.calendar.sync.proofHttp.proofDeleteEvent, {
      eventId,
    });
    if (deleted === null) {
      return jsonResponse(404, errorResult(notFoundError("calendarProofEvents")));
    }
    await recordEffect(ctx, `g3-proof-admin-delete:${eventId}`, {});
    return jsonResponse(200, okResult({ eventId, action: "delete" }));
  }
  if (body.action === "move") {
    const moved = await ctx.runMutation(internal.calendar.sync.proofHttp.proofPatchEvent, {
      eventId,
      patchJson: "{}",
      status: "cancelled",
    });
    if (moved === null) {
      return jsonResponse(404, errorResult(notFoundError("calendarProofEvents")));
    }
    await recordEffect(ctx, `g3-proof-admin-move:${eventId}`, {});
    return jsonResponse(200, okResult({ eventId, action: "move" }));
  }
  return jsonResponse(400, errorResult(validationError("action_unknown")));
});

// ---------------------------------------------------------------------------
// The guarded G3 evidence read (sanitized; no secrets).
// ---------------------------------------------------------------------------

/** POST /calendar/oauth/proof/sync-state — G3's sanitized state read. */
export const proofSyncStateHandler = httpAction(async (ctx, request) => {
  const g3Guard = process.env.KIERO_G3_PROOF_ENABLED === "1";
  if (!g3Guard || !proofEnabled(process.env)) {
    return proofDisabled();
  }
  let body: { companyId?: unknown; dedupKey?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  if (typeof body.companyId !== "string") {
    return jsonResponse(400, errorResult(validationError("company_id_missing")));
  }
  // The internal read runs directly (the guard above is this route's);
  // a malformed id fails Convex's id validation loudly.
  const state = await ctx.runQuery(internal.calendar.sync.proof.syncStateInternal, {
    companyId: body.companyId as Id<"companies">,
  });
  const value: Record<string, unknown> = { state };
  if (typeof body.dedupKey === "string" && body.dedupKey.length > 0) {
    value.effectCount = await ctx.runQuery(
      internal.calendar.connection.proofHttp.countProofEffects,
      { dedupKey: body.dedupKey },
    );
  }
  return jsonResponse(200, okResult(value));
});

// ---------------------------------------------------------------------------
// Small helpers.
// ---------------------------------------------------------------------------

/** Reads the private extended property the create body carries. */
function readSemanticProperty(body: Record<string, unknown>): string {
  const extended = body.extendedProperties;
  if (typeof extended !== "object" || extended === null) {
    return "";
  }
  const priv = (extended as Record<string, unknown>).private;
  if (typeof priv !== "object" || priv === null) {
    return "";
  }
  const value = (priv as Record<string, unknown>)[KIERO_SEMANTIC_PROPERTY];
  return typeof value === "string" ? value : "";
}

/** The trailing event id of one pathPrefix-routed URL. */
function eventIdOf(url: string): string | null {
  const path = new URL(url).pathname;
  if (!path.startsWith(`${EVENTS_PREFIX}/`)) {
    return null;
  }
  const tail = path.slice(EVENTS_PREFIX.length + 1);
  return tail.length === 0 || tail.includes("/") ? null : decodeURIComponent(tail);
}
