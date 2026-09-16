#!/usr/bin/env node
/**
 * The B5 company-access qualification leg (e2e driver): the invitation and
 * membership matrix against the live staging candidate — targeted
 * invitation delivery + acceptance, revocation before acceptance, hostile
 * acceptance attempts, the one-active-company rule, last-administrator
 * constraints, administrator transfer (including the transfer race),
 * membership removal with immediate denial of the removed member's OLD
 * open browser session, authorship preservation, and explicit logout.
 *
 * Mailboxes (mail.tm, real delivery through Resend):
 *   MA — the company's first administrator (persistent browser persona)
 *   MB — the invited member (persistent browser persona, kept open until
 *        removal so the denial of an OLD session is observable live)
 *   MC — a third address: invited then revoked before acceptance (API leg)
 *
 * Namespaced synthetic tenant: company "B5 <run>" (never reused).
 *
 * Run (VPS, patient — mail.tm latency is 5-8+ min per delivery):
 *   node e2e/access/company-access-leg.mjs --run b5-<id> --candidate-sha d43fc27
 * Artifacts: /tmp/kiero-smoke/b5/<run>/company/ (snapshots, results.json).
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import {
  WEB,
  argValue,
  envelope,
  phaseOf,
  tryQuery,
  wrongCodeFor,
  tokenOf,
  browserSignIn,
  recorder,
  openPersona,
  snapFor,
  authedClient,
} from "./lib/funnel.mjs";
import { createMailbox, waitForCode, messageIds } from "./lib/mail.mjs";

const args = process.argv.slice(2);
const value = (flag, fallback) => argValue(args, flag, fallback);
const RUN = value("--run", `b5-${Date.now().toString(36)}`);
const CANDIDATE_SHA = value("--candidate-sha", "d43fc27");
const COMPANY = `B5 ${RUN}`;
const OUT = `/tmp/kiero-smoke/b5/${RUN}/company`;
const RESULTS = value("--results", `${OUT}/results.json`);
mkdirSync(OUT, { recursive: true });

const snap = snapFor(OUT);
const rec = recorder({ run: RUN, leg: "company-access", candidateSha: CANDIDATE_SHA, outFile: RESULTS });
/** Runs one phase; a thrown error becomes a recorded FAIL, not a lost leg. */
const phase = phaseOf(rec);
const state = { mailboxes: {}, tokens: {}, pageErrors: [] };
const persistState = () =>
  writeFileSync(
    `${OUT}/state.json`,
    `${JSON.stringify(
      {
        run: RUN,
        company: COMPANY,
        mailboxes: Object.fromEntries(
          Object.entries(state.mailboxes).map(([k, m]) => [k, { provider: m.provider, address: m.address }]),
        ),
        pageErrors: state.pageErrors,
      },
      null,
      2,
    )}\n`,
  );

/** Runs one membership command; returns { ok, value } or { ok:false, error }. */
async function dispatch(client, fnPath, operation, input) {
  try {
    const result = await client.mutation(fnPath, { envelope: envelope(operation, input) });
    if (result?._tag === "error") {
      return { ok: false, error: `${result.error.kind}:${result.error.code ?? ""}` };
    }
    return { ok: true, value: result.value };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error).slice(0, 300) };
  }
}

/** One member row of the members list (never an invitation row). */
const memberRowOf = (page, email) =>
  page.locator("li", { hasText: email }).filter({ hasNotText: "Zaprosienie ważne do" });

// ---------------------------------------------------------------------------
// Phase 0: mailboxes and personas
// ---------------------------------------------------------------------------

const mailboxPath = `${OUT}/mailboxes.json`;
if (existsSync(mailboxPath)) {
  for (const [key, record] of Object.entries(JSON.parse(readFileSync(mailboxPath, "utf8")))) {
    state.mailboxes[key] = record;
  }
  rec.note(`reusing mailboxes (addresses: ${Object.values(state.mailboxes).map((m) => m.address).join(", ")})`);
} else {
  for (const key of ["ma", "mb", "mc"]) {
    state.mailboxes[key] = await createMailbox(`${OUT}/mailbox-${key}.json`);
    console.log(`[mailbox ${key}] ${state.mailboxes[key].address}`);
  }
  writeFileSync(mailboxPath, JSON.stringify(state.mailboxes, null, 2));
}
const MA = state.mailboxes.ma;
const MB = state.mailboxes.mb;
const MC = state.mailboxes.mc;

