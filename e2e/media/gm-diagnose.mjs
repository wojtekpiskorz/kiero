/**
 * D7 diagnosis, deterministic single-pass: one fresh mailbox is the
 * session, the GM allow-list entry, and the invited first admin of a
 * GM-onboarded (alpha-activated) company; one photo message lands
 * there; GM inspect exposes the processing runs and media rows.
 */
import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync } from "node:fs";

const run = promisify(execFile);
const WEB = "https://kiero-staging-web.wojtek-524.workers.dev";
const CLI = "/projects/kiero-worktrees/d7-media/tools/smoke/mailbox.mjs";
const OUT = `/tmp/kiero-smoke/d7/gm-${process.env.KIERO_DIAG_RUN ?? Date.now().toString(36)}`;
const PROFILE = `${OUT}/profile`; // fresh per run: no session carryover
const CHROMIUM = "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";
const FIXTURE = "/projects/kiero-worktrees/d7-media/e2e/media/fixtures/voice-note-pl.wav";
const DEPLOYMENT = "wojtek-piskorz-jr:kiero-dev-core:staging";
const OWNER_GM = "wojtek@honestly.design";
mkdirSync(OUT, { recursive: true });

const mailbox = JSON.parse((await run("node", [CLI, "account", "--out", `${OUT}/mailbox.json`])).stdout);
console.log(`[mailbox] ${mailbox.address}`);
const allow = (email) =>
  run("npx", ["convex", "env", "set", "KIERO_GM_EMAILS", `${OWNER_GM},${email}`, "--deployment", DEPLOYMENT]);
const restore = () =>
  execFile("npx", ["convex", "env", "set", "KIERO_GM_EMAILS", OWNER_GM, "--deployment", DEPLOYMENT]);
process.on("exit", restore);

const browser = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROMIUM, headless: true, locale: "pl-PL", viewport: { width: 1400, height: 900 },
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    `--use-file-for-fake-audio-capture=${FIXTURE}`,
  ],
});
const page = await browser.newPage();
const snap = async (tag) => {
  const body = await page.evaluate(() => document.body?.innerText ?? "");
  await page.screenshot({ path: `${OUT}/${tag}.png`, fullPage: true });
  writeFileSync(`${OUT}/${tag}.txt`, body);
  return body;
};

