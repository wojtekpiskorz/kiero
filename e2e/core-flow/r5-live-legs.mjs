/**
 * R5 live legs (issue #130) :: the three browser-level proofs PR #149
 * recorded as pending, driven against a REAL deployed dev lease and a
 * REAL Chromium (playwright-core, the browser-leg.mjs pattern).
 *
 * Everything is REAL: the deployed Convex lease (default
 * kiero-dev-core:dev/i4 = nautical-loris-352), the deployed gateway
 * Worker (kiero-dev-gateway-i4), the accept path for every seeded
 * message (gateway /uploads/prepare + acceptSourceCommand, text-only),
 * the real purge command (sources.purgeSource), and the web app itself
 * (vite dev server with VITE_CONVEX_URL + VITE_GATEWAY_URL). No media
 * capture is involved, so no boundary mock is installed.
 *
 * Legs (the recorded pending halves of R5-P1/P3):
 *  L1. R5-P1 live: a source with 121 NEWER messages opens directly from
 *      the canonical /zrodlo?zrodlo=<id> URL while the conversation feed
 *      keeps its page size (and the old source stays unreachable even at
 *      the 120-row cap);
 *  L2. the legacy conversation deep link /?zrodlo=<id> REDIRECTS to the
 *      canonical dossier (browser-level wiring; fragment identity when a
 *      matched fragment exists after interpretation), and a malformed
 *      legacy value is refused in place, never looped;
 *  L3. UI-level refusals: a cross-company source id and a PURGED source
 *      id both render the truthful uniform Polish refusal and leak no
 *      content; a malformed canonical value refuses too.
 *
 * Seeding is bounded and honest: one old source with a distinctive
 * marker, 121 real text-only filler messages (the real composer path),
 * a foreign company's source, and one source purged through the real
 * public command before the browser phase.
 *
 * Run (repo root; the dev server must serve the app, see KIERO_R5_APP):
 *   KIERO_R5_CONVEX=nautical-loris-352.convex.cloud \
 *   KIERO_R5_GATEWAY=https://kiero-dev-gateway-i4.wojtek-524.workers.dev \
 *   VITE_CONVEX_URL=https://nautical-loris-352.convex.cloud \
 *   VITE_GATEWAY_URL=https://kiero-dev-gateway-i4.wojtek-524.workers.dev \
 *   npm --prefix apps/web run dev -- --port 5173
 * then: node e2e/core-flow/r5-live-legs.mjs
 * (Not a vitest file: live evidence, transcribed onto #130. Everything
 * printed is sanitized: ids, states and Polish product text only; no
 * tokens, no secrets.)
 */

import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { homedir } from "node:os";
import { envelope, fixtureCodeOf, signInWithFixtureCode } from "../helpers.mjs";

const CONVEX_URL = process.env.KIERO_R5_CONVEX_URL ?? "https://nautical-loris-352.convex.cloud";
const GATEWAY = process.env.KIERO_R5_GATEWAY ?? "https://kiero-dev-gateway-i4.wojtek-524.workers.dev";
const APP_URL = process.env.KIERO_R5_APP ?? "http://localhost:5173";
const CHROMIUM =
  process.env.KIERO_R5_CHROMIUM ??
  `${homedir}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const RUN = process.env.KIERO_R5_PROOF_RUN ?? Date.now().toString(36);
const EMAIL = `r5-web-${RUN}@kiero.invalid`;
const FOREIGN_EMAIL = `r5-obcy-${RUN}@kiero.invalid`;
const FILLERS = Number(process.env.KIERO_R5_FILLERS ?? 121);

/** Distinctive markers the legs assert render or never render. */
const OLD_MARKER = `ZALICZKA-STARA-WIADOMOSC-${RUN}-5000`;
const PURGED_MARKER = `DO-USUNIECIA-TRWALE-${RUN}`;
const FOREIGN_MARKER = `SEKRET-OBCEJ-FIRMY-${RUN}`;

const REFUSAL = "Takie źródło nie istnieje albo nie należy do Twojej firmy.";
const LEGACY_MALFORMED = "Odnośnik do źródła jest nieprawidłowy — nie otworzono żadnej wiadomości.";

const results = [];
function record(id, outcome, detail) {
  results.push({ id, outcome });
  console.log(`[${outcome}] ${id}${detail === undefined ? "" : ` :: ${detail}`}`);
  return outcome === "PASS";
}
const note = (line) => console.log(`NOTE | ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const isOk = (result) => result?._tag === "ok";
const value = (result) => (isOk(result) ? result.value : null);
const errCode = (result) => (result?._tag === "error" ? result.error.code : "ok");
const key = () => `idem_${randomUUID()}`;

// --- seed: real bosses, firms, and the real accept/purge surfaces ----------