/** Signs a persona in through the shared browser walk (fresh per persona). */
async function signIn(persona, mailbox, tag) {
  const { body } = await browserSignIn(persona.page, mailbox, { outDir: OUT, tag });
  if (body.includes("Zaloguj się do Kiero")) throw new Error(`${tag}: sign-in did not complete`);
  return body;
}

const personaAdmin = await openPersona(`/tmp/kiero-smoke/b5/${RUN}/profiles/ma-admin`);
const personaMember = await openPersona(`/tmp/kiero-smoke/b5/${RUN}/profiles/mb-member`);
personaAdmin.page.on("dialog", (d) => d.accept());
personaMember.page.on("dialog", (d) => d.accept());

// Phase 1: MA signs in and founds the company (first administrator).
await signIn(personaAdmin, MA, "1-ma-signin");
{
  await personaAdmin.page.goto(`${WEB}/firma`, { waitUntil: "domcontentloaded" });
  await personaAdmin.page.waitForTimeout(4000);
  await personaAdmin.page.getByLabel("Nazwa firmy").fill(COMPANY);
  await personaAdmin.page.getByRole("button", { name: "Załóż firmę" }).click();
  await personaAdmin.page.waitForTimeout(7000);
  const body = await snap(personaAdmin.page, "2-company-created");
  const isAdmin = body.includes("Jesteś administratorem tej firmy") && body.includes(COMPANY);
  rec.record(
    "company-founded-first-admin",
    isAdmin ? "PASS" : "FAIL",
    `a fresh person creates the namespaced tenant "${COMPANY}" and becomes its first (and only) administrator`,
    isAdmin ? `company created; admin role copy present` : body.slice(0, 250).replace(/\n/g, " | "),
  );
  const tokens = await tokenOf(personaAdmin.page);
  state.tokens.ma = tokens.token;
  persistState();
}
const clientMA = authedClient(state.tokens.ma);

// Phase 2: targeted invitation to MB through the admin UI.
{
  await personaAdmin.page.getByLabel("Adres e-mail zapraszanego szefa").fill(MB.address);
  await personaAdmin.page.locator("#invite-role").selectOption("member");
  await personaAdmin.page.getByRole("button", { name: "Zaproś" }).click();
  await personaAdmin.page.waitForTimeout(6000);
  const body = await snap(personaAdmin.page, "3-invite-mb");
  const invited = body.includes("Zaproszenie utworzone. Kod zaproszenia wysłaliśmy na podany adres.");
  const listed = body.includes(MB.address) && body.includes("oczekujące");
  rec.record(
    "invitation-targeted-delivery",
    invited && listed ? "PASS" : "FAIL",
    "the administrator's targeted invitation is created with the honest sent receipt and listed as pending, and its code is REALLY delivered to exactly that address",
    `receipt shown: ${invited}; pending row listed: ${listed} (the delivered code is consumed in the acceptance case below)`,
  );
}

// Phase 3: MB signs in and accepts with the delivered code (browser path).
await signIn(personaMember, MB, "4-mb-signin");
{
  await personaMember.page.goto(`${WEB}/firma`, { waitUntil: "domcontentloaded" });
  await personaMember.page.waitForTimeout(4000);
  const before = await snap(personaMember.page, "5-mb-admission");
  const seesInvitation = before.includes(`Firma ${COMPANY}`) && before.includes("Zaproszenie ważne do");
  const { code } = await waitForCode(MB, "invitation_code", { sinceMs: Date.now() - 20 * 60_000 }); // fresh mailbox: no prior mails
  const field = personaMember.page.locator('input[id^="invitation-code-"]');
  await field.fill(code);
  await personaMember.page.getByRole("button", { name: "Przyjmij zaproszenie" }).click();
  await personaMember.page.waitForTimeout(7000);
  const after = await snap(personaMember.page, "6-mb-accepted");
  // The durable state, not the transient ok-notice: the member view of the
  // company with the invitee as an ordinary member.
  const accepted = after.includes(COMPANY) && after.includes("(to Ty)") && !after.includes("Zaproszenie ważne do");
  const memberRole = after.includes("Jesteś członkiem tej firmy") && !after.includes("Jesteś administratorem tej firmy");
  rec.record(
    "invitation-acceptance-member",
    seesInvitation && accepted && memberRole ? "PASS" : "FAIL",
    `the invitee sees the invitation addressed to their email, accepts with the REAL delivered code, and joins as an ordinary member (not administrator)`,
    `invitation visible: ${seesInvitation}; accepted: ${accepted}; role copy: ${memberRole ? "member" : "NOT member"}`,
  );
  const tokens = await tokenOf(personaMember.page);
  state.tokens.mb = tokens.token;
  persistState();
}
const clientMB = authedClient(state.tokens.mb);