// 1. Fresh session: sign out whatever is there, login as the new mailbox.
await page.goto(WEB, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(5000);
if ((await page.getByLabel("Adres e-mail").count()) === 0) {
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(5000);
}
const again = page.getByRole("button", { name: /Zaloguj si|Zaloguj się ponownie/ });
if ((await page.getByLabel("Adres e-mail").count()) === 0 && (await again.count()) >= 1) {
  await again.first().click();
  await page.waitForTimeout(2500);
}
if ((await page.getByLabel("Adres e-mail").count()) === 0) {
  const stuck = await page.evaluate(() => document.body?.innerText ?? "");
  await page.screenshot({ path: `${OUT}/0-stuck.png`, fullPage: true });
  console.log("[stuck state]", stuck.slice(0, 800).replace(/\n/g, " | "));
  throw new Error("sign-in card not reachable");
}
await page.getByLabel("Adres e-mail").fill(mailbox.address);
const since = new Date().toISOString();
await page.getByRole("button", { name: "Wyślij kod" }).click();
await page.waitForTimeout(2000);
const { stdout: loginOut } = await run("node", [CLI, "wait-code", "--address", mailbox.address, "--password", mailbox.password, "--since", since, "--timeout", "420"]).catch(() => ({ stdout: "" }));
const code = /CODE=(\d{8})/.exec(loginOut)?.[1];
if (code === undefined) throw new Error("login code missing");
await page.getByLabel("Kod z wiadomości").fill(code);
await page.getByRole("button", { name: "Zaloguj się kodem" }).click();
await page.waitForTimeout(6000);
console.log("[session] fresh login ok");

// 2. GM entry (allow-list this mailbox for the run).
await allow(mailbox.address);
await page.goto(`${WEB}/gm`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
await page.getByLabel("Podstawa wejścia w tryb GM").fill("Diagnoza D7: inspekcja ścieżki mediów.");
await page.getByRole("button", { name: "Wejdź w tryb GM" }).click();
await page.waitForTimeout(6000);
console.log("[gm]", (await snap("1-gm")).includes("TRYB GM AKTYWNY") ? "entered" : "STATE?");

// 3. GM-onboard the activated company inviting THIS mailbox.
await page.getByLabel("Nazwa firmy", { exact: true }).last().fill("Diagnoza Final");
await page.getByLabel("Adres e-mail pierwszego administratora").fill(mailbox.address);
await page.getByLabel("Podstawa wdrożenia").fill("Diagnoza D7: firma do inspekcji przetwarzania mediów.");
await page.getByRole("button", { name: "Utwórz firmę i zaproś" }).click();
await page.waitForTimeout(8000);
let body = await snap("2-onboard");
const companyId = body.split("Firmy objęte udziałem w alfie")[1]?.match(/([a-z0-9]{26,})/)?.[1];
console.log("[onboard] companyId:", companyId);

// 4. Accept the invitation (back to /firma as the same session).
await page.goto(`${WEB}/firma`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
const invField = page.getByLabel("Kod zaproszenia z wiadomości");
if ((await invField.count()) === 1) {
  const { stdout } = await run("node", [CLI, "invitation-code", "--address", mailbox.address, "--password", mailbox.password, "--timeout", "420"]).catch(() => ({ stdout: "" }));
  const codes = /CODES=([\d,]+)/.exec(stdout)?.[1]?.split(",") ?? [];
  console.log("[invite] codes:", codes.join(","));
  for (const c of codes) {
    const field = page.getByLabel("Kod zaproszenia z wiadomości");
    if ((await field.count()) !== 1) break;
    await field.fill(c);
    await page.getByRole("button", { name: "Przyjmij zaproszenie" }).click();
    await page.waitForTimeout(5000);
    const now = await page.evaluate(() => document.body?.innerText ?? "");
    if (!now.includes("spróbuj ponownie")) { console.log("[invite] accepted with", c); break; }
  }
}
body = await snap("3-invite");
console.log("[firma]", body.includes("Jesteś administratorem tej firmy") ? "admin of the onboarded company" : body.slice(-300).replace(/\n/g, " | "));

// 5. One photo message inside that company.
await page.goto(WEB, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
await page.getByRole("button", { name: "Nagraj głos" }).click();
await page.waitForTimeout(12000);
await page.getByRole("button", { name: "Zatrzymaj nagrywanie" }).click();
await page.waitForTimeout(3000);
await page.getByRole("button", { name: "Wyślij" }).click();
await page.waitForTimeout(75000);
await snap("4-sent");
console.log("[sent] voice captured");

// 6. GM inspect the company.
await page.goto(`${WEB}/gm`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
body = await page.evaluate(() => document.body?.innerText ?? "");
if (body.includes("Tryb GM nieaktywny")) {
  await page.getByLabel("Podstawa wejścia w tryb GM").fill("Diagnoza D7: odczyt przebiegów.");
  await page.getByRole("button", { name: "Wejdź w tryb GM" }).click();
  await page.waitForTimeout(6000);
}
await page.locator("#gm-inspect-company").fill(companyId ?? "");
await page.getByLabel("Podstawa inspekcji").fill("Diagnoza D7: przebiegi przetwarzania mediów.");
await page.getByRole("button", { name: "Inspekcjonuj" }).click();
await page.waitForTimeout(9000);
const inspection = await snap("5-inspection");
const at = inspection.indexOf("Wynik inspekcji");
console.log("--- inspection ---");
console.log(inspection.slice(at >= 0 ? at : 0, (at >= 0 ? at : 0) + 3000));
await browser.close();
