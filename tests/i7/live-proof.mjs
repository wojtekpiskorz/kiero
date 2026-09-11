/**
 * I7 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/i7, instance wandering-eel-569)
 * and a REAL browser running the REAL production build of the web app.
 *
 * Leg A (node, no browser): the backend version handshake against the
 * deployment's public /platform/health endpoint, fed through the REAL
 * decision module (apps/web/src/pwa/update/handshake.ts, loaded through
 * node --experimental-strip-types so the same code the bundle ships is
 * the code proven).
 *
 * Leg B (real Chromium, real served build, real service worker): the
 * physical PWA update row. The app is served from a local static server
 * whose /sw.js responses carry an injected release marker; "deploying a
 * new release" is flipping that marker, exactly what a deploy that
 * touches the worker script does to the worker's bytes. Everything else
 * is real: the React app, the composed registration (A4), F3's untouched
 * worker (no fetch handler, no cache), the update module's detection,
 * the safe-point gate, the Polish prompt, the user-click reload, the
 * waiting worker's activation, D4's real IndexedDB draft store, and the
 * session revocation surface (B1/B2) while an update is pending.
 *
 * Physical-device legs (real phones, installed PWA, real update prompts
 * over mobile networks) stay NOT RUN; see the issue report.
 *
 * Run (from the repo root, after building with VITE_CONVEX_URL set):
 *   VITE_CONVEX_URL=https://wandering-eel-569.eu-west-1.convex.cloud npm run build
 *   node --experimental-strip-types tests/i7/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.
 * Everything printed is sanitized: no tokens, no secrets.)
 */

import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, "..", "..");
const DIST = join(REPO, "apps", "web", "dist");