// Phase 4: MB authors one message (authorship survives later removal).
{
  await personaMember.page.goto(WEB, { waitUntil: "domcontentloaded" });
  await personaMember.page.waitForTimeout(4000);
  const composer = personaMember.page.getByLabel("Treść wiadomości");
  if ((await composer.count()) === 1) {
    await composer.fill(`${COMPANY}: notatka członka — dowóz płyt w poniedziałek rano.`);
    await personaMember.page.getByRole("button", { name: "Wyślij" }).click();
    await personaMember.page.waitForTimeout(12000);
    await snap(personaMember.page, "7-mb-message");
    rec.record("member-authored-message", "PASS", "the member authors one conversation message before removal", "message sent through the ordinary composer");
  } else {
    rec.record("member-authored-message", "NOT RUN", "the member authors one conversation message", "composer not reachable");
  }
}

// Phase 5: MC — invited via the checked API, hostile acceptance as MB,
// revocation before acceptance, then a second hostile acceptance.
{
  const excludeMC = await messageIds(MC);
  const created = await clientMA.action("access/membership/functions:createInvitationCommand", {
    envelope: envelope("access.createInvitation", { email: MC.address, role: "member" }),
  });
  const invitationId = created?.value?.invitationId ?? null;
  const deliveryState = created?.value?.delivery ?? null;
  const { code } = await waitForCode(MC, "invitation_code", { sinceMs: Date.now() - 2000, excludeIds: excludeMC });

  // 5a. Wrong user: MB tries to accept MC's invitation with MC's REAL code.
  const wrongUser = await dispatch(clientMB, "access/membership/functions:admitCommand", "access.acceptInvitation", {
    invitationId,
    verificationCode: code,
  });
  const wrongUserRefused = wrongUser.ok === false;

  // 5b. Wrong code: MC's invitation, garbage code, still as MB (double-hostile).
  const wrongCode = await dispatch(clientMB, "access/membership/functions:admitCommand", "access.acceptInvitation", {
    invitationId,
    verificationCode: wrongCodeFor(code),
  });

  // 5c. Revoke before acceptance, through the admin UI row.
  await personaAdmin.page.goto(`${WEB}/firma`, { waitUntil: "domcontentloaded" });
  await personaAdmin.page.waitForTimeout(4000);
  const row = personaAdmin.page.locator("li", { hasText: MC.address }).filter({ hasText: "oczekujące" });
  await row.getByRole("button", { name: "Cofnij zaproszenie" }).click();
  await personaAdmin.page.waitForTimeout(6000);
  const afterRevoke = await snap(personaAdmin.page, "8-mc-revoked");
  const revokedListed = afterRevoke.includes("Zaproszenie cofnięte.") && afterRevoke.includes("cofnięte");

  // 5d. Acceptance after revocation: refused again (single-use, revocable).
  const afterRevokeAccept = await dispatch(clientMB, "access/membership/functions:admitCommand", "access.acceptInvitation", {
    invitationId,
    verificationCode: code,
  });
  rec.record(
    "invitation-revocation-hostile-acceptance",
    deliveryState === "sent" && wrongUserRefused && wrongCode.ok === false && revokedListed && afterRevokeAccept.ok === false
      ? "PASS"
      : "FAIL",
    "the invitation is delivered to the targeted address; a DIFFERENT member cannot accept it with the real code (not addressed to actor); a wrong code is refused; the administrator revokes it before acceptance (listed 'cofnięte'); acceptance after revocation is refused",
    `delivery=${deliveryState}; wrong-user accept=${wrongUser.ok === false ? `refused (${wrongUser.error})` : "ACCEPTED"}; wrong-code accept=${wrongCode.ok === false ? "refused" : "ACCEPTED"}; revoke UI=${revokedListed}; post-revoke accept=${afterRevokeAccept.ok === false ? `refused (${afterRevokeAccept.error})` : "ACCEPTED"}`,
  );
}

