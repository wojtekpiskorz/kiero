#!/usr/bin/env node
/**
 * The B5 error-copy probe: drives the REAL sign-in form against a mailbox
 * whose per-address issuance budget is exhausted, and against a wrong
 * code, to record EXACTLY which Polish copy the user sees on the prod-type
 * staging deployment (server error sanitization vs the marker-keyed
 * classifications in features/sign-in/state.ts).
 *
 * Evidence input: a mailbox record JSON with an exhausted budget
 * (e.g. the identity leg's m3). Usage:
 *   node e2e/access/limiter-copy-probe.mjs --mailbox /tmp/.../mailbox-m3.json
 */

import { readFileSync } from "node:fs";
import { WEB, CHROMIUM, snapFor } from "./lib/funnel.mjs";
import { waitForCode } from "./lib/mail.mjs";

const args = process.argv.slice(2);
const value = (flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const mailbox = JSON.parse(readFileSync(value("--mailbox"), "utf8"));
const OUT = value("--out") ?? "/tmp/kiero-smoke/b5/limiter-copy-probe";
const snap = snapFor(OUT);

const pw = await import("playwright-core");
const browser = await pw.chromium.launch({ executablePath: CHROMIUM, headless: true });
const page = await (await browser.newContext({ locale: "pl-PL" })).newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(`pageerror: ${e.message}`));

// 1. The exhausted-budget send: the issuance limiter throws server-side.
await page.goto(WEB, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(2500);
await page.getByLabel("Adres e-mail").fill(mailbox.address);
await page.getByRole("button", { name: "Wyślij kod" }).click();
await page.waitForTimeout(8000);
const afterSend = await snap(page, "1-limiter-send");
console.log("[limiter send] alert line:", (afterSend.match(/^[^\n]*(nie udało się|Zbyt wiele|Coś nie zadziałało|Odczekaj)[^\n]*$/im) ?? ["(no failure line)"])[0]);

// 2. A wrong code on a fresh delivery (the identity leg's mailbox has its
//    own budget; use the same exhausted mailbox's PENDING last code if the
//    send was refused — then a wrong code attempt is only possible after a
//    code exists; skip if the code form never opened).
if (afterSend.includes("Kod z wiadomości")) {
  await page.getByLabel("Kod z wiadomości").fill("12345678");
  await page.getByRole("button", { name: "Zaloguj się kodem" }).click();
  await page.waitForTimeout(8000);
  const afterWrong = await snap(page, "2-wrong-code");
  console.log("[wrong code] alert line:", (afterWrong.match(/^[^\n]*(Kod jest nieprawidłowy|Zbyt wiele|Coś nie zadziałało)[^\n]*$/im) ?? ["(no failure line)"])[0]);
} else {
  console.log("[wrong code] code form never opened (send refused)");
}
console.log("[page errors]", errors.length === 0 ? "none" : errors.slice(0, 3).join(" | "));
await browser.close();
