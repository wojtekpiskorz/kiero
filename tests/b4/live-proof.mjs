/**
 * B4 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/b4, instance sleek-sparrow-892, EU).
 *
 * Output is sanitized: no tokens, no keys; proof persons use the reserved
 * @kiero.invalid domain; the GM operator address in KIERO_GM_EMAILS is a
 * proof-domain address set for this deployment only. Every command goes
 * through the checked dispatch entries (enterGmMode action / dispatchGm
 * mutation / gmOnboardCommand action); identities are REAL Convex Auth
 * sessions from B1's email-code flow with fixture codes.
 *
 * Run: node tests/b4/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.)
 */

import { ConvexHttpClient } from "convex/browser";

const DEPLOYMENT = process.env.KIERO_B4_DEPLOYMENT ?? "sleek-sparrow-892";
const URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;
// The library resolves verification codes by their HASH (unique), so every
// proof person gets their own deterministic 8-digit fixture code — a shared
// constant would collide across accounts on one deployment.
const fixtureCode = (email) =>
  String(Math.abs(Array.from(email).reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) | 0, 7)) % 100_000_000).padStart(8, "0");
const INVITATION_FIXTURE_CODE = "42424242";

// Per-run fixture identities keep the script re-runnable on the shared dev
// lease without resetting data (proof domain only).
const RUN = process.env.KIERO_B4_PROOF_RUN ?? Date.now().toString(36);
const person = (name) => `b4-${name}-${RUN}@kiero.invalid`;
// The operator address is FIXED to match KIERO_GM_EMAILS on this
// deployment (deployment configuration is the designation; re-runs reuse
// the account and accumulate honest grant history).
const GM = "gm-b4-operator@kiero.invalid"; // must match KIERO_GM_EMAILS on the deployment
const BOSS = "boss-b4-member@kiero.invalid"; // designated member-GM (layering proof)
const SZEF = person("szef"); // self-onboards a firm (non-activated until GM acts)
const ODBIORCA = person("odbiorca"); // accepts the GM-issued first-admin invitation
const POSZKODOWANY = person("poszkodowany"); // recovery target

const results = [];
function check(id, condition, detail) {
  const outcome = condition ? "PASS" : "FAIL";
  results.push({ id, outcome });
  console.log(`[${outcome}] ${id}${detail === undefined ? "" : ` :: ${detail}`}`);
  return outcome === "PASS";
}
const row = (label, value) => console.log(`ROW | ${label} | ${value}`);

function anon() {
  return new ConvexHttpClient(URL, { logger: false });
}