const boss = await signInWithFixtureCode(CONVEX_URL, EMAIL, fixtureCodeOf(EMAIL));
if (typeof boss.refreshToken !== "string") throw new Error("sign-in returned no refresh token");
const { token, refreshToken } = boss;
const created = await boss.client.mutation("access/membership/functions:admitCommand", {
  envelope: envelope("access.createCompany", {
    name: `Budowa R5 ${RUN}`,
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
  }),
});
if (!isOk(created)) throw new Error("company creation failed");
const project = await boss.client.mutation("projects/functions:dispatchProjects", {
  envelope: envelope("projects.identifyProject", {
    displayName: "Banan",
    initialStage: "in_progress",
    clientId: null,
  }),
});
const BANAN = value(project)?.projectId ?? null;
if (BANAN === null) throw new Error("project creation failed");
record("S0/the seeded boss has a firm and project", "PASS", `project=${BANAN}`);

// The foreign company's own boss and source (never disclosed to A).
const foreign = await signInWithFixtureCode(CONVEX_URL, FOREIGN_EMAIL, fixtureCodeOf(FOREIGN_EMAIL));
const foreignCompany = await foreign.client.mutation("access/membership/functions:admitCommand", {
  envelope: envelope("access.createCompany", {
    name: `Firma Obca R5 ${RUN}`,
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
  }),
});
if (!isOk(foreignCompany)) throw new Error("foreign company creation failed");

const gw = async (t, path, init = {}) => {
  const response = await fetch(`${GATEWAY}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${t}` },
  });
  let body = null;
  try {
    body = await response.json();
  } catch {
    body = { parse: "failed", status: response.status };
  }
  return { status: response.status, body };
};
const jsonInit = (method, payload) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

/** One text-only source through the REAL composer path (no media parts). */
async function sendTextOnly(persona, { text, hints = [] }) {
  const idempotencyKey = key();
  const prepared = await gw(
    persona.token,
    "/uploads/prepare",
    jsonInit("POST", { draftId: idempotencyKey, parts: 1, mediaKinds: [] }),
  );
  const uploadId = prepared.body?.value?.uploadId;
  if (uploadId === undefined) {
    throw new Error(`prepare failed: status=${prepared.status} code=${errCode(prepared.body)}`);
  }
  const accepted = await persona.client.mutation("sources/accept/commands:acceptSourceCommand", {
    envelope: envelope(
      "sources.acceptSource",
      {
        uploadId,
        authorText: text,
        timezoneSnapshot: "Europe/Warsaw",
        projectHints: hints,
      },
      idempotencyKey,
    ),
  });
  if (accepted?._tag === "error") {
    throw new Error(`accept failed: ${accepted.error.code} ${accepted.error.message}`);
  }
  return accepted.value.sourceId;
}

// The OLD source first (oldest row), then 121 NEWER real messages so the
// old one lands beyond the feed's 120-row cap.
const OLD_ID = await sendTextOnly(boss, {
  text: `Banan: zaliczka od klienta wynosi 5000 złotych (marker: ${OLD_MARKER}).`,
  hints: [BANAN],
});
record("S1/old-source-accepted", "PASS", `sourceId=${OLD_ID}`);

for (let i = 1; i <= FILLERS; i += 1) {
  await sendTextOnly(boss, { text: `Wpis porządkowy ${i} z ${FILLERS} w rozmowie firmy.` });
  if (i % 20 === 0) note(`seeded ${i}/${FILLERS} newer messages`);
}
record("S2/fillers-accepted", "PASS", `count=${FILLERS}`);

// The source A will purge for real before the browser phase.
const PURGED_ID = await sendTextOnly(boss, { text: `Wiadomość przeznaczona do trwałego usunięcia (marker: ${PURGED_MARKER}).` });
const purged = await boss.client.mutation("sources/accept/commands:acceptSourceCommand", {
  envelope: envelope("sources.purgeSource", { sourceId: PURGED_ID, confirmation: "USUŃ TRWALE" }),
});
record(
  "S3/purge-command-accepted",
  isOk(purged) ? "PASS" : "FAIL",
  isOk(purged) ? "sources.purgeSource ok" : errCode(purged),
);

// The foreign source (company B), after the fillers so it cannot pollute A's feed order.
const FOREIGN_ID = await sendTextOnly(foreign, { text: `Tajne ustalenie obcej firmy (marker: ${FOREIGN_MARKER}).` });
record("S4/foreign-source-accepted", "PASS", `sourceId=${FOREIGN_ID}`);

// The purged read must already refuse (the tombstone commits atomically).
const purgedRead = await boss.client.query("sources/read/views:sourceExposition", { sourceId: PURGED_ID });
record(
  "S5/purged-read-refuses-before-browser",
  purgedRead?._tag === "error" && purgedRead.error.code === "source_not_in_company" ? "PASS" : "FAIL",
  `code=${errCode(purgedRead)}`,
);

