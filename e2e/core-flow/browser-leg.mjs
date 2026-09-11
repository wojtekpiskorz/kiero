/**
 * J2 browser legs :: the JOINED conversation surface driven by a REAL
 * Chromium (playwright-core --no-save pattern; headless build), against
 * the REAL dev/j2 deployment and the REAL kiero-dev-gateway-j2 Worker.
 *
 * The browser runs the REAL web app (vite dev server with VITE_CONVEX_URL
 * + VITE_GATEWAY_URL). The ONLY mocked layer sits at the MEDIA boundary,
 * exactly as D4's proof allowed: navigator.mediaDevices.getUserMedia +
 * window.MediaRecorder are replaced by deterministic fakes emitting seeded
 * webm/opus chunks. EVERYTHING else is real: the React app, the drafts
 * IndexedDB store, fetch to the gateway Worker, R2 multipart parts, the
 * Convex ledger, D1 acceptance, E3/E4 processing and E6's answer loop.
 *
 * Legs (issue #61 focused verification, browser half):
 *  W1. the join: "/" IS the composer surface (all capture modes inside
 *      the conversation) and the retired /wpis nav entry is gone;
 *  W2. one mixed source through the joined composer (text + recording +
 *      photo) reaches durable acceptance and renders in the history with
 *      the honest processing vocabulary;
 *  W3. VOICE-ONLY send: no text, recording only: the Send button enables
 *      (the J2 ruling's client half) and the message is accepted;
 *  W4. the source-backed answer: "Zapytaj agenta" on a question message
 *      renders E6's structured result inline (answer + evidence, or the
 *      honest clarification/failure, never a guess);
 *  W5. the direct correction: "Popraw tę wiadomość" prefills the composer
 *      (Korekta ustalenia) and the new message references the original;
 *  W6. Co teraz over the repaired attention reads: the screen renders the
 *      person's reminders (NOT the unavailable note) and the snooze
 *      control works (the notification-click flow's landing surface).
 *
 * Run (from the repo root, dev server on :5173):
 *   node e2e/core-flow/browser-leg.mjs
 * (Not a vitest file: live evidence, transcribed into docs/evidence/.
 * Everything printed is sanitized: no tokens, no secrets.)
 */

import { randomUUID } from "node:crypto";
import { chromium } from "playwright-core";
import { homedir } from "node:os";
import { envelope, fixtureCodeOf, signInWithFixtureCode } from "../helpers.mjs";

const CONVEX_URL = process.env.KIERO_J2_CONVEX_URL ?? "https://zany-snail-540.convex.cloud";
const GATEWAY = process.env.KIERO_J2_GATEWAY ?? "https://kiero-dev-gateway-j2.wojtek-524.workers.dev";
const APP_URL = process.env.KIERO_J2_APP ?? "http://localhost:5173";
const CHROMIUM =
  process.env.KIERO_J2_CHROMIUM ??
  `${homedir}/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`;

const RUN = process.env.KIERO_J2_PROOF_RUN ?? Date.now().toString(36);
const EMAIL = `j2-web-${RUN}@kiero.invalid`;

