/**
 * The G1 Calendar OAuth HTTP boundary (Convex deployment site routes).
 *
 * Routes (wired by the sanctioned append in convex/http.ts):
 *
 * - `POST /calendar/oauth/start`: the authorization start. The caller
 *   presents the USER's Convex access token (Authorization header); Convex
 *   verifies it, the canonical chain resolves the user/company scope, and
 *   the response carries the constructed Google authorization URL with the
 *   one-time state and the S256 PKCE challenge. The verifier, the state
 *   hash and every credential stay server-side.
 * - `GET /calendar/oauth/callback`: Google's redirect target (browser
 *   navigation; the single-use state IS the correlation capability). Runs
 *   the full completion protocol: consume state -> re-check membership ->
 *   ONE bounded token exchange -> scope enforcement -> find-or-create the
 *   dedicated calendar -> record the connection. Answers a minimal Polish
 *   HTML status page (barebones; no styling).
 * - `POST /calendar/oauth/callback/complete`: the SAME protocol entered by
 *   the verified Worker bridge (Authorization: Bearer <service
 *   credential>); the gateway's calendar-oauth callback route forwards
 *   Google's query here server-to-server. JSON envelope answers.
 *
 * The guarded proof fixtures (the fake Google endpoints and the sanitized
 * evidence reads) live in ./proofHttp.ts, beside the fixture vocabulary
 * (./proof.ts); their routes are wired by the same convex/http.ts append.
 *
 * Uncertainty semantics (echo template): every external leg is bounded by
 * an explicit deadline; a 5xx, timeout or unreadable success body is
 * UNCERTAIN and only ever records an honest error state — never a blind
 * retry. A timeout after the calendar-create POST is exactly the case the
 * no-blind-duplicate rule exists for.
 */