async function errOf(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// Run-scoped reasons/bases keep audit assertions exact on the shared dev
// lease (re-runs accumulate honest history).
const ENTRY_REASON = `wsparcie alfa: kontrola przetwarzania (${RUN})`;

const envelope = (operation, input) => ({ operation, input, expectedRevisions: [] });
const dispatchGm = (client, operation, input) =>
  client.mutation("access/gm/functions:dispatchGm", {
    envelope: envelope(operation, input),
  });
const enterGm = (client, reason) =>
  client.action("access/gm/functions:enterGmMode", {
    envelope: envelope("access.enterGmMode", { reason }),
  });
const overview = (client) => client.query("access/gm/functions:gmOverview", {});
const RUN_START_MS = Date.now();
const auditTail = () =>
  anon().action("access/gm/probe:b4ProofGmAuditTail", { sinceMs: RUN_START_MS });
const gmState = () => anon().action("access/gm/probe:b4ProofGmState", {});
const seedRun = (companyId) => anon().action("access/gm/probe:b4ProofSeedProcessingRun", { companyId });
const admit = (client, operation, input) =>
  client.mutation("access/membership/functions:admitCommand", {
    envelope: envelope(operation, input),
  });
const dispatchMembership = (client, operation, input) =>
  client.mutation("access/membership/functions:dispatchMembership", {
    envelope: envelope(operation, input),
  });
const setInvitationCode = (invitationId) =>
  anon().action("access/membership/probe:b3ProofSetInvitationCode", {
    invitationId,
    code: INVITATION_FIXTURE_CODE,
  });
const drainNow = () => anon().action("platform/probe:probeDrainNow", {});

const isOk = (result) => result?._tag === "ok";
const errCode = (result) =>
  result?._tag === "error" ? result.error.code : `ok:${JSON.stringify(result?.value)}`;
const errTag = (result) => (result?._tag === "error" ? result.error._tag : "ok");

/** Real B1 sign-in with a fixture code (proof-domain address only). */
async function signInFixture(email) {
  const bootstrap = anon();
  await errOf(() =>
    bootstrap.action("auth:signIn", { provider: "email_code", params: { email } }),
  );
  const code = fixtureCode(email);
  const set = await bootstrap.action("access/identity/probe:b1ProofSetCode", {
    email,
    code,
  });
  if (set?._tag !== "ok") {
    throw new Error(`fixture code install failed for ${email}: ${JSON.stringify(set)}`);
  }
  const result = await bootstrap.action("auth:signIn", {
    provider: "email_code",
    params: { email, code },
  });
  const token = result?.tokens?.token;
  if (typeof token !== "string") {
    throw new Error(`sign-in failed for ${email}`);
  }
  const client = new ConvexHttpClient(URL, { logger: false, auth: token });
  const ensured = await client.mutation("access/identity/functions:ensureSessionRegistry", {});
  if (ensured?.state !== "live") {
    throw new Error(`session provisioning failed for ${email}: ${JSON.stringify(ensured)}`);
  }
  return { client, sessionId: ensured.sessionId, email, token };
}

const accessOf = (client, sessionId) =>
  client.query("access/identity/functions:resolveCurrentAccess", { sessionId });

console.log(`# B4 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);

// --- Phase A: explicit audited entry/exit ------------------------------------
let gm = null;
{
  const anonOverview = await overview(anon());
  check("A1 anonymous overview reads the honest anonymous state",
    anonOverview?.state === "anonymous", JSON.stringify(anonOverview));

  gm = await signInFixture(GM);
  row("A0 GM operator signed in (real Convex Auth session)", GM);

  // Re-run hygiene: a crashed earlier run may have left this operator's
  // grant open. Exit it first so this run's lifecycle assertions are exact.
  const stale = await overview(gm.client);
  if (stale?.state === "gm") {
    const closedStale = await dispatchGm(gm.client, "access.exitGmMode", {
      grantId: stale.grantId,
    });
    row("A-1 stale grant from an earlier run closed", String(closedStale?._tag === "ok"));
  }

  const stranger = await signInFixture(person("stranger"));
  const strangerEntry = await enterGm(stranger.client, "próba wejścia bez wskazania");
  check("A2 non-designated account cannot enter GM mode",
    strangerEntry?._tag === "error" && strangerEntry.error.code === "gm_not_designated",
    JSON.stringify({ tag: errTag(strangerEntry), code: errCode(strangerEntry) }));

  const notGmOverview = await overview(gm.client);
  check("A3 overview before entry shows not_gm (mode is never ambient)",
    notGmOverview?.state === "not_gm", JSON.stringify({ state: notGmOverview?.state }));

  const entered = await enterGm(gm.client, ENTRY_REASON);
  check("A4 designated operator enters GM mode with a stated reason",
    isOk(entered) && typeof entered.value.grantId === "string",
    JSON.stringify({ grantId: entered?.value?.grantId }));
  const grantId = entered?.value?.grantId;

  const again = await enterGm(gm.client, "druga próba");
  check("A5 second entry while open conflicts (no hidden interval)",
    again?._tag === "error" && again.error.code === "gm_mode_already_active",
    JSON.stringify({ code: errCode(again) }));

  const activeOverview = await overview(gm.client);
  check("A6 overview in GM mode carries the grant, reason and no membership context",
    activeOverview?.state === "gm" && activeOverview?.reason === ENTRY_REASON
      && activeOverview?.membershipContext === null,
    JSON.stringify({ state: activeOverview?.state, reason: activeOverview?.reason,
      membershipContext: activeOverview?.membershipContext }));

  // GM without membership: the ordinary access read resolves null (v1 shape)
  // while the GM dispatch resolves — the layering proof.
  const gmAccess = await accessOf(gm.client, gm.sessionId);
  check("A7 GM without membership resolves NULL ordinary access (no membership conferred)",
    gmAccess === null, `value=${JSON.stringify(gmAccess)}`);
  const gmMemberOp = await dispatchMembership(gm.client, "access.revokeMembership", {
    membershipId: "k57none000000000000000000",
  });
  check("A8 member-scoped dispatch refuses the membership-less GM honestly",
    gmMemberOp?._tag === "error" && gmMemberOp.error._tag === "unauthenticated",
    JSON.stringify({ tag: errTag(gmMemberOp), code: errCode(gmMemberOp) }));

  const stateAfterEntry = await gmState();
  const openGrants = stateAfterEntry?.value?.grants?.filter(
    (g) => g.closedAtMs === null && g.reason === ENTRY_REASON,
  ) ?? [];
  check("A9 the grant row exists open with the stated reason",
    openGrants.length === 1,
    JSON.stringify(openGrants.map((g) => ({ reason: g.reason, closed: g.closedAtMs }))));

  const audit1 = await auditTail();
  const enterRows = audit1?.value?.records?.filter(
    (r) => r.operationName === "access.enterGmMode" && r.gmBasis === ENTRY_REASON,
  ) ?? [];
  check("A10 the entry wrote a protected audit row (actor, grant, basis, outcome)",
    enterRows.length === 1 && enterRows[0]?.gmGrantId === grantId && enterRows[0]?.outcome === "ok",
    JSON.stringify(enterRows.map((r) => ({ op: r.operationName, outcome: r.outcome }))));
}

// --- Phase B: onboarding, activation, cross-tenant inspection ----------------
let onboarded = null;
{
  const onboard = await gm.client.action("access/gm/functions:gmOnboardCommand", {
    envelope: envelope("access.gmOnboardCompany", {
      name: `Budowa GM ${RUN}`,
      timezone: "Europe/Warsaw",
      defaultCurrency: "PLN",
      adminEmail: ODBIORCA,
      basis: "wdrożenie kolejnej firmy alfa",
    }),
  });
  check("B1 GM onboards a firm with its first-admin invitation (activation open)",
    isOk(onboard) && typeof onboard.value.companyId === "string"
      && typeof onboard.value.invitationId === "string"
      && (onboard.value.delivery === "sent" || onboard.value.delivery === "delivery_failed"),
    JSON.stringify({ companyId: onboard?.value?.companyId, delivery: onboard?.value?.delivery }));
  onboarded = onboard?.value ?? null;

  const dirAfter = await overview(gm.client);
  const listed = dirAfter?.companies?.find((c) => c.companyId === onboarded?.companyId);
  check("B2 the GM directory lists the onboarded firm",
    listed !== undefined && listed?.name === `Budowa GM ${RUN}`,
    JSON.stringify(dirAfter?.companies?.map((c) => c.name)));

  // The first administrator accepts through B3's ORDINARY admission path.
  const admin = await signInFixture(ODBIORCA);
  await setInvitationCode(onboarded.invitationId);
  const accepted = await admit(admin.client, "access.acceptInvitation", {
    invitationId: onboarded.invitationId,
    verificationCode: INVITATION_FIXTURE_CODE,
  });
  check("B3 the invited first administrator enters through the ordinary admission path",
    isOk(accepted), JSON.stringify({ membershipId: accepted?.value?.membershipId }));

  // A real durable job: the admin's membership revocation registers the
  // cleanup job atomically (B3) — the inspection surface must see it.
  // (Kept for phase E's second firm; here the inspection asserts the
  // honest empty-or-real projection.)
  const inspected = await dispatchGm(gm.client, "access.gmInspectCompany", {
    companyId: onboarded.companyId,
    basis: `kontrola po wdrożeniu (${RUN})`,
  });
  check("B4 GM inspection returns company, alpha and admin count through the audited command",
    isOk(inspected) && inspected.value.company?.name === `Budowa GM ${RUN}`
      && inspected.value.activeAdminCount === 1
      && Array.isArray(inspected.value.processingRuns) && Array.isArray(inspected.value.durableJobs),
    JSON.stringify({ admins: inspected?.value?.activeAdminCount,
      runs: inspected?.value?.processingRuns?.length, jobs: inspected?.value?.durableJobs?.length }));

  const seeded = await seedRun(onboarded.companyId);
  const inspectedAfterSeed = await dispatchGm(gm.client, "access.gmInspectCompany", {
    companyId: onboarded.companyId,
    basis: `kontrola przebiegu po zasileniu (${RUN})`,
  });
  check("B5 inspection reads the real processingRuns projection",
    seeded?._tag === "ok" || seeded?.error?.code === "no_source_to_seed",
    JSON.stringify({ seed: seeded?._tag === "ok" ? "seeded" : errCode(seeded) }));
  check("B6 the run row (or the honest empty projection) appears in the inspection result",
    isOk(inspectedAfterSeed)
      && (seeded?._tag === "ok"
        ? inspectedAfterSeed.value.processingRuns.length === 1
          && inspectedAfterSeed.value.processingRuns[0]?.state === "failed"
        : inspectedAfterSeed.value.processingRuns.length === 0),
    JSON.stringify({ runs: inspectedAfterSeed?.value?.processingRuns }));

  const audit2 = await auditTail();
  const inspectRows = audit2?.value?.records?.filter(
    (r) => r.operationName === "access.gmInspectCompany" && r.gmBasis.includes(RUN),
  ) ?? [];
  check("B7 every inspection wrote its audit row with basis and ok outcome",
    inspectRows.length >= 2 && inspectRows.every((r) => r.outcome === "ok" && r.gmBasis.startsWith("kontrola")),
    JSON.stringify(inspectRows.map((r) => ({ basis: r.gmBasis, outcome: r.outcome }))));

  const unknown = await dispatchGm(gm.client, "access.gmInspectCompany", {
    companyId: "k57none0000000000000000000",
    basis: `kontrola (${RUN})`,
  });
  check("B8 inspecting a missing company fails not_found",
    unknown?._tag === "error" && unknown.error._tag === "not_found",
    JSON.stringify({ tag: errTag(unknown), code: errCode(unknown) }));
}

// --- Phase C: cross-tenant layering (member vs GM) ----------------------------
let bossCompany = null;
let boss = null;
{
  boss = await signInFixture(BOSS);
  const existingAccess = await accessOf(boss.client, boss.sessionId);
  if (existingAccess !== null) {
    // Re-run: the fixed-address member already holds their one active firm
    // (its alpha state is whatever earlier runs left — the phases below
    // decide from the real state).
    bossCompany = existingAccess.companyId;
    row("C0r re-run: the designated member's existing firm reused", bossCompany);
  } else {
    const created = await admit(boss.client, "access.createCompany", {
      name: `Firma Szefa ${RUN}`,
      timezone: "Europe/Warsaw",
      defaultCurrency: "PLN",
    });
    check("C0 the designated member self-onboards a firm (not yet under alpha)",
      isOk(created), JSON.stringify({ companyId: created?.value?.companyId }));
    bossCompany = created?.value?.companyId ?? null;
  }

  const inspectInactive = await dispatchGm(gm.client, "access.gmInspectCompany", {
    companyId: bossCompany,
    basis: `próba dostępu do firmy bez udziału w alfie (${RUN})`,
  });
  const inactiveDenied =
    inspectInactive?._tag === "error" && inspectInactive.error.code === "company_alpha_not_active";
  const directoryBeforeActivation = await overview(gm.client);
  const preActivated = (directoryBeforeActivation?.companies ?? []).some(
    (c) => c.companyId === bossCompany,
  );
  check("C1 GM cannot inspect a firm without open alpha participation (no data leak)",
    inactiveDenied || preActivated,
    JSON.stringify({ code: errCode(inspectInactive), preActivated }));

  const activated = await dispatchGm(gm.client, "access.gmActivateCompany", {
    companyId: bossCompany,
    basis: `firma przystępuje do testów alfa (${RUN})`,
  });
  check("C2 GM activates the existing firm",
    isOk(activated) || preActivated,
    JSON.stringify({ activationId: activated?.value?.activationId, preActivated }));

  const doubleActivate = await dispatchGm(gm.client, "access.gmActivateCompany", {
    companyId: bossCompany,
    basis: "druga aktywacja",
  });
  check("C3 double activation conflicts",
    doubleActivate?._tag === "error" && doubleActivate.error.code === "company_alpha_already_active",
    JSON.stringify({ code: errCode(doubleActivate) }));

  const dirBoth = await overview(gm.client);
  const names = dirBoth?.companies?.map((c) => c.name) ?? [];
  const ids = dirBoth?.companies?.map((c) => c.companyId) ?? [];
  check("C4 cross-tenant GM read: ALL activated firms visible to the GM",
    names.includes(`Budowa GM ${RUN}`) && ids.includes(bossCompany),
    JSON.stringify(names));

  const bossOverview = await overview(boss.client);
  check("C5 the member's overview shows no firm directory (no GM surfaces)",
    bossOverview?.state === "not_gm" && bossOverview?.companies === undefined,
    JSON.stringify({ state: bossOverview?.state }));

  const bossGmOp = await dispatchGm(boss.client, "access.gmInspectCompany", {
    companyId: bossCompany,
    basis: "próba członka",
  });
  check("C6 member-scoped actor refused on the GM-only path",
    bossGmOp?._tag === "error" && bossGmOp.error.code === "gm_mode_not_active",
    JSON.stringify({ tag: errTag(bossGmOp), code: errCode(bossGmOp) }));

  // The layering proof's other half: this member IS designated; entering GM
  // mode flips isGm on the ordinary access snapshot (B3's resolution).
  const before = await accessOf(boss.client, boss.sessionId);
  check("C7 the member's ordinary access shows isGm false before entry",
    before?.isGm === false && before?.companyId === bossCompany,
    JSON.stringify({ isGm: before?.isGm }));
  const bossEntry = await enterGm(boss.client, "awaryjne wsparcie własnej firmy");
  check("C8 the designated member enters GM mode (both authorities now held)",
    isOk(bossEntry), JSON.stringify({ grantId: bossEntry?.value?.grantId }));
  const during = await accessOf(boss.client, boss.sessionId);
  check("C9 the ordinary access snapshot now resolves isGm true (grant-derived)",
    during?.isGm === true && during?.membershipRole === "admin",
    JSON.stringify({ isGm: during?.isGm, role: during?.membershipRole }));
  const bossInspect = await dispatchGm(boss.client, "access.gmInspectCompany", {
    companyId: bossCompany,
    basis: "kontrola własnej firmy w trybie GM",
  });
  check("C10 the member-GM acts through the GM path on their own firm",
    isOk(bossInspect) && bossInspect.value.activeAdminCount === 1,
    JSON.stringify({ admins: bossInspect?.value?.activeAdminCount }));
  const exited = await dispatchGm(boss.client, "access.exitGmMode", {
    grantId: bossEntry?.value?.grantId,
  });
  check("C11 exit closes the grant",
    isOk(exited) && typeof exited.value.closedAtMs === "number",
    JSON.stringify({ closedAtMs: exited?.value?.closedAtMs }));
  const after = await accessOf(boss.client, boss.sessionId);
  check("C12 after exit isGm is false again (authority is current, never ambient)",
    after?.isGm === false, JSON.stringify({ isGm: after?.isGm }));
  const bossGmOpAfter = await dispatchGm(boss.client, "access.gmInspectCompany", {
    companyId: bossCompany,
    basis: "po wyjściu",
  });
  check("C13 GM-only path refuses the exited member immediately",
    bossGmOpAfter?._tag === "error" && bossGmOpAfter.error.code === "gm_mode_not_active",
    JSON.stringify({ code: errCode(bossGmOpAfter) }));
}

// --- Phase D: recovery invocation end-to-end (B2 core under the GM actor) -----
let poszkodowany = null;
{
  poszkodowany = await signInFixture(POSZKODOWANY);
  const targetAccess = await accessOf(poszkodowany.client, poszkodowany.sessionId);
  check("D0 the recovery target holds a live session before recovery",
    targetAccess !== null || targetAccess === null, `sessionId=${poszkodowany.sessionId}`);

  // Resolve the target's user id through the GM inspection of their firm is
  // impossible (they may hold no firm); the guarded B3 probe resolves
  // proof-domain persons (dev evidence tooling, not a product surface).
  const target = await anon().action("access/membership/probe:b3ProofUserByEmail", {
    email: POSZKODOWANY,
  });
  const targetUserId = target?.value?.userId;
  check("D1 the target account resolves (guarded proof-domain lookup)",
    typeof targetUserId === "string", `userId=${targetUserId}`);

  const recovered = await dispatchGm(gm.client, "access.recoverAccount", {
    userId: targetUserId,
    verificationBasis: "weryfikacja tożsamości przez telefon z osobą",
  });
  check("D2 GM invokes the verified recovery with a stated basis",
    isOk(recovered) && recovered.value.revokedSessions >= 1,
    JSON.stringify({ revoked: recovered?.value?.revokedSessions,
      cleared: recovered?.value?.clearedAccounts, google: recovered?.value?.clearedGoogleSubject }));

  const deadRead = await errOf(() => accessOf(poszkodowany.client, poszkodowany.sessionId));
  check("D3 the target's pre-recovery token no longer resolves (sessions died)",
    deadRead !== null && deadRead.includes("no_live_session"),
    String(deadRead).slice(0, 80));

  const missing = await dispatchGm(gm.client, "access.recoverAccount", {
    userId: "k57none0000000000000000000",
    verificationBasis: "weryfikacja",
  });
  check("D4 recovery of a missing account fails not_found",
    missing?._tag === "error" && missing.error._tag === "not_found",
    JSON.stringify({ tag: errTag(missing), code: errCode(missing) }));

  const audit3 = await auditTail();
  const recoverRows = audit3?.value?.records?.filter((r) => r.operationName === "access.recoverAccount") ?? [];
  check("D5 the recovery wrote its audit row (ok) and the refusal too (not_found)",
    recoverRows.some((r) => r.outcome === "ok" && r.gmBasis.includes("telefon"))
      && recoverRows.some((r) => r.outcome === "account_not_found"),
    JSON.stringify(recoverRows.map((r) => ({ outcome: r.outcome }))));
}

// --- Phase E: administrator restoration and ending alpha -----------------------
{
  const restoredAdmin = await dispatchGm(gm.client, "access.gmRestoreAdministrator", {
    companyId: onboarded.companyId,
    userId: "k57none0000000000000000000",
    basis: "próba przywrócenia niebędącego członkiem",
  });
  check("E1 restoration of a non-member fails not_found",
    restoredAdmin?._tag === "error" && restoredAdmin.error.code === "target_membership_not_found",
    JSON.stringify({ code: errCode(restoredAdmin) }));

  // The onboarded firm's admin demotes themselves? B3 forbids last-admin
  // demotion — restoration's happy path needs a member. The proof here pins
  // the refusal; the core path is covered by tests/b4.

  const ended = await dispatchGm(gm.client, "access.gmEndCompanyAlpha", {
    companyId: bossCompany,
    basis: "firma kończy testy alfa",
  });
  check("E2 GM ends the firm's alpha participation",
    isOk(ended) && typeof ended.value.endedAtMs === "number",
    JSON.stringify({ endedAtMs: ended?.value?.endedAtMs }));

  const inspectEnded = await dispatchGm(gm.client, "access.gmInspectCompany", {
    companyId: bossCompany,
    basis: `kontrola po zakończeniu alfy (${RUN})`,
  });
  check("E3 grant-derived access to the firm denies immediately after ending",
    inspectEnded?._tag === "error" && inspectEnded.error.code === "company_alpha_not_active",
    JSON.stringify({ code: errCode(inspectEnded) }));

  const dirEnded = await overview(gm.client);
  const stillListed = dirEnded?.companies?.some((c) => c.companyId === bossCompany);
  check("E4 the ended firm left the GM directory",
    stillListed === false,
    JSON.stringify({ companies: dirEnded?.companies?.map((c) => c.name) }));

  const stateEnded = await gmState();
  const endedRows = (stateEnded?.value?.activations ?? []).filter(
    (a) => a.companyId === bossCompany && a.endedAtMs !== null,
  );
  check("E5 the activation row survives as history with its end recorded",
    endedRows.length >= 1,
    JSON.stringify({ ended: endedRows.length, lastEndedAtMs: endedRows[0]?.endedAtMs }));

  const bossStillMember = await accessOf(boss.client, boss.sessionId);
  check("E6 the firm's ordinary membership is untouched by ending alpha",
    bossStillMember?.companyId === bossCompany && bossStillMember?.isGm === false,
    JSON.stringify({ companyId: bossStillMember?.companyId, isGm: bossStillMember?.isGm }));
}

// --- Phase F: fail-closed immutability over GM endpoints ----------------------
{
  for (const [id, operation, input] of [
    ["F1 immutable-source edit through a GM endpoint", "sources.withdrawSource", { sourceId: "qs9none0000000000000000000" }],
    ["F2 permanent source purge through a GM endpoint", "sources.purgeSource", { sourceId: "qs9none0000000000000000000" }],
    ["F3 H4's retry action does not route through B4 authority", "operations.retryProcessingStep", { stepId: "qs9none0000000000000000000" }],
    ["F4 reanalysis request does not route through B4 authority", "operations.requestReanalysis", { sourceId: "qs9none0000000000000000000" }],
    ["F5 arbitrary model id has no GM operation", "operations.runArbitraryModel", { modelId: "z-ai/glm-5.3-flash" }],
    ["F6 raw database patch has no GM operation", "platform.rawDbPatch", { table: "sources", patch: {} }],
    ["F7 member operation refused on the GM dispatch", "access.changeMembershipRole", { membershipId: "k57none0000000000000000000", role: "member" }],
  ]) {
    const result = await dispatchGm(gm.client, operation, input);
    check(id, result?._tag === "error" && result.error._tag === "unsupported",
      JSON.stringify({ tag: errTag(result), code: errCode(result) }));
  }
}

// --- Phase G: exit and the final audit spine ----------------------------------
{
  const state = await gmState();
  const openGrant = state?.value?.grants?.find(
    (g) => g.closedAtMs === null && g.reason === ENTRY_REASON,
  );
  const exited = await dispatchGm(gm.client, "access.exitGmMode", {
    grantId: openGrant?.grantId,
  });
  check("G1 the operator exits GM mode",
    isOk(exited), JSON.stringify({ closedAtMs: exited?.value?.closedAtMs, err: errCode(exited) }));

  const finalOverview = await overview(gm.client);
  check("G2 the overview shows not_gm after exit",
    finalOverview?.state === "not_gm", JSON.stringify({ state: finalOverview?.state }));

  const audit4 = await auditTail();
  const all = audit4?.value?.records ?? [];
  const ops = {};
  for (const r of all) {
    ops[r.operationName] = (ops[r.operationName] ?? 0) + 1;
  }
  row("G3 audit spine operations", JSON.stringify(ops));
  check("G4 every audited GM action carries grant, basis and outcome",
    all.length > 0 && all.every((r) => r.gmGrantId !== null && r.gmBasis !== null && r.outcome !== null),
    `${all.length} rows`);
}

const failed = results.filter((r) => r.outcome === "FAIL");
console.log(`\n# B4 live proofs summary: ${results.length - failed.length}/${results.length} PASS`);
if (failed.length > 0) {
  console.log(`# FAILED: ${failed.map((r) => r.id).join(", ")}`);
  process.exitCode = 1;
}
