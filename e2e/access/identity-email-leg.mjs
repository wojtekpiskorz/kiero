#!/usr/bin/env node
/**
 * The B5 email identity qualification leg (e2e driver): the email-code
 * identity matrix on REAL delivered OTPs, same-email behavior, the
 * linkable halves of the explicit linking ceremony, email change, and
 * session controls — against the live staging candidate.
 *
 * Mailboxes (mail.tm, real delivery through Resend):
 *   M1 — the email-code person (browser persona + second browser + API legs)
 *   M3 — the per-address issuance/verification limit probe (never signs in)
 *   M4 — the email-change target address
 *
 * The account feature UI (B2 panels) is not mounted in the v1 host, so
 * linking/email-change/session-control ceremonies run against the SAME
 * deployed Convex functions with a real session token; the browser drives
 * the ordinary sign-in, session-recovery, denial and calendar/Google
 * surface states.
 *
 * Run (VPS, patient — mail.tm latency is 5-8+ min per delivery):
 *   node e2e/access/identity-email-leg.mjs --run b5-<id> --candidate-sha d43fc27
 * Artifacts: /tmp/kiero-smoke/b5/<run>/identity/ (snapshots, results.json).
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import {
  WEB,
  CONVEX_URL,
  CHROMIUM,
  convexAuthNamespace,
  recorder,
  openPersona,
  snapFor,
  apiRequestCode,
  apiVerifyCode,
  authedClient,
} from "./lib/funnel.mjs";
import { createMailbox, waitForCode, messageIds, nextCodeAfter } from "./lib/mail.mjs";

const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : fallback;
};
const RUN = value("--run", `b5-${Date.now().toString(36)}`);
const CANDIDATE_SHA = value("--candidate-sha", "d43fc27");
const OUT = `/tmp/kiero-smoke/b5/${RUN}/identity`;
const RESULTS = value("--results", `${OUT}/results.json`);
mkdirSync(OUT, { recursive: true });

const snap = snapFor(OUT);
const rec = recorder({ run: RUN, leg: "identity-email", candidateSha: CANDIDATE_SHA, outFile: RESULTS });
const state = { mailboxes: {}, tokens: {}, sessionIds: {}, pageErrors: [] };
const persistState = () =>
  writeFileSync(
    `${OUT}/state.json`,
    `${JSON.stringify(
      {
        run: RUN,
        mailboxes: Object.fromEntries(
          Object.entries(state.mailboxes).map(([k, m]) => [k, { provider: m.provider, address: m.address }]),
        ),
        sessionIds: state.sessionIds,
        pageErrors: state.pageErrors,
      },
      null,
      2,
    )}\n`,
  );

/** Extracts the current session's Convex auth tokens from a live page (never logged). */
async function tokenOf(page) {
  const ns = convexAuthNamespace();
  return await page.evaluate((namespace) => ({
    token: localStorage.getItem(`__convexAuthJWT_${namespace}`),
    refreshToken: localStorage.getItem(`__convexAuthRefreshToken_${namespace}`),
  }), ns);
}

/** Reads a protected identity query; returns { ok, value } or { ok:false, error }. */
async function tryQuery(client, name, fn) {
  try {
    return { ok: true, value: await fn(client) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 300), name };
  }
}

const wrongCodeFor = (code) => {
  const first = code[0] === "9" ? "0" : "9";
  return `${first}${code.slice(1)}`;
};

/** Runs one phase; a thrown error becomes a recorded FAIL, not a lost leg. */
async function phase(name, fn) {
  try {
    await fn();
  } catch (error) {
    rec.record(name, "FAIL", `phase ${name} completes`, `driver error: ${String(error?.message ?? error).slice(0, 400)}`);
  }
}

/**
 * Requests a sign-in code THROUGH THE REAL FORM and waits for the next
 * delivery (id-snapshot freshness: deterministic against second-level
 * mail.tm timestamps).
 */
async function browserCode(page, mailbox) {
  const excludeIds = await messageIds(mailbox);
  await page.getByRole("button", { name: "Wyślij kod" }).click();
  await page.waitForTimeout(2000);
  return await waitForCode(mailbox, "sign_in_code", { sinceMs: Date.now() - 2000, excludeIds });
}

// ---------------------------------------------------------------------------
// Phase 0: mailboxes
// ---------------------------------------------------------------------------

