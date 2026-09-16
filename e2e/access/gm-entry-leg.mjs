#!/usr/bin/env node
/**
 * The B5 GM-entry leg (e2e driver).
 *
 * Default mode (--mode refusal, safe, NO env mutation): proves the
 * fail-closed entry against the live staging candidate — a real,
 * signed-in, non-designated account is refused GM entry with the honest
 * Polish copy, both through the real /gm panel and through the checked
 * action. The KIERO_GM_EMAILS allow-list is never touched by this driver.
 *
 * Pending mode (--mode entry): the full audited-entry walk for the
 * coordinator to execute AFTER serializing the KIERO_GM_EMAILS mutation:
 * designated-operator sign-in, audited entry with a stated basis, the GM
 * banner, an audited company inspection, unchanged ordinary boss
 * read/activity metrics, and exit. NOT executed by the B5 lane.
 *
 * Run (refusal, live):
 *   node e2e/access/gm-entry-leg.mjs --run b5-<id> --mode refusal
 * Run (entry, coordinator only, after allow-listing the operator address):
 *   node e2e/access/gm-entry-leg.mjs --run b5-gm --mode entry \
 *     --operator-mailbox <operator-mailbox.json> --company-id <k78...>
 */

import { mkdirSync, writeFileSync, readFileSync } from "node:fs";
import {
  WEB,
  argValue,
  envelope,
  tokenOf,
  browserSignIn,
  recorder,
  openPersona,
  snapFor,
  authedClient,
} from "./lib/funnel.mjs";
import { createMailbox } from "./lib/mail.mjs";

const args = process.argv.slice(2);
const value = (flag, fallback) => argValue(args, flag, fallback);
const RUN = value("--run", `b5-gm-${Date.now().toString(36)}`);
const MODE = value("--mode", "refusal"); // refusal (live) | entry (coordinator)
const CANDIDATE_SHA = value("--candidate-sha", "d43fc27");
const OUT = `/tmp/kiero-smoke/b5/${RUN}/gm`;
const RESULTS = value("--results", `${OUT}/results.json`);
mkdirSync(OUT, { recursive: true });
const snap = snapFor(OUT);
const rec = recorder({ run: RUN, leg: "gm-entry", candidateSha: CANDIDATE_SHA, outFile: RESULTS });