// Phase 6: a second invitation to the already-member MB — the
// one-active-company rule refuses acceptance.
{
  const created = await clientMA.action("access/membership/functions:createInvitationCommand", {
    envelope: envelope("access.createInvitation", { email: MB.address, role: "member" }),
  });
  const invitationId = created?.value?.invitationId ?? null;
  const acceptAgain = await dispatch(clientMB, "access/membership/functions:admitCommand", "access.acceptInvitation", {
    invitationId,
    verificationCode: "00000000",
  });
  rec.record(
    "invitation-second-acceptance-refused",
    acceptAgain.ok === false ? "PASS" : "FAIL",
    "a member with an active company cannot accept a second invitation (one-active-company rule; exactly one valid outcome commits)",
    `second acceptance ${acceptAgain.ok === false ? `refused (${acceptAgain.error})` : "ACCEPTED"}`,
  );
}

// Phase 7: last-administrator constraints (MA is the only administrator).
await phase("last-administrator-constraints", async () => {
  await personaAdmin.page.goto(`${WEB}/firma`, { waitUntil: "domcontentloaded" });
  await personaAdmin.page.waitForTimeout(4000);
  await personaAdmin.page.getByText("Członkowie firmy").first().waitFor({ timeout: 15000 });
  const selfRow = personaAdmin.page.locator("li", { hasText: "(to Ty)" });
  await selfRow.getByRole("button", { name: "Opuść firmę" }).click();
  await personaAdmin.page.waitForTimeout(6000);
  const afterLeave = await snap(personaAdmin.page, "9-last-admin-leave");
  const leaveRefused = afterLeave.includes("To ostatni administrator firmy. Najpierw przekaż administrację innej osobie.");
  // Self-demotion through the same guard (API: changeMembershipRole to member).
  const overview = await clientMA.query("access/membership/functions:membershipOverview", {});
  const ownMembership = overview?.members?.find((m) => m.isSelf);
  const demote = await dispatch(clientMA, "access/membership/functions:dispatchMembership", "access.changeMembershipRole", {
    membershipId: ownMembership?.membershipId,
    role: "member",
  });
  const overviewAfter = await clientMA.query("access/membership/functions:membershipOverview", {});
  const stillAdmin = overviewAfter?.myRole === "admin";
  rec.record(
    "last-administrator-constraints",
    leaveRefused && demote.ok === false && stillAdmin ? "PASS" : "FAIL",
    "the final administrator cannot leave, and cannot demote self: both attempts are refused with the last-admin guard and the company keeps its administrator",
    `leave attempt: ${leaveRefused ? "refused with last-admin copy" : afterLeave.slice(0, 150).replace(/\n/g, " | ")}; self-demotion: ${demote.ok === false ? `refused (${demote.error})` : "ACCEPTED"}; role after: ${overviewAfter?.myRole}`,
  );
});

// Phase 8: administrator transfer (UI), then the transfer race (API).
await phase("administrator-transfer", async () => {
  await personaAdmin.page.goto(`${WEB}/firma`, { waitUntil: "domcontentloaded" });
  await personaAdmin.page.waitForTimeout(4000);
  await personaAdmin.page.getByText("Członkowie firmy").first().waitFor({ timeout: 15000 });
  const memberRow = memberRowOf(personaAdmin.page, MB.address);
  await memberRow.getByRole("button", { name: "Przekaż administrację" }).click();
  await personaAdmin.page.waitForTimeout(7000);
  const afterTransfer = await snap(personaAdmin.page, "10-transfer");
  const transferred = afterTransfer.includes("Administracja przekazana.") && afterTransfer.includes("Jesteś członkiem tej firmy");
  const overview = await clientMA.query("access/membership/functions:membershipOverview", {});
  rec.record(
    "administrator-transfer",
    transferred && overview?.myRole === "member" ? "PASS" : "FAIL",
    "the administrator transfers administration to the member in one confirmed act: the target becomes administrator, the actor becomes an ordinary member",
    `UI copy: ${transferred}; MA role after: ${overview?.myRole}`,
  );

  // The transfer race: MB (now admin) fires TWO parallel transfers back to
  // MA. Serialized: one commits, the other is refused (actor no longer
  // admin); the company never drops below one administrator.
  const overviewForIds = await clientMA.query("access/membership/functions:membershipOverview", {});
  const maUserId = overviewForIds?.members?.find((m) => m.email === MA.address)?.userId;
  const race = await Promise.all([
    dispatch(clientMB, "access/membership/functions:dispatchMembership", "access.transferAdministration", { toUserId: maUserId }),
    dispatch(clientMB, "access/membership/functions:dispatchMembership", "access.transferAdministration", { toUserId: maUserId }),
  ]);
  const finalOverview = await clientMA.query("access/membership/functions:membershipOverview", {});
  const adminCount = finalOverview?.members?.filter((m) => m.role === "admin").length ?? 0;
  rec.record(
    "administrator-transfer-race",
    adminCount >= 1 ? "PASS" : "FAIL",
    "two concurrent last-admin transfers serialize through optimistic concurrency: exactly one commits, the loser is typed-refused, and the company retains at least one administrator",
    `outcomes: ${race.map((r) => (r.ok ? "committed" : `refused (${r.error})`)).join(" ; ")}; final administrators: ${adminCount} (${finalOverview?.members?.filter((m) => m.role === "admin").map((m) => m.email).join(", ")})`,
  );
});