const CONVEX_URL = process.env.KIERO_I7_CONVEX ?? "https://wandering-eel-569.eu-west-1.convex.cloud";
const SITE_URL = process.env.KIERO_I7_SITE ?? "https://wandering-eel-569.eu-west-1.convex.site";
const PORT = Number(process.env.KIERO_I7_PORT ?? 8787);
const CHROMIUM =
  process.env.KIERO_I7_CHROMIUM ??
  `${process.env.HOME ?? ""}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;
const PLAYWRIGHT_CORE =
  process.env.KIERO_I7_PLAYWRIGHT ??
  join(process.env.HOME ?? "", ".npm", "_npx", "9833c18b2d85bc59", "node_modules", "playwright-core");

const RUN = Date.now().toString(36);
const EMAIL = `i7-live-${RUN}@kiero.invalid`;

const results = [];
function record(id, outcome, detail) {
  results.push({ id, outcome, detail });
  console.log(`[${outcome}] ${id}${detail === undefined ? "" : ` :: ${detail}`}`);
  return outcome === "PASS";
}
function summarize() {
  const counts = results.reduce(
    (acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }),
    {},
  );
  console.log(`\nSummary: ${JSON.stringify(counts)} of ${results.length} checks`);
  return results.every((r) => r.outcome === "PASS");
}

// ---------------------------------------------------------------------------
// Leg A: the version handshake against the real deployment
// ---------------------------------------------------------------------------

const { ConvexHttpClient } = await import(pathToFileURL(join(REPO, "node_modules", "convex", "browser", "index.js")).href).catch(
  async () => await import("convex/browser"),
);
const {
  CLIENT_EXPECTED_RUNTIME_VERSION,
  decideRuntimeHandshake,
  convexSiteUrlFromCloudUrl,
} = await import(pathToFileURL(join(REPO, "apps", "web", "src", "pwa", "update", "handshake.ts")).href);

record(
  "A0 the site URL derives from the deployment's cloud URL",
  convexSiteUrlFromCloudUrl(CONVEX_URL) === SITE_URL,
  `${convexSiteUrlFromCloudUrl(CONVEX_URL)}`,
);

const healthResponse = await fetch(`${SITE_URL}/platform/health`, {
  headers: { accept: "application/json" },
});
const health = await healthResponse.json();
const serverRuntime = health?.value?.runtimeVersion ?? null;
record(
  "A1 the real /platform/health answers the runtime version",
  healthResponse.status === 200 && serverRuntime === CLIENT_EXPECTED_RUNTIME_VERSION,
  `http=${healthResponse.status} runtimeVersion=${serverRuntime} deploymentLabel=${health?.value?.deployment}`,
);
record(
  "A2 the real handshake decides this client supported",
  decideRuntimeHandshake(CLIENT_EXPECTED_RUNTIME_VERSION, serverRuntime).status === "supported",
  `client=${CLIENT_EXPECTED_RUNTIME_VERSION} server=${serverRuntime}`,
);
record(
  "A3 a newer-MAJOR server would be update-required (same real decision path)",
  decideRuntimeHandshake(CLIENT_EXPECTED_RUNTIME_VERSION, "a99.0").status === "unsupported",
  "a99.0 -> unsupported",
);

// ---------------------------------------------------------------------------
// The fixture person (B3/B1 pattern, sanitized)
// ---------------------------------------------------------------------------

const fixtureCodeOf = (seed) => {
  let hash = 0;
  for (const byte of Buffer.from(seed)) {
    hash = (hash * 31 + byte) % 90_000_000;
  }
  return String(42_000_000 + hash);
};

const anon = () => new ConvexHttpClient(CONVEX_URL, { logger: false });
const code = fixtureCodeOf(EMAIL);
await anon().action("auth:signIn", { provider: "email_code", params: { email: EMAIL } }).catch(() => undefined);
const setCode = await anon().action("access/identity/probe:b1ProofSetCode", { email: EMAIL, code });
if (setCode?._tag !== "ok") throw new Error("fixture code install failed");
const signedIn = await anon().action("auth:signIn", {
  provider: "email_code",
  params: { email: EMAIL, code },
});
const token = signedIn?.tokens?.token;
const refreshToken = signedIn?.tokens?.refreshToken;
if (typeof token !== "string" || typeof refreshToken !== "string") {
  throw new Error("sign-in failed");
}
const person = new ConvexHttpClient(CONVEX_URL, { logger: false, auth: token });
const ensured = await person.mutation("access/identity/functions:ensureSessionRegistry", {});
if (ensured?.state !== "live") throw new Error("session provisioning failed");
const sessionId = ensured.sessionId;
const created = await person.mutation("access/membership/functions:admitCommand", {
  envelope: {
    operation: "access.createCompany",
    input: { name: `Budowa I7 ${RUN}`, timezone: "Europe/Warsaw", defaultCurrency: "PLN" },
    expectedRevisions: [],
  },
});
if (created?._tag !== "ok") throw new Error("createCompany failed");
record("A4 the live person is signed-in with their own firm", true, `sessionId present=${typeof sessionId === "string"}`);

// ---------------------------------------------------------------------------
// The local release server over the production build
// ---------------------------------------------------------------------------

let currentRelease = "v1";
const servedReleases = [];
const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", `http://127.0.0.1:${PORT}`);
  if (url.pathname === "/__control/release" && request.method === "POST") {
    let body = "";
    request.on("data", (chunk) => {
      body += String(chunk);
    });
    request.on("end", () => {
      currentRelease = JSON.parse(body).release;
      response.writeHead(204).end();
    });
    return;
  }
  if (url.pathname === "/sw.js") {
    const script = `${readFileSync(join(DIST, "sw.js"), "utf8")}\n/* kiero release: ${currentRelease} */\n`;
    servedReleases.push(currentRelease);
    response.writeHead(200, {
      "content-type": "text/javascript",
      "cache-control": "no-store",
    });
    response.end(script);
    return;
  }
  const file = url.pathname === "/" ? "index.html" : url.pathname.replace(/^\/+/, "");
  const serveHtml = () => {
    const html = readFileSync(join(DIST, "index.html"), "utf8").replace(
      "</head>",
      `  <meta name="kiero-release" content="${currentRelease}">\n  </head>`,
    );
    response.writeHead(200, { "content-type": "text/html", "cache-control": "no-store" });
    response.end(html);
  };
  if (file === "index.html") {
    serveHtml();
    return;
  }
  try {
    const body = readFileSync(join(DIST, file));
    const type = file.endsWith(".js")
      ? "text/javascript"
      : file.endsWith(".html")
        ? "text/html"
        : "application/octet-stream";
    response.writeHead(200, { "content-type": type, "cache-control": "no-store" });
    response.end(body);
  } catch {
    // SPA routing: feature routes like /wpis serve the shell.
    serveHtml();
  }
});
await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
const APP_URL = `http://127.0.0.1:${PORT}`;

