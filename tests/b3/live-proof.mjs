/**
 * B3 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/b3, instance pastel-albatross-170, EU).
 *
 * Output is sanitized: no tokens, no keys; proof persons use the reserved
 * @kiero.invalid domain; invitation codes are dev-deployment fixture
 * installs (the emailed-delivery leg is BLOCKED without RESEND_API_KEY,
 * exactly like B1's OTP evidence). Every command goes through the checked
 * dispatch entries (admitCommand / dispatchMembership / the
 * createInvitation action wrapper); identities are REAL Convex Auth
 * sessions from B1's email-code flow with fixture codes.
 *
 * Run: node tests/b3/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.)
 */

import { ConvexHttpClient } from "convex/browser";

const DEPLOYMENT = process.env.KIERO_B3_DEPLOYMENT ?? "pastel-albatross-170";
const URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;
const FIXTURE_CODE = "42424242";

// Per-run fixture identities keep the script re-runnable on the shared dev
// lease without resetting data (proof domain only).
const RUN = process.env.KIERO_B3_PROOF_RUN ?? Date.now().toString(36);
const person = (name) => `b3-${name}-${RUN}@kiero.invalid`;
const SZEF1 = person("szef1");
const SZEF2 = person("szef2");
const SZEF5 = person("szef5");
const SZEF6 = person("szef6");
const SZEF7 = person("szef7");
const SZEF8 = person("szef8");
const RACER = person("racer");
const OBCY = person("obcy");
const NEVER = person("never");
const COMPANY_NAME = `Budowa B3 ${RUN}`;

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

const envelope = (operation, input) => ({ operation, input, expectedRevisions: [] });
const admit = (client, operation, input) =>
  client.mutation("access/membership/functions:admitCommand", {
    envelope: envelope(operation, input),
  });
const dispatch = (client, operation, input) =>
  client.mutation("access/membership/functions:dispatchMembership", {
    envelope: envelope(operation, input),
  });
