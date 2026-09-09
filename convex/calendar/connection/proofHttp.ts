/**
 * The G1 guarded proof-fixture HTTP surface (dev deployment only).
 *
 * Everything the evidence script (tests/g1/live-proof.mjs) needs beyond the
 * production routes lives HERE, beside the fixture vocabulary (./proof.ts),
 * not in the production boundary (./http.ts): a fake Google token endpoint
 * and Calendar API that RECORD THEIR EFFECTS in `externalEffects` before
 * answering (the A3 echo pattern), so the no-duplicate-effect proofs count
 * rows per dedup key, plus guarded reads of the sanitized connection state
 * and the real refresh capability.
 *
 * Same guard as B1's probe: queries and mutations cannot be guarded by
 * deployment variables, so every fixture entry is an HTTP action that
 * checks `KIERO_G1_PROOF_ENABLED === "1"`; on any other deployment the
 * variable is absent and every fixture fails closed 404. Fixture values
 * are constants, never secrets.
 *
 * Routes (wired by the sanctioned append in convex/http.ts):
 * - `POST /calendar/oauth/proof/fake-google/token`
 * - `POST /calendar/oauth/proof/fake-google/api/calendars`
 * - `GET  /calendar/oauth/proof/fake-google/api/calendars/kiero-proof-calendar`
 * - `POST /calendar/oauth/proof/refresh`
 * - `POST /calendar/oauth/proof/state`
 */