import { httpAction } from "../../_generated/server";
import type { ActionCtx } from "../../_generated/server";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { errorResult, okResult } from "@kiero/contracts";
import { unauthenticatedError, forbiddenError, unsupportedError } from "@kiero/runtime";
import { verifyServiceBearerToken } from "../../operations/telemetry/serviceToken";
import {
  decideCalendarCreateOutcome,
  decideCalendarReadOutcome,
  decideCalendarStep,
  decideExchangeOutcome,
  type ReconnectReason,
} from "./cores";
import {
  createDedicatedCalendar,
  decodeIdTokenClaims,
  dedicatedCalendarSummary,
  exchangeCodeForTokens,
  readKnownCalendar,
  scopesSatisfied,
  splitScopes,
} from "./protocol";
import { callbackRedirectUri, calendarOAuthConfig } from "./operations";
import { calendarApiBase } from "./functions";
import { sealCredential } from "./credentialStore";

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** Minimal Polish status page (barebones: semantic HTML, no styling). */
function polishStatusPage(title: string, detail: string, status: number): Response {
  const html = `<!doctype html><html lang="pl"><head><meta charset="utf-8"><title>Kiero — Kalendarz</title></head><body><section aria-labelledby="k"><h1 id="k">Kalendarz Kiero w Google</h1><p role="status">${title}</p><p>${detail}</p><p><a href="/">Wróć do Kiero</a></p></section></body></html>`;
  return new Response(html, {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

function originOf(request: Request): string {
  return new URL(request.url).origin;
}

// ---------------------------------------------------------------------------
// POST /calendar/oauth/start
// ---------------------------------------------------------------------------

/**
 * The authorization start. Identity comes ONLY from the verified Convex
 * token (ctx.auth at the HTTP boundary); the company scope from the
 * canonical chain. The response never contains the verifier or state hash.
 */
export const calendarStartHandler = httpAction(async (ctx, request) => {
  const identity = await ctx.auth.getUserIdentity();
  if (identity === null) {
    return jsonResponse(401, errorResult(unauthenticatedError("no_verified_identity")));
  }
  const resolved = await ctx.runQuery(
    internal.calendar.connection.functions.resolveSubjectContext,
    { subject: identity.subject },
  );
  if (resolved === null) {
    // A verified person without an active firm has no company scope for a
    // connection (sign-in alone never confers it — same rule as B3).
    return jsonResponse(403, errorResult(forbiddenError("no_company_scope", "company")));
  }
  let body: { mode?: unknown; acknowledgeUnknownCreation?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    body = {};
  }
  const mode =
    body.mode === "switch" || body.mode === "recreate" ? body.mode : "connect";
  const acknowledgeUnknownCreation = body.acknowledgeUnknownCreation === true;
  const result = await ctx.runMutation(
    internal.calendar.connection.operations.startFlowTransaction,
    {
      userId: resolved.userId,
      companyId: resolved.companyId,
      mode,
      acknowledgeUnknownCreation,
      redirectUri: callbackRedirectUri(process.env, originOf(request)),
    },
  );
  return jsonResponse(result._tag === "ok" ? 200 : 409, result);
});

// ---------------------------------------------------------------------------
// The callback protocol (GET browser leg + POST bridge leg).
// ---------------------------------------------------------------------------

/** One completion's terminal view for the response surfaces (no secrets). */
interface CallbackAnswer {
  readonly status: number;
  readonly ok: boolean;
  readonly code: string;
  readonly polishTitle: string;
  readonly polishDetail: string;
}

/**
 * The page vocabulary: every machine reconnect reason plus the two
 * flow-level codes the callback surfaces. Keyed by the closed union so a
 * missing reason page is a COMPILE error, never a silent fallback (the
 * schema's reconnectReason union and ./cores RECONNECT_REASONS are the
 * vocabulary).
 */
type AnswerCode = ReconnectReason | "invalid_state" | "google_client_not_configured";

const ANSWERS: Record<AnswerCode, CallbackAnswer> = {
  invalid_state: {
    status: 400,
    ok: false,
    code: "invalid_state",
    polishTitle: "Nieprawidłowe połączenie.",
    polishDetail: "Ten link wygasł albo został już użyty. Zacznij połączenie od nowa w Kiero.",
  },
  authorization_expired: {
    status: 400,
    ok: false,
    code: "authorization_expired",
    polishTitle: "Upłynął czas na połączenie.",
    polishDetail: "Rozpocznij połączenie kalendarza od nowa w Kiero.",
  },
  membership_lost: {
    status: 403,
    ok: false,
    code: "membership_lost",
    polishTitle: "Brak dostępu do firmy.",
    polishDetail: "Twoje członkostwo w tej firmie zostało cofnięte, więc połączenia kalendarza nie można dokończyć.",
  },
  authorization_denied: {
    status: 400,
    ok: false,
    code: "authorization_denied",
    polishTitle: "Nie udostępniono kalendarza.",
    polishDetail: "Zgoda w Google nie została udzielona. Możesz spróbować ponownie w Kiero.",
  },
  // Upstream (Google-leg) outcomes answer 200 with the typed result in the
  // payload: the Cloudflare edge in front of *.convex.site replaces origin
  // 502/504 bodies with its own error page (verified live), which would hide
  // the honest Polish page and JSON envelope from the user.
  exchange_failed: {
    status: 200,
    ok: false,
    code: "exchange_failed",
    polishTitle: "Google odrzucił połączenie.",
    polishDetail: "Wymiana uprawnienia nie powiodła się. Spróbuj połączyć kalendarz ponownie w Kiero.",
  },
  exchange_unknown: {
    status: 200,
    ok: false,
    code: "exchange_unknown",
    polishTitle: "Wynik połączenia jest niepewny.",
    polishDetail: "Odpowiedź Google nie dotarła w całości. Kiero nie powtórzy wymiany automatycznie — spróbuj ponownie w Kiero.",
  },
  scopes_missing: {
    status: 400,
    ok: false,
    code: "scopes_missing",
    polishTitle: "Brak wymaganych uprawnień.",
    polishDetail: "Kiero potrzebuje zgody wyłącznie na własny kalendarz Kiero. Połącz ponownie i zostaw wymagane uprawnienia.",
  },
  creation_failed: {
    status: 200,
    ok: false,
    code: "creation_failed",
    polishTitle: "Nie udało się utworzyć kalendarza.",
    polishDetail: "Google odmówił utworzenia kalendarza Kiero. Spróbuj ponownie w Kiero.",
  },
  creation_unknown: {
    status: 200,
    ok: false,
    code: "creation_unknown",
    polishTitle: "Wynik tworzenia kalendarza jest niepewny.",
    polishDetail: "Kalendarz mógł zostać utworzony, ale odpowiedź Google nie dotarła. Kiero nie utworzy drugiego kalendarza automatycznie — wróć do Kiero i zdecyduj o ponownej próbie.",
  },
  calendar_access_lost: {
    status: 409,
    ok: false,
    code: "calendar_access_lost",
    polishTitle: "Kalendarz Kiero jest niedostępny.",
    polishDetail: "Zapisany kalendarz nie odpowiada (mógł zostać usunięty). Jeśli na pewno go usunąłeś, użyj opcji Odtwórz w Kiero.",
  },
  calendar_read_unknown: {
    status: 200,
    ok: false,
    code: "calendar_read_unknown",
    polishTitle: "Stan kalendarza jest niepewny.",
    polishDetail: "Odpowiedź Google nie dotarła w całości. Kiero nie utworzy drugiego kalendarza automatycznie — spróbuj ponownie w Kiero.",
  },
  refresh_failed: {
    status: 200,
    ok: false,
    code: "refresh_failed",
    polishTitle: "Google cofnął dostęp do kalendarza.",
    polishDetail: "Połączenie zostało zatrzymane. Połącz kalendarz ponownie w Kiero.",
  },
  google_client_not_configured: {
    status: 200,
    ok: false,
    code: "google_client_not_configured",
    polishTitle: "Połączenie z Google nie jest skonfigurowane.",
    polishDetail: "Administrator Kiero musi jeszcze uzupełnić dane klienta Google OAuth dla tego środowiska.",
  },
};

function answerFor(code: AnswerCode): CallbackAnswer {
  return ANSWERS[code];
}

/**
 * The one calendar-creation leg (find-or-create's "create" half): reads the
 * company name for the dedicated calendar's summary, performs ONE bounded
 * create POST, and maps the outcome onto the lifecycle — `creation_unknown`
 * never triggers a blind second POST. Both create paths (no known calendar,
 * and the recreate decision after an ambiguous read) run exactly this.
 */
async function createDedicatedCalendarLeg(
  ctx: ActionCtx,
  input: {
    readonly apiBase: string;
    readonly accessToken: string;
    readonly companyId: Id<"companies">;
  },
): Promise<{ calendarId: string | null; failure: ReconnectReason | null }> {
  const companyName = await ctx.runQuery(internal.calendar.connection.functions.companyNameFor, {
    companyId: input.companyId,
  });
  const create = await createDedicatedCalendar({
    apiBase: input.apiBase,
    accessToken: input.accessToken,
    summary: dedicatedCalendarSummary(companyName ?? "Kiero"),
  });
  const decision = decideCalendarCreateOutcome(create);
  return decision.kind === "created"
    ? { calendarId: decision.calendarId, failure: null }
    : { calendarId: null, failure: decision.reason };
}

/** The full callback protocol; shared by the browser and bridge entries. */
async function runCallbackProtocol(
  ctx: ActionCtx,
  params: { state: string; code: string | null; error: string | null },
  requestOrigin: string,
): Promise<CallbackAnswer & { connected: boolean }> {
  const redirectUri = callbackRedirectUri(process.env, requestOrigin);
  const prepared = await ctx.runMutation(
    internal.calendar.connection.operations.prepareCallbackTransaction,
    { state: params.state, redirectUri },
  );
  if (prepared.status === "invalid_state") {
    return { ...answerFor("invalid_state"), connected: false };
  }
  if (prepared.status === "finish_error") {
    return { ...answerFor(prepared.reason), connected: false };
  }
  const config = calendarOAuthConfig(process.env);

  // Google reported the user denied (or otherwise failed) consent.
  if (params.error !== null) {
    await ctx.runMutation(internal.calendar.connection.operations.completeCallbackTransaction, {
      connectionId: prepared.flow.connectionId,
      completion: { kind: "error", reason: "authorization_denied" },
    });
    return { ...answerFor("authorization_denied"), connected: false };
  }
  if (params.code === null) {
    await ctx.runMutation(internal.calendar.connection.operations.completeCallbackTransaction, {
      connectionId: prepared.flow.connectionId,
      completion: { kind: "error", reason: "exchange_failed" },
    });
    return { ...answerFor("exchange_failed"), connected: false };
  }
  if (config.clientId === null || config.clientSecret === null) {
    await ctx.runMutation(internal.calendar.connection.operations.completeCallbackTransaction, {
      connectionId: prepared.flow.connectionId,
      completion: { kind: "error", reason: "exchange_failed" },
    });
    return { ...answerFor("google_client_not_configured"), connected: false };
  }

  // ONE bounded exchange; uncertain outcomes never retry.
  const exchange = await exchangeCodeForTokens({
    tokenEndpoint: config.tokenEndpoint,
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    code: params.code,
    redirectUri: prepared.flow.redirectUri,
    verifier: prepared.flow.verifier,
  });
  const exchangeDecision = decideExchangeOutcome(
    exchange.kind === "granted"
      ? {
          kind: "granted",
          grant: exchange.grant,
          scopesSatisfied: scopesSatisfied(splitScopes(exchange.grant.grantedScope)),
        }
      : { kind: "failed", failure: exchange.failure },
  );
  if (!exchangeDecision.proceed) {
    const reason = exchangeDecision.outcome.kind === "error" ? exchangeDecision.outcome.reason : "exchange_failed";
    await ctx.runMutation(internal.calendar.connection.operations.completeCallbackTransaction, {
      connectionId: prepared.flow.connectionId,
      completion: { kind: "error", reason },
    });
    return { ...answerFor(reason), connected: false };
  }
  const grant = exchangeDecision.grant;
  const claims = grant.idToken === null ? null : decodeIdTokenClaims(grant.idToken);
  if (claims === null) {
    await ctx.runMutation(internal.calendar.connection.operations.completeCallbackTransaction, {
      connectionId: prepared.flow.connectionId,
      completion: { kind: "error", reason: "exchange_failed" },
    });
    return { ...answerFor("exchange_failed"), connected: false };
  }

  // Find-or-create the dedicated calendar (never a blind second create).
  const step = decideCalendarStep({
    googleCalendarId: prepared.flow.knownCalendarId,
    googleAccountSubject: prepared.flow.knownGoogleSubject,
    verifiedGoogleSubject: claims.subject,
  });
  const apiBase = calendarApiBase(process.env);
  let calendarId: string | null = null;
  let calendarReused = false;
  let failure: ReconnectReason | null = null;

  if (step.kind === "verify_known") {
    const read = await readKnownCalendar({ apiBase, accessToken: grant.accessToken, calendarId: step.calendarId });
    const decision = decideCalendarReadOutcome(read, prepared.flow.mode);
    if (decision.kind === "reuse") {
      calendarId = step.calendarId;
      calendarReused = true;
    } else if (decision.kind === "create") {
      ({ calendarId, failure } = await createDedicatedCalendarLeg(ctx, {
        apiBase,
        accessToken: grant.accessToken,
        companyId: prepared.flow.companyId,
      }));
    } else {
      failure = decision.reason;
    }
  } else {
    ({ calendarId, failure } = await createDedicatedCalendarLeg(ctx, {
      apiBase,
      accessToken: grant.accessToken,
      companyId: prepared.flow.companyId,
    }));
  }

  if (calendarId === null) {
    await ctx.runMutation(internal.calendar.connection.operations.completeCallbackTransaction, {
      connectionId: prepared.flow.connectionId,
      completion: { kind: "error", reason: failure ?? "creation_unknown" },
      googleAccountSubject: claims.subject,
      ...(claims.email === null ? {} : { googleAccountEmail: claims.email }),
    });
    return { ...answerFor(failure ?? "creation_unknown"), connected: false };
  }

  // The action holds the raw tokens; it seals them HERE (the deployment
  // key) so only the sealed bundle crosses into the recording mutation
  // (Convex records function arguments; raw tokens must never appear there).
  const nowMs = Date.now();
  const sealed = await sealCredential(
    {
      accessToken: grant.accessToken,
      refreshToken: grant.refreshToken,
      accessTokenExpiresAtMs: nowMs + grant.expiresInSeconds * 1000,
      obtainedAtMs: nowMs,
    },
    process.env,
  );
  const applied = await ctx.runMutation(internal.calendar.connection.operations.completeCallbackTransaction, {
    connectionId: prepared.flow.connectionId,
    completion: { kind: "connected", calendarId, calendarReused },
    credentialStorage: sealed.storage,
    credentialCiphertext: sealed.ciphertext,
    accessTokenExpiresAtMs: nowMs + grant.expiresInSeconds * 1000,
    googleAccountSubject: claims.subject,
    ...(claims.email === null ? {} : { googleAccountEmail: claims.email }),
    grantedScope: grant.grantedScope,
  });
  if (!applied.ok) {
    // The terminal write lost the race (disconnect during the external
    // legs): the disconnect wins, nothing was recorded.
    return { ...answerFor("invalid_state"), connected: false };
  }
  return {
    status: 200,
    ok: true,
    code: "connected",
    polishTitle: "Kalendarz Kiero jest połączony.",
    polishDetail: calendarReused
      ? `Połączono z istniejącym kalendarzem Kiero na koncie ${claims.email ?? "Google"}.`
      : `Utworzono kalendarz Kiero na koncie ${claims.email ?? "Google"}.`,
    connected: true,
  };
}

/** GET /calendar/oauth/callback — Google's browser redirect target. */
export const calendarCallbackHandler = httpAction(async (ctx, request) => {
  const url = new URL(request.url);
  const state = url.searchParams.get("state") ?? "";
  const code = url.searchParams.get("code");
  const error = url.searchParams.get("error");
  if (state.length === 0) {
    return polishStatusPage(
      "Nieprawidłowe połączenie.",
      "Ten link jest niekompletny. Zacznij połączenie od nowa w Kiero.",
      400,
    );
  }
  const answer = await runCallbackProtocol(ctx, { state, code, error }, originOf(request));
  return polishStatusPage(answer.polishTitle, answer.polishDetail, answer.status);
});

/** POST /calendar/oauth/callback/complete — the verified bridge entry. */
export const calendarCallbackCompleteHandler = httpAction(async (ctx, request) => {
  const authorized = await verifyServiceBearerToken(
    request.headers.get("authorization"),
    process.env.KIERO_SERVICE_TOKEN,
  );
  if (!authorized) {
    return jsonResponse(401, errorResult(unauthenticatedError("service_credential_invalid")));
  }
  let body: { state?: unknown; code?: unknown; error?: unknown } = {};
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse(400, errorResult(unsupportedError("calendar.oauth", "body_not_json")));
  }
  const state = typeof body.state === "string" ? body.state : "";
  if (state.length === 0) {
    return jsonResponse(400, errorResult(unsupportedError("calendar.oauth", "state_missing")));
  }
  const answer = await runCallbackProtocol(
    ctx,
    {
      state,
      code: typeof body.code === "string" ? body.code : null,
      error: typeof body.error === "string" ? body.error : null,
    },
    originOf(request),
  );
  return jsonResponse(
    answer.status,
    okResult({ code: answer.code, connected: answer.connected }),
  );
});