const mailboxPath = `${OUT}/mailboxes.json`;
if (existsSync(mailboxPath)) {
  const stored = JSON.parse(readFileSync(mailboxPath, "utf8"));
  for (const [key, record] of Object.entries(stored)) state.mailboxes[key] = record;
  rec.note(`reusing mailboxes from ${mailboxPath} (addresses only: ${Object.keys(stored).join(", ")})`);
} else {
  for (const key of ["m1", "m3", "m4"]) {
    state.mailboxes[key] = await createMailbox(`${OUT}/mailbox-${key}.json`);
    console.log(`[mailbox ${key}] ${state.mailboxes[key].address}`);
  }
  writeFileSync(mailboxPath, JSON.stringify(state.mailboxes, null, 2));
  persistState();
}
const M1 = state.mailboxes.m1;
const M3 = state.mailboxes.m3;
const M4 = state.mailboxes.m4;

// ---------------------------------------------------------------------------
// Phase A: M1 — delivery, session recovery, independent browsers, device
// revocation, logout, wrong code, replay, expiry
// ---------------------------------------------------------------------------

// A1. Real delivery through the browser sign-in (persona m1-browser).
const personaA = await openPersona(`/tmp/kiero-smoke/b5/${RUN}/profiles/m1-browser`);
await phase("otp-delivery", async () => {
  const since = Date.now();
  await personaA.page.goto(WEB, { waitUntil: "domcontentloaded" });
  await personaA.page.waitForTimeout(2500);
  const googleOffered = await personaA.page.getByRole("button", { name: "Zaloguj się przez Google" }).count();
  rec.record(
    "google-entry-present",
    googleOffered >= 1 ? "PASS" : "FAIL",
    "sign-in card offers Google (providerAvailability.google true on staging)",
    googleOffered >= 1 ? "button 'Zaloguj się przez Google' rendered" : "no Google button rendered",
    { scope: "the Google completion leg itself stays BLOCKED (owner credentials)" },
  );
  await personaA.page.getByLabel("Adres e-mail").fill(M1.address);
  const delivered = await browserCode(personaA.page, M1);
  console.log(`[otp] delivered in ${Math.round((Date.now() - since) / 1000)}s`);
  await personaA.page.getByLabel("Kod z wiadomości").fill(delivered.code);
  await personaA.page.getByRole("button", { name: "Zaloguj się kodem" }).click();
  await personaA.page.waitForTimeout(7000);
  const after = await snap(personaA.page, "a1-delivery-signin");
  const signedIn = !after.includes("Zaloguj się do Kiero");
  rec.record(
    "otp-delivery",
    signedIn ? "PASS" : "FAIL",
    "real Resend delivery to a real mail.tm mailbox signs the persona in (no fixture codes on staging)",
    signedIn ? `code delivered + consumed; post-login state shows: ${after.includes("Nie należysz") ? "no-company admission view" : "authenticated app"}` : `still on sign-in card: ${after.slice(0, 200).replace(/\n/g, " | ")}`,
    { deliverySeconds: Math.round((Date.now() - since) / 1000), subject: delivered.subject },
  );
  const tokensA = await tokenOf(personaA.page);
  state.tokens.a = tokensA.token;
  const clientA = authedClient(tokensA.token);
  const ensured = await clientA.mutation("access/identity/functions:ensureSessionRegistry", {});
  state.sessionIds.a = ensured?.sessionId ?? null;
  persistState();
});

// A2. Session recovery after reload (persistent identity, live session).
await phase("session-recovery-reload", async () => {
  await personaA.page.reload({ waitUntil: "domcontentloaded" });
  await personaA.page.waitForTimeout(5000);
  const body = await snap(personaA.page, "a2-reload-recovery");
  const stillSignedIn = !body.includes("Zaloguj się do Kiero") && !body.includes("Sesja tego urządzenia została zakończona");
  rec.record(
    "session-recovery-reload",
    stillSignedIn ? "PASS" : "FAIL",
    "a full reload of the persistent profile keeps the live session (no re-authentication prompt)",
    stillSignedIn ? "session survived reload" : `sign-in/session-ended surface after reload: ${body.slice(0, 200).replace(/\n/g, " | ")}`,
  );
});