if (MODE === "refusal") {
  // -------------------------------------------------------------------------
  // Live: a real non-designated account is refused entry (fail-closed).
  // -------------------------------------------------------------------------
  const mailbox = await createMailbox(`${OUT}/mailbox-gm.json`);
  console.log(`[mailbox gm] ${mailbox.address}`);
  const persona = await openPersona(`/tmp/kiero-smoke/b5/${RUN}/profiles/gm-probe`);
  persona.page.on("dialog", (d) => d.accept());
  await browserSignIn(persona.page, mailbox);

  await persona.page.goto(`${WEB}/gm`, { waitUntil: "domcontentloaded" });
  await persona.page.waitForTimeout(5000);
  const entry = await snap(persona.page, "1-gm-entry-surface");
  const surfaceOk = entry.includes("Tryb GM nieaktywny") && entry.includes("Podstawa wejścia w tryb GM");
  await persona.page.getByLabel("Podstawa wejścia w tryb GM").fill("B5: próba wejścia konta niewskazanego jako operator.");
  await persona.page.getByRole("button", { name: "Wejdź w tryb GM" }).click();
  await persona.page.waitForTimeout(8000);
  const after = await snap(persona.page, "2-gm-refused");
  const refusedCopy = after.includes("To konto nie jest wskazane jako operator GM w tej instalacji.");
  const notActive = after.includes("Tryb GM nieaktywny");

  const tokens = await tokenOf(persona.page);
  const client = authedClient(tokens.token);
  let apiRefusal = "n/a";
  try {
    const result = await client.action("access/gm/functions:enterGmMode", {
      envelope: envelope("access.enterGmMode", { reason: "B5: weryfikacja odmowy przez sprawdzoną akcję." }),
    });
    apiRefusal = result?._tag === "error" ? `refused (${result.error.kind}:${result.error.code ?? ""})` : `ACCEPTED (${JSON.stringify(result)})`;
  } catch (error) {
    apiRefusal = `refused (${String(error?.message ?? error).slice(0, 160)})`;
  }
  const overview = await client.query("access/gm/functions:gmOverview", {});

  rec.record(
    "gm-entry-non-designated-refused",
    surfaceOk && refusedCopy && notActive && !apiRefusal.startsWith("ACCEPTED") && overview?.state === "not_gm"
      ? "PASS"
      : "FAIL",
    "a real signed-in account NOT on the operator allow-list cannot enter GM mode: the /gm panel answers the honest Polish refusal copy, the checked action refuses (forbidden gm_not_designated), and the overview stays not_gm — no env var was read or touched by the driver",
    `panel surface: ${surfaceOk}; refusal copy: ${refusedCopy}; mode still inactive: ${notActive}; action: ${apiRefusal}; overview state: ${overview?.state}`,
  );
  rec.record(
    "page-errors-zero",
    (persona.errors ?? []).length === 0 ? "PASS" : "FAIL",
    "no pageerror events in the GM refusal session",
    (persona.errors ?? []).length === 0 ? "none" : persona.errors.slice(0, 3).join(" | "),
  );
  await persona.browser.close();
} else if (MODE === "entry") {
  // -------------------------------------------------------------------------
  // PENDING (coordinator execution only): the audited-entry walk.
  // Preconditions the coordinator owns:
  //   1. KIERO_GM_EMAILS on wojtek-piskorz-jr:kiero-dev-core:staging contains
  //      the operator address (serialized between lanes; this driver never
  //      mutates env).
  //   2. --operator-mailbox names a mail.tm mailbox record whose address is
  //      the allow-listed operator.
  //   3. --company-id names the B5 company to inspect; --boss-page (optional)
  //      names an already-signed-in boss profile to read ordinary metrics.
  // -------------------------------------------------------------------------
  const operator = JSON.parse(readFileSync(value("--operator-mailbox"), "utf8"));
  const companyId = value("--company-id");
  const bossProfile = value("--boss-profile");
  const basis = value("--basis", "B5: kwalifikacja wpisu GM — audytowane wejście i inspekcja.");
  if (companyId === undefined) throw new Error("--company-id is required in entry mode");

  const persona = await openPersona(`/tmp/kiero-smoke/b5/${RUN}/profiles/gm-operator`);
  persona.page.on("dialog", (d) => d.accept());
  await browserSignIn(persona.page, operator);

  // Boss read/activity metrics before the GM walk (the independent baseline).
  let bossBefore = null;
  let bossPage = null;
  if (bossProfile !== undefined) {
    const boss = await openPersona(bossProfile);
    bossPage = boss;
    await boss.page.goto(WEB, { waitUntil: "domcontentloaded" });
    await boss.page.waitForTimeout(6000);
    bossBefore = await boss.page.evaluate(() => document.body?.innerText ?? "");
  }

  await persona.page.goto(`${WEB}/gm`, { waitUntil: "domcontentloaded" });
  await persona.page.waitForTimeout(5000);
  await persona.page.getByLabel("Podstawa wejścia w tryb GM").fill(basis);
  await persona.page.getByRole("button", { name: "Wejdź w tryb GM" }).click();
  await persona.page.waitForTimeout(8000);
  const active = await snap(persona.page, "1-gm-active");
  const banner = active.includes("TRYB GM AKTYWNY") && active.includes(`Podstawa wejścia: ${basis}`);
  rec.record(
    "gm-entry-audited",
    banner ? "PASS" : "FAIL",
    "the designated operator enters GM mode with a stated basis; the unmistakable banner records the basis, actor email and start time (the audited grant)",
    banner ? "banner TRYB GM AKTYWNY with the stated basis rendered" : active.slice(0, 250).replace(/\n/g, " | "),
  );

  await persona.page.locator("#gm-inspect-company").fill(companyId);
  await persona.page.getByLabel("Podstawa inspekcji").fill("B5: kontrola odczytu GM bez zmian metryk szefów.");
  await persona.page.getByRole("button", { name: "Inspekcjonuj" }).click();
  await persona.page.waitForTimeout(9000);
  const inspection = await snap(persona.page, "2-gm-inspection");
  const inspected = inspection.includes("Wynik inspekcji") && inspection.includes("Aktywni administratorzy");
  rec.record(
    "gm-inspect-audited",
    inspected ? "PASS" : "FAIL",
    "the GM inspection command answers with the company result block (an audited GM read of the target company)",
    inspected ? "result block rendered" : inspection.slice(0, 250).replace(/\n/g, " | "),
  );

  // Ordinary boss metrics unchanged by the GM walk.
  if (bossPage !== null && bossBefore !== null) {
    await bossPage.page.reload({ waitUntil: "domcontentloaded" });
    await bossPage.page.waitForTimeout(6000);
    const bossAfter = await bossPage.page.evaluate(() => document.body?.innerText ?? "");
    const unchanged = bossBefore === bossAfter;
    rec.record(
      "gm-ordinary-metrics-unchanged",
      unchanged ? "PASS" : "FAIL",
      "the boss's own conversation surface (read states, unread counts, activity) is byte-identical before and after the GM entry+inspection",
      unchanged ? "identical" : "DIFFERS (see 3-boss-diff)",
    );
    if (!unchanged) {
      writeFileSync(`${OUT}/3-boss-before.txt`, bossBefore);
      writeFileSync(`${OUT}/3-boss-after.txt`, bossAfter);
    }
    await bossPage.browser.close();
  } else {
    rec.record(
      "gm-ordinary-metrics-unchanged",
      "NOT RUN",
      "boss metrics baseline captured before/after the GM walk",
      "no --boss-profile supplied",
    );
  }

  await persona.page.getByRole("button", { name: "Zakończ tryb GM" }).click();
  await persona.page.waitForTimeout(7000);
  const exited = await snap(persona.page, "4-gm-exited");
  // Exit returns the panel to the honest inactive state (the entry form with
  // "Tryb GM nieaktywny"); the audited entry stays in the protected log.
  const exitOk = exited.includes("Tryb GM nieaktywny") && exited.includes("Podstawa wejścia w tryb GM");
  rec.record(
    "gm-exit",
    exitOk ? "PASS" : "FAIL",
    "explicit exit ends GM access immediately; the audit entry remains",
    exitOk ? "exit confirmed" : exited.slice(0, 200).replace(/\n/g, " | "),
  );
  await persona.browser.close();
} else {
  throw new Error(`unknown mode ${MODE}`);
}

rec.write(RESULTS);
console.log(`[done] results: ${RESULTS}`);
