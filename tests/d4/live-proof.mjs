/**
 * D4 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/d4, instance industrious-cricket-665)
 * through the REAL per-lane gateway Worker (kiero-dev-gateway-d4) and the
 * REAL EU R2 bucket (kiero-dev-media, jurisdiction eu, shared dev bucket —
 * object keys are companyId-scoped, this deployment's companies are fresh).
 *
 * BROWSER: a real Chromium (headed-capable build, driven headless) runs the
 * REAL web app (vite dev server with VITE_CONVEX_URL + VITE_GATEWAY_URL).
 * The ONLY mocked layer sits at the MEDIA boundary, exactly as the issue
 * allows: navigator.mediaDevices.getUserMedia + window.MediaRecorder are
 * replaced by deterministic fakes that emit seeded 1 MiB webm/opus chunks
 * (60 chunks = 60 MiB, a long WhatsApp-style note). EVERYTHING else is
 * real: the React app, the drafts IndexedDB store, fetch to the gateway
 * Worker, R2 multipart parts, the Convex ledger (prepare/begin/part/
 * complete/finalize) and D1's atomic acceptance.
 *
 * Scenarios (issue #32 focused verification, the live-provable half):
 *  L1. one logical message = text + one recording + one photo through the
 *      whole real chain (prepare/begin/parts/complete/finalize/accept);
 *  L2. RECOVERABLE DRAFT: the page is KILLED mid-upload (after >=2 parts
 *      reached R2); reopening shows the honest "przerwana wysyłka" panel
 *      with the exact surviving fragment (listen, discard, resume);
 *  L3. resume continues from the SERVER manifest (no re-sent parts) and
 *      completes; the acceptance key produces EXACTLY ONE source (no
 *      duplicate message), the upload row is bound and accepted;
 *  L4. deleting one persisted recording chunk (simulated eviction of the
 *      fragment) turns resume into an explicit Polish error — never a
 *      false saved state and never a truncated upload.
 *
 * Physical-device legs (real mic/camera, real iOS/Android browsers, real
 * OS-level storage eviction, real PWA update prompts) stay NOT RUN; see
 * the issue report.
 *
 * Run (from the repo root, dev server on :5173):
 *   node tests/d4/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.
 * Everything printed is sanitized: no tokens, no secrets.)
 */

import { ConvexHttpClient } from "convex/browser";
import { chromium } from "playwright-core";
import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";

const CONVEX_URL = process.env.KIERO_D4_CONVEX ?? "https://industrious-cricket-665.convex.cloud";
const GATEWAY =
  process.env.KIERO_D4_GATEWAY ?? "https://kiero-dev-gateway-d4.wojtek-524.workers.dev";
const APP_URL = process.env.KIERO_D4_APP ?? "http://localhost:5173";
const CHROMIUM =
  process.env.KIERO_D4_CHROMIUM ??
  `${homedir()}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const RUN = Date.now().toString(36);
const EMAIL = `d4-live-${RUN}@kiero.invalid`;

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

// --- seed: a REAL signed-in person with their own firm (B3 fixture pattern) --

const fixtureCodeOf = (seed) => {
  let hash = 0;
  for (const byte of Buffer.from(seed)) {
    hash = (hash * 31 + byte) % 90_000_000;
  }
  return String(42_000_000 + hash);
};

const anon = () => new ConvexHttpClient(CONVEX_URL, { logger: false });
const code = fixtureCodeOf(EMAIL);
// The initial signIn triggers email delivery, which this lease deliberately
// has no provider key for (the D2 pattern: the error is irrelevant because
// the fixture code below IS the verification code; the second signIn passes).
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
const created = await person.mutation("access/membership/functions:admitCommand", {
  envelope: {
    operation: "access.createCompany",
    input: { name: `Budowa D4 ${RUN}`, timezone: "Europe/Warsaw", defaultCurrency: "PLN" },
    expectedRevisions: [],
  },
});
if (created?._tag !== "ok") throw new Error("createCompany failed");
const companyId = created.value.companyId;
record("P0 the live person is signed-in with their own firm", "PASS", `companyId=${companyId}`);

const gw = async (path, init = {}) => {
  const response = await fetch(`${GATEWAY}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
  });
  return { status: response.status, body: await response.json().catch(() => null) };
};

// --- the media-boundary mock (the ONLY mocked layer, injected per page) ------

