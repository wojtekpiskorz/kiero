/**
 * F1 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/f1, instance sincere-dogfish-352, EU).
 *
 * Actor context: the A3 service-bridge identity (the service account's own
 * session, resolved through the canonical resolution and authorization
 * seam) plus server-seeded fixture sessions: a second boss of the same
 * company (isolation), a second device of boss A (device consistency), a
 * revoked boss (access failure) and a GM operator with an open grant and
 * open alpha activation (read-only inspection). No development-auth
 * shortcut exists; sessions are created server-side by guarded probe
 * fixtures.
 *
 * Run: node tests/f1/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.)
 */

import { ConvexHttpClient } from "convex/browser";
import { randomUUID } from "node:crypto";

const DEPLOYMENT = "sincere-dogfish-352";
const CLIENT_URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;

const client = () => new ConvexHttpClient(CLIENT_URL);

const results = [];
function record(id, ok, detail) {
  const outcome = ok ? "PASS" : "FAIL";
  results.push({ id, outcome, detail });
  console.log(`[${outcome}] ${id}${detail === undefined ? "" : ` :: ${detail}`}`);
  return outcome === "PASS";
}
function summarize() {
  const counts = results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
  console.log(`\nSummary: ${JSON.stringify(counts)} of ${results.length} checks`);
  return results.every((r) => r.outcome === "PASS");
}
const key = () => `idem_${randomUUID()}`;
const envelope = (operation, input) => ({ operation, input, expectedRevisions: [] });