// Wait (bounded) for the old source's interpretation so the fragment leg
// can use a REAL matched fragment when one exists.
const terminalStates = new Set(["processed", "failed"]);
let oldState = null;
let fragmentId = null;
for (let attempt = 0; attempt < 40; attempt += 1) {
  const exposition = await boss.client.query("sources/read/views:sourceExposition", { sourceId: OLD_ID });
  oldState = value(exposition)?.processingState ?? null;
  if (oldState !== null && terminalStates.has(oldState)) {
    break;
  }
  await sleep(6_000);
}
if (oldState !== null && terminalStates.has(oldState)) {
  const evidence = await boss.client.query("sources/read/views:sourceEvidence", {
    sourceId: OLD_ID,
    paginationOpts: { numItems: 20, cursor: null },
  });
  const rows = value(evidence)?.page ?? [];
  fragmentId = rows.map((row) => row.fragmentId).find((id) => id !== null) ?? null;
}
note(`old source processingState=${oldState}; matched fragment=${fragmentId ?? "none"}`);
record(
  "S6/old-source-terminal",
  oldState !== null && terminalStates.has(oldState) ? "PASS" : "FAIL",
  `state=${oldState}`,
);

// --- the browser -----------------------------------------------------------

const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
const context = await browser.newContext({ locale: "pl-PL" });
await context.addInitScript(
  ({ convexUrl, t, r }) => {
    const ns = convexUrl.replace(/[^a-zA-Z0-9]/g, "");
    localStorage.setItem(`__convexAuthJWT_${ns}`, t);
    localStorage.setItem(`__convexAuthRefreshToken_${ns}`, r);
  },
  { convexUrl: CONVEX_URL, t: token, r: refreshToken },
);
const page = await context.newPage();
page.on("pageerror", (error) => console.log(`  [page-error] ${error.message}`));

const canonical = (id, fragment = null) =>
  `/zrodlo?zrodlo=${encodeURIComponent(id)}${fragment === null ? "" : `&fragment=${encodeURIComponent(fragment)}`}`;
const articleCount = async () => page.locator("main article").count();

// The app must be up before any leg (the dev server is the operator's leg).
{
  let up = false;
  for (let attempt = 0; attempt < 30; attempt += 1) {
    up = await page
      .goto(APP_URL, { waitUntil: "domcontentloaded", timeout: 10_000 })
      .then(() => true)
      .catch(() => false);
    if (up) break;
    note(`waiting for the dev server at ${APP_URL}`);
    await sleep(2_000);
  }
  if (!up) throw new Error(`the dev server never answered at ${APP_URL}`);
}

// L1: the capped feed, the direct dossier open, the unchanged feed size.
await page.waitForSelector("#capture-text", { timeout: 30_000 });
await page.waitForSelector("main article", { timeout: 30_000 });
await sleep(1_500);
const initialCount = await articleCount();
record("L1/feed-initial-page-size", initialCount === 30 ? "PASS" : "FAIL", `articles=${initialCount}`);
let feedText = (await page.textContent("main")) ?? "";
record("L1/old-marker-absent-from-first-page", !feedText.includes(OLD_MARKER) ? "PASS" : "FAIL", "marker not in the first 30 rows");

// Grow the feed to the 120-row cap: the old source must stay unreachable
// in the feed itself (the reason the canonical dossier exists).
let cappedCount = initialCount;
for (let click = 0; click < 3; click += 1) {
  const more = page.locator('button:has-text("Pokaż starsze wiadomości")');
  if ((await more.count()) === 0) break;
  await more.click();
  await sleep(1_200);
}
await sleep(1_500);
cappedCount = await articleCount();
feedText = (await page.textContent("main")) ?? "";
record(
  "L1/old-source-beyond-the-120-cap",
  cappedCount === 120 && !feedText.includes(OLD_MARKER) ? "PASS" : "FAIL",
  `articles=${cappedCount}; marker present=${feedText.includes(OLD_MARKER)}`,
);