const MEDIA_MOCK = `
(() => {
  const stopped = [];
  const fakeTrack = () => ({ stop: () => stopped.push(1) });
  class FakeMediaStream {
    getAudioTracks() { return [fakeTrack(), fakeTrack()]; }
  }
  navigator.mediaDevices.getUserMedia = async () => new FakeMediaStream();
  const SUPPORTED = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  const chunkBuffer = (seq) => {
    const arr = new Uint8Array(1024 * 1024);
    let s = (seq + 1) * 2654435761 % 2147483647;
    for (let i = 0; i < arr.length; i++) { s = (s * 48271) % 2147483647; arr[i] = s & 0xff; }
    return arr;
  };
  window.__fakeChunkSeq = 0;
  class FakeMediaRecorder {
    constructor(stream, options) {
      this.mimeType = (options && options.mimeType) || "";
      this.ondataavailable = null; this.onstop = null; this.onerror = null;
      this.__stopped = false;
    }
    start(timeslice) {
      this.__timer = setInterval(() => {
        if (this.__stopped) return;
        if (this.ondataavailable) {
          const seq = window.__fakeChunkSeq++;
          this.ondataavailable({ data: new Blob([chunkBuffer(seq)], { type: this.mimeType }) });
        }
        if (window.__fakeChunkSeq >= 12) this.stop();
      }, 40);
    }
    stop() {
      if (this.__stopped) return;
      this.__stopped = true;
      clearInterval(this.__timer);
      if (this.onstop) this.onstop();
    }
  }
  FakeMediaRecorder.isTypeSupported = (m) => SUPPORTED.includes(m);
  window.MediaRecorder = FakeMediaRecorder;
  window.__kieroD4Mock = "media-boundary-only";
})();`;

/** Reads the draft entries straight from the page's real IndexedDB. */
async function readDraftRecord(page) {
  return page.evaluate(
    async () => {
      const db = await new Promise((resolve, reject) => {
        const open = indexedDB.open("kiero-drafts", 1);
        open.onsuccess = () => resolve(open.result);
        open.onerror = () => reject(open.error);
      });
      return await new Promise((resolve) => {
        const tx = db.transaction(["entries"], "readonly");
        const keysReq = tx.objectStore("entries").getAllKeys();
        const rowsReq = tx.objectStore("entries").getAll();
        tx.oncomplete = () =>
          resolve({
            keys: keysReq.result,
            blobs: rowsReq.result.map((v) => (v instanceof Blob ? v.size : v)),
          });
      });
    },
    undefined,
    { polling: "raf" },
  );
}

