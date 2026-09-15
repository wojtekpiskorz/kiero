#!/usr/bin/env node
/**
 * D7's photo-leg driver: the ordinary photo-only and photo+text walks
 * through the REAL byte path (composer -> gateway multipart -> R2 ->
 * images executor normalization -> durable processing -> retained
 * access in the source dossier), against the live staging origin.
 *
 * Fixtures live in ./fixtures (hash-addressed in the evidence
 * manifest). The funnel mailbox (tools/smoke/mailbox.mjs) supplies the
 * ordinary session; no fixture/proof flags exist on staging.
 *
 * Run (VPS): node e2e/media/photo-leg.mjs --out /tmp/kiero-smoke/d7/photo1
 */

import { chromium } from "playwright-core";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const args = process.argv.slice(2);
const value = (flag, fallback) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : fallback;
};
const WEB = value("--web", process.env.KIERO_SMOKE_WEB ?? "https://kiero-staging-web.wojtek-524.workers.dev");
const OUT = value("--out", "/tmp/kiero-smoke/d7/photo1");
const CHROMIUM = process.env.KIERO_SMOKE_CHROMIUM ?? "/root/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome";
const MODE = value("--mode", "photo-text"); // photo-text | photo-only
mkdirSync(OUT, { recursive: true });

// Fixture manifest: exact bytes + hashes, the independently expected shapes.
const fixtures = {};
for (const name of readdirSync(join(here, "fixtures"))) {
  const bytes = readFileSync(join(here, "fixtures", name));
  fixtures[name] = { bytes: bytes.length, sha256: createHash("sha256").update(bytes).digest("hex") };
}
writeFileSync(`${OUT}/fixture-manifest.json`, JSON.stringify(fixtures, null, 2));
console.log("[fixtures]", JSON.stringify(Object.fromEntries(Object.entries(fixtures).map(([k, v]) => [k, v.bytes]))));

const mailbox = JSON.parse((await run("node", [join(root, "tools", "smoke", "mailbox.mjs"), "account", "--out", `${OUT}/mailbox.json`])).stdout);
console.log(`[mailbox] ${mailbox.address}`);

