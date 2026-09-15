#!/usr/bin/env node
/**
 * The committed authenticated smoke driver (R18's regression and I8's
 * reproduction procedure): one real browser, one smoke mailbox, the
 * ordinary user path end to end against the live web origin.
 *
 * Stages: email-code sign-in (the mailbox CLI reads the delivered OTP),
 * company creation on /firma, one conversation message, and one agent
 * answer ("Zapytaj agenta"). Every stage logs the observed honest copy;
 * screenshots land next to the artifacts under --out.
 *
 * Run (VPS or anywhere with the cached Chromium):
 *   KIERO_SMOKE_WEB=https://kiero-staging-web.wojtek-524.workers.dev \
 *   node tools/smoke/auth-smoke.mjs --out /tmp/kiero-smoke/run
 *
 * The mailbox CLI (./mailbox.mjs) must sit next to this file. Requires
 * playwright-core with a Chromium executable at
 * $KIERO_SMOKE_CHROMIUM (default: the VPS ms-playwright path).
 */

import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : fallback;
};
const WEB = value("--web", process.env.KIERO_SMOKE_WEB ?? "https://kiero-staging-web.wojtek-524.workers.dev");
const OUT = value("--out", "/tmp/kiero-smoke/auth-run");
const CHROMIUM = process.env.KIERO_SMOKE_CHROMIUM ?? "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";
mkdirSync(OUT, { recursive: true });

/** Creates the throwaway mailbox for this run (fresh per run: the issuance limiter is per address). */
const mailbox = JSON.parse(
  (await run("node", [join(here, "mailbox.mjs"), "account", "--out", `${OUT}/mailbox.json`])).stdout,
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

// Stage 1: ordinary email-code sign-in with the delivered OTP.
await page.goto(WEB, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
await page.getByLabel("Adres e-mail").fill(mailbox.address);
const since = new Date().toISOString();
await page.getByRole("button", { name: "Wyślij kod" }).click();
await page.waitForTimeout(2000);
const { stdout } = await run("node", [
  join(here, "mailbox.mjs"), "wait-code",
  "--address", mailbox.address, "--password", mailbox.password,
  "--since", since, "--timeout", "150",
]);
const code = /CODE=(\d{8})/.exec(stdout)?.[1];
if (code === undefined) throw new Error(`mailbox CLI returned no code: ${stdout}`);
console.log(`[login] delivered code ${code}`);
await page.getByLabel("Kod z wiadomości").fill(code);
await page.getByRole("button", { name: "Zaloguj się kodem" }).click();
await page.waitForTimeout(6000);
const afterLogin = await snap("1-login");
console.log(`[login] ${afterLogin.includes("Nie należysz jeszcze") ? "PASS: signed in, no company yet" : "STATE: unexpected"}`);

// Stage 2: create the company on /firma.
await page.goto(`${WEB}/firma`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3500);
const nameField = page.getByLabel("Nazwa firmy");
if ((await nameField.count()) !== 1) throw new Error("/firma did not render the creation form");
await nameField.fill("Firma Smoke Kiero");
await page.getByRole("button", { name: "Załóż firmę" }).click();
await page.waitForTimeout(6000);
const afterCompany = await snap("2-company");
console.log(`[firma] ${afterCompany.includes("Jesteś administratorem tej firmy") ? "PASS: first administrator" : "STATE: unexpected"}`);

// Stage 3: one conversation message through the ordinary composer.
await page.goto(WEB, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
const composer = page.getByLabel("Treść wiadomości");
if ((await composer.count()) !== 1) throw new Error("conversation composer missing");
await composer.fill("Banan: dowóz płytek w środę rano, klient Kaczmarek potwierdził odbiór. Wycena na 12 tysięcy.");
await page.getByRole("button", { name: "Wyślij" }).click();
await page.waitForTimeout(12000);
const afterMessage = await snap("3-message");
const sentVisible = afterMessage.includes("dowóz płytek");
console.log(`[message] ${sentVisible ? "PASS: source message in the feed" : "STATE: message not visible yet"}`);

// Stage 4: one agent answer through the live providers.
await page.waitForTimeout(8000);
const ask = page.getByRole("button", { name: "Zapytaj agenta o tę wiadomość" });
if ((await ask.count()) < 1) throw new Error("ask-agent control missing on the sent message");
await ask.first().click();
await page.waitForTimeout(25000);
const afterAgent = await snap("4-agent");
const agentAnswered = /odpowied|Odpowied|ustale|Nie udało si|gave-up|provider/.test(afterAgent);
console.log(`[agent] ${agentAnswered ? "PASS: agent answer rendered (or its honest refusal)" : "STATE: no agent output"}`);
console.log(`[agent] page errors: ${errors.length === 0 ? "none" : errors.slice(0, 3).join(" | ")}`);
writeFileSync(`${OUT}/summary.json`, JSON.stringify({
  web: WEB, mailbox: mailbox.address, code, at: new Date().toISOString(), pageErrors: errors,
}, null, 2));
await browser.close();
