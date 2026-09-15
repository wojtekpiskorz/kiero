/**
 * D7's voice-leg driver: a voice-only source through the real byte path
 * (composer recording -> gateway multipart -> R2 -> media worker
 * segmentation -> OpenRouter STT -> durable processing), with the
 * browser's mic replaced by the approved synthetic Polish fixture.
 */
import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const WEB = "https://kiero-staging-web.wojtek-524.workers.dev";
const OUT = "/tmp/kiero-smoke/d7/voice1";
const CHROMIUM = "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";
const FIXTURE = join(here, "fixtures", "voice-note-pl.wav");
mkdirSync(OUT, { recursive: true });

const bytes = readFileSync(FIXTURE);
const manifest = { fixture: "voice-note-pl.wav", bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
writeFileSync(`${OUT}/fixture-manifest.json`, JSON.stringify(manifest, null, 2));

const mailbox = JSON.parse((await run("node", [join(root, "tools", "smoke", "mailbox.mjs"), "account", "--out", `${OUT}/mailbox.json`])).stdout);
console.log(`[mailbox] ${mailbox.address}`);

const browser = await chromium.launchPersistentContext(`${OUT}/profile`, {
  executablePath: CHROMIUM,
  headless: true,
  locale: "pl-PL",
  viewport: { width: 1400, height: 900 },
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${FIXTURE}`,
  ],
});
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));
const snap = async (tag) => {
  const body = await page.evaluate(() => document.body?.innerText ?? "");
  await page.screenshot({ path: `${OUT}/${tag}.png`, fullPage: true });
  writeFileSync(`${OUT}/${tag}.txt`, body);
  return body;
};

// Session + company (fresh).
await page.goto(WEB, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
let alreadyBody = await page.evaluate(() => document.body?.innerText ?? "");
let loggedIn = !alreadyBody.includes("Zaloguj się do Kiero");
if (loggedIn) console.log("[session] reused persistent profile");
for (let attempt = 1; attempt <= 3 && !loggedIn; attempt++) {
  await page.getByLabel("Adres e-mail").fill(mailbox.address);
  const since = new Date().toISOString();
  await page.getByRole("button", { name: "Wyślij kod" }).click();
  await page.waitForTimeout(2000);
  const { stdout } = await run("node", [join(root, "tools", "smoke", "mailbox.mjs"), "wait-code", "--address", mailbox.address, "--password", mailbox.password, "--since", since, "--timeout", "420"]).catch(() => ({ stdout: "" }));
  const code = /CODE=(\d{8})/.exec(stdout)?.[1];
  if (code === undefined) { console.log(`[session] attempt ${attempt}: no code yet`); continue; }
  await page.getByLabel("Kod z wiadomości").fill(code);
  await page.getByRole("button", { name: "Zaloguj się kodem" }).click();
  await page.waitForTimeout(6000);
  const now = await page.evaluate(() => document.body?.innerText ?? "");
  loggedIn = !now.includes("Zaloguj się do Kiero");
}
if (!loggedIn) throw new Error("login failed after 3 attempts");
await page.goto(`${WEB}/firma`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
const firmaText = await page.evaluate(() => document.body?.innerText ?? "");
if (firmaText.includes("Jesteś administratorem")) {
  console.log("[firma] existing company reused");
} else {
  await page.getByLabel("Nazwa firmy").fill("Firma Voice D7");
  await page.getByRole("button", { name: "Załóż firmę" }).click();
  await page.waitForTimeout(6000);
  console.log("[firma] created");
}

// Voice-only: record via the fake mic (the fixture), stop, send without text.
await page.goto(WEB, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
await page.getByRole("button", { name: "Nagraj głos" }).click();
await page.waitForTimeout(12000); // let the ~10s fixture play through
const recText = await page.evaluate(() => document.body?.innerText ?? "");
console.log("[recording]", /Nagrywam|Zatrzymaj/.test(recText) ? "recorder active" : "STATE: " + recText.slice(0, 120));
await page.getByRole("button", { name: "Zatrzymaj nagrywanie" }).click();
await page.waitForTimeout(3000);
const afterStop = await snap("1-recorded");
console.log("[recorded]", /Nagranie głosowe|nagranie/.test(afterStop) ? "attachment registered" : "STATE: no attachment");
await page.getByRole("button", { name: "Wyślij" }).click();

let body = "";
let outcome = "timeout";
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(10_000);
  body = await page.evaluate(() => document.body?.innerText ?? "");
  if (/niepowodzenie przetwarzania|Przetwarzanie nie udało się/.test(body)) { outcome = "failed"; break; }
  if (i > 4 && !/przetwarzana|wysyłanie materiałów|Agent przetwarza/.test(body)) { outcome = "complete"; break; }
}
await snap("2-after-send");
console.log(`[processing] outcome=${outcome}`);
console.log("[feed tail]", body.slice(-500).replace(/\n/g, " | "));
console.log("[errors]", errors.length === 0 ? "none" : errors.slice(0, 3).join(" | "));
writeFileSync(`${OUT}/summary.json`, JSON.stringify({ mailbox: mailbox.address, outcome, errors, at: new Date().toISOString() }, null, 2));
await browser.close();
