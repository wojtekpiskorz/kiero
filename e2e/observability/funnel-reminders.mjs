#!/usr/bin/env node
/**
 * The I11 funnel + task-reminder driver (issue #138): one namespaced
 * ORDINARY user session against the live staging web origin, exercising
 * the notification trigger chains through their designed surfaces only.
 *
 * Stages:
 *   R1  fresh mailbox + delivered-OTP sign-in (no GM, no fixtures).
 *   R2  company creation on /firma with an explicit company timezone whose
 *       local clock is OUTSIDE the default quiet hours (20:00-06:00) and
 *       past 07:00 local, so a date-only deadline whose reminder instant
 *       already passed clamps to ONE prompt that may fire during the run.
 *   R3  one source message carrying: an explicit deadline ustalenie
 *       request, a unique run marker and a fake credential-shaped token
 *       (the leak-scan probes that none of it ever reaches a diagnostic
 *       event or the sink payload).
 *   R4  one live agent answer ("Zapytaj agenta"); an honest refusal is an
 *       acceptable outcome and is recorded as such.
 *   R5  project identification on /projekty.
 *   R6  task WITH a bound date ustalenie on /praca (the dated slot).
 *   R7  task WITHOUT a deadline (the evaluator's no_deadline state).
 *   R8  /powiadomienia: the honest web-push device state (physical-device
 *       delivery is J4's; only the designed enable path is exercised).
 *   R9  /co-teraz: the personal reminder projection lines.
 *   R10 the personal snooze ("Odroczenie przypomnień").
 *   R11 evaluator wait: poll /co-teraz until the reminder line settles,
 *       then one Convex snapshot export for the server truth of the run's
 *       own company (schedules, intents, deliveries) + marker leak scan.
 *
 * Run:
 *   node e2e/observability/funnel-reminders.mjs --out /tmp/kiero-i11/funnel-run
 * Env: KIERO_I11_CHROMIUM (Chromium executable), defaults to the VPS path.
 */

import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : fallback;
};

const WEB = value("--web", "https://kiero-staging-web.wojtek-524.workers.dev");
const OUT = value("--out", "/tmp/kiero-i11/funnel-run");
const DEPLOYMENT = value("--deployment", "wojtek-piskorz-jr:kiero-dev-core:staging");
const CHROMIUM = process.env.KIERO_I11_CHROMIUM ?? "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";
/** Local clock outside the default quiet hours and past 07:00 local. */
const COMPANY_TIMEZONE = value("--timezone", "America/Los_Angeles");
mkdirSync(OUT, { recursive: true });

const { recorder, writeJson, runId, exportSnapshot, summarizeSnapshot, companyIdByName } = await import(
  "./lib/snapshot.mjs"
);
const rec = recorder();
const id = runId();
const MARKER = `I11OBS${id}`;
const FAKE_TOKEN = `sk-proj-I11OBS${id}`;
const COMPANY_NAME = `Firma I11 Obs ${id}`;
const PROJECT_NAME = `I11 Obs ${id}`;
const DATED_TASK = `Wycena I11 ${id}`;
const UNDATED_TASK = `Zadanie bez terminu I11 ${id}`;
/** A plain future-in-local-time date; the company zone keeps it "today". */
const deadlineDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: COMPANY_TIMEZONE,
}).format(new Date());

// --- R1: fresh mailbox + delivered-OTP sign-in --------------------------------
const mailbox = JSON.parse(
  (await run("node", [join(here, "..", "..", "tools", "smoke", "mailbox.mjs"), "account", "--out", `${OUT}/mailbox.json`])).stdout,
);
console.log(`[mailbox] ${mailbox.address} (${mailbox.provider})`);