import { v } from "convex/values";
import { httpAction, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { errorResult, okResult } from "@kiero/contracts";
import { unsupportedError } from "@kiero/runtime";
import {
  PROOF_CALENDAR_ID,
  PROOF_TIMEOUT_DELAY_MS,
  parseProofCode,
  proofCalendarCreateEffectKey,
  proofEnabled,
  proofTokenEffectKey,
  proofTokenResponse,
  type ProofCalendarBehavior,
  type ProofTokenBehavior,
} from "./proof";

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Records one observable fake-Google effect BEFORE answering (echo). */
export const recordProofEffect = internalMutation({
  args: { dedupKey: v.string(), serviceName: v.string(), payload: v.string() },
  handler: async (ctx, args) => {
    await ctx.db.insert("externalEffects", {
      dedupKey: args.dedupKey,
      serviceName: args.serviceName,
      payload: args.payload,
      receivedAtMs: Date.now(),
    });
  },
});

/** Counts recorded effects per dedup key (the no-duplicate proofs). */
export const countProofEffects = internalQuery({
  args: { dedupKey: v.string() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("externalEffects")
      .withIndex("by_dedup", (q) => q.eq("dedupKey", args.dedupKey))
      .collect();
    return rows.length;
  },
});

/** Sanitized connection-row read for the evidence script (no secrets). */
export const proofConnectionState = internalQuery({
  args: {},
  handler: async (ctx) => {
    const rows = await ctx.db.query("calendarConnections").order("desc").collect();
    return rows.map((row) => ({
      connectionId: row._id,
      userId: row.userId,
      companyId: row.companyId,
      state: row.state,
      googleCalendarId: row.googleCalendarId ?? null,
      googleAccountSubject: row.googleAccountSubject ?? null,
      googleAccountEmail: row.googleAccountEmail ?? null,
      grantedScopes: row.grantedScopes ?? null,
      credentialStorage: row.credentialStorage ?? null,
      credentialCiphertext: row.credentialCiphertext ?? null,
      authorizationMode: row.authorizationMode ?? null,
      reconnectReason: row.reconnectReason ?? null,
      cleanupStatus: row.cleanupStatus ?? null,
      connectedAtMs: row.connectedAtMs ?? null,
      disconnectedAtMs: row.disconnectedAtMs ?? null,
      lastSuccessfulContactMs: row.lastSuccessfulContactMs ?? null,
    }));
  },
});

/** Guard response for disabled fixtures. */
function proofDisabled(): Response {
  return jsonResponse(404, errorResult(unsupportedError("calendar.proof", "proof_guard_disabled")));
}

/**
 * POST /calendar/oauth/proof/fake-google/token — the fake token endpoint.
 * Clearly labeled fixture: real credentials are absent (owner action), so
 * the live proofs exchange against THIS endpoint, which records its effect
 * first and then answers per the code's `t-…`/`r-…` behavior selector.
 */
export const proofFakeTokenEndpoint = httpAction(async (ctx, request) => {
  if (!proofEnabled(process.env)) {
    return proofDisabled();
  }
  const form = new URLSearchParams(await request.text());
  const grantType = form.get("grant_type") ?? "";
  const credential = form.get("code") ?? form.get("refresh_token") ?? "";
  const verifier = form.get("code_verifier") ?? "";
  const parsed = parseProofCode(credential);
  const behavior: ProofTokenBehavior =
    grantType === "refresh_token"
      ? parsed.refreshBehavior === "invalid_grant"
        ? "invalid_grant"
        : parsed.refreshBehavior === "timeout"
          ? "timeout"
          : "ok"
      : parsed.tokenBehavior;
  // The effect (token issued / grant consumed) happens BEFORE the answer.
  await ctx.runMutation(internal.calendar.connection.proofHttp.recordProofEffect, {
    dedupKey: proofTokenEffectKey(`${grantType}:${credential}`),
    serviceName: "g1-proof-fake-google-token",
    payload: JSON.stringify({ grantType, credential, behavior, verifierUsed: verifier.length > 0 }),
  });
  if (behavior === "timeout") {
    await new Promise((resolve) => setTimeout(resolve, PROOF_TIMEOUT_DELAY_MS));
    return jsonResponse(200, { status: "recorded", slow: true });
  }
  const response = proofTokenResponse(behavior, credential, verifier);
  return jsonResponse(response.status, response.body);
});

/** The effect-key subject + behavior the fake Calendar API derives from a bearer token. */
function proofCalendarContext(authorization: string): { effectSubject: string; behavior: ProofCalendarBehavior } {
  const token = authorization.replace(/^Bearer\s+/i, "").replace(/^proof-access-/, "");
  const parsed = parseProofCode(token);
  return {
    // The full proof base (run-scoped) so effect-ledger counts stay per-run.
    effectSubject: `proof-google-${parsed.base}`,
    behavior: parsed.calendarBehavior,
  };
}

/**
 * POST /calendar/oauth/proof/fake-google/api/calendars — the fake Calendar
 * create endpoint. `c-create_timeout` records the creation and then stalls
 * past every caller deadline: the calendar EXISTS while the caller can
 * only record `creation_unknown` (the load-bearing uncertainty case).
 */
export const proofFakeCalendarCreate = httpAction(async (ctx, request) => {
  if (!proofEnabled(process.env)) {
    return proofDisabled();
  }
  const { effectSubject, behavior } = proofCalendarContext(request.headers.get("authorization") ?? "");
  await ctx.runMutation(internal.calendar.connection.proofHttp.recordProofEffect, {
    dedupKey: proofCalendarCreateEffectKey(effectSubject),
    serviceName: "g1-proof-fake-google-calendar",
    payload: JSON.stringify({ behavior, summary: "proof" }),
  });
  if (behavior === "create_timeout") {
    await new Promise((resolve) => setTimeout(resolve, PROOF_TIMEOUT_DELAY_MS));
    return jsonResponse(200, { status: "recorded", slow: true });
  }
  if (behavior === "create_rejected") {
    return jsonResponse(400, { error: "invalid" });
  }
  return jsonResponse(200, { id: PROOF_CALENDAR_ID, summary: "Kiero — proof" });
});

/** GET /calendar/oauth/proof/fake-google/api/calendars/kiero-proof-calendar. */
export const proofFakeCalendarRead = httpAction(async (_ctx, request) => {
  if (!proofEnabled(process.env)) {
    return proofDisabled();
  }
  const { behavior } = proofCalendarContext(request.headers.get("authorization") ?? "");
  if (behavior === "read_timeout") {
    await new Promise((resolve) => setTimeout(resolve, PROOF_TIMEOUT_DELAY_MS));
    return jsonResponse(200, { status: "recorded", slow: true });
  }
  if (behavior === "ambiguous404") {
    return jsonResponse(404, { error: "notFound" });
  }
  return jsonResponse(200, { id: PROOF_CALENDAR_ID, summary: "Kiero — proof" });
});

/**
 * POST /calendar/oauth/proof/refresh — the guarded entry that runs the REAL
 * credential capability action (one bounded refresh attempt) for the
 * evidence script. Dev proof deployments only.
 */
export const proofRefreshHandler = httpAction(async (ctx, request) => {
  if (!proofEnabled(process.env)) {
    return proofDisabled();
  }
  let body: { connectionId?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  if (typeof body.connectionId !== "string") {
    return jsonResponse(400, errorResult(unsupportedError("calendar.proof", "connection_id_missing")));
  }
  const outcome = await ctx.runAction(internal.calendar.connection.functions.refreshCredentials, {
    connectionId: body.connectionId,
  });
  return jsonResponse(200, okResult(outcome));
});

/** POST /calendar/oauth/proof/state — sanitized evidence read (guarded). */
export const proofStateHandler = httpAction(async (ctx, request) => {
  if (!proofEnabled(process.env)) {
    return proofDisabled();
  }
  let body: { dedupKey?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  const rows = await ctx.runQuery(internal.calendar.connection.proofHttp.proofConnectionState, {});
  const effectCount =
    typeof body.dedupKey === "string" && body.dedupKey.length > 0
      ? await ctx.runQuery(internal.calendar.connection.proofHttp.countProofEffects, { dedupKey: body.dedupKey })
      : null;
  const value: Record<string, unknown> = { connections: rows };
  if (effectCount !== null) {
    value.effectCount = effectCount;
  }
  return jsonResponse(200, okResult(value));
});