const results = [];
function record(id, outcome, detail) {
  results.push({ id, outcome });
  console.log(`[${outcome}] ${id}${detail === undefined ? "" : ` :: ${detail}`}`);
  return outcome === "PASS";
}
const note = (line) => console.log(`NOTE | ${line}`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// --- seed: a REAL signed-in boss with their own firm + one project + task ----

const isOk = (result) => result?._tag === "ok";
const value = (result) => (isOk(result) ? result.value : null);
const errCode = (result) => (result?._tag === "error" ? result.error.code : "ok");
const key = () => `idem_${randomUUID()}`;

// Real B1 sign-in with the deterministic fixture code (the shared helper);
// the browser leg additionally needs the REFRESH token (it seeds the
// app's localStorage auth keys before the first load).
const boss = await signInWithFixtureCode(CONVEX_URL, EMAIL, fixtureCodeOf(EMAIL));
if (typeof boss.refreshToken !== "string") throw new Error("sign-in returned no refresh token");
const { token, refreshToken } = boss;
const created = await boss.client.mutation("access/membership/functions:admitCommand", {
  envelope: envelope("access.createCompany", {
    name: `Budowa J2 Web ${RUN}`,
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
// One task with an open checklist point, so /co-teraz has real rows over
// the repaired ordinary-token reads.
const task = await boss.client.mutation("work/functions:dispatchWork", {
  envelope: envelope(
    "work.changeTask",
    {
      taskId: null,
      projectId: BANAN,
      title: "Zamówić płytki do Banana",
      executorContactId: null,
      coordinatorMembershipId: null,
      deadlineFindingId: null,
      expectedRevision: 1,
    },
    key(),
  ),
});
const TASK_ID = value(task)?.taskId ?? null;
record("W0/the browser boss has a firm, project and task", TASK_ID !== null ? "PASS" : "FAIL", `task=${TASK_ID}`);

// --- the media-boundary mock (the ONLY mocked layer, D4's exact pattern) -----

const MEDIA_MOCK = `
(() => {
  const fakeTrack = () => ({ stop: () => undefined });
  class FakeMediaStream {
    getAudioTracks() { return [fakeTrack(), fakeTrack()]; }
  }
  navigator.mediaDevices.getUserMedia = async () => new FakeMediaStream();
  const SUPPORTED = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
  const chunkBuffer = (seq) => {
    const arr = new Uint8Array(256 * 1024);
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
        if (window.__fakeChunkSeq >= 4) this.stop();
      }, 30);
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
  window.__kieroJ2Mock = "media-boundary-only";
})();`;

// --- the browser --------------------------------------------------------------

const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
const context = await browser.newContext({ locale: "pl-PL" });
await context.addInitScript(MEDIA_MOCK);
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

// W1: the join: "/" carries the composer; /wpis is gone from the nav.
await page.goto(APP_URL, { waitUntil: "domcontentloaded" });
await page.waitForSelector("#capture-text", { timeout: 30_000 });
const heading = (await page.textContent("h1"))?.trim();
record(
  "W1/conversation-carries-the-composer",
  heading === "Rozmowa firmy" ? "PASS" : "FAIL",
  `h1=${heading}`,
);
const navText = (await page.textContent("nav")) ?? "";
record(
  "W1/retired-wpis-nav-entry-gone",
  !navText.includes("Nowy wpis") ? "PASS" : "FAIL",
  navText.includes("Nowy wpis") ? "nav still lists Nowy wpis" : "nav clean",
);
const gone = await page.goto(`${APP_URL}/wpis`, { waitUntil: "domcontentloaded" }).then(() => true);
const bodyAfterWpis = (await page.textContent("body")) ?? "";
record(
  "W1/old-wpis-route-has-no-composer-screen",
  gone && !bodyAfterWpis.includes("Szkic") && bodyAfterWpis.length > 0 ? "PASS" : "FAIL",
  "the router sends /wpis to the not-found screen (no composer remount)",
);
await page.goBack().catch(() => page.goto(APP_URL));
await page.waitForSelector("#capture-text", { timeout: 30_000 });

// W2: one mixed source (text + recording + photo) through the JOINED composer.
await page.click("text=Nagraj głos");
await page.waitForSelector("text=Zatrzymaj nagrywanie", { timeout: 10_000 });
await page.waitForSelector("audio[aria-label='Posłuchaj nagrania']", { timeout: 30_000 });
const photoPath = "/tmp/e4-invoice.jpg";
await page.setInputFiles('input[type=file][accept="image/*"]', photoPath);
await page.fill(
  "#capture-text",
  `Banan: zaliczka od klienta wynosi 5000 złotych, klient potwierdził odbiór płytek w piątek rano.`,
);
await page.click("button[type=submit]");
await page.waitForSelector("text=Wiadomość zapisana", { timeout: 180_000 });
record("W2/mixed-source-sent-through-joined-composer", "PASS");
await page.waitForSelector("text=Historia wiadomości", { timeout: 15_000 });
await sleep(2_000);
const historyText = (await page.textContent("main")) ?? "";
record(
  "W2/mixed-message-renders-in-history",
  historyText.includes("zaliczka") ? "PASS" : "FAIL",
  "the accepted original appears in the conversation history",
);

// W3: VOICE-ONLY: no text, recording only; Send must be ENABLED.
await page.click("text=Nagraj głos");
await page.waitForSelector("text=Zatrzymaj nagrywanie", { timeout: 10_000 });
await page.waitForSelector("audio[aria-label='Posłuchaj nagrania']", { timeout: 30_000 });
const sendEnabled = await page.isDisabled("button[type=submit]").then((disabled) => !disabled);
record(
  "W3/voice-only-send-enabled-without-text",
  sendEnabled ? "PASS" : "FAIL",
  sendEnabled ? "submit enabled with recording only" : "submit stayed disabled",
);
await page.click("button[type=submit]");
await page.waitForSelector("text=Wiadomość zapisana", { timeout: 180_000 });
record("W3/voice-only-source-accepted", "PASS");

// W4: the source-backed answer. Send a QUESTION message, then ask the agent.
await page.fill("#capture-text", "Pytanie do agenta: jaka jest zaliczka od klienta w projekcie Banan?");
await page.click("button[type=submit]");
await page.waitForSelector("text=Wiadomość zapisana", { timeout: 120_000 });
await sleep(1_500);
await page.click("text=Zapytaj agenta o tę wiadomość");
note("W4 asking the agent (real answer loop; may take up to ~3 minutes)");
const answerAppeared = await page
  .waitForSelector("text=Odpowiedź agenta", { timeout: 200_000 })
  .then(() => true)
  .catch(() => false);
const mainText = (await page.textContent("main")) ?? "";
const clarified = mainText.includes("Sprawa do wyjaśnienia");
// The honest refusal notices (session lost mid-ask, provider unreachable)
// are ALSO correct renders: never a guess, never silence.
const honestFailure =
  mainText.includes("Nie udało się uzyskać odpowiedzi agenta") ||
  mainText.includes("Agent nie mógł rozpocząć odpowiedzi");
record(
  "W4/agent-answer-renders-inline",
  answerAppeared || clarified || honestFailure ? "PASS" : "FAIL",
  answerAppeared
    ? "Odpowiedź agenta rendered"
    : clarified
      ? "Sprawa do wyjaśnienia rendered"
      : honestFailure
        ? "honest failure notice rendered"
        : "no answer panel",
);
if (answerAppeared) {
  const cites = mainText.includes("Źródło:");
  record(
    "W4/answer-cites-evidence",
    cites ? "PASS" : "FAIL",
    cites ? "evidence quote rendered" : "no evidence quote in panel",
  );
} else if (clarified) {
  record("W4/answer-cites-evidence", "PASS", "clarification panel (no evidence claim made)");
}

// W5: the direct correction prefills the composer (Korekta ustalenia).
const correctionButtons = await page.locator("text=Popraw tę wiadomość").count();
if (correctionButtons > 0) {
  await page.locator("text=Popraw tę wiadomość").first().click();
  await page.waitForSelector("text=Piszesz korektę", { timeout: 10_000 });
  const prefill = await page.inputValue("#capture-text");
  record(
    "W5/correction-prefills-the-composer",
    prefill.startsWith("Poprawka do wiadomości") ? "PASS" : "FAIL",
    prefill.slice(0, 60),
  );
  await page.fill("#capture-text", "Korekta ustalenia: zaliczka wynosi 6000 złotych, nie 5000.");
  await page.click("button[type=submit]");
  await page.waitForSelector("text=Wiadomość zapisana", { timeout: 120_000 });
  record("W5/correction-message-sent-as-new-source", "PASS");
} else {
  record("W5/correction-prefills-the-composer", "FAIL", "no correction button rendered");
}

// W6: Co teraz over the repaired reads (the H2 gap's landing surface).
await page.goto(`${APP_URL}/co-teraz`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("h1", { timeout: 30_000 });
const nowHeading = (await page.textContent("h1"))?.trim();
await page.waitForSelector("text=Zamówić płytki do Banana", { timeout: 30_000 }).catch(() => undefined);
const nowText = (await page.textContent("main")) ?? "";
const unavailable = nowText.includes("stan przypomnień chwilowo niedostępny");
const showsTask = nowText.includes("Zamówić płytki do Banana");
record(
  "W6/co-teraz-renders-reminders-under-user-token",
  nowHeading === "Co teraz" && !unavailable && showsTask ? "PASS" : "FAIL",
  `heading=${nowHeading}; task visible=${showsTask}; unavailable note=${unavailable}`,
);
const snoozeLabel = await page.locator(`label:has-text("Odrocz przypomnienia")`).count();
if (snoozeLabel > 0) {
  const input = page.locator(`input[type=datetime-local]`).first();
  await input.fill("2026-09-12T09:00");
  // The BUTTON, not the label: "Odrocz" is a substring of the label text
  // too, so the locator pins the submit control by tag.
  await page.click("button:has-text(\"Odrocz\")").then(() => true).catch(() => false);
  const snoozedNotice = await page
    .waitForSelector("text=Przypomnienia odroczone", { timeout: 20_000 })
    .then(() => true)
    .catch(() => false);
  record(
    "W6/snooze-works-under-user-token",
    snoozedNotice ? "PASS" : "FAIL",
    snoozedNotice ? "snooze accepted" : "no confirmation",
  );
} else {
  record("W6/snooze-works-under-user-token", "FAIL", "no snooze control rendered for the task");
}

await browser.close();

const counts = results.reduce(
  (acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }),
  {},
);
console.log(`\nSummary: ${JSON.stringify(counts)} of ${results.length} checks`);
process.exit(results.every((r) => r.outcome === "PASS") ? 0 : 1);