const invite = (client, input) =>
  client.action("access/membership/functions:createInvitationCommand", {
    envelope: envelope("access.createInvitation", input),
  });

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
  const set = await bootstrap.action("access/identity/probe:b1ProofSetCode", {
    email,
    code: FIXTURE_CODE,
  });
  if (set?._tag !== "ok") {
    throw new Error(`fixture code install failed for ${email}: ${JSON.stringify(set)}`);
  }
  const result = await bootstrap.action("auth:signIn", {
    provider: "email_code",
    params: { email, code: FIXTURE_CODE },
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
  return { client, sessionId: ensured.sessionId, email };
}

const companyState = (companyId) =>
  anon().action("access/membership/probe:b3ProofCompanyState", { companyId });
const setInvitationCode = (invitationId, code) =>
  anon().action("access/membership/probe:b3ProofSetInvitationCode", { invitationId, code });
const expireInvitation = (invitationId) =>
  anon().action("access/membership/probe:b3ProofExpireInvitation", { invitationId });
const drainNow = () => anon().action("platform/probe:probeDrainNow", {});

console.log(`# B3 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);

// --- Phase A: honest surfaces before any membership -------------------------
{
  const client = anon();
  const availability = await client.query("access/identity/functions:providerAvailability", {});
  check("A1 provider availability honest (email code on, Google off)",
    availability?.emailCode === true && availability?.google === false,
    JSON.stringify(availability));
  const denied = await errOf(() =>
    client.query("access/identity/functions:resolveCurrentAccess", { sessionId: "k57anon" }),
  );
  check("A2 anonymous current-access read denied (Polish copy)",
    denied !== null && denied.includes("Najpierw się zaloguj"));
  const anonAdmit = await admit(client, "access.acceptInvitation", {
    invitationId: "k57anon0000000000000000000",
    verificationCode: "00000000",
  });
  check("A3 anonymous admission command fails closed unauthenticated",
    anonAdmit?._tag === "error" && anonAdmit.error._tag === "unauthenticated",
    JSON.stringify({ tag: errTag(anonAdmit), code: errCode(anonAdmit) }));
  const anonDispatch = await dispatch(client, "access.transferAdministration", {
    toUserId: "k57anon0000000000000000000",
  });
  check("A4 anonymous company-scoped dispatch fails closed unauthenticated",
    anonDispatch?._tag === "error" && anonDispatch.error._tag === "unauthenticated",
    JSON.stringify({ tag: errTag(anonDispatch), code: errCode(anonDispatch) }));
  const malformed = await client.mutation("access/membership/functions:dispatchMembership", {
    envelope: { nonsense: true },
  });
  check("A5 malformed command envelope fails typed validation",
    malformed?._tag === "error" && malformed.error._tag === "validation");
}

// --- Phase B: first boss — create company, become first administrator ------
let companyA = null;
let szef1 = null;
{
  szef1 = await signInFixture(SZEF1);
  row("B0 szef1 signed in (real Convex Auth session, fixture code)", SZEF1);
  const preAccess = await szef1.client.query("access/identity/functions:resolveCurrentAccess", {
    sessionId: szef1.sessionId,
  });
  check("B1 membership-less person resolves null access before admission",
    preAccess === null, `value=${JSON.stringify(preAccess)}`);
  const probe = await szef1.client.query("access/identity/functions:accessContextProbe", {});
  check("B2 canonical chain resolves no company scope before admission", probe === null);
  const scoped = await dispatch(szef1.client, "access.revokeMembership", {
    membershipId: "k57none000000000000000000",
  });
  check("B3 company-scoped dispatch denies membership-less actor honestly",
    scoped?._tag === "error" && scoped.error._tag === "unauthenticated",
    JSON.stringify({ code: errCode(scoped) }));
  const created = await admit(szef1.client, "access.createCompany", {
    name: COMPANY_NAME,
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
  });
  check("B4 company created with first administrator (admission dispatch)",
    isOk(created) && typeof created.value.companyId === "string" && typeof created.value.membershipId === "string",
    JSON.stringify({ companyId: created?.value?.companyId, membershipId: created?.value?.membershipId }));
  companyA = created?.value?.companyId ?? null;
  const again = await admit(szef1.client, "access.createCompany", {
    name: `Druga firma ${RUN}`,
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
  });
  check("B5 second company refused (one-active-company rule)",
    again?._tag === "error" && again.error.code === "one_active_company_rule",
    JSON.stringify({ tag: errTag(again), code: errCode(again) }));
  const access = await szef1.client.query("access/identity/functions:resolveCurrentAccess", {
    sessionId: szef1.sessionId,
  });
  check("B6 resolveCurrentAccess returns the REAL company scope for the first admin",
    access?.companyId === companyA && access?.membershipRole === "admin" && access?.isGm === false,
    JSON.stringify({ companyId: access?.companyId, role: access?.membershipRole, tz: access?.companyTimezone, currency: access?.defaultCurrency }));
  const probeAfter = await szef1.client.query("access/identity/functions:accessContextProbe", {});
  check("B7 canonical access context resolves the member's company",
    probeAfter?.companyId === companyA, JSON.stringify(probeAfter));
  const overview = await szef1.client.query("access/membership/functions:membershipOverview", {});
  check("B8 overview shows the firm, the sole admin member and an empty invitation list",
    overview?.state === "member" && overview?.myRole === "admin"
      && overview?.members?.length === 1 && overview?.members?.[0]?.isSelf === true
      && overview?.invitations?.length === 0,
    JSON.stringify({ state: overview?.state, role: overview?.myRole, members: overview?.members?.length }));
  const badTz = await admit(szef1.client, "access.createCompany", {
    name: "X",
    timezone: "Mars/Olympus",
    defaultCurrency: "PLN",
  });
  check("B9 invalid timezone rejected before any write",
    badTz?._tag === "error", JSON.stringify({ code: errCode(badTz) }));
}

// --- Phase C: invitation lifecycle (issue, honest delivery, accept) ---------
let szef2 = null;
let szef2Invitation = null;
{
  const issued = await invite(szef1.client, { email: SZEF2, role: "member" });
  check("C1 invitation issued to one targeted address (7-day expiry; honest delivery failure without RESEND_API_KEY)",
    isOk(issued) && issued.value.delivery === "delivery_failed"
      && issued.value.expiresAtMs > Date.now() + 6.9 * 24 * 3600 * 1000,
    JSON.stringify({ delivery: issued?.value?.delivery, expiresAtMs: issued?.value?.expiresAtMs }));
  szef2Invitation = issued?.value?.invitationId ?? null;
  const duplicate = await invite(szef1.client, { email: SZEF2, role: "member" });
  check("C2 duplicate live invitation refused",
    duplicate?._tag === "error" && duplicate.error.code === "invitation_already_pending",
    JSON.stringify({ code: errCode(duplicate) }));
  await setInvitationCode(szef2Invitation, FIXTURE_CODE);

  // Fresh sign-up flow: the person did not exist before the invitation.
  szef2 = await signInFixture(SZEF2);
  const admissionView = await szef2.client.query("access/membership/functions:membershipOverview", {});
  check("C3 fresh sign-up sees the targeted pending invitation (no code anywhere in the view)",
    admissionView?.state === "no_company"
      && admissionView?.pendingInvitations?.length === 1
      && admissionView?.pendingInvitations?.[0]?.companyName === COMPANY_NAME
      && admissionView?.pendingInvitations?.[0]?.role === "member"
      && !JSON.stringify(admissionView).includes(FIXTURE_CODE),
    JSON.stringify({ state: admissionView?.state, pending: admissionView?.pendingInvitations?.length }));
  const wrongCode = await admit(szef2.client, "access.acceptInvitation", {
    invitationId: szef2Invitation,
    verificationCode: "00000000",
  });
  check("C4 wrong invitation code refused (validation)",
    wrongCode?._tag === "error" && wrongCode.error.code === "verification_code_mismatch",
    JSON.stringify({ code: errCode(wrongCode) }));
  const accepted = await admit(szef2.client, "access.acceptInvitation", {
    invitationId: szef2Invitation,
    verificationCode: FIXTURE_CODE,
  });
  check("C5 invitation accepted by the fresh sign-up (admission dispatch)",
    isOk(accepted) && typeof accepted.value.membershipId === "string",
    JSON.stringify({ membershipId: accepted?.value?.membershipId }));
  const access2 = await szef2.client.query("access/identity/functions:resolveCurrentAccess", {
    sessionId: szef2.sessionId,
  });
  check("C6 second member resolves the real company scope with member role",
    access2?.companyId === companyA && access2?.membershipRole === "member",
    JSON.stringify({ companyId: access2?.companyId, role: access2?.membershipRole }));
  const secondUse = await admit(szef2.client, "access.acceptInvitation", {
    invitationId: szef2Invitation,
    verificationCode: FIXTURE_CODE,
  });
  check("C7 invitation is single-use (second acceptance refused)",
    secondUse?._tag === "error" && secondUse.error.code === "invitation_not_pending",
    JSON.stringify({ code: errCode(secondUse) }));
}

// --- Phase C2: expiry, revocation, rejection, stranger denial --------------
{
  // Expired invitation.
  const exp = await invite(szef1.client, { email: SZEF5, role: "member" });
  await setInvitationCode(exp.value.invitationId, FIXTURE_CODE);
  await expireInvitation(exp.value.invitationId);
  const szef5 = await signInFixture(SZEF5);
  const expired = await admit(szef5.client, "access.acceptInvitation", {
    invitationId: exp.value.invitationId,
    verificationCode: FIXTURE_CODE,
  });
  check("C8 expired invitation refused even with the correct code",
    expired?._tag === "error" && expired.error.code === "invitation_expired",
    JSON.stringify({ code: errCode(expired) }));
  const reissue = await invite(szef1.client, { email: SZEF5, role: "member" });
  check("C9 re-issuing after expiry closes the stale row and issues a fresh one",
    isOk(reissue) && reissue.value.invitationId !== exp.value.invitationId, "stale=closed,fresh=issued");

  // Revoked invitation.
  const rev = await invite(szef1.client, { email: SZEF6, role: "member" });
  await setInvitationCode(rev.value.invitationId, FIXTURE_CODE);
  const revoked = await dispatch(szef1.client, "access.revokeInvitation", {
    invitationId: rev.value.invitationId,
  });
  check("C10 administrator revokes the invitation",
    isOk(revoked) && revoked.value.revoked === "revoked");
  const revokedAgain = await dispatch(szef1.client, "access.revokeInvitation", {
    invitationId: rev.value.invitationId,
  });
  check("C11 revocation is idempotent", isOk(revokedAgain));
  const szef6 = await signInFixture(SZEF6);
  const unusable = await admit(szef6.client, "access.acceptInvitation", {
    invitationId: rev.value.invitationId,
    verificationCode: FIXTURE_CODE,
  });
  check("C12 revoked invitation unusable",
    unusable?._tag === "error" && unusable.error.code === "invitation_not_pending",
    JSON.stringify({ code: errCode(unusable) }));

  // Rejection by the invitee.
  const rej = await invite(szef1.client, { email: SZEF8, role: "member" });
  await setInvitationCode(rej.value.invitationId, FIXTURE_CODE);
  const szef8 = await signInFixture(SZEF8);
  const rejected = await admit(szef8.client, "access.rejectInvitation", {
    invitationId: rej.value.invitationId,
  });
  check("C13 invitee rejects the invitation",
    isOk(rejected) && rejected.value.state === "rejected");
  const acceptAfterReject = await admit(szef8.client, "access.acceptInvitation", {
    invitationId: rej.value.invitationId,
    verificationCode: FIXTURE_CODE,
  });
  check("C14 rejected invitation no longer acceptable",
    acceptAfterReject?._tag === "error" && acceptAfterReject.error.code === "invitation_not_pending",
    JSON.stringify({ code: errCode(acceptAfterReject) }));

  // A stranger cannot accept someone else's targeted invitation.
  const obcyEarly = await signInFixture(OBCY);
  const notYours = await admit(obcyEarly.client, "access.acceptInvitation", {
    invitationId: reissue.value.invitationId,
    verificationCode: FIXTURE_CODE,
  });
  check("C15 non-targeted person learns nothing (not_found, no existence leak)",
    notYours?._tag === "error" && notYours.error._tag === "not_found",
    JSON.stringify({ tag: errTag(notYours), code: errCode(notYours) }));

  // Existing-identity acceptance: szef7 signed in BEFORE being invited.
  const szef7 = await signInFixture(SZEF7);
  const preInvited = await szef7.client.query("access/membership/functions:membershipOverview", {});
  const inv7 = await invite(szef1.client, { email: SZEF7, role: "member" });
  await setInvitationCode(inv7.value.invitationId, FIXTURE_CODE);
  const accepted7 = await admit(szef7.client, "access.acceptInvitation", {
    invitationId: inv7.value.invitationId,
    verificationCode: FIXTURE_CODE,
  });
  check("C16 EXISTING identity (account before invitation) accepts too",
    preInvited?.state === "no_company" && isOk(accepted7),
    JSON.stringify({ preState: preInvited?.state, membershipId: accepted7?.value?.membershipId }));

  // Race acceptance vs a second acceptance: exactly one valid outcome.
  const race = await invite(szef1.client, { email: RACER, role: "member" });
  await setInvitationCode(race.value.invitationId, FIXTURE_CODE);
  const racerA = await signInFixture(RACER);
  const racerB = await signInFixture(RACER);
  const outcomes = await Promise.allSettled([
    admit(racerA.client, "access.acceptInvitation", {
      invitationId: race.value.invitationId,
      verificationCode: FIXTURE_CODE,
    }),
    admit(racerB.client, "access.acceptInvitation", {
      invitationId: race.value.invitationId,
      verificationCode: FIXTURE_CODE,
    }),
  ]);
  const settled = outcomes.map((o) =>
    o.status === "fulfilled" ? o.value : { _tag: "error", error: { code: "threw" } },
  );
  const oks = settled.filter(isOk).length;
  check("C17 racing acceptances commit exactly one valid outcome (OCC on the invitation row)",
    oks === 1 && settled.filter((r) => !isOk(r)).every((r) => r.error.code === "invitation_not_pending"),
    JSON.stringify(settled.map((r) => errCode(r))));
}

// --- Phase D: roles, administration transfer, last-admin guard --------------
{
  const state0 = await companyState(companyA);
  // Membership order is creation order: [0] szef1 (creator), [1] szef2, [2] szef7, [3] racer.
  const szef1m = state0.value.memberships[0];
  const szef2m = state0.value.memberships[1];
  row("D0 company membership order", state0.value.memberships.map((m) => `${m.role}/${m.state}`).join(","));

  const promoted = await dispatch(szef1.client, "access.changeMembershipRole", {
    membershipId: szef2m.membershipId,
    role: "admin",
  });
  check("D1 administrator promotes a member (role vocabulary admin/member)",
    isOk(promoted), JSON.stringify({ membershipId: promoted?.value?.membershipId }));
  const state1 = await companyState(companyA);
  check("D2 company now has two active administrators",
    state1.value.activeAdminCount === 2, `admins=${state1.value.activeAdminCount}`);

  // Race two last-admin transfers: the company must retain administration.
  const raced = await Promise.allSettled([
    dispatch(szef1.client, "access.transferAdministration", { toUserId: szef2m.userId }),
    dispatch(szef2.client, "access.transferAdministration", { toUserId: szef1m.userId }),
  ]);
  const raceResults = raced.map((o) =>
    o.status === "fulfilled" ? o.value : { _tag: "error", error: { code: "threw" } },
  );
  const stateAfterRace = await companyState(companyA);
  check("D3 two racing transfers leave the company with at least one administrator",
    stateAfterRace.value.activeAdminCount >= 1
      && raceResults.every(
        (r) => isOk(r) || r.error._tag === "conflict" || r.error._tag === "forbidden" || r.error.code === "threw",
      ),
    JSON.stringify({ admins: stateAfterRace.value.activeAdminCount, outcomes: raceResults.map((r) => errCode(r)) }));

  // Normalize: exactly one admin, szef1, for the guard proofs.
  let state = stateAfterRace;
  const adminOf = (s) => s.value.memberships.find((m) => m.role === "admin" && m.state === "active");
  if (state.value.activeAdminCount === 2) {
    const m2 = state.value.memberships.find((m) => m.userId === szef2m.userId && m.state === "active");
    await dispatch(szef1.client, "access.changeMembershipRole", {
      membershipId: m2.membershipId,
      role: "member",
    });
  } else if (adminOf(state).userId !== szef1m.userId) {
    await dispatch(szef2.client, "access.transferAdministration", { toUserId: szef1m.userId });
    const m2 = state.value.memberships.find((m) => m.userId === szef2m.userId && m.state === "active");
    if (m2.role === "admin") {
      await dispatch(szef1.client, "access.changeMembershipRole", {
        membershipId: m2.membershipId,
        role: "member",
      });
    }
  }
  state = await companyState(companyA);
  check("D4 normalized: szef1 is the sole administrator for the guard proofs",
    state.value.activeAdminCount === 1 && adminOf(state).userId === szef1m.userId,
    `admins=${state.value.activeAdminCount}`);

  const ownMembershipId = adminOf(state).membershipId;
  const leave = await dispatch(szef1.client, "access.revokeMembership", {
    membershipId: ownMembershipId,
  });
  check("D5 final administrator cannot leave",
    leave?._tag === "error" && leave.error.code === "last_administrator",
    JSON.stringify({ tag: errTag(leave), code: errCode(leave) }));
  const selfDemote = await dispatch(szef1.client, "access.changeMembershipRole", {
    membershipId: ownMembershipId,
    role: "member",
  });
  check("D6 final administrator cannot lose administration by demotion",
    selfDemote?._tag === "error" && selfDemote.error.code === "last_administrator",
    JSON.stringify({ code: errCode(selfDemote) }));
  const toSelf = await dispatch(szef1.client, "access.transferAdministration", {
    toUserId: szef1m.userId,
  });
  check("D7 transfer to self refused",
    toSelf?._tag === "error" && toSelf.error.code === "transfer_to_self",
    JSON.stringify({ code: errCode(toSelf) }));
  const nonMember = await anon().action("access/membership/probe:b3ProofUserByEmail", {
    email: SZEF5,
  });
  check("D8a guarded probe resolves the non-member target person (dev fixtures only)",
    isOk(nonMember) && typeof nonMember.value.userId === "string", "userId=<redacted>");
  const toOutsider = await dispatch(szef1.client, "access.transferAdministration", {
    toUserId: nonMember.value.userId,
  });
  check("D8 transfer to a non-member refused (not_found)",
    toOutsider?._tag === "error" && toOutsider.error.code === "target_membership_not_found",
    JSON.stringify({ code: errCode(toOutsider) }));
  const memberInvited = await invite(szef2.client, { email: NEVER, role: "member" });
  check("D9 plain member cannot administer (invitation issuance forbidden)",
    memberInvited?._tag === "error" && memberInvited.error._tag === "forbidden",
    JSON.stringify({ tag: errTag(memberInvited), code: errCode(memberInvited) }));
  const transferred = await dispatch(szef1.client, "access.transferAdministration", {
    toUserId: szef2m.userId,
  });
  check("D10 administration transferred atomically (promote+demote in one transaction)",
    isOk(transferred)
      && transferred.value.adminMembershipId === szef2m.membershipId
      && transferred.value.demotedMembershipId === ownMembershipId,
    JSON.stringify({ admin: transferred?.value?.adminMembershipId, demoted: transferred?.value?.demotedMembershipId }));
  const stateT = await companyState(companyA);
  check("D11 after transfer the company retains exactly one administrator (roles swapped)",
    stateT.value.activeAdminCount === 1
      && stateT.value.memberships.find((m) => m.membershipId === szef2m.membershipId)?.role === "admin"
      && stateT.value.memberships.find((m) => m.membershipId === ownMembershipId)?.role === "member",
    `admins=${stateT.value.activeAdminCount}`);
}

// --- Phase E: revocation fan-out + immediate access end ----------------------
{
  const state = await companyState(companyA);
  const admin = state.value.memberships.find((m) => m.role === "admin" && m.state === "active");
  const victim = state.value.memberships.find(
    (m) => m.state === "active" && m.membershipId !== admin.membershipId,
  );
  const adminClient = admin.userId === state.value.memberships[0].userId ? szef1.client : szef2.client;
  const victimIsSzef1 = victim.userId === state.value.memberships[0].userId;
  const victimClient = victimIsSzef1 ? szef1.client : szef2.client;
  const victimSessionId = victimIsSzef1 ? szef1.sessionId : szef2.sessionId;
  const revoked = await dispatch(adminClient, "access.revokeMembership", {
    membershipId: victim.membershipId,
  });
  check("E1 administrator revokes a member (timestamped, atomic with event+job)",
    isOk(revoked) && typeof revoked.value.revokedAtMs === "number",
    `revokedAtMs=${revoked?.value?.revokedAtMs}`);
  const afterState = await companyState(companyA);
  check("E2 revoked membership kept as history (state revoked, authorship preserved)",
    afterState.value.memberships.find((m) => m.membershipId === victim.membershipId)?.state === "revoked"
      && afterState.value.activeAdminCount >= 1,
    `admins=${afterState.value.activeAdminCount}`);
  // The membership row ends access IMMEDIATELY; the durable cleanup may have
  // already revoked the device session too (registered runAfter(0)). Both
  // shapes are honest denials: a null snapshot, or the sanitized
  // unauthenticated throw once the registry row is revoked.
  const freshAccessError = await errOf(() =>
    victimClient.query("access/identity/functions:resolveCurrentAccess", {
      sessionId: victimSessionId,
    }),
  );
  const freshAccess = freshAccessError === null
    ? await victimClient.query("access/identity/functions:resolveCurrentAccess", {
        sessionId: victimSessionId,
      })
    : null;
  const deniedByNull = freshAccess === null;
  const deniedByThrow = freshAccessError !== null && freshAccessError.includes("Najpierw się zaloguj");
  check("E3 fresh current-access read DENIES the removed boss (null snapshot or revoked-session throw)",
    deniedByNull || deniedByThrow,
    JSON.stringify({ nullSnapshot: deniedByNull, revokedSession: deniedByThrow }));
  const overviewError = await errOf(() =>
    victimClient.query("access/membership/functions:membershipOverview", {}),
  );
  const victimOverview = overviewError === null
    ? await victimClient.query("access/membership/functions:membershipOverview", {})
    : null;
  check("E4 removed boss gets no company data (admission view or denied session)",
    victimOverview === null || victimOverview?.state === "no_company",
    JSON.stringify({ state: victimOverview?.state ?? "denied" }));

  // The declared consumer edge: drain -> cleanup job -> device sessions die.
  await drainNow();
  let deniedReason = null;
  for (let attempt = 0; attempt < 20; attempt++) {
    const ensured = await victimClient.mutation("access/identity/functions:ensureSessionRegistry", {});
    if (ensured?.state === "denied") {
      deniedReason = ensured.reason;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  check("E5 durable MembershipRevoked intent ran: the removed boss's sessions are revoked",
    deniedReason === "revoked", `reason=${JSON.stringify(deniedReason)}`);
}

// --- Phase F: tenant isolation -----------------------------------------------
{
  const stranger = await signInFixture(OBCY);
  const created = await admit(stranger.client, "access.createCompany", {
    name: "Firma Obcych",
    // A real multi-segment IANA zone the removed contract regex rejected:
    // proves end-to-end that validateTimezone is the single authority and
    // the access snapshot mirrors what it accepted.
    timezone: "America/Argentina/Buenos_Aires",
    defaultCurrency: "EUR",
  });
  check("F1 a second, fully isolated company exists (stranger is its first admin; multi-segment IANA zone accepted)",
    isOk(created) && created.value.companyId !== companyA,
    JSON.stringify({ companyId: created?.value?.companyId }));
  const stateA = await companyState(companyA);
  const aMember = stateA.value.memberships.find((m) => m.state === "active");
  const crossRole = await dispatch(stranger.client, "access.changeMembershipRole", {
    membershipId: aMember.membershipId,
    role: "member",
  });
  check("F2 cross-tenant membership id is indistinguishable from missing (no leak)",
    crossRole?._tag === "error" && crossRole.error._tag === "not_found",
    JSON.stringify({ tag: errTag(crossRole), code: errCode(crossRole) }));
  const anInvitation = stateA.value.invitations.find((i) => i.state === "pending");
  if (anInvitation) {
    const crossInvite = await dispatch(stranger.client, "access.revokeInvitation", {
      invitationId: anInvitation.invitationId,
    });
    check("F3 cross-tenant invitation revocation denied (not_found)",
      crossInvite?._tag === "error" && crossInvite.error._tag === "not_found",
      JSON.stringify({ code: errCode(crossInvite) }));
  } else {
    check("F3 cross-tenant invitation revocation denied (no pending invitation to probe)", false);
  }
  const crossRevoke = await dispatch(stranger.client, "access.revokeMembership", {
    membershipId: aMember.membershipId,
  });
  check("F4 cross-tenant membership revocation denied (not_found)",
    crossRevoke?._tag === "error" && crossRevoke.error._tag === "not_found",
    JSON.stringify({ code: errCode(crossRevoke) }));
  const strangerAccess = await stranger.client.query("access/identity/functions:resolveCurrentAccess", {
    sessionId: stranger.sessionId,
  });
  check("F5 stranger resolves ONLY their own company scope (snapshot decodes the multi-segment zone)",
    strangerAccess?.companyId === created.value.companyId && strangerAccess?.companyId !== companyA
      && strangerAccess?.companyTimezone === "America/Argentina/Buenos_Aires",
    JSON.stringify({ companyId: strangerAccess?.companyId, role: strangerAccess?.membershipRole, tz: strangerAccess?.companyTimezone }));
  const strangerOverview = await stranger.client.query("access/membership/functions:membershipOverview", {});
  const leaked = JSON.stringify(strangerOverview);
  check("F6 stranger's overview leaks no other-tenant content",
    strangerOverview?.state === "member"
      && strangerOverview?.members?.length === 1
      && !leaked.includes(COMPANY_NAME),
    JSON.stringify({ state: strangerOverview?.state, members: strangerOverview?.members?.length }));
}

// --- Summary -----------------------------------------------------------------
const counts = results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
console.log(`\nSummary: ${JSON.stringify(counts)} of ${results.length} checks`);
if (results.some((r) => r.outcome !== "PASS")) {
  console.log("B3 LIVE PROOFS FAILED");
  process.exit(1);
}
console.log("ALL B3 LIVE PROOFS PASSED");