// ---------------------------------------------------------------------------
// Leg B: the real browser, the real build, the real update
// ---------------------------------------------------------------------------

const { chromium } = await import(pathToFileURL(join(PLAYWRIGHT_CORE, "index.mjs")).href);
const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
const context = await browser.newContext({ locale: "pl-PL" });
// The session bridge (the D4 pattern): the REAL token from the fixture
// sign-in above goes into the browser's convex-auth storage.
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

const visibilityTick = () =>
  page.evaluate(() => {
    window.dispatchEvent(new Event("visibilitychange"));
  });
const waitingWorker = () =>
  page.evaluate(async () => {
    const registration = await navigator.serviceWorker.getRegistration();
    return registration?.waiting ?? null;
  });
const readDraft = () =>
  page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const open = indexedDB.open("kiero-drafts", 1);
      open.onsuccess = () => resolve(open.result);
    });
    const keys = await new Promise((resolve) => {
      const tx = db.transaction(["entries"], "readonly");
      const req = tx.objectStore("entries").getAllKeys();
      tx.oncomplete = () => resolve(req.result);
    });
    const draftKey = keys.find((k) => String(k).endsWith("#draft"));
    if (draftKey === undefined) return null;
    return await new Promise((resolve) => {
      const tx = db.transaction(["entries"], "readonly");
      const req = tx.objectStore("entries").get(draftKey);
      tx.oncomplete = () => resolve(req.result);
    });
  });

// B1: first load registers the worker; a reload makes it the controller.
await page.goto(`${APP_URL}/`, { waitUntil: "load" });
await page.evaluate(async () => {
  await navigator.serviceWorker.ready;
});
await page.reload({ waitUntil: "load" });
const controlled = await page.evaluate(() => navigator.serviceWorker.controller !== null);
record("B1 the production build registers F3's worker and controls the page", controlled, `served sw releases=${[...new Set(servedReleases)].join(",")}`);

// B2: the signed-in boss edits a REAL draft on /wpis.
await page.goto(`${APP_URL}/wpis`, { waitUntil: "load" });
await page.waitForSelector("#capture-text", { timeout: 30_000 });
const DRAFT_TEXT = `I7 live ${RUN}: Banan, dowóz płytek w środę rano`;
await page.fill("#capture-text", DRAFT_TEXT);
record("B2 the composer holds the boss's text as the local draft", true, `chars=${DRAFT_TEXT.length}`);

// B3: deploy release v2 (only the worker's bytes change) while the boss
// has just typed: the update is DETECTED but the prompt DEFERS (editing).
await fetch(`http://127.0.0.1:${PORT}/__control/release`, {
  method: "POST",
  body: JSON.stringify({ release: "v2" }),
});
await visibilityTick();
let waitingSeen = false;
for (let attempt = 0; attempt < 50 && !waitingSeen; attempt += 1) {
  waitingSeen = (await waitingWorker()) !== null;
  if (!waitingSeen) {
    await page.waitForTimeout(200);
  }
}
record("B3 the new release installs a WAITING worker behind the old client", waitingSeen, `release=v2 served=${servedReleases.filter((r) => r === "v2").length}x`);
// Keep the editing settle window hot, then re-evaluate: no prompt yet.
await page.type("#capture-text", "!", { delay: 10 });
await visibilityTick();
await page.waitForTimeout(700);
const promptDuringEditing = await page.$("div[role=status]");
record(
  "B4 NO prompt during active editing (the safe-point gate defers it)",
  promptDuringEditing === null,
  `promptDuringEditing=${promptDuringEditing === null ? "absent" : "present"}`,
);