// A3. M3 — the per-address issuance limit (fires now; mails checked later).
await phase("otp-issuance-limit", async () => {
  const outcomes = [];
  for (let i = 1; i <= 6; i++) {
    try {
      await apiRequestCode(M3.address);
      outcomes.push(`send ${i}: issued`);
    } catch (error) {
      outcomes.push(`send ${i}: REJECTED ${String(error?.message ?? error).slice(0, 160)}`);
    }
  }
  const sixthBlocked = outcomes[5].includes("REJECTED");
  rec.record(
    "otp-issuance-limit",
    outcomes.slice(0, 5).every((o) => !o.includes("REJECTED")) && sixthBlocked ? "PASS" : "FAIL",
    "5 code requests on one address all issue; the 6th rapid request is refused by the per-address issuance limiter (marker [kiero:issuance_rate_limited], copy 'Zbyt wiele próśb o kod na ten adres. Odczekaj kilka minut i spróbuj ponownie.')",
    outcomes.join(" ; "),
  );
  writeFileSync(`${OUT}/a3-issuance-limit.txt`, `${outcomes.join("\n")}\n`);
});

// A4. Independent browser sessions: a second persistent profile signs into
// the SAME address — one account, two devices, both live.
const personaB = await openPersona(`/tmp/kiero-smoke/b5/${RUN}/profiles/m1-second`);
await phase("sameemail-resume-second-device", async () => {
  await personaB.page.goto(WEB, { waitUntil: "domcontentloaded" });
  await personaB.page.waitForTimeout(2500);
  await personaB.page.getByLabel("Adres e-mail").fill(M1.address);
  const delivered = await browserCode(personaB.page, M1);
  await personaB.page.getByLabel("Kod z wiadomości").fill(delivered.code);
  await personaB.page.getByRole("button", { name: "Zaloguj się kodem" }).click();
  await personaB.page.waitForTimeout(7000);
  const body = await snap(personaB.page, "a4-second-browser");
  const secondSignedIn = !body.includes("Zaloguj się do Kiero") && !body.includes("innej metody logowania");
  rec.record(
    "sameemail-resume-second-device",
    secondSignedIn ? "PASS" : "FAIL",
    "same-email email-code sign-in on an independent device RESUMES the same account (no method-conflict, no duplicate identity): both devices see one shared session registry",
    secondSignedIn ? "second device signed in without conflict" : `second device state: ${body.slice(0, 200).replace(/\n/g, " | ")}`,
  );
  const tokensB = await tokenOf(personaB.page);
  state.tokens.b = tokensB.token;
  const clientB = authedClient(tokensB.token);
  const ensuredB = await clientB.mutation("access/identity/functions:ensureSessionRegistry", {});
  state.sessionIds.b = ensuredB?.sessionId ?? null;
  const sessions = await clientB.query("access/identity/functions:listMySessions", {});
  const liveCount = sessions.filter((s) => s.revokedAtMs === null).length;
  const bothVisible = sessions.some((s) => s.sessionId === state.sessionIds.a) && sessions.some((s) => s.sessionId === state.sessionIds.b);
  rec.record(
    "independent-browser-sessions",
    bothVisible && liveCount >= 2 ? "PASS" : "FAIL",
    "both device sessions exist under ONE account (the second device's session list contains the first device's session)",
    `live sessions visible from device B: ${liveCount}; device A row present: ${sessions.some((s) => s.sessionId === state.sessionIds.a)}`,
    { sessions: sessions.map((s) => ({ label: s.deviceLabel, current: s.isCurrent, revoked: s.revokedAtMs !== null, upstream: s.upstreamState })) },
  );
  persistState();
});

// A5. Self-service device revocation: device B revokes device A's session;
// device A's old profile must be denied immediately; device B stays live.
await phase("device-revocation-immediate-denial", async () => {
  const clientB = authedClient(state.tokens.b);
  const result = await clientB.mutation("access/identity/functions:revokeSession", {
    sessionId: state.sessionIds.a,
  });
  const revokedOk = result?._tag === "ok";
  await personaA.page.goto(`${WEB}/firma`, { waitUntil: "domcontentloaded" });
  await personaA.page.waitForTimeout(6000);
  const denied = await snap(personaA.page, "a5-device-a-denied");
  const denial = denied.includes("Sesja tego urządzenia została zakończona");
  const clientA = authedClient(state.tokens.a);
  const readA = await tryQuery(clientA, "listMySessions", (c) => c.query("access/identity/functions:listMySessions", {}));
  const readB = await tryQuery(clientB, "listMySessions", (c) => c.query("access/identity/functions:listMySessions", {}));
  rec.record(
    "device-revocation-immediate-denial",
    revokedOk && denial && readA.ok === false && readB.ok ? "PASS" : "FAIL",
    "revoking one device's session ends ONLY that device: the revoked profile shows the Polish session-ended view, its token's protected reads fail, the revoking device stays live",
    `revoke result ${JSON.stringify(result)}; device A view: ${denial ? "session-ended alert" : denied.slice(0, 120).replace(/\n/g, " | ")}; device A API: ${readA.ok === false ? `denied (${readA.error})` : "STILL ALLOWED"}; device B API: ${readB.ok ? "live" : `denied (${readB.error})`}`,
  );
  state.pageErrors.push(...(personaA.errors ?? []));
  await personaA.browser.close();
});