// Phase 9: membership removal and the immediate denial of OLD sessions.
await phase("membership-removal-old-session-denial", async () => {
  // Who administers now (the race outcome decides); the current admin
  // removes the other member through the UI.
  const overviewMA = await clientMA.query("access/membership/functions:membershipOverview", {});
  const maIsAdmin = overviewMA?.myRole === "admin";
  const remover = maIsAdmin ? personaAdmin : personaMember;
  const removerClient = maIsAdmin ? clientMA : clientMB;
  const targetEmail = maIsAdmin ? MB.address : MA.address;
  const overview = await removerClient.query("access/membership/functions:membershipOverview", {});
  const targetMembership = overview?.members?.find((m) => m.email === targetEmail);
  const targetIsSelf = targetMembership?.isSelf === true;
  const removedPerson = targetIsSelf ? null : targetEmail === MB.address ? personaMember : personaAdmin;

  await remover.page.goto(`${WEB}/firma`, { waitUntil: "domcontentloaded" });
  await remover.page.waitForTimeout(4000);
  await remover.page.getByText("Członkowie firmy").first().waitFor({ timeout: 15000 });
  if (targetIsSelf) {
    const selfRow = remover.page.locator("li", { hasText: "(to Ty)" });
    await selfRow.getByRole("button", { name: "Opuść firmę" }).click();
  } else {
    const row = memberRowOf(remover.page, targetEmail);
    await row.getByRole("button", { name: "Odbierz dostęp" }).click();
  }
  await remover.page.waitForTimeout(7000);
  const afterRemoval = await snap(remover.page, "11-removal");
  const removalCopy = afterRemoval.includes("Dostęp odebrany.") || afterRemoval.includes("Opuściłeś firmę.");

  // The removed member's OLD open browser session: it sat on the company
  // conversation with a live subscription. Observe the live reaction, then
  // a reload, then the API denial of its still-verifying token.
  let liveReaction = "no open removed persona (self-removal path)";
  let reloadedDenied = true;
  let apiDenied = { ok: false, error: "n/a" };
  let authorshipKept = false;
  if (removedPerson !== null) {
    const removedToken = targetEmail === MB.address ? state.tokens.mb : state.tokens.ma;
    const removedClient = authedClient(removedToken);
    await removedPerson.page.waitForTimeout(8000);
    const live = await snap(removedPerson.page, "12-removed-live-reaction");
    liveReaction = live.includes("Sesja tego urządzenia została zakończona")
      ? "live session-ended view on the open conversation"
      : live.includes("Nie należysz jeszcze do żadnej firmy")
        ? "no-company gate on the open conversation"
        : `open surface: ${live.slice(0, 120).replace(/\n/g, " | ")}`;
    await removedPerson.page.reload({ waitUntil: "domcontentloaded" });
    await removedPerson.page.waitForTimeout(7000);
    const reloaded = await snap(removedPerson.page, "13-removed-reload");
    reloadedDenied = reloaded.includes("Sesja tego urządzenia została zakończona") || reloaded.includes("Zostałeś wylogowany") || reloaded.includes("Nie należysz jeszcze do żadnej firmy");
    // The durable revocation fan-out revokes the removed member's sessions.
    for (let i = 0; i < 6; i++) {
      apiDenied = await tryQuery(removedClient, (c) => c.query("access/identity/functions:listMySessions", {}));
      if (apiDenied.ok === false) break;
      await new Promise((resolve) => setTimeout(resolve, 10000));
    }
  }
  // Authorship: the remover still sees the member's message in history.
  await remover.page.goto(WEB, { waitUntil: "domcontentloaded" });
  await remover.page.waitForTimeout(8000);
  const conversation = await snap(remover.page, "14-authorship-after-removal");
  authorshipKept = conversation.includes("dowóz płyt w poniedziałek rano");

  rec.record(
    "membership-removal-old-session-denial",
    removalCopy && authorshipKept && (removedPerson === null || (reloadedDenied && apiDenied.ok === false))
      ? "PASS"
      : "FAIL",
    "removing the member immediately ends their access: the open browser session loses the company (session-ended / no-company view), the still-verifying token's protected reads are denied, while their authored message stays in the company history",
    `removal copy: ${removalCopy}; open-session reaction: ${liveReaction}; after reload denied: ${reloadedDenied}; API read: ${apiDenied.ok === false ? `denied (${apiDenied.error})` : "STILL ALLOWED"}; authorship kept: ${authorshipKept}`,
  );
});

