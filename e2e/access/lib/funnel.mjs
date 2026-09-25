/**
 * The B5 funnel session library (e2e leg): the API-level and browser-level
 * primitives every access driver shares — the lane's counterpart of
 * e2e/helpers.mjs (which is imported, never duplicated: `envelope` comes
 * from there).
 *
 * API level (the four-stage authenticated smoke path): `auth:signIn`
 * issues a REAL code through Resend (read from the mail.tm mailbox via
 * ./mail.mjs), and verifying it returns the session tokens. This gives
 * the hostile matrix (wrong code, replay, expiry, races) precise,
 * deterministic control while the browser level proves the ordinary
 * user-visible path.
 *
 * Browser level: persistent-profile Chromium contexts (independent
 * personas = independent devices), pageerror collection, sanitized
 * snapshots, the shared sign-in walk, and the results recorder
 * (id -> PASS/FAIL/BLOCKED/NOT RUN with expected/observed detail).
 *
 * No import side effects; no credential VALUES are logged (mailbox
 * passwords are throwaway test artifacts referenced by address).
 */

import { ConvexHttpClient } from "convex/browser";
import { mkdirSync, writeFileSync } from "node:fs";
import { waitForCode, messageIds } from "./mail.mjs";

export { waitForCode };

/** The checked-dispatch envelope, imported from the repo's shared helpers. */
export { envelope } from "../../helpers.mjs";

export const CHROMIUM =
  process.env.KIERO_SMOKE_CHROMIUM ?? "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";
export const WEB =
  process.env.KIERO_SMOKE_WEB ?? "https://kiero-staging-web.wojtek-524.workers.dev";
export const CONVEX_URL =
  process.env.KIERO_SMOKE_CONVEX ?? "https://outgoing-marlin-429.eu-west-1.convex.cloud";

// ---------------------------------------------------------------------------
// Shared driver utilities (single definitions; every leg imports these)
// ---------------------------------------------------------------------------

/** Reads one --flag value from a CLI arg list (no off-by-one defaults). */
export function argValue(args, flag, fallback) {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : fallback;
}

/**
 * Runs one recorded phase; a thrown error becomes a recorded FAIL of that
 * phase's case, never a lost leg. Usage: `const phase = phaseOf(rec);`.
 */
export function phaseOf(rec) {
  return async function phase(name, fn) {
    try {
      await fn();
    } catch (error) {
      rec.record(name, "FAIL", `phase ${name} completes`, `driver error: ${String(error?.message ?? error).slice(0, 400)}`);
    }
  };
}

/**
 * A protected read whose typed rejection text may be sanitized on prod:
 * returns { ok: true, value } or { ok: false, error }.
 */
export async function tryQuery(client, fn) {
  try {
    return { ok: true, value: await fn(client) };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 300) };
  }
}

/** A deterministically-wrong variant of a delivered 8-digit code. */
export const wrongCodeFor = (code) => (code[0] === "9" ? "0" : "9") + code.slice(1);

/** Reads the page's current Convex auth tokens from localStorage (never logged). */
export async function tokenOf(page) {
  const namespace = convexAuthNamespace();
  return await page.evaluate(
    (ns) => ({
      token: localStorage.getItem(`__convexAuthJWT_${ns}`),
      refreshToken: localStorage.getItem(`__convexAuthRefreshToken_${ns}`),
    }),
    namespace,
  );
}

// ---------------------------------------------------------------------------
// The sanitized results recorder
// ---------------------------------------------------------------------------

/**
 * The per-case recorder: every case gets status PASS/FAIL/BLOCKED/NOT RUN,
 * the independently expected result, the observed result and a note; the
 * tally is written as results.json at the end of the leg.
 */
export function recorder({ run, leg, web = WEB, convexUrl = CONVEX_URL, candidateSha, outFile }) {
  const results = [];
  const header = { run, leg, candidateSha, environment: { web, convexUrl } };
  const write = () => {
    if (outFile === undefined) return;
    mkdirSync(outFile.slice(0, outFile.lastIndexOf("/")), { recursive: true });
    writeFileSync(outFile, `${JSON.stringify({ ...header, executedAt: new Date().toISOString(), results }, null, 2)}\n`);
  };
  const record = (id, status, expected, observed, extra = {}) => {
    results.push({ id, status, expected, observed, ...extra });
    console.log(`[${status}] ${id} :: expected=${expected} :: observed=${observed}`);
    write();
    return status === "PASS";
  };
  return {
    results,
    record,
    note: (line) => console.log(`NOTE | ${line}`),
    write,
  };
}

/** The localStorage namespace @convex-dev/auth derives from the deployment URL. */
export function convexAuthNamespace(url = CONVEX_URL) {
  return url.replace(/[^a-zA-Z0-9]/g, "");
}

// ---------------------------------------------------------------------------
// API level: the real email-code funnel through auth:signIn
// ---------------------------------------------------------------------------

/** A fresh anonymous Convex client (no identity). */
export function anonClient() {
  return new ConvexHttpClient(CONVEX_URL, { logger: false });
}

/** Requests a sign-in code for an address (a real Resend delivery). */
export async function apiRequestCode(email) {
  const client = anonClient();
  return await client.action("auth:signIn", { provider: "email_code", params: { email } });
}

/**
 * Verifies a sign-in code. Returns the tokens on success; on rejection
 * returns { error } with the sanitized message the server sent (typed
 * markers stay visible for classification; no secrets ever appear).
 */