const browser = await chromium.launch({ executablePath: CHROMIUM, headless: true });
const page = await (await browser.newContext({ locale: "pl-PL" })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
const snap = async (tag) => {
  const body = await page.evaluate(() => document.body?.innerText ?? "");
  await page.screenshot({ path: `${OUT}/${tag}.png`, fullPage: true });
  writeFileSync(`${OUT}/${tag}.txt`, body);
  return body;
};
/** Waits for a control to appear (SPA reload + live-query settle). */
const waitForControl = async (selector, label) => {
  try {
    await page.locator(selector).first().waitFor({ state: "visible", timeout: 20000 });
    return true;
  } catch {
    await snap(`missing-${label}`);
    return false;
  }
};

await page.goto(WEB, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
await page.getByLabel("Adres e-mail").fill(mailbox.address);
// The mailbox is brand new (no earlier mail), and the OTP can land in the
// SAME second as the request: start the poll window 60s BEFORE the click
// instead of at it, or the since-filter races the delivery.
const since = new Date(Date.now() - 60_000).toISOString();
await page.getByRole("button", { name: "Wyślij kod" }).click();
await page.waitForTimeout(2000);
const { stdout } = await run("node", [
  join(here, "..", "..", "tools", "smoke", "mailbox.mjs"), "wait-code",
  "--address", mailbox.address, "--password", mailbox.password,
  "--since", since, "--timeout", "720",
]);
const code = /CODE=(\d{8})/.exec(stdout)?.[1];
if (code === undefined) throw new Error(`mailbox CLI returned no code: ${stdout}`);
await page.getByLabel("Kod z wiadomości").fill(code);
await page.getByRole("button", { name: "Zaloguj się kodem" }).click();
await page.waitForTimeout(6000);
const afterLogin = await snap("r1-login");
rec[afterLogin.includes("Nie należysz jeszcze") ? "pass" : "fail"](
  "R1 OTP sign-in",
  "delivered code signs in; no company yet",
  afterLogin.includes("Nie należysz jeszcze") ? "signed in (no company yet)" : firstLine(afterLogin),
);

// --- R2: company creation with the explicit company timezone ------------------
await page.goto(`${WEB}/firma`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500);
const nameField = page.getByLabel("Nazwa firmy");
if ((await nameField.count()) !== 1) throw new Error("/firma did not render the creation form");
await nameField.fill(COMPANY_NAME);
const timezoneField = page.locator("#create-company-timezone");
// Hoisted BEFORE the submit click: the creation form unmounts on success,
// so counting the field afterwards would always read "absent".
const timezoneSet = (await timezoneField.count()) === 1;
if (timezoneSet) {
  await timezoneField.fill(COMPANY_TIMEZONE);
}
await page.getByRole("button", { name: "Załóż firmę" }).click();
await page.waitForTimeout(6000);
const afterCompany = await snap("r2-company");
const companyOk = afterCompany.includes("Jesteś administratorem tej firmy");
rec[companyOk ? "pass" : "fail"](
  "R2 company created",
  `first administrator copy; timezone ${COMPANY_TIMEZONE}`,
  companyOk
    ? `created as administrator (timezone ${timezoneSet ? COMPANY_TIMEZONE : "not set (field absent)"}, local date ${deadlineDate})`
    : firstLine(afterCompany),
);

// --- R3: the source message (marker + fake credential + deadline request) -----
await page.goto(WEB, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
const composer = page.getByLabel("Treść wiadomości");
if ((await composer.count()) !== 1) throw new Error("conversation composer missing");
await composer.fill(
  `Projekt ${PROJECT_NAME}: klient Kaczmarek zamówił wycenę płytek na taras. ` +
    `Proszę zapisz ustalenie: termin oddania wyceny to ${deadlineDate} (cały dzień, bez godziny). ` +
    `Klucz testowy dostawcy (nieprawdziwy): ${FAKE_TOKEN}. Marker uruchomienia: ${MARKER}.`,
);
await page.getByRole("button", { name: "Wyślij" }).click();
await page.waitForTimeout(12000);
const afterMessage = await snap("r3-message");
rec[afterMessage.includes(MARKER) ? "pass" : "fail"](
  "R3 source message",
  "message visible in the feed",
  afterMessage.includes(MARKER) ? "sent and visible (marker present)" : "message not visible yet",
);

// --- R4: the live agent answer -------------------------------------------------
// The answer block or its honest refusal copy (H1's rendering vocabulary).
const ANSWER_OR_REFUSAL = /Odpowiedź agenta|Nie udało się uzyskać odpowiedzi|Dostawca modelu nie odpowiedział/;
await page.waitForTimeout(8000);
const ask = page.getByRole("button", { name: "Zapytaj agenta o tę wiadomość" });
let agentOutcome = "ask control missing";
if ((await ask.count()) >= 1) {
  await ask.first().click();
  await page.waitForTimeout(35000);
  const afterAgent = await snap("r4-agent");
  agentOutcome = ANSWER_OR_REFUSAL.test(afterAgent)
    ? `agent output rendered: ${excerpt(afterAgent, 160)}`
    : "no agent output in the window";
}
// The matcher must see the ANSWER BLOCK or the honest refusal copy, never
// the composer's own message text (the "ustale" class matched R3's source).
const answered = ANSWER_OR_REFUSAL.test(
  await page.evaluate(() => document.body?.innerText ?? ""),
);
rec[answered ? "pass" : "fail"](
  "R4 agent answer",
  "a live agent answer or its honest refusal",
  agentOutcome,
);

// --- R5: wait for the agent's project publication ------------------------------
// The /projekty identification UI is honestly "W przygotowaniu" (pending
// implementation in the deployed app): a Projekt arises from the FIRST
// CLIENT INQUIRY, i.e. the agent's memory publication of the message just
// sent. Poll /praca until the task form's project select carries an option
// (the form renders only when at least one project exists), bounded.
let projectReady = false;
let afterProject = "";
for (let attempt = 0; attempt < 10 && !projectReady; attempt += 1) {
  await page.goto(`${WEB}/praca`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(6000);
  afterProject = await snap(`r5-work-wait-${attempt}`);
  const options = await page.locator("#task-edit-project option").allTextContents().catch(() => []);
  projectReady = options.filter((label) => label.trim() !== "").length > 0;
  if (!projectReady && attempt < 9) await page.waitForTimeout(24000);
}
rec[
  projectReady ? "pass" : "fail"
](
  "R5 project published by the agent",
  "a project exists after the source message (the /projekty UI is pending; projects come from the agent)",
  projectReady
    ? `task form ready; project options: ${JSON.stringify((await page.locator("#task-edit-project option").allTextContents()).slice(0, 4))}`
    : `no project after the wait window: ${excerpt(afterProject, 140)}`,
);

// --- R6/R7: the two tasks (dated slot + undated) -------------------------------
if (projectReady) {
  // The project select carries only real project options (no empty row):
  // the first one is this run's agent-published project.
  await page.locator("#task-edit-project").selectOption({ index: 0 });
  // The term options load through a live query once the project state settles.
  await page.waitForTimeout(3000);

  // Dated task: bind the deadline to a temporal ustalenie when one exists.
  const deadlineSelect = page.locator("#task-edit-deadline");
  const deadlineOptions = await deadlineSelect.locator("option").allTextContents();
  const bindable = deadlineOptions.filter(
    (label) => !/nowe zadanie|brak ustaleń|bez terminu|^\(brak\)$|—/.test(label.trim()),
  );
  // A bindable option must be a real date label, selected by VALUE (never a
  // positional index): the pass condition includes the binding itself.
  const datedLabel = bindable.find((label) => /\d{2}\.\d{2}\.\d{4}|\d{4}-\d{2}-\d{2}/.test(label)) ?? null;
  let datedBound = false;
  if (datedLabel !== null) {
    await deadlineSelect.selectOption({ label: datedLabel });
    datedBound = true;
  }
  await page.locator("#task-edit-title").fill(DATED_TASK);
  await page.getByRole("button", { name: "Zapisz zadanie" }).click();
  await page.waitForTimeout(5000);
  let afterTask = await snap("r6-dated-task");
  const taskSaved = afterTask.includes(DATED_TASK);
  rec[taskSaved && datedBound ? "pass" : "fail"](
    "R6 dated task saved",
    "task created with the deadline bound to the temporal ustalenie",
    taskSaved
      ? datedBound
        ? `${DATED_TASK} created with deadline binding: ${JSON.stringify(datedLabel)}`
        : `${DATED_TASK} created but NO date-labelled ustalenie option existed (deadline left empty; the binding did not happen)`
      : firstLine(afterTask),
  );

  // Undated task: the evaluator's no_deadline state.
  await page.locator("#task-edit-title").fill(UNDATED_TASK);
  await deadlineSelect.selectOption({ index: 0 });
  await page.getByRole("button", { name: "Zapisz zadanie" }).click();
  await page.waitForTimeout(5000);
  afterTask = await snap("r7-undated-task");
  rec[afterTask.includes(UNDATED_TASK) ? "pass" : "fail"](
    "R7 undated task saved",
    "second task created without a deadline",
    afterTask.includes(UNDATED_TASK) ? `${UNDATED_TASK} created (no deadline)` : firstLine(afterTask),
  );
} else {
  rec.notRun(
    "R6 dated task saved",
    "task with a bound date ustalenie",
    "no project existed after the wait window, so the /praca form stayed hidden",
  );
  rec.notRun(
    "R7 undated task saved",
    "task without a deadline",
    "no project existed after the wait window, so the /praca form stayed hidden",
  );
}

// --- R8: the honest push device state -------------------------------------------
await page.goto(`${WEB}/powiadomienia`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
const pushBefore = await snap("r8-push-before");
const serverConfigured = !pushBefore.includes("Ten serwer nie ma jeszcze skonfigurowanych kluczy push");
rec.note(
  "R8 server push keys",
  "VAPID present server-side (no serverNotConfigured copy)",
  serverConfigured
    ? "server reports push configured; screen rendered"
    : `server reports NOT configured: ${excerpt(pushBefore, 140)}`,
);
const enable = page.getByRole("button", { name: "Włącz na tym urządzeniu" });
if ((await enable.count()) === 1) {
  await enable.click();
  await page.waitForTimeout(8000);
}
const pushAfter = await snap("r8-push-after");
const pushOutcome = pushAfter.includes("Powiadomienia włączone")
  ? "registered (unexpected in headless Chromium)"
  : pushAfter.includes("Uprawnienie odrzucone") || pushAfter.includes("uprawnienie")
    ? "honest permission-denied recovery copy"
    : pushAfter.includes("nie obsługuje")
      ? "honest unsupported-browser copy"
      : excerpt(pushAfter, 140);
rec.note(
  "R8 enable push on this device",
  "the designed enable path; headless Chromium cannot hold a real subscription",
  pushOutcome,
);

// --- R9: the personal reminder projection ---------------------------------------
await page.goto(`${WEB}/co-teraz`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
const coTeraz = await snap("r9-co-teraz");
const reminderLineOf = (task) => {
  const at = coTeraz.indexOf(task);
  if (at < 0) return "task not listed";
  const window = coTeraz.slice(at, at + 400);
  const match = /przypomnienie zaplanowane na [^\n]*|przypomnienie dostarczone|przypomnienie wstrzymane \([^)]*\)|brak zaplanowanych przypomnień|przypomnienia odroczone do [^\n]*/.exec(window);
  return match === null ? "no reminder line in window" : match[0];
};
rec.note("R9 reminder projection (dated task)", "the personal reminder line of the dated task", reminderLineOf(DATED_TASK));
rec.note("R9 reminder projection (undated task)", "the personal reminder line of the undated task", reminderLineOf(UNDATED_TASK));

// --- R10: the personal snooze ----------------------------------------------------
const snoozeInput = page.locator("input[id^='now-snooze-']").first();
if ((await snoozeInput.count()) >= 1) {
  await snoozeInput.fill(snoozeValueInCompanyZone());
  await page.getByRole("button", { name: "Odrocz" }).first().click();
  await page.waitForTimeout(5000);
  const afterSnooze = await snap("r10-snooze");
  rec[afterSnooze.includes("odroczone") ? "pass" : "fail"](
    "R10 snooze",
    "snoozed-until copy after the command",
    afterSnooze.includes("odroczone") ? "reminders snoozed for this boss only" : firstLine(afterSnooze),
  );
} else {
  rec.notRun("R10 snooze", "snooze control present", "no snooze input rendered on /co-teraz");
}

// --- R11: evaluator wait + server truth ------------------------------------------
// Poll the personal projection until the dated task's line settles into
// delivered/suppressed/scheduled, bounded by the 5-minute safety net.
let settled = false;
let finalCoTeraz = coTeraz;
for (let attempt = 0; attempt < 8 && !settled; attempt += 1) {
  await page.waitForTimeout(45000);
  await page.goto(`${WEB}/co-teraz`, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(3000);
  finalCoTeraz = await snap(`r11-wait-${attempt}`);
  const line = reminderLineOf(DATED_TASK);
  settled = /dostarczone|wstrzymane|zaplanowane|odroczone|brak zaplanowanych/.test(line);
}
const settledLine = reminderLineOf(DATED_TASK);
rec.note(
  "R11 evaluator outcome (dated task)",
  "the reminder line settles (delivered/suppressed/scheduled) within the evaluator window",
  `${settledLine} after the wait${settled ? "" : " (still unsettled)"}`,
);

await browser.close();

const snapExport = await exportSnapshot({ deployment: DEPLOYMENT, outDir: OUT, tag: `funnel-${id}` });
const companyId = companyIdByName(snapExport, COMPANY_NAME);
rec[companyId !== null ? "pass" : "fail"](
  "R11 session company found",
  "the namespaced company exists exactly once",
  companyId === null ? `company ${COMPANY_NAME} not found` : companyId,
);
const summary = summarizeSnapshot(snapExport, { companyId: companyId ?? undefined, markers: [MARKER, FAKE_TOKEN, mailbox.address] });
writeJson(join(OUT, "r11-snapshot-summary.json"), summary);

const session = summary.session ?? { tasks: [], reminderSchedules: [], reminderIntents: [] };
const dated = session.tasks.filter((t) => t.title === DATED_TASK);
const undated = session.tasks.filter((t) => t.title === UNDATED_TASK);
rec[dated.length === 1 && undated.length === 1 ? "pass" : "fail"](
  "R11 tasks in server truth",
  "both tasks stored with their deadline shape",
  `dated: ${JSON.stringify(dated.map((t) => ({ hasDeadline: t.hasDeadline, state: t.state })))}; undated: ${JSON.stringify(undated.map((t) => ({ hasDeadline: t.hasDeadline })))}`,
);
rec.note(
  "R11 reminder schedules",
  "per-task schedule anchors with their status vocabulary",
  JSON.stringify(session.reminderSchedules.map((s) => ({ taskId: s.taskId.slice(-6), status: s.status }))),
);
rec.note(
  "R11 task-reminder intents",
  "intent states for this company (dedup keys + delivery)",
  session.reminderIntents.length === 0
    ? "no task_reminder intents (consistent with no_deadline)"
    : JSON.stringify(
        session.reminderIntents.map((i) => ({
          state: i.state,
          suppressedReason: i.suppressedReason,
          delivered: i.deliveredAtMs !== null,
          dedupKey: i.dedupKey,
        })),
      ),
);
rec.note(
  "R11 push rows",
  "no synthetic push rows (physical delivery is J4's)",
  `subscriptions ${session.pushSubscriptions}, deliveries ${session.pushDeliveries}`,
);
rec[session.markerLeakHits.length === 0 ? "pass" : "fail"](
  "R11 session marker leak scan",
  "the run marker, fake token and mailbox address never reach diagnostic events",
  session.markerLeakHits.length === 0
    ? "clean"
    : `${session.markerLeakHits.length} hits: ${JSON.stringify(session.markerLeakHits.slice(0, 3))}`,
);
rec[errors.length === 0 ? "pass" : "fail"](
  "R12 zero page errors",
  "no pageerror events during the whole session",
  errors.length === 0 ? "none" : errors.slice(0, 3).join(" | "),
);

writeJson(join(OUT, "funnel-result.json"), {
  run: "funnel-reminders",
  at: new Date().toISOString(),
  web: WEB,
  deployment: DEPLOYMENT,
  runId: id,
  marker: MARKER,
  company: COMPANY_NAME,
  timezone: COMPANY_TIMEZONE,
  deadlineDate,
  mailbox: mailbox.address,
  pageErrors: errors,
  rows: rec.rows,
  allPassed: rec.allPassed(),
  summary,
});
console.log(`\nfunnel-reminders: ${rec.allPassed() ? "ALL PASS (notes allowed)" : "FAILURES PRESENT"}`);
process.exit(rec.allPassed() ? 0 : 1);

// --- helpers -----------------------------------------------------------------
function firstLine(text) {
  const flat = String(text).replace(/\s+/g, " ").trim();
  return flat.length > 160 ? `${flat.slice(0, 160)}…` : flat;
}
function excerpt(text, length) {
  const flat = String(text).replace(/\s+/g, " ");
  return flat.length > length ? `${flat.slice(0, length)}…` : flat;
}
/** A snooze moment ~6h out, formatted for the datetime-local input. */
function snoozeValueInCompanyZone() {
  const target = new Date(Date.now() + 6 * 60 * 60 * 1000);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: COMPANY_TIMEZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(target);
  const get = (type) => parts.find((p) => p.type === type)?.value ?? "00";
  return `${get("year")}-${get("month")}-${get("day")}T${get("hour")}:${get("minute")}`;
}