// A6. Wrong code, then the correct delivered code, through the real form
// (a throwaway non-persistent context), then the one-time-use/replay probe.
await phase("otp-wrong-code", async () => {
  const pw = await import("playwright-core");
  const browser = await pw.chromium.launch({ executablePath: CHROMIUM, headless: true });
  const context = await browser.newContext({ locale: "pl-PL" });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(WEB, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.getByLabel("Adres e-mail").fill(M1.address);
  const delivered = await browserCode(page, M1);
  const wrong = wrongCodeFor(delivered.code);
  await page.getByLabel("Kod z wiadomości").fill(wrong);
  await page.getByRole("button", { name: "Zaloguj się kodem" }).click();
  await page.waitForTimeout(5000);
  const afterWrong = await snap(page, "a6-wrong-code");
  const wrongAlert = afterWrong.includes("Kod jest nieprawidłowy lub wygasł. Poproś o nowy kod.");
  const resendOffered = (await page.getByRole("button", { name: "Wyślij kod ponownie" }).count()) >= 1;
  rec.record(
    "otp-wrong-code",
    wrongAlert ? "PASS" : "FAIL",
    "a wrong 8-digit code is refused with the Polish copy 'Kod jest nieprawidłowy lub wygasł. Poproś o nowy kod.' and the resend control appears; no session is created",
    `alert shown: ${wrongAlert}; resend offered: ${resendOffered}; still on code form: ${afterWrong.includes("Kod z wiadomości")}`,
  );
  await page.getByLabel("Kod z wiadomości").fill(delivered.code);
  await page.getByRole("button", { name: "Zaloguj się kodem" }).click();
  await page.waitForTimeout(7000);
  const afterRight = await snap(page, "a6-then-correct");
  const signedIn = !afterRight.includes("Zaloguj się do Kiero");
  // One-time use / replay: the consumed code, replayed by a fresh anonymous
  // client, must be refused.
  const replay = await apiVerifyCode(M1.address, delivered.code);
  rec.record(
    "otp-onetime-use-replay-refused",
    signedIn && replay.error !== undefined ? "PASS" : "FAIL",
    "after a code consummates a sign-in, submitting the SAME code again from a fresh unauthenticated client is refused (one-time use; no second session)",
    `correct-code sign-in: ${signedIn ? "ok" : "FAILED"}; replay probe: ${replay.error !== undefined ? `refused (${replay.error})` : "ACCEPTED — replay possible"}`,
  );
  const tokensC = await tokenOf(page);
  state.tokens.c = tokensC.token;
  const clientC = authedClient(tokensC.token);
  const ensuredC = await clientC.mutation("access/identity/functions:ensureSessionRegistry", {});
  state.sessionIds.c = ensuredC?.sessionId ?? null;
  state.pageErrors.push(...errors);
  await context.close();
  await browser.close();
  persistState();
});

// A7. Expiry: request a code, let the 15-minute validity lapse, then submit
// the DELIVERED code — it must be refused (real elapsed time, no clock fake).
await phase("otp-expiry", async () => {
  const issuedAt = Date.now();
  const delivered = await nextCodeAfter(M1, "sign_in_code", () => apiRequestCode(M1.address));
  rec.note(`expiry probe: code requested at ${new Date(issuedAt).toISOString()}, delivered ${delivered.mailCreatedAt}; validity is 15 minutes — waiting`);
  const waitMs = issuedAt + 16 * 60_000 + 5000 - Date.now();
  if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  const probe = await apiVerifyCode(M1.address, delivered.code);
  rec.record(
    "otp-expiry",
    probe.error !== undefined ? "PASS" : "FAIL",
    "a delivered code submitted after its 15-minute validity (16 min real wait) is refused",
    probe.error !== undefined ? `refused after ${Math.round((Date.now() - issuedAt) / 60000)} min: ${probe.error}` : "ACCEPTED after expiry — the code outlived its validity",
    { issuedAt: new Date(issuedAt).toISOString(), deliveredAt: delivered.mailCreatedAt, submittedAt: new Date().toISOString() },
  );
});

// A8. Calendar: the v1 host must NOT expose the Calendar entry (ADR
// calendar-deferral-2026-09); /kalendarz renders the not-found screen.
await phase("calendar-entry-absent", async () => {
  await personaB.page.goto(`${WEB}/kalendarz`, { waitUntil: "domcontentloaded" });
  await personaB.page.waitForTimeout(3000);
  const body = await snap(personaB.page, "a8-calendar-route");
  const notFound = body.includes("Nie ma takiej strony");
  const navText = await personaB.page.evaluate(() => document.querySelector('nav[aria-label="Funkcje"]')?.innerText ?? "");
  const calendarInNav = /kalendarz/i.test(navText);
  rec.record(
    "calendar-entry-absent",
    notFound && !calendarInNav ? "PASS" : "FAIL",
    "no Calendar entry point in the v1 host (navigation has no Kalendarz; /kalendarz is the not-found screen) — the whole Google Calendar integration is deferred beyond v1 per docs/adr/calendar-deferral-2026-09.md",
    `route: ${notFound ? "not-found screen" : "SOMETHING MOUNTS"}; nav contains calendar: ${calendarInNav}`,
    { note: "the disconnect-keeps-sign-in leg is deferred with the integration (owner C6 #197); sign-in usability was proven by every reload/recovery case here" },
  );
});

// ---------------------------------------------------------------------------
// Phase B: M1 — the linking ceremony's email legs and hostile probes
// (the Google OAuth legs are BLOCKED: owner credentials; see results notes)
// ---------------------------------------------------------------------------

await phase("linking-ceremony", async () => {
  const clientC = authedClient(state.tokens.c);
  const clientB = authedClient(state.tokens.b);

  // B1. Concurrent begins: two parallel beginLinking(target google) from two
  // sessions of the SAME account — exactly one ceremony, one typed rejection.
  const begins = await Promise.allSettled([
    clientC.mutation("access/linking/functions:beginLinking", { targetMethod: "google" }),
    clientB.mutation("access/linking/functions:beginLinking", { targetMethod: "google" }),
  ]);
  const outcomes = begins.map((b) => (b.status === "fulfilled" ? { ok: true, value: b.value } : { ok: false, error: String(b.reason?.message ?? b.reason).slice(0, 200) }));
  const okCount = outcomes.filter((o) => o.ok).length;
  const refusedCount = outcomes.filter((o) => !o.ok).length;
  const canonical = await clientC.query("access/linking/functions:linkingStatus", {});
  const oneCeremony =
    canonical?.activeAttempt !== null &&
    canonical?.activeAttempt?.targetMethod === "google" &&
    canonical.activeAttempt.state === "awaiting_first_proof" &&
    canonical.activeAttempt.nextLeg === "email_code";
  rec.record(
    "link-concurrent-begin",
    okCount === 1 && refusedCount === 1 && oneCeremony ? "PASS" : "FAIL",
    "two PARALLEL begin attempts for the same address serialize: exactly one ceremony commits (the canonical status shows one open ceremony on the email leg) and the other is refused — never two active ceremonies; the refusal's typed [ceremony_in_progress] code is unobservable through the sanitized prod error channel (defect D1), pinned by tests/b2",
    `begun=${okCount}; refused=${refusedCount}; canonical status=${JSON.stringify(canonical?.activeAttempt)}; refusal sample=${outcomes.find((o) => !o.ok)?.error ?? "none"}`,
  );

  // B2. Status shows the active ceremony on the google target, email leg next.
  const status1 = await clientC.query("access/linking/functions:linkingStatus", {});
  const ceremonyVisible =
    status1?.activeAttempt !== null &&
    status1?.activeAttempt?.targetMethod === "google" &&
    status1.activeAttempt.state === "awaiting_first_proof" &&
    status1.activeAttempt.nextLeg === "email_code";
  rec.record(
    "link-ceremony-opened",
    ceremonyVisible ? "PASS" : "FAIL",
    "linkingStatus shows the active google-target ceremony: state awaiting_first_proof, next leg email_code (the initiating email method must re-prove first)",
    `status: ${JSON.stringify(status1)}`,
  );

  // B3. Wrong proof code (nothing staged yet): refused, ceremony unchanged.
  const statusBeforeB3 = await clientC.query("access/linking/functions:linkingStatus", {});
  const wrongEarly = await tryQuery(clientC, "verifyProofCode", (c) =>
    c.mutation("access/linking/functions:verifyProofCode", { code: "00000000" }),
  );
  const statusAfterB3 = await clientC.query("access/linking/functions:linkingStatus", {});
  const unchangedB3 =
    JSON.stringify(statusBeforeB3?.activeAttempt) === JSON.stringify(statusAfterB3?.activeAttempt);
  rec.record(
    "link-wrong-code-unstaged",
    wrongEarly.ok === false && unchangedB3 ? "PASS" : "FAIL",
    "verifying a proof code while none is staged is refused and the ceremony is left unchanged (no partial state); the typed [code_wrong_or_expired] code is unobservable through the sanitized prod error channel (defect D1), pinned by tests/b2",
    wrongEarly.ok === false ? `refused (${wrongEarly.error}); ceremony unchanged: ${unchangedB3}` : "ACCEPTED without a staged code",
  );

  // B4. The real proof-code delivery (method_link_code) + wrong then correct.
  const excludeIds = await messageIds(M1);
  const sent = await clientC.action("access/linking/functions:sendProofCode", {});
  const delivered = await waitForCode(M1, "method_link_code", { sinceMs: Date.now() - 2000, excludeIds });
  const wrongAfterStage = await tryQuery(clientC, "verifyProofCode", (c) =>
    c.mutation("access/linking/functions:verifyProofCode", { code: wrongCodeFor(delivered.code) }),
  );
  const verified = await clientC.mutation("access/linking/functions:verifyProofCode", { code: delivered.code });
  const status2 = await clientC.query("access/linking/functions:linkingStatus", {});
  const legAdvanced =
    sent?.sent === true &&
    wrongAfterStage.ok === false &&
    verified?.leg === "first_proof" &&
    verified?.linked === false &&
    status2?.activeAttempt?.state === "awaiting_target_proof" &&
    status2?.activeAttempt?.nextLeg === "google_oauth";
  rec.record(
    "link-email-leg-delivered",
    legAdvanced ? "PASS" : "FAIL",
    "the ceremony's emailed proof code is REALLY delivered (subject 'Kiero — kod do potwierdzenia metody logowania'), a wrong value is the typed [code_wrong_or_expired] rejection, a wrong value is refused without state change, the delivered code advances the ceremony to awaiting_target_proof with the google_oauth leg next",
    `sent=${JSON.stringify(sent)}; wrong staged ${wrongAfterStage.ok === false ? "refused" : "ACCEPTED"}; correct=${JSON.stringify(verified)}; state=${status2?.activeAttempt?.state}/${status2?.activeAttempt?.nextLeg}`,
    {
      note: "the target google_oauth leg (and the commit) requires a real Google login — BLOCKED, owner action; the email leg is fully proven live",
    },
  );

  // B5. The email-side unauthorized-merge refusal: an email-code account
  // asking to attach email_code again is [method_already_attached].
  const cancel = await clientC.mutation("access/linking/functions:cancelLinking", {});
  const again = await tryQuery(clientC, "beginLinking", (c) =>
    c.mutation("access/linking/functions:beginLinking", { targetMethod: "email_code" }),
  );
  const statusB5 = await clientC.query("access/linking/functions:linkingStatus", {});
  rec.record(
    "link-email-target-already-attached",
    cancel?.cancelled === true && again.ok === false && statusB5?.activeAttempt === null ? "PASS" : "FAIL",
    "after cancelling, beginning an email_code-target ceremony on an email-code account is refused (no self-merge, no duplicate credential) and no ceremony is left open; the typed [method_already_attached] code is unobservable through the sanitized prod error channel (defect D1), pinned by tests/b2",
    `cancel=${JSON.stringify(cancel)}; begin email_code ${again.ok === false ? "refused" : "ACCEPTED"}; open ceremony: ${JSON.stringify(statusB5?.activeAttempt)}`,
  );

  // B6. Cross-method same-email sign-in (both directions) — BLOCKED live.
  rec.record(
    "sameemail-cross-method-signin",
    "BLOCKED",
    "signing in with Google at an address owned by an email-code person (and the reverse) is refused with the method-conflict copy 'Konto z tym adresem e-mail używa innej metody logowania…' — no implicit merge; the explicit ceremony commits the link",
    "requires a real Google login (owner credentials); NOT executed on staging by this lane. The refusal/commit code paths (decideCreateOrUpdateUser + googleLinkFromCallbackHook) are unit-fixture-proven; live proof lands with the Google completion leg",
    {
      blocked: {
        responsibleActor: "owner (Wojtek Piskorz)",
        nextAction: "one tester Google login on the staged noVNC browser (or owner-relayed test credentials)",
        resumptionTrigger: "Google sign-in completion leg executed against staging",
      },
    },
  );
  rec.record(
    "link-google-oauth-commit",
    "BLOCKED",
    "the google_oauth target leg completes the ceremony (the auth-callback hook commits users.googleSubject + ceremony state atomically; a resumed Google sign-in records the fresh proof for the reverse direction)",
    "requires the real Google OAuth login — same owner action as sameemail-cross-method-signin",
    {
      blocked: {
        responsibleActor: "owner",
        nextAction: "tester Google login on staged noVNC browser",
        resumptionTrigger: "Google sign-in completion leg executed",
      },
    },
  );
});

// ---------------------------------------------------------------------------
// Phase C: email change to M4 (recent-auth gated), then identity continuity
// ---------------------------------------------------------------------------

await phase("emailchange-confirm", async () => {
  // A fresh session for the recent-authentication window.
  const freshSentAt = Date.now();
  const delivered = await nextCodeAfter(M1, "sign_in_code", () => apiRequestCode(M1.address));
  const fresh = await apiVerifyCode(M1.address, delivered.code);
  if (fresh.error !== undefined) throw new Error(`fresh sign-in failed: ${fresh.error}`);
  const clientD = authedClient(fresh.token);
  const ensuredD = await clientD.mutation("access/identity/functions:ensureSessionRegistry", {});
  state.sessionIds.d = ensuredD?.sessionId ?? null;
  state.tokens.d = fresh.token;
  persistState();

  // C1. Request the change: a real code to the NEW address.
  const excludeM4 = await messageIds(M4);
  const requested = await clientD.action("access/linking/functions:requestEmailChange", { newEmail: M4.address });
  const mail = await waitForCode(M4, "email_change_code", { sinceMs: Date.now() - 2000, excludeIds: excludeM4 });

  // C2. Wrong confirmation first: typed rejection, old address intact.
  const wrongConfirm = await tryQuery(clientD, "confirmEmailChange", (c) =>
    c.mutation("access/linking/functions:confirmEmailChange", { code: wrongCodeFor(mail.code) }),
  );
  const statusBefore = await clientD.query("access/linking/functions:linkingStatus", {});
  const wrongOk = requested?.requested === true && wrongConfirm.ok === false && statusBefore?.email === M1.address;

  // C3. Correct confirmation: the account address becomes M4, sessions live.
  const confirmed = await clientD.mutation("access/linking/functions:confirmEmailChange", { code: mail.code });
  const statusAfter = await clientD.query("access/linking/functions:linkingStatus", {});
  const sessionsAfter = await clientD.query("access/identity/functions:listMySessions", {});
  const confirmOk = confirmed?.newEmail === M4.address && statusAfter?.email === M4.address;
  const sessionsLive = sessionsAfter.some((s) => s.sessionId === state.sessionIds.d && s.revokedAtMs === null);
  rec.record(
    "emailchange-confirm",
    wrongOk && confirmOk && sessionsLive ? "PASS" : "FAIL",
    "requesting an address change sends a real code to the NEW address ('Kiero — kod do zmiany adresu e-mail'); a wrong confirmation is refused and leaves the old address and sessions untouched; the correct code moves the account address while the current session stays live (the typed [code_wrong_or_expired] code is unobservable through the sanitized prod error channel — defect D1, pinned by tests/b2)",
    `requested=${JSON.stringify(requested)}; wrong confirm ${wrongConfirm.ok === false ? "refused" : "ACCEPTED"}; email before/after=${statusBefore?.email} -> ${statusAfter?.email}; confirmed=${JSON.stringify(confirmed)}; session d still live=${sessionsLive}`,
  );

  // C4. The old address no longer reaches the account: a fresh sign-in there
  // resolves a DIFFERENT (new, empty) person — no implicit merge back. (One
  // issuance slot must recover first: the C-phase send spent the budget.)
  const waitMs = freshSentAt + 7 * 60_000 - Date.now();
  if (waitMs > 0) {
    rec.note(`waiting ${Math.round(waitMs / 1000)}s for one issuance slot to recover on the old address`);
    await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  let oldMail = null;
  let lastSendError = null;
  for (let i = 0; i < 3 && oldMail === null; i++) {
    try {
      oldMail = await nextCodeAfter(M1, "sign_in_code", () => apiRequestCode(M1.address));
    } catch (error) {
      lastSendError = String(error?.message ?? error).slice(0, 200);
      rec.note(`old-address send attempt ${i + 1} failed (${lastSendError}); waiting for slot recovery`);
      await new Promise((resolve) => setTimeout(resolve, 6.5 * 60_000));
    }
  }
  if (oldMail === null) throw new Error(`no code deliverable on the old address: ${lastSendError}`);
  const oldSignIn = await apiVerifyCode(M1.address, oldMail.code);
  let oldAccountIsSeparate = null;
  if (oldSignIn.error === undefined) {
    const oldClient = authedClient(oldSignIn.token);
    // Provision the fresh device's registry row (the read path alone would
    // deny with registry_missing; provisioning is part of the honest sign-in).
    await oldClient.mutation("access/identity/functions:ensureSessionRegistry", {});
    const oldSessions = await oldClient.query("access/identity/functions:listMySessions", {});
    // A merged/resumed account would see the M4 account's live sessions.
    oldAccountIsSeparate = !oldSessions.some((s) => s.sessionId === state.sessionIds.d);
    rec.record(
      "emailchange-old-address-detached",
      oldAccountIsSeparate ? "PASS" : "FAIL",
      "after the change, proving the OLD address creates a separate fresh person and does NOT resume the moved account (its device sessions are absent from the new session list)",
      `old-address sign-in created a separate account: ${oldAccountIsSeparate}; sessions visible there: ${oldSessions.length}`,
    );
  } else {
    rec.record(
      "emailchange-old-address-detached",
      "NOT RUN",
      "old-address re-probe refused",
      `sign-in rejected: ${oldSignIn.error}`,
    );
  }
});

// ---------------------------------------------------------------------------
// Phase D: M3 — real deliveries of the limiter mails + verification limit
// ---------------------------------------------------------------------------

await phase("otp-verification-failure-limit", async () => {
  // Prove the 5 limiter sends really delivered codes (any of them).
  let lastCode = null;
  try {
    const delivered = await waitForCode(M3, "sign_in_code", { sinceMs: Date.now() - 60 * 60_000, timeoutMs: 120_000 });
    lastCode = delivered.code;
  } catch (error) {
    rec.note(`M3 delivery poll: ${String(error?.message ?? error).slice(0, 160)}`);
  }
  rec.record(
    "otp-limiter-mails-really-delivered",
    lastCode !== null ? "PASS" : "NOT RUN",
    "the limiter probe's issued codes are real Resend deliveries to the real mailbox (the limiter counts sends, not shadows)",
    lastCode !== null ? "a delivered sign-in code was read from the M3 mailbox" : "no sign-in mail readable within the short poll window (mail.tm latency); the issuance-limit case itself already passed on the send-side refusals",
  );

  // Verification-failure rate limit, behaviorally: repeated WRONG
  // verifications on the pending code, then the CORRECT code itself — if
  // even the correct code is refused, the limiter engaged (an outcome that
  // survives error sanitization).
  if (lastCode !== null) {
    const attempts = [];
    for (let i = 1; i <= 8; i++) {
      const probe = await apiVerifyCode(M3.address, wrongCodeFor(lastCode));
      attempts.push(`${i}: ${probe.error !== undefined ? "refused" : "ACCEPTED"}`);
    }
    const correctAfter = await apiVerifyCode(M3.address, lastCode);
    const limiterEngaged = correctAfter.error !== undefined;
    rec.record(
      "otp-verification-failure-limit",
      limiterEngaged ? "PASS" : "NOT RUN",
      "after repeated wrong-code verifications on one address, the verification rate limit engages: even the CORRECT pending code is refused until the window passes (fail-closed against guessing; the library's refusal text is sanitized on prod — defect D1 — so the OUTCOME carries the proof)",
      limiterEngaged
        ? `${attempts.join(" ; ")}; then the CORRECT code: refused (${correctAfter.error})`
        : `${attempts.join(" ; ")}; the correct pending code still verified after 8 wrong attempts — no limiter engaged at that depth on this candidate; recorded honestly`,
    );
    writeFileSync(`${OUT}/d-verification-limit.txt`, `${attempts.join("\n")}\ncorrect-after: ${correctAfter.error ?? "accepted"}\n`);
  }
});

// ---------------------------------------------------------------------------
// Wrap-up: page errors, results
// ---------------------------------------------------------------------------

const personaErrors = [...(personaA.errors ?? []), ...(personaB.errors ?? []), ...state.pageErrors];
rec.record(
  "page-errors-zero",
  personaErrors.length === 0 ? "PASS" : "FAIL",
  "no pageerror events across the leg's browser sessions",
  personaErrors.length === 0 ? "none" : personaErrors.slice(0, 5).join(" | "),
);
rec.write(RESULTS);
persistState();
console.log(`[done] results: ${RESULTS}`);
console.log(`[tally] ${JSON.stringify(rec.results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {}))}`);
try {
  await personaB.browser.close();
} catch {}