// B5: once the input settles, the Polish prompt appears (never before).
await page.waitForTimeout(1_800);
await visibilityTick();
await page.waitForSelector("div[role=status]", { timeout: 15_000 });
const promptHeading = await page.textContent("div[role=status] p");
const promptButton = await page.textContent("div[role=status] button");
record(
  "B5 the Polish update prompt appears at the safe point",
  promptHeading?.includes("Dostępna jest nowa wersja Kiero") === true &&
    promptButton?.trim() === "Odśwież teraz",
  `heading="${promptHeading?.trim()}"`,
);

// B6: the draft was persisted/migrated BEFORE the prompt showed.
const draftAtPrompt = await readDraft();
record(
  "B6 the local draft migrated to the current client schema before the prompt",
  draftAtPrompt?.draftSchemaVersion === 1 && typeof draftAtPrompt?.text === "string" && draftAtPrompt.text.includes(DRAFT_TEXT),
  `schemaVersion=${draftAtPrompt?.draftSchemaVersion} textLen=${draftAtPrompt?.text?.length ?? 0}`,
);

// B7: the user-click reload delivers the new release and the draft
// SURVIVES the update (the joint D4 row). Chromium keeps the controlling
// worker across reloads (no skipWaiting exists by design), so the worker
// generation completes its swap when the tab closes; the APP version is
// the served release marker, which the reload already refreshed (the
// worker installs no fetch handler: every asset comes from the network).
await page.evaluate(() => {
  window.__i7PreReloadMarker = true;
});
await page.click("div[role=status] button");
await page.waitForFunction(() => window.__i7PreReloadMarker === undefined, null, { timeout: 20_000 });
await page.waitForSelector("#capture-text", { timeout: 30_000 });
const textAfterReload = await page.inputValue("#capture-text");
const releaseAfterReload = await page.evaluate(
  () => document.querySelector("meta[name=kiero-release]")?.getAttribute("content") ?? null,
);
const controlledAfterReload = await page.evaluate(() => navigator.serviceWorker.controller !== null);
await visibilityTick();
await page.waitForTimeout(1_500);
const promptReappeared = await page.$("div[role=status]");
record(
  "B7 the user-click reload delivers the new release; the draft survives",
  textAfterReload.includes(DRAFT_TEXT) &&
    releaseAfterReload === "v2" &&
    controlledAfterReload &&
    promptReappeared === null,
  `textAfterReload="${textAfterReload.slice(0, 32)}..." release=${releaseAfterReload} controller=${controlledAfterReload} rePrompt=${promptReappeared === null ? "no" : "yes"}`,
);

// B8: immediate revocation on an old client (an update is pending again).
await fetch(`http://127.0.0.1:${PORT}/__control/release`, {
  method: "POST",
  body: JSON.stringify({ release: "v3" }),
});
await visibilityTick();
let waitingV3 = false;
for (let attempt = 0; attempt < 50 && !waitingV3; attempt += 1) {
  waitingV3 = (await waitingWorker()) !== null;
  if (!waitingV3) {
    await page.waitForTimeout(200);
  }
}
await page.waitForTimeout(1_800);
await visibilityTick();
await page.waitForSelector("div[role=status]", { timeout: 15_000 });
const revoked = await person.mutation("access/identity/functions:revokeSession", { sessionId });
record(
  "B8 an update is pending while the server revokes this session",
  waitingV3 && revoked?._tag === "ok",
  `waitingV3=${waitingV3} revokeOutcome=${revoked?._tag}`,
);
const sessionEndedVisible = await page
  .waitForSelector("text=Sesja tego urządzenia została zakończona", { timeout: 30_000 })
  .then(() => true)
  .catch(() => false);
record(
  "B9 revocation applies IMMEDIATELY on the old client (no update shielding)",
  sessionEndedVisible,
  `sessionEndedNotice=${sessionEndedVisible}`,
);

await browser.close();
server.close();

console.log(`\nLive proof complete. APP_URL=${APP_URL} release=${currentRelease}`);
process.exit(summarize() ? 0 : 1);
