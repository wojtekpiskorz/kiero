/** D7 dossier/memory verification for a completed media source. */
import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync } from "node:fs";

const run = promisify(execFile);
const WEB = process.env.KIERO_SMOKE_WEB ?? "https://kiero-staging-web.wojtek-524.workers.dev";
const CLI = "/projects/kiero/tools/smoke/mailbox.mjs";
const OUT = process.argv[2] ?? "/tmp/kiero-smoke/d7/dossier";
mkdirSync(OUT, { recursive: true });
const EMAIL = process.argv[3];
const PASSWORD = process.argv[4];

const browser = await chromium.launch({
  executablePath: "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
  headless: true,
});
const page = await (await browser.newContext({ locale: "pl-PL" })).newPage();
const failed = [];
page.on("response", (r) => {
  if (r.status() >= 400) failed.push(`${r.status()} ${r.url().slice(0, 90)}`);
});
await page.goto(WEB, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2000);
await page.getByLabel("Adres e-mail").fill(EMAIL);
const since = new Date().toISOString();
await page.getByRole("button", { name: "Wyślij kod" }).click();
await page.waitForTimeout(2000);
const { stdout } = await run("node", [CLI, "wait-code", "--address", EMAIL, "--password", PASSWORD, "--since", since, "--timeout", "150"]);
await page.getByLabel("Kod z wiadomości").fill(/CODE=(\d{8})/.exec(stdout)[1]);
await page.getByRole("button", { name: "Zaloguj się kodem" }).click();
await page.waitForTimeout(6000);

// Open the source dossier of the last message: read its real href and navigate directly.
const hrefs = await page.evaluate(() => Array.from(document.querySelectorAll('a[href*="zrodlo="]')).map((a) => a.getAttribute("href")));
console.log("[dossier hrefs]", JSON.stringify(hrefs.slice(-3)));
if (hrefs.length > 0) {
  await page.goto(`${new URL(hrefs.at(-1), WEB).pathname}${new URL(hrefs.at(-1), WEB).search}`, { waitUntil: "domcontentloaded" });
}
await page.waitForTimeout(6000);
await page.screenshot({ path: `${OUT}/dossier.png`, fullPage: true });
const dossier = await page.evaluate(() => document.body?.innerText ?? "");
const at = dossier.indexOf("Stan przetwarzania");
console.log("--- dossier (source detail) ---");
console.log(dossier.slice(at >= 0 ? at - 200 : 0, (at >= 0 ? at : 0) + 1500));
console.log("[http failures]", failed.length === 0 ? "none" : failed.slice(0, 6).join(" | "));

// The company memory: what did the agent extract?
await page.goto(`${WEB}/pamiec`, { waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForTimeout(5000);
const mem = await page.evaluate(() => document.body?.innerText ?? "");
await page.screenshot({ path: `${OUT}/memory.png`, fullPage: true });
console.log("--- memory (tail) ---");
console.log(mem.slice(-1500));
await browser.close();