const PROFILE = value("--profile", "/tmp/kiero-smoke/d7/profile");
const browser = await chromium.launchPersistentContext(PROFILE, {
  executablePath: CHROMIUM,
  headless: true,
  locale: "pl-PL",
  viewport: { width: 1400, height: 900 },
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

// Session: reuse the persistent profile's session when it still resolves;
// otherwise a fresh funnel login (patient, mail.tm latency varies).
async function signedIn() {
  const text = await page.evaluate(() => document.body?.innerText ?? "");
  return !text.includes("Zaloguj się do Kiero") && /Firma|Rozmowa firmy/.test(text);
}
await page.goto(WEB, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
if (await signedIn()) {
  console.log("[session] reused persistent profile");
} else {
  let signed = false;
  for (let attempt = 1; attempt <= 3 && !signed; attempt++) {
    console.log(`[session] funnel login attempt ${attempt}`);
    await page.getByLabel("Adres e-mail").fill(mailbox.address);
    const since = new Date().toISOString();
    await page.getByRole("button", { name: "Wyślij kod" }).click();
    await page.waitForTimeout(2000);
    const { stdout } = await run("node", [
      join(root, "tools", "smoke", "mailbox.mjs"), "wait-code",
      "--address", mailbox.address, "--password", mailbox.password, "--since", since, "--timeout", "420",
    ]).catch(() => ({ stdout: "" }));
    const code = /CODE=(\d{8})/.exec(stdout)?.[1];
    if (code === undefined) { console.log("[session] code did not arrive; retrying"); continue; }
    await page.getByLabel("Kod z wiadomości").fill(code);
    await page.getByRole("button", { name: "Zaloguj się kodem" }).click();
    await page.waitForTimeout(6000);
    signed = await signedIn();
  }
  if (!signed) throw new Error("funnel login failed after 3 attempts");
}
const mailboxRecord = JSON.parse(await (await import("node:fs/promises")).readFile(`${OUT}/mailbox.json`, "utf8"));
await page.goto(`${WEB}/firma`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
const firmaText = await page.evaluate(() => document.body?.innerText ?? "");
if (firmaText.includes("Jesteś administratorem tej firmy")) {
  console.log("[firma] PASS: existing company reused");
} else {
  await page.getByLabel("Nazwa firmy").fill("Firma Media D7");
  await page.getByRole("button", { name: "Załóż firmę" }).click();
  await page.waitForTimeout(6000);
  console.log("[firma]", (await snap("1-firma")).includes("Jesteś administratorem tej firmy") ? "PASS" : "STATE?");
}

// The composer walk.
await page.goto(WEB, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(3000);
const photoInput = page.locator('input[type="file"][accept="image/*"]');
console.log("[composer] photo input count:", await photoInput.count());
if (MODE === "photo-text") {
  await page.getByLabel("Treść wiadomości").fill("Zdjęcia z budowy Banan: faktura i portret odbioru.");
}
const files = MODE === "photo-only"
  ? [join(here, "fixtures", "normal-note.jpg")]
  : [join(here, "fixtures", "normal-note.jpg"), join(here, "fixtures", "rotated-portrait.jpg")];
await photoInput.setInputFiles(files);
await page.waitForTimeout(2500);
const afterAttach = await snap("2-attached");
console.log("[attach]", /Usuń|Zdjęcia/.test(afterAttach) ? "PASS: attachments registered" : "STATE: no attachment UI");

await page.getByRole("button", { name: "Wyślij" }).click();
// Uploads + durable acceptance + processing: poll the feed for the honest states.
let body = "";
let outcome = "timeout";
for (let i = 0; i < 30; i++) {
  await page.waitForTimeout(10_000);
  body = await page.evaluate(() => document.body?.innerText ?? "");
  if (/niepowodzenie przetwarzania|Przetwarzanie nie udało się/.test(body)) { outcome = "failed"; break; }
  if (/częściowo przetworzona|Część materiałów/.test(body) && i > 3) { outcome = "partial"; }
  const processedCount = (body.match(/przetworzona(?!.*przetwarzana)/g) ?? []).length;
  if (i > 5 && !/przetwarzana/.test(body)) { outcome = "complete"; break; }
}
await snap("3-after-send");
console.log(`[processing] outcome=${outcome}`);

// Stage 4: the inline source dossier of the sent message (retained media access).
await page.getByRole("button", { name: "Szczegóły i źródło" }).last().click();
await page.waitForTimeout(4000);
const dossier = await snap("4-dossier");
const at = dossier.indexOf("Stan przetwarzania");
const mediaMentioned = /Zdjęcia|zdję|normaliz|oryginał|wersja|fragment|Fragment/.test(dossier);
console.log("[dossier]", at >= 0 ? `PASS: detail opens; media vocabulary present=${mediaMentioned}` : "STATE: dossier body unclear");
if (at >= 0) console.log("[dossier excerpt]", dossier.slice(Math.max(at - 150, 0), at + 700).replace(/\n/g, " | ").slice(0, 550));

try {
// Stage 4b: the full dossier page (/zrodlo permalink) with real media rendering.
const perma = dossier.match(/https:\/\/[^\s]+\/zrodlo\?zrodlo=[a-z0-9]+/)?.[0]
  ?? (await page.evaluate(() => Array.from(document.querySelectorAll('a[href*="/zrodlo?"]')).map((a) => a.getAttribute("href")))).at(-1);
console.log("[media] perma:", String(perma).slice(0, 120));
if (perma !== undefined) {
  let u;
  try { u = perma.startsWith("http") ? new URL(perma) : new URL(perma, WEB); } catch { u = new URL("/zrodlo", WEB); }
  await page.goto(u.href, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(7000);
  const mediaInfo = await page.evaluate(async () => {
    const imgs = Array.from(document.querySelectorAll("img")).map((i) => i.getAttribute("src") ?? "");
    const audios = Array.from(document.querySelectorAll("audio")).map((a) => a.getAttribute("src") ?? a.querySelector("source")?.getAttribute("src") ?? "");
    const statuses = [];
    for (const src of [...imgs, ...audios].filter((x) => x !== "")) {
      try {
        const r = await fetch(src, { method: "GET" });
        statuses.push(`${r.status} ${r.headers.get("content-type") ?? "?"} ${(r.headers.get("content-length") ?? "?")}B`);
      } catch (e) {
        statuses.push(`ERR ${String(e).slice(0, 40)}`);
      }
    }
    return { imgCount: imgs.length, audioCount: audios.length, srcs: [...imgs, ...audios].map((x) => x.slice(0, 80)), statuses };
  });
  await snap("4b-zrodlo-page");
  console.log("[media]", JSON.stringify(mediaInfo));
}

} catch (e) { console.log("[media] STAGE_ERROR:", String(e).slice(0, 300)); }
try {
// Stage 4c: ask the agent about this message (the user-visible extraction proof).
await page.goto(WEB, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(4000);
const ask = page.getByRole("button", { name: "Zapytaj agenta o tę wiadomość" });
console.log("[agent] ask button count:", await ask.count());
if ((await ask.count()) >= 1) {
  await ask.first().click();
  let afterAsk = "";
  for (let i = 0; i < 18; i++) {
    await page.waitForTimeout(10_000);
    afterAsk = await page.evaluate(() => document.body?.innerText ?? "");
    if (/Odpowiedź agenta|Nie udało się uzyskać odpowiedzi/.test(afterAsk)) break;
  }
  await page.screenshot({ path: `${OUT}/4c-agent.png`, fullPage: true });
  const { writeFileSync } = await import("node:fs");
  writeFileSync(`${OUT}/4c-agent.txt`, afterAsk);
  const m = afterAsk.match(/(Odpowiedź agenta|Nie udało si[^\n]*)[\s\S]{0,1100}/);
  console.log("[agent answer]", m ? m[0].replace(/\n/g, " | ").slice(0, 900) : "not rendered after 180s");
}

} catch (e) { console.log("[agent] STAGE_ERROR:", String(e).slice(0, 300)); }
// Stage 5: the company memory tail (what the agent recorded).
await page.goto(`${WEB}/pamiec`, { waitUntil: "domcontentloaded" }).catch(() => {});
await page.waitForTimeout(5000);
const mem = await snap("5-memory");
console.log("[memory tail]", mem.slice(-700).replace(/\n/g, " | "));
console.log("[errors]", errors.length === 0 ? "none" : errors.slice(0, 3).join(" | "));
writeFileSync(`${OUT}/summary.json`, JSON.stringify({
  web: WEB, mode: MODE, mailbox: mailbox.address, outcome, pageErrors: errors, at: new Date().toISOString(),
}, null, 2));
await browser.close();