const markRead = (input, sessionId) =>
  client().action("attention/read_state/probe:probeMarkSourceRead", {
    envelope: envelope("attention.markSourceRead", input),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const readState = (sourceIds, sessionId) =>
  client().action("attention/read_state/probe:probeReadState", {
    sourceIds,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const attentionState = (sessionId) =>
  client().action("attention/read_state/probe:probeAttentionState", {
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const gmOverview = (gmSessionId, companyId) =>
  client().action("attention/read_state/probe:probeGmReadStateOverview", {
    gmSessionId,
    companyId,
  });
const changePrefs = (input, sessionId) =>
  client().action("attention/preferences/probe:probeChangeNotificationPreferences", {
    envelope: envelope("attention.changeNotificationPreferences", input),
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const myPrefs = (sessionId) =>
  client().action("attention/preferences/probe:probeMyPreferences", {
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const evaluate = (request, sessionId) =>
  client().action("attention/preferences/probe:probeEvaluatePersonalDelivery", {
    ...(sessionId === undefined ? {} : { sessionId }),
    ...request,
  });
const companyView = (numItems, sessionId) =>
  client().action("sources/read/probe:probeCompanyConversation", {
    numItems,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const projectView = (projectId, numItems, sessionId) =>
  client().action("sources/read/probe:probeProjectConversation", {
    projectId,
    numItems,
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const accept = (input, idempotencyKey, sessionId) =>
  client().action("sources/accept/probe:probeAcceptSource", {
    envelope: { ...envelope("sources.acceptSource", input), idempotencyKey },
    ...(sessionId === undefined ? {} : { sessionId }),
  });

const isOk = (r) => r._tag === "ok";
const isErr = (r, kind, code) =>
  r._tag === "error" && (kind === undefined || r.error._tag === kind) &&
  (code === undefined || r.error.code === code);

console.log(`# F1 live proofs :: ${DEPLOYMENT} :: ${new Date().toISOString()}`);

// Rerunnable evidence: relative event counts from a start baseline, and a
// neutral personal-preferences preflight (the deployment keeps its data
// across runs; fresh sources and per-source row filters keep every check
// meaningful on a warm deployment).
const eventsBase = (await attentionState()).value.readChangedEvents.length;
await changePrefs({
  mutedProjectIds: [],
  companyEntriesMuted: false,
  taskRemindersMuted: false,
  hidePreviewContent: false,
  quietHours: null,
});

// --- fixtures ---------------------------------------------------------------
const seed = await client().action("platform/probe:probeSeed", {});
if (seed._tag !== "ok") throw new Error(`probeSeed failed: ${JSON.stringify(seed)}`);
const companyA = seed.value.companyId;

const proj = async (name) => {
  const seeded = await client().action("sources/accept/probe:probeSeedProject", { displayName: name });
  if (seeded._tag !== "ok") throw new Error("project seeding failed");
  return seeded.value.projectId;
};
const P1 = await proj("Banan (F1)");
const P2 = await proj("Kaczmarek (F1)");

const bossB = await client().action("attention/read_state/probe:probeSeedBoss", {
  email: "f1-boss-b@kiero.invalid",
  displayName: "F1 boss B",
  deviceLabel: "f1-boss-b-bridge",
});
const bossC = await client().action("attention/read_state/probe:probeSeedBoss", {
  email: "f1-boss-c@kiero.invalid",
  displayName: "F1 boss C (revocation)",
  deviceLabel: "f1-boss-c-bridge",
});
const bossD = await client().action("attention/read_state/probe:probeSeedBoss", {
  email: "f1-boss-d@kiero.invalid",
  displayName: "F1 boss D (GM write denial)",
  deviceLabel: "f1-boss-d-bridge",
});
if (!isOk(bossB) || !isOk(bossC) || !isOk(bossD)) throw new Error("boss seeding failed");
const SESS_B = bossB.value.sessionId;
const SESS_C = bossC.value.sessionId;
const USER_B = bossB.value.userId;
const USER_C = bossC.value.userId;

const deviceA2 = await client().action("attention/read_state/probe:probeSeedDevice", {
  email: "platform-service@kiero.invalid",
  deviceLabel: "f1-boss-a-device-2",
});
if (!isOk(deviceA2)) throw new Error("device seeding failed");
const SESS_A2 = deviceA2.value.sessionId;

const gm = await client().action("attention/read_state/probe:probeSeedGm", {});
if (!isOk(gm)) throw new Error(`GM seeding failed: ${JSON.stringify(gm)}`);
const SESS_GM = gm.value.sessionId;

const uploadFor = async () => {
  const upload = await client().action("sources/accept/probe:probeSeedUpload", {});
  if (upload._tag !== "ok") throw new Error("upload seeding failed");
  return upload.value.uploadId;
};
const acceptText = async (text, hints) => {
  const accepted = await accept(
    {
      uploadId: await uploadFor(),
      authorText: text,
      intendedSentAtIso: "2026-09-09T07:15:00.000Z",
      timezoneSnapshot: "Europe/Warsaw",
      projectHints: hints,
    },
    key(),
  );
  if (accepted._tag !== "ok") throw new Error(`acceptance failed: ${JSON.stringify(accepted)}`);
  return accepted.value.sourceId;
};

// One shared mixed-project source: appears in the company view AND both
// project views, one original (CONTEXT.md "Rozmowa projektowa").
const S1 = await acceptText("Dowóz płytek na Buniewice; Kaczmarek potwierdza odbiór", [P1, P2]);
// A company-entry source with no project links (a projection that no
// project view carries).
const S4 = await acceptText("Notatka ogólna firmy bez projektu", []);

// --- A1: both bosses start unread; absence is the glossary's unread ------
const beforeA = await readState([S1]);
const beforeB = await readState([S1], SESS_B);
record(
  "A1 both bosses initially unread (absence = unread)",
  isOk(beforeA) && isOk(beforeB) &&
    beforeA.value.entries[0].read === false && beforeA.value.entries[0].readAtMs === null &&
    beforeB.value.entries[0].read === false,
  `A=${JSON.stringify(beforeA.value?.entries[0])} B=${JSON.stringify(beforeB.value?.entries[0])}`,
);

// --- A2: ONE mutation by A marks the logical source read everywhere ------
const marked = await markRead({ sourceId: S1, read: true });
const afterA = await readState([S1]);
const afterA2 = await readState([S1], SESS_A2); // A's second device
const afterB = await readState([S1], SESS_B); // B: untouched
record(
  "A2 A reads -> read for A on BOTH devices, still unread for B",
  isOk(marked) && isOk(afterA) && isOk(afterA2) && isOk(afterB) &&
    afterA.value.entries[0].read === true &&
    afterA2.value.entries[0].read === true &&
    afterA.value.entries[0].readAtMs === afterA2.value.entries[0].readAtMs &&
    afterB.value.entries[0].read === false,
  `A(dev1)=${afterA.value?.entries[0]?.read} A(dev2)=${afterA2.value?.entries[0]?.read} B=${afterB.value?.entries[0]?.read}`,
);

// --- A3: the same state answers the company view AND both project views --
const company = await companyView(5);
const viewP1 = await projectView(P1, 5);
const viewP2 = await projectView(P2, 5);
const inCompany = company.value?.page?.some((rowR) => rowR.sourceId === S1) ?? false;
const inP1 = viewP1.value?.page?.some((rowR) => rowR.sourceId === S1) ?? false;
const inP2 = viewP2.value?.page?.some((rowR) => rowR.sourceId === S1) ?? false;
record(
  "A3 one mixed-project source, one row: company and both project views carry the same sourceId",
  isOk(company) && isOk(viewP1) && isOk(viewP2) && inCompany && inP1 && inP2 &&
    afterA.value.entries[0].read === true,
  `company=${inCompany} P1=${inP1} P2=${inP2} -> readState(A)=${afterA.value?.entries[0]?.read}`,
);

// --- A4: idempotent marking; exactly one row and one event ----------------
const again = await markRead({ sourceId: S1, read: true });
const state1 = await attentionState();
const rowsForA1 = state1.value.readStates.filter((r) => r.sourceId === S1);
const events1 = state1.value.readChangedEvents;
record(
  "A4 repeat mark is idempotent (one row, one event)",
  isOk(again) && rowsForA1.length === 1 && events1.length === eventsBase + 1,
  `rows=${rowsForA1.length} events=${events1.length}`,
);

// --- A5: explicit unread flips back; B still untouched --------------------
const unmarked = await markRead({ sourceId: S1, read: false });
const state2 = await attentionState();
const afterB2 = await readState([S1], SESS_B);
record(
  "A5 explicit unmark flips A back (second event); B unchanged",
  isOk(unmarked) &&
    state2.value.readStates.filter((r) => r.sourceId === S1)[0].read === false &&
    state2.value.readChangedEvents.length === eventsBase + 2 &&
    afterB2.value.entries[0].read === false &&
    state2.value.readStates.filter((r) => r.sourceId === S1).length === 1,
  `events=${state2.value.readChangedEvents.length} B=${afterB2.value?.entries[0]?.read}`,
);
// restore read for later checks
await markRead({ sourceId: S1, read: true });

// --- A6: concurrent mark calls collapse (one row, one event) --------------
const S2 = await acceptText("Wspólne oznaczenie równoległe (F1 concurrency)", [P1]);
const concurrent = await Promise.all(
  Array.from({ length: 8 }, () => markRead({ sourceId: S2, read: true }).catch(() => ({ _tag: "error" }))),
);
const state3 = await attentionState();
record(
  "A6 eight concurrent marks: all settle ok, one row, one event",
  concurrent.every(isOk) &&
    state3.value.readStates.filter((r) => r.sourceId === S2).length === 1 &&
    state3.value.readChangedEvents.length === eventsBase + 4,
  `ok=${concurrent.filter(isOk).length}/8 rows=${state3.value.readStates.filter((r) => r.sourceId === S2).length} events=${state3.value.readChangedEvents.length}`,
);

// --- A7: crash proof — row AND event roll back together -------------------
const S3 = await acceptText("Oznaczenie z planowanym awaryjnym przerwaniem", [P1]);
let crashThrew = false;
try {
  await client().action("attention/read_state/probe:probeCrashMarkSourceRead", {
    envelope: envelope("attention.markSourceRead", { sourceId: S3, read: true }),
  });
} catch (error) {
  crashThrew = true;
}
const state4 = await attentionState();
record(
  "A7 deliberate post-registration crash rolls row and event back together",
  crashThrew &&
    state4.value.readStates.filter((r) => r.sourceId === S3).length === 0 &&
    state4.value.readChangedEvents.length === eventsBase + 4,
  `threw=${crashThrew} rows=${state4.value.readStates.filter((r) => r.sourceId === S3).length} events=${state4.value.readChangedEvents.length}`,
);

// --- A8: a source with NO projection keeps read state (links are views) ---
const markedS4 = await markRead({ sourceId: S4, read: true });
const readS4 = await readState([S4]);
const viewP1b = await projectView(P1, 20);
const s4InProject = viewP1b.value?.page?.some((rowR) => rowR.sourceId === S4) ?? false;
record(
  "A8 marking a company-entry source works though no project projection carries it",
  isOk(markedS4) && readS4.value.entries[0].read === true && !s4InProject,
  `read=${readS4.value?.entries[0]?.read} appearsInProjectView=${s4InProject}`,
);

// --- A9: cross-tenant identifiers are rejected ------------------------------
const iso = await client().action("sources/accept/probe:probeSeedIsolation", {});
if (iso._tag !== "ok") throw new Error("isolation seeding failed");
const SESS_B_COMPANY = iso.value.sessionId;
const foreign = await accept(
  {
    uploadId: iso.value.uploadId,
    authorText: "Obcy wpis firmy B",
    intendedSentAtIso: "2026-09-09T07:15:00.000Z",
    timezoneSnapshot: "Europe/Warsaw",
    projectHints: [],
  },
  key(),
  SESS_B_COMPANY,
);
if (foreign._tag !== "ok") throw new Error("company-B acceptance failed");
const S_B = foreign.value.sourceId;

const markForeign = await markRead({ sourceId: S_B, read: true });
const readForeign = await readState([S_B]);
record(
  "A9 forged cross-company mark AND projection both fail forbidden",
  isErr(markForeign, "forbidden", "tenant_scope_mismatch") &&
    isErr(readForeign, "forbidden", "tenant_scope_mismatch"),
  `mark=${markForeign.error?._tag}/${markForeign.error?.code} read=${readForeign.error?._tag}/${readForeign.error?.code}`,
);

// --- A10: unknown source id fails not_found ---------------------------------
const notFound = await markRead({ sourceId: "k57d4a8eq2x9w7c1vbn8hj6t0a5q3zz9", read: true });
record(
  "A10 mark of an unknown source id fails not_found",
  isErr(notFound, "not_found"),
  `${notFound.error?._tag}/${notFound.error?.code}`,
);

// --- A11: revoked membership fails closed -----------------------------------
const cBefore = await markRead({ sourceId: S2, read: true }, SESS_C);
const revoked = await client().action("attention/read_state/probe:probeRevokeFixtureMembership", {
  email: "f1-boss-c@kiero.invalid",
});
const cAfter = await markRead({ sourceId: S2, read: true }, SESS_C);
record(
  "A11 revoked membership: same session worked before, fails closed after",
  isOk(cBefore) && isOk(revoked) && isErr(cAfter, "unauthenticated"),
  `before=ok after=${cAfter.error?._tag}`,
);

// --- A12: GM inspection reads without mutating boss state ------------------
const beforeGm = await attentionState();
const gmRead = await gmOverview(SESS_GM, companyA);
const gmReadAgain = await gmOverview(SESS_GM, companyA);
const afterGm = await attentionState();
const gmSeesS1 = (gmRead.value?.readStates ?? []).some(
  (r) => r.sourceId === S1 && r.read === true,
);
record(
  "A12 GM overview lists company read states and writes nothing",
  isOk(gmRead) && isOk(gmReadAgain) && gmSeesS1 &&
    JSON.stringify(beforeGm.value.readStates) === JSON.stringify(afterGm.value.readStates) &&
    beforeGm.value.readChangedEvents.length === afterGm.value.readChangedEvents.length,
  `gmSeesS1=${gmSeesS1} rowsBefore=${beforeGm.value.readStates.length} rowsAfter=${afterGm.value.readStates.length}`,
);

// --- A13: GM cannot write boss read state (no membership, fail closed) ------
const gmWrite = await markRead({ sourceId: S1, read: true }, SESS_GM);
const stateAfterGmWrite = await attentionState();
record(
  "A13 GM session cannot mark read (no company membership; fail closed)",
  isErr(gmWrite, "unauthenticated") &&
    JSON.stringify(stateAfterGmWrite.value.readStates) === JSON.stringify(afterGm.value.readStates),
  `gmWrite=${gmWrite.error?._tag} rowsUnchanged=${
    JSON.stringify(stateAfterGmWrite.value.readStates) === JSON.stringify(afterGm.value.readStates)
  }`,
);

// --- A14: a boss session (no GM grant) cannot use the GM overview -----------
const bossAsGm = await gmOverview(SESS_B, companyA);
record(
  "A14 non-GM session denied the GM overview",
  isErr(bossAsGm, "forbidden"),
  `${bossAsGm.error?._tag}/${bossAsGm.error?.code}`,
);

// --- P1: defaults before any change ------------------------------------------
const prefs0 = await myPrefs();
record(
  "P1 no row -> effective defaults (no mutes, default quiet hours)",
  isOk(prefs0) &&
    prefs0.value.mutedProjectIds.length === 0 &&
    prefs0.value.companyEntriesMuted === false &&
    prefs0.value.taskRemindersMuted === false &&
    prefs0.value.hidePreviewContent === false &&
    prefs0.value.quietHours.startMinuteOfDay === 1200 &&
    prefs0.value.quietHours.endMinuteOfDay === 360 &&
    prefs0.value.quietHoursSource === "company_default",
  `quiet=${JSON.stringify(prefs0.value?.quietHours)} src=${prefs0.value?.quietHoursSource}`,
);

// --- P2: each control changes independently ----------------------------------
const muteP = await changePrefs({ mutedProjectIds: [P1, P1, P2] });
const prefsMute = await myPrefs();
const qh = await changePrefs({ quietHours: { startMinuteOfDay: 540, endMinuteOfDay: 1020 } });
const prefsQh = await myPrefs();
const cem = await changePrefs({ companyEntriesMuted: true });
const trm = await changePrefs({ taskRemindersMuted: true });
const hpc = await changePrefs({ hidePreviewContent: true });
const prefsAll = await myPrefs();
record(
  "P2 five controls change independently and coexist (deduped mute list)",
  isOk(muteP) && isOk(qh) && isOk(cem) && isOk(trm) && isOk(hpc) &&
    prefsMute.value.mutedProjectIds.length === 2 &&
    prefsMute.value.quietHoursSource === "company_default" &&
    prefsQh.value.mutedProjectIds.length === 2 &&
    prefsQh.value.quietHours.startMinuteOfDay === 540 &&
    prefsQh.value.quietHoursSource === "personal" &&
    prefsAll.value.companyEntriesMuted === true &&
    prefsAll.value.taskRemindersMuted === true &&
    prefsAll.value.hidePreviewContent === true &&
    prefsAll.value.quietHours.startMinuteOfDay === 540,
  `mutes=${JSON.stringify(prefsAll.value?.mutedProjectIds)} quiet=${prefsAll.value?.quietHours?.startMinuteOfDay}-${prefsAll.value?.quietHours?.endMinuteOfDay}`,
);

// --- P3: empty patch, unknown project and cross-company mute rejected ---------
const emptyPatch = await changePrefs({});
const unknownMute = await changePrefs({ mutedProjectIds: ["k57d4a8eq2x9w7c1vbn8hj6t0a5q3zz9"] });
const foreignMute = await changePrefs({ mutedProjectIds: [iso.value.projectId] });
record(
  "P3 empty patch -> validation; unknown project -> validation; cross-company project -> forbidden",
  isErr(emptyPatch, "validation", "preference_patch_empty") &&
    isErr(unknownMute, "validation", "project_reference_not_found") &&
    isErr(foreignMute, "forbidden", "tenant_scope_mismatch"),
  `empty=${emptyPatch.error?.code} unknown=${unknownMute.error?.code} foreign=${foreignMute.error?.code}`,
);

// --- P4: quiet-hours null reverts to the company default ---------------------
const revert = await changePrefs({ quietHours: null });
const prefsReverted = await myPrefs();
record(
  "P4 quietHours null reverts to the company default window",
  isOk(revert) &&
    prefsReverted.value.quietHours.startMinuteOfDay === 1200 &&
    prefsReverted.value.quietHoursSource === "company_default",
  `src=${prefsReverted.value?.quietHoursSource}`,
);

// --- P4b: clearing every mute restores the neutral row ------------------------
const clear = await changePrefs({
  mutedProjectIds: [],
  companyEntriesMuted: false,
  taskRemindersMuted: false,
  hidePreviewContent: false,
});
const prefsCleared = await myPrefs();
record(
  "P4b full clear restores the neutral personal settings",
  isOk(clear) &&
    prefsCleared.value.mutedProjectIds.length === 0 &&
    prefsCleared.value.companyEntriesMuted === false &&
    prefsCleared.value.taskRemindersMuted === false &&
    prefsCleared.value.hidePreviewContent === false,
  `mutes=${prefsCleared.value?.mutedProjectIds?.length}`,
);

// --- P5: quiet-hour boundary evaluation live (default window) ----------------
const at = (nowMs, request = {}) =>
  evaluate({ kind: "source_entry", scope: "company", projectIds: [], isAuthor: false, read: false, nowMs, ...request });
const e1759 = await at(Date.parse("2026-09-09T17:59:00.000Z"));
const e1800 = await at(Date.parse("2026-09-09T18:00:00.000Z"));
const e0400 = await at(Date.parse("2026-09-09T04:00:00.000Z"));
record(
  "P5 default window boundaries: 19:59 free, 20:00 deferred to next 06:00, 06:00 free",
  isOk(e1759) && e1759.value.decision.decision === "eligible" &&
    isOk(e1800) && e1800.value.decision.decision === "deferred" &&
      e1800.value.decision.untilMs === Date.parse("2026-09-10T04:00:00.000Z") &&
    isOk(e0400) && e0400.value.decision.decision === "eligible",
  `19:59=${e1759.value?.decision.decision} 20:00=${e1800.value?.decision.decision}@${
    e1800.value?.decision.untilMs ? new Date(e1800.value.decision.untilMs).toISOString() : "-"
  } 06:00=${e0400.value?.decision.decision}`,
);

// --- P6: DST boundary evaluation live (company timezone Europe/Warsaw) -------
const fall = await at(Date.parse("2026-10-24T23:00:00.000Z"));
const spring = await at(Date.parse("2027-03-27T23:30:00.000Z"));
record(
  "P6 DST: fall-back night defers to 05:00Z, spring-forward night to 04:00Z",
  isOk(fall) && fall.value.decision.decision === "deferred" &&
    fall.value.decision.untilMs === Date.parse("2026-10-25T05:00:00.000Z") &&
    isOk(spring) && spring.value.decision.decision === "deferred" &&
    spring.value.decision.untilMs === Date.parse("2027-03-28T04:00:00.000Z"),
  `fall->${new Date(fall.value?.decision.untilMs ?? 0).toISOString()} spring->${new Date(spring.value?.decision.untilMs ?? 0).toISOString()} tz=${fall.value?.companyTimezone}`,
);

// --- P7: live eligibility matrix over the REAL stored row ---------------------
await changePrefs({
  mutedProjectIds: [P1],
  companyEntriesMuted: true,
  taskRemindersMuted: true,
});
const nowDay = Date.parse("2026-09-09T10:00:00.000Z");
const m1 = await at(nowDay, { kind: "source_entry", scope: "project", projectIds: [P1] });
const m2 = await at(nowDay, { kind: "source_entry", scope: "company", projectIds: [] });
const m3 = await at(nowDay, { kind: "task_reminder", scope: "project", projectIds: [P1] });
const m4 = await at(nowDay, { kind: "source_entry", scope: "company", projectIds: [], isAuthor: true });
const m5 = await at(nowDay, { kind: "source_entry", scope: "company", projectIds: [], read: true });
record(
  "P7 eligibility matrix: project mute, company mute, reminder mute, own entry, read",
  isOk(m1) && m1.value.decision.decision === "suppressed" && m1.value.decision.reason === "muted_project" &&
    isOk(m2) && m2.value.decision.reason === "muted_company_entries" &&
    isOk(m3) && m3.value.decision.decision === "suppressed" && m3.value.decision.reason === "muted_task_reminders" &&
    isOk(m4) && m4.value.decision.reason === "own_entry" &&
    isOk(m5) && m5.value.decision.reason === "already_read",
  `project=${m1.value?.decision.reason ?? m1.value?.decision.decision} company=${m2.value?.decision.reason} reminder=${m3.value?.decision.reason} author=${m4.value?.decision.reason} read=${m5.value?.decision.reason}`,
);

// --- P7b: reading never suppresses a task reminder -----------------------------
await changePrefs({ taskRemindersMuted: false });
const m6 = await at(nowDay, { kind: "task_reminder", scope: "project", projectIds: [P1], read: true });
record(
  "P7b reading never suppresses a task reminder (read=true, reminder unmuted)",
  isOk(m6) && m6.value.decision.decision === "eligible",
  `task_reminder+read=${m6.value?.decision.decision}`,
);

// --- P8: the same preferences are invisible to another boss (per-person) ------
const prefsB = await myPrefs(SESS_B);
record(
  "P8 boss B resolves the defaults (A's personal row is A's alone)",
  isOk(prefsB) &&
    prefsB.value.mutedProjectIds.length === 0 &&
    prefsB.value.companyEntriesMuted === false &&
    prefsB.value.quietHoursSource === "company_default",
  `B mutes=${prefsB.value?.mutedProjectIds?.length} src=${prefsB.value?.quietHoursSource}`,
);

const ok = summarize();
process.exit(ok ? 0 : 1);