export async function apiVerifyCode(email, code) {
  const client = anonClient();
  try {
    const result = await client.action("auth:signIn", { provider: "email_code", params: { email, code } });
    const token = result?.tokens?.token;
    if (typeof token !== "string") {
      return { error: "no tokens in sign-in result" };
    }
    return { token, refreshToken: result?.tokens?.refreshToken };
  } catch (error) {
    return { error: String(error?.message ?? error).slice(0, 300) };
  }
}

/** An authenticated client from a session token. */
export function authedClient(token) {
  return new ConvexHttpClient(CONVEX_URL, { logger: false, auth: token });
}

/**
 * The full API funnel for one mailbox: request the code, wait for the
 * real delivery (id-snapshot fresh), verify, provision the session
 * registry. Returns the authenticated client, both tokens and the live
 * session id.
 */
export async function apiFunnelSignIn(mailbox) {
  const excludeIds = await messageIds(mailbox);
  await apiRequestCode(mailbox.address).catch((error) => {
    throw new Error(`code request rejected: ${String(error?.message ?? error).slice(0, 300)}`);
  });
  const { code } = await waitForCode(mailbox, "sign_in_code", { sinceMs: Date.now() - 2000, excludeIds });
  const verified = await apiVerifyCode(mailbox.address, code);
  if (verified.error !== undefined) {
    throw new Error(`verify rejected: ${verified.error}`);
  }
  const client = authedClient(verified.token);
  const ensured = await client.mutation("access/identity/functions:ensureSessionRegistry", {});
  if (ensured?.state !== "live") {
    throw new Error(`session provisioning failed: ${JSON.stringify(ensured)}`);
  }
  return { client, token: verified.token, refreshToken: verified.refreshToken, sessionId: ensured.sessionId, code };
}

/** Waits for the delivered sign-in code (patient: mail.tm 5-8+ min). */
export async function waitForDelivery(mailbox, sinceMs) {
  return await waitForCode(mailbox, "sign_in_code", { sinceMs });
}

// ---------------------------------------------------------------------------
// Browser level: persistent-profile personas
// ---------------------------------------------------------------------------

let chromiumModule = null;

/** Lazily imports playwright-core (the drivers run where it is installed). */
export async function chromium() {
  if (chromiumModule === null) {
    chromiumModule = (await import("playwright-core")).chromium;
  }
  return chromiumModule;
}

/**
 * Opens one persistent-profile browser context = one independent device.
 * Profiles live under /tmp/kiero-smoke/b5/<run>/profiles/<persona>; a
 * persona reused across legs keeps its session (the reload-recovery and
 * revocation-denial cases depend on exactly this).
 */
export async function openPersona(profileDir, { viewport = { width: 1400, height: 900 } } = {}) {
  const pw = await chromium();
  const browser = await pw.launchPersistentContext(profileDir, {
    executablePath: CHROMIUM,
    headless: true,
    locale: "pl-PL",
    viewport,
  });
  const page = browser.pages()[0] ?? (await browser.newPage());
  const errors = [];
  page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
  return { browser, page, errors };
}

/** Sanitized snapshot: full-page screenshot + body text, returns the text. */
export function snapFor(outDir) {
  mkdirSync(outDir, { recursive: true });
  return async (page, tag) => {
    const body = await page.evaluate(() => document.body?.innerText ?? "");
    await page.screenshot({ path: `${outDir}/${tag}.png`, fullPage: true });
    writeFileSync(`${outDir}/${tag}.txt`, body);
    return body;
  };
}

/**
 * The browser code request every leg shares: the real card, a real code
 * request, the real delivered code — WITHOUT submitting it (the wrong-code
 * case must submit its own value first). FRESHNESS-CORRECT: the mailbox
 * is snapshotted by message id BEFORE the request (mail.tm timestamps
 * truncate to whole seconds, so a wall-clock `since` alone can miss a
 * mail created in the request's own second — the b5-i1 lesson).
 */
export async function browserRequestCode(page, mailbox, { timeoutMs = 720_000 } = {}) {
  await page.goto(WEB, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);
  await page.getByLabel("Adres e-mail").fill(mailbox.address);
  const excludeIds = await messageIds(mailbox);
  await page.getByRole("button", { name: "Wyślij kod" }).click();
  await page.waitForTimeout(2000);
  const { code } = await waitForCode(mailbox, "sign_in_code", {
    sinceMs: Date.now() - 2000,
    excludeIds,
    timeoutMs,
  });
  return code;
}

/**
 * The browser sign-in walk every leg shares: request the delivered code
 * (browserRequestCode), submit it, and read the post-login page.
 * Returns { code, body }; body is also written as
 * `<outDir>/<tag>.png|.txt` when outDir is given. Callers assert the
 * post-login state themselves.
 */
export async function browserSignIn(page, mailbox, { outDir, tag = "signin", timeoutMs = 720_000 } = {}) {
  const code = await browserRequestCode(page, mailbox, { timeoutMs });
  await page.getByLabel("Kod z wiadomości").fill(code);
  await page.getByRole("button", { name: "Zaloguj się kodem" }).click();
  await page.waitForTimeout(6000);
  const body = await page.evaluate(() => document.body?.innerText ?? "");
  if (outDir !== undefined) {
    await page.screenshot({ path: `${outDir}/${tag}.png`, fullPage: true });
    writeFileSync(`${outDir}/${tag}.txt`, body);
  }
  return { code, body };
}