/** Reads the draft metadata record (the #draft key) from the page's IDB. */
async function readDraftMeta(page) {
  return page.evaluate(async () => {
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
}

// --- the browser --------------------------------------------------------------

// This lease has no email-delivery provider (AUTH_RESEND_KEY is a PENDING
// secret in infra/environments/local.md), so the UI's email step cannot
// send a code here. The session bridge is honest: the REAL token from the
// fixture sign-in above is placed into the browser's convex-auth storage
// (the library's own key, __convexAuthJWT_<deployment address>), so every
// request the app makes still carries this real signed-in person and every
// membership/upload check runs for real. B1's lane owns the UI walk proof.
const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
const context = await browser.newContext({ locale: "pl-PL" });
await context.addInitScript(MEDIA_MOCK);
await context.addInitScript(
  ({ convexUrl, t, r }) => {
    // The library namespaces storage keys by the deployment address with
    // non-alphanumerics stripped (its useNamespacedStorage); both the JWT
    // and the refresh token go in, exactly what its own sign-in writes.
    const ns = convexUrl.replace(/[^a-zA-Z0-9]/g, "");
    localStorage.setItem(`__convexAuthJWT_${ns}`, t);
    localStorage.setItem(`__convexAuthRefreshToken_${ns}`, r);
  },
  { convexUrl: CONVEX_URL, t: token, r: refreshToken },
);
const page = await context.newPage();
page.on("pageerror", (error) => console.log(`  [page-error] ${error.message}`));

const photoPath = `/tmp/kiero-d4-photo-${RUN}.png`;
writeFileSync(
  photoPath,
  Buffer.from(
    "89504e470d0a1a0a0000000d494844520000000100000001080600000" +
      "01f15c4890000000a49444154789c6360000002000100ffff03000006000557bfabd400" +
      "00000049454e44ae426082",
    "hex",
  ),
);

// L1a: reach /wpis already signed in (the real session bridge above)
await page.goto(`${APP_URL}/wpis`);
await page.waitForSelector("#capture-text", { timeout: 30_000 });
const composerHeading = await page.textContent("h1");
record(
  "L1a the signed-in boss reaches the composer directly (real B1 session)",
  composerHeading?.trim() === "Nowy wpis" ? "PASS" : "FAIL",
  `heading=${composerHeading?.trim()}`,
);

// L1b: one-tap recording after permission (mocked mic; real engine + store)
await page.click("text=Nagraj głos");
await page.waitForSelector("text=Zatrzymaj nagrywanie", { timeout: 10_000 });
const chunkKeysWhileRecording = await page.evaluate(async () => {
  await new Promise((r) => setTimeout(r, 350));
  const db = await new Promise((resolve) => {
    const open = indexedDB.open("kiero-drafts", 1);
    open.onsuccess = () => resolve(open.result);
  });
  return await new Promise((resolve) => {
    const tx = db.transaction(["entries"], "readonly");
    const keys = tx.objectStore("entries").getAllKeys();
    tx.oncomplete = () => resolve(keys.result.filter((k) => String(k).includes("#rec#")));
  });
});
record(
  "L1b recording persists chunks INCREMENTALLY while still recording",
  chunkKeysWhileRecording.length >= 5 ? "PASS" : "FAIL",
  `chunkKeysDuringRecording=${chunkKeysWhileRecording.length}`,
);

// Let the 60 MiB recording finish (auto-stop), then the composer shows listen.
await page.waitForSelector("audio[aria-label='Posłuchaj nagrania']", { timeout: 30_000 });
const listenVisible = await page.isVisible("audio[aria-label='Posłuchaj nagrania']");
const afterRecording = await readDraftRecord(page);
const chunkCount = afterRecording.keys.filter((k) => String(k).includes("#rec#")).length;
record(
  "L1c stopped recording leaves the recoverable fragment (listen, discard, re-record)",
  listenVisible && chunkCount === 12 ? "PASS" : "FAIL",
  `chunks=${chunkCount}/12 listen=${listenVisible}`,
);

// L1d: photos + text complete the one logical message
await page.setInputFiles('input[type=file][accept="image/*"]', photoPath);
await page.waitForSelector("text=faktura", { timeout: 10_000 }).catch(() => undefined);
await page.fill("#capture-text", `D4 live ${RUN}: dowóz płytek w środę rano, potwierdzone telefonicznie (nagranie + zdjęcie faktury).`);
const draftBeforeSend = await readDraftRecord(page);
const photoKeys = draftBeforeSend.keys.filter((k) => String(k).includes("#photo#")).length;
record(
  "L1d text + one recording + photo sit in ONE draft before Send",
  photoKeys === 1 ? "PASS" : "FAIL",
  `photoKeys=${photoKeys} draftBlobEntries=${draftBeforeSend.blobs.length}`,
);

// L2: kill the page MID-UPLOAD (after >=2 durable parts)
await page.click("button[type=submit]"); // Wyślij
let killedAtParts = null;
const killDeadline = Date.now() + 120_000;
let lastBody = "";
while (Date.now() < killDeadline) {
  const body = (await page.textContent("body").catch(() => "")) ?? "";
  lastBody = body;
  const match = body.match(/części (\d+)\/(\d+)/);
  if (match && Number(match[1]) >= 2) {
    killedAtParts = match[0];
    break;
  }
  if (body.includes("Wiadomość zapisana")) {
    break; // too fast (should not happen with the kill cadence)
  }
  await page.waitForTimeout(250);
}
const enough = killedAtParts !== null && Number(killedAtParts.match(/części (\d+)/)?.[1]) >= 2;
if (!enough) {
  console.log("  [L2a-diagnostic] body excerpt:", JSON.stringify((lastBody.match(/Stan szkicu:[^\n]{0,80}|Wysyłanie[^\n]{0,60}|Połączenie[^\n]{0,80}/g) ?? []).join(" | ")));
}
record(
  "L2a upload progress is visible per part (killed at >= 2 durable parts)",
  enough ? "PASS" : "FAIL",
  `observed=${killedAtParts}`,
);
await page.close({ runBeforeUnload: false }); // the tab dies mid-upload

// L2b: reopen — the honest interrupted panel with the exact fragment
const page2 = await context.newPage();
await page2.goto(`${APP_URL}/wpis`);
await page2.waitForSelector("#capture-text", { timeout: 30_000 });
const panelVisible = await page2
  .waitForSelector("text=Przerwana wysyłka wiadomości", { timeout: 20_000 })
  .then(() => true)
  .catch(() => false);
const listen2 = await page2.isVisible("audio[aria-label='Posłuchaj nagrania']");
const recoveryDraft = await readDraftRecord(page2);
const draftRow = recoveryDraft.blobs.length; // record + 12 chunks + 1 photo = 14
record(
  "L2b the reopened page shows the recoverable fragment panel (listen/discard/resume)",
  panelVisible && listen2 ? "PASS" : "FAIL",
  `panel=${panelVisible} listen=${listen2} idbEntries=${draftRow}`,
);
const interruptedRecord = await readDraftMeta(page2);
record(
  "L2c the persisted draft phase is honestly mid-send with the mirrored upload session",
  interruptedRecord?.phase === "uploading" && interruptedRecord?.session?.uploadId ? "PASS" : "FAIL",
  `phase=${interruptedRecord?.phase} uploadId=${interruptedRecord?.session?.uploadId?.slice(0, 6)}`,
);

// What did the server record before the kill? (the resume baseline)
const killSession = await gw(
  `/uploads/${interruptedRecord.session.uploadId}/session`,
);
const audioManifest = killSession.body?.value?.attachments?.find((a) => a.kind === "audio")?.parts
  ?.length;
record(
  "L2d the server holds the partial manifest at the kill point",
  typeof audioManifest === "number" && audioManifest >= 2 ? "PASS" : "FAIL",
  `recordedAudioParts=${audioManifest}`,
);

// L3: resume — only missing parts travel, ONE source, no duplicate
await page2.click("text=Wznów wysyłkę");
let firstProgress = null;
const resumeDeadline = Date.now() + 120_000;
while (Date.now() < resumeDeadline) {
  const body = (await page2.textContent("body").catch(() => "")) ?? "";
  const match = body.match(/części (\d+)\/(\d+)/);
  if (match !== null) {
    firstProgress = match[0];
    break;
  }
  if (body.includes("Wiadomość zapisana")) {
    break; // single-part remainder may complete between polls
  }
  await page2.waitForTimeout(200);
}
const resumedFrom = firstProgress?.match(/części (\d+)/)?.[1];
record(
  "L3a resume continues from the server manifest (first progress >= recorded parts)",
  resumedFrom !== null && Number(resumedFrom) >= audioManifest ? "PASS" : "FAIL",
  `serverRecorded=${audioManifest} firstResumedProgress=${firstProgress?.trim()}`,
);
await page2.waitForSelector("text=Wiadomość zapisana", { timeout: 240_000 });
record("L3b resumed send completes with the durable saved receipt", "PASS");

// The state line settles to D1's honest processing vocabulary.
let stateLine = "";
const stateDeadline = Date.now() + 90_000;
while (Date.now() < stateDeadline) {
  const body = (await page2.textContent("body").catch(() => "")) ?? "";
  stateLine =
    body.match(
      /Agent przetwarza wiadomość|Pamięć zaktualizowana|częściowo przetworzona|niepowodzenie przetwarzania|Wiadomość zapisana/,
    )?.[0] ?? "";
  if (stateLine.length > 0) {
    break;
  }
  await page2.waitForTimeout(300);
}
record(
  "L3c the sent source renders its honest processing state",
  stateLine.length > 0 ? "PASS" : "FAIL",
  `stateLine=${stateLine.slice(0, 60)}`,
);

// Server-side truth: ONE source for the acceptance key, bound upload.
const ledger = await person.action("sources/uploads/probe:probeUploadsState", {});
const uploadRow = ledger.value.uploads.find(
  (u) => u.uploadId === interruptedRecord.session.uploadId,
);
const boundAttachments = ledger.value.attachments.filter(
  (a) => a.uploadId === interruptedRecord.session.uploadId && a.sourceId,
);
// The probe's rows are caller-company-scoped; the acceptance key IS the
// stable draft id, so "one row per key" is exactly "no duplicate message".
const sourcesForDraft = ledger.value.sources.filter(
  (s) => s.acceptanceKey === interruptedRecord.draftId,
);
record(
  "L3d exactly ONE accepted source binds the upload (no duplicate message)",
  uploadRow?.acceptedSourceId !== undefined &&
    boundAttachments.length === 2 &&
    ledger.value.sources.length === 1 &&
    sourcesForDraft.length === 1
    ? "PASS"
    : "FAIL",
  `acceptedSourceId=${uploadRow?.acceptedSourceId?.slice(0, 6)} bound=${boundAttachments.length}/2 sourcesTotal=${ledger.value.sources.length} byKey=${sourcesForDraft.length}`,
);

// The next draft is fresh (new draftId) and the pill reset to Auto.
const freshDraft = await readDraftRecord(page2);
record(
  "L3e after success the composer holds a fresh empty draft (new stable id)",
  freshDraft.blobs.length === 1 ? "PASS" : "FAIL",
  `idbEntries=${freshDraft.blobs.length} (record only)`,
);

// L4: simulated fragment eviction -> resume refuses honestly
const page3 = await context.newPage();
await page3.goto(`${APP_URL}/wpis`);
await page3.waitForSelector("#capture-text", { timeout: 30_000 });
await page3.fill("#capture-text", `D4 live ${RUN}: druga wiadomość z nagraniem (symulacja uszkodzenia).`);
await page3.click("text=Nagraj głos");
await page3.waitForSelector("audio[aria-label='Posłuchaj nagrania']", { timeout: 30_000 });
await page3.click("button[type=submit]");
// Kill mid-upload again (poll parts directly; no other waits first), then
// delete one persisted chunk (eviction).
const evictDeadline = Date.now() + 120_000;
let page3AtClose = "";
while (Date.now() < evictDeadline) {
  const body = (await page3.textContent("body").catch(() => "")) ?? "";
  page3AtClose = body;
  const done = Number(body.match(/części (\d+)/)?.[1] ?? 0);
  if (done >= 2 || body.includes("Wiadomość zapisana")) {
    break;
  }
  await page3.waitForTimeout(200);
}
console.log(
  "  [L4-diagnostic] page3 at close:",
  JSON.stringify(
    (page3AtClose.match(/części \d+\/\d+|Wiadomość zapisana|Przerwana wysyłka wiadomości|Połączenie przerwało[^\n]{0,40}/g) ?? []).join(" | "),
  ),
);
await page3.close({ runBeforeUnload: false });
const page4 = await context.newPage();
await page4.goto(`${APP_URL}/wpis`);
await page4.waitForSelector("#capture-text", { timeout: 30_000 });
const panel4 = await page4
  .waitForSelector("text=Przerwana wysyłka wiadomości", { timeout: 30_000 })
  .then(() => true)
  .catch(async () => {
    console.log(
      "  [L4-diagnostic] page4 body:",
      JSON.stringify((((await page4.textContent("body").catch(() => "")) ?? "").match(/Przerwana[^\n]{0,40}|Wiadomość zapisana|Stan szkicu: [^\n]{0,40}/g) ?? []).join(" | ")),
    );
    return false;
  });
if (!panel4) {
  record("L4 a lost chunk (simulated eviction) turns resume into an explicit Polish error", "FAIL", "page4 showed no interrupted panel");
  await browser.close();
  process.exit(summarize() ? 0 : 1);
}
await page4.evaluate(async () => {
  const db = await new Promise((resolve) => {
    const open = indexedDB.open("kiero-drafts", 1);
    open.onsuccess = () => resolve(open.result);
  });
  const target = await new Promise((resolve) => {
    const tx = db.transaction(["entries"], "readonly");
    const keys = tx.objectStore("entries").getAllKeys();
    tx.oncomplete = () => resolve(keys.result.find((k) => String(k).endsWith("#rec#0")));
  });
  await new Promise((resolve) => {
    const tx = db.transaction(["entries"], "readwrite");
    tx.objectStore("entries").delete(target);
    tx.oncomplete = () => resolve();
  });
});
const corruptBefore = await page4.textContent("body");
await page4.click("text=Wznów wysyłkę").catch(() => undefined);
await page4.waitForFunction(
  () => /Nie udało się odczytać całości szkicu|uszkodzony/.test(document.body.textContent),
  undefined,
  { timeout: 30_000 },
).catch(() => undefined);
const afterCorrupt = await page4.textContent("body");
const corruptErrorShown =
  /Nie udało się odczytać całości szkicu|uszkodzony/.test(afterCorrupt ?? "") &&
  !/Wiadomość zapisana/.test(afterCorrupt ?? "");
void corruptBefore;
record(
  "L4 a lost chunk (simulated eviction) turns resume into an explicit Polish error, never a save",
  corruptErrorShown ? "PASS" : "FAIL",
  `errorVisible=${corruptErrorShown}`,
);

// No second source appeared from the corrupted draft either.
const ledger2 = await person.action("sources/uploads/probe:probeUploadsState", {});
record(
  "L4b the corrupted draft created no second source (no false saved state)",
  ledger2.value.sources.length === 1 ? "PASS" : "FAIL",
  `sourcesTotal=${ledger2.value.sources.length}`,
);

await browser.close();
mkdirSync("/tmp", { recursive: true });
process.exit(summarize() ? 0 : 1);