// The direct canonical open: the dossier fetches by id, feed-independent.
await page.goto(`${APP_URL}${canonical(OLD_ID)}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("h1", { timeout: 30_000 });
await page.waitForSelector("text=Wiadomość źródłowa", { timeout: 30_000 });
const dossierText = (await page.textContent("main")) ?? "";
record(
  "L1/dossier-opens-the-old-source-directly",
  (await page.textContent("h1"))?.trim() === "Źródło" && dossierText.includes(OLD_MARKER) ? "PASS" : "FAIL",
  "the dossier renders the old source's original text",
);
const canonicalLink = dossierText.includes(canonical(OLD_ID)) ? "PASS" : "FAIL";
record("L1/dossier-displays-the-canonical-link", canonicalLink, canonical(OLD_ID));

// Back on the conversation: the default page size is untouched.
await page.goto(`${APP_URL}/`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("main article", { timeout: 30_000 });
await sleep(1_500);
const afterCount = await articleCount();
record(
  "L1/feed-size-unchanged-after-dossier-visit",
  afterCount === initialCount ? "PASS" : "FAIL",
  `articles=${afterCount} (was ${initialCount})`,
);

// L2: the legacy conversation deep link redirects to the dossier.
await page.goto(`${APP_URL}/?zrodlo=${encodeURIComponent(OLD_ID)}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("text=Wiadomość źródłowa", { timeout: 30_000 });
const redirectedTo = new URL(page.url()).pathname + new URL(page.url()).search;
record(
  "L2/legacy-link-redirects-to-canonical-dossier",
  redirectedTo === canonical(OLD_ID) ? "PASS" : "FAIL",
  `landed=${redirectedTo}`,
);
const redirectText = (await page.textContent("main")) ?? "";
record(
  "L2/redirected-dossier-shows-the-old-source",
  redirectText.includes(OLD_MARKER) ? "PASS" : "FAIL",
  "original text after the redirect",
);

// Fragment identity through the legacy redirect, with a REAL matched
// fragment when interpretation produced one (else deterministic pin holds).
if (fragmentId !== null) {
  await page.goto(
    `${APP_URL}/?zrodlo=${encodeURIComponent(OLD_ID)}&fragment=${encodeURIComponent(fragmentId)}`,
    { waitUntil: "domcontentloaded" },
  );
  await page.waitForSelector("text=Wiadomość źródłowa", { timeout: 30_000 });
  const fragmentTarget = new URL(page.url()).pathname + new URL(page.url()).search;
  record(
    "L2/legacy-fragment-identity-kept",
    fragmentTarget === canonical(OLD_ID, fragmentId) ? "PASS" : "FAIL",
    `landed=${fragmentTarget}`,
  );
} else {
  note("no matched fragment after interpretation; fragment identity stays pinned by tests/h3 (deterministic)");
}

// A malformed legacy value refuses in place (no loop, no doomed read).
await page.goto(`${APP_URL}/?zrodlo=${encodeURIComponent("/../etc")}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#capture-text", { timeout: 30_000 });
await sleep(1_000);
const malformedText = (await page.textContent("body")) ?? "";
const stayedOnConversation = new URL(page.url()).pathname === "/";
record(
  "L2/malformed-legacy-value-refused-in-place",
  stayedOnConversation && malformedText.includes(LEGACY_MALFORMED) ? "PASS" : "FAIL",
  `path=${new URL(page.url()).pathname}; notice=${malformedText.includes(LEGACY_MALFORMED)}`,
);

// L3: foreign, purged and malformed canonical targets refuse truthfully.
await page.goto(`${APP_URL}${canonical(FOREIGN_ID)}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(`text=${REFUSAL}`, { timeout: 30_000 });
let refusalText = (await page.textContent("main")) ?? "";
record(
  "L3/foreign-source-refuses",
  refusalText.includes(REFUSAL) && !refusalText.includes(FOREIGN_MARKER) ? "PASS" : "FAIL",
  "uniform not-found; no foreign content",
);

await page.goto(`${APP_URL}${canonical(PURGED_ID)}`, { waitUntil: "domcontentloaded" });
await page.waitForSelector(`text=${REFUSAL}`, { timeout: 30_000 });
refusalText = (await page.textContent("main")) ?? "";
record(
  "L3/purged-source-refuses",
  refusalText.includes(REFUSAL) && !refusalText.includes(PURGED_MARKER) ? "PASS" : "FAIL",
  "uniform not-found; no purged content",
);

await page.goto(`${APP_URL}/zrodlo?zrodlo=${encodeURIComponent("not an id")}`, {
  waitUntil: "domcontentloaded",
});
await page.waitForSelector(`text=${REFUSAL}`, { timeout: 30_000 });
record(
  "L3/malformed-canonical-value-refuses",
  ((await page.textContent("main")) ?? "").includes(REFUSAL) ? "PASS" : "FAIL",
  "client-side honest refusal",
);

await browser.close();

const counts = results.reduce(
  (acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }),
  {},
);
console.log(`\nSummary: ${JSON.stringify(counts)} of ${results.length} checks`);
const runIds = { RUN, OLD_ID, PURGED_ID, FOREIGN_ID, fillers: FILLERS, fragmentId };
console.log(`Run ids: ${JSON.stringify(runIds)}`);
process.exit(results.every((r) => r.outcome === "PASS") ? 0 : 1);