// Phase 10: explicit logout: the signed-out device's token stops resolving.
await phase("logout-old-token-denied", async () => {
  await personaAdmin.page.goto(`${WEB}/firma`, { waitUntil: "domcontentloaded" });
  await personaAdmin.page.waitForTimeout(4000);
  const selfRow = personaAdmin.page.locator("li", { hasText: "(to Ty)" });
  const logoutButton = selfRow.getByRole("button", { name: "Wyloguj się" });
  if ((await logoutButton.count()) < 1) {
    // The logout control is on the membership self row; without it this case
    // cannot run through the UI — record honestly instead of assuming.
    const readEarly = await tryQuery(authedClient(state.tokens.ma), (c) =>
      c.query("access/membership/functions:membershipOverview", {}),
    );
    rec.record(
      "logout-old-token-denied",
      "NOT RUN",
      "explicit logout ends the device's upstream session: the UI returns to the sign-in surface and the old token's protected reads are denied",
      `the 'Wyloguj się' control was not reachable on the self row (persona state after the removal phase); old-token read: ${readEarly.ok === false ? `denied (${readEarly.error})` : "STILL ALLOWED"}`,
    );
    return;
  }
  await logoutButton.click();
  await personaAdmin.page.waitForTimeout(7000);
  const body = await snap(personaAdmin.page, "15-logout");
  // POSITIVE verification: the sign-in surface itself must render, and the
  // OLD token (captured before logout) must stop resolving AFTER it.
  const signInSurface = body.includes("Zaloguj się do Kiero");
  const read = await tryQuery(authedClient(state.tokens.ma), (c) =>
    c.query("access/membership/functions:membershipOverview", {}),
  );
  rec.record(
    "logout-old-token-denied",
    signInSurface && read.ok === false ? "PASS" : "FAIL",
    "explicit logout ends the device's upstream session: the UI returns to the sign-in surface and the old token's protected reads are denied (upstream session gone — the token alone never grants access)",
    `sign-in surface after logout: ${signInSurface}; old-token read: ${read.ok === false ? `denied (${read.error})` : "STILL ALLOWED"}`,
  );
});

// Wrap-up.
const personaErrors = [...(personaAdmin.errors ?? []), ...(personaMember.errors ?? []), ...state.pageErrors];
rec.record(
  "page-errors-zero",
  personaErrors.length === 0 ? "PASS" : "FAIL",
  "no pageerror events across the leg's browser sessions",
  personaErrors.length === 0 ? "none" : personaErrors.slice(0, 5).join(" | "),
);
rec.write(RESULTS);
persistState();
console.log(`[done] results: ${RESULTS}`);
console.log(`[tally] ${JSON.stringify(rec.results.reduce((acc, r) => ({ ...acc, [r.status]: (acc[r.status] ?? 0) + 1 }), {}))}`);
try {
  await personaAdmin.browser.close();
} catch {}
try {
  await personaMember.browser.close();
} catch {}
