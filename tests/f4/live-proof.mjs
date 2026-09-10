/**
 * F4 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/f4, instance combative-tapir-941, EU).
 *
 * Actor context: the A3 service-bridge identity plus server-seeded fixture
 * bosses of the service company (the F1/F2 people fixtures). No
 * development-auth shortcut; sessions are created server-side by guarded
 * probe fixtures. The dated-task and deadline-finding fixtures are the
 * lease-workaround rows this lane's guarded probe writes directly (the C4
 * c4ProofSeedWitnessedSource precedent); every REMINDER decision runs
 * through the real recompute/evaluator transactions and the real drain ->
 * durable job -> executor edge.
 *
 * Clock policy: the evaluator's `nowMs` is caller-owned, so scenario
 * evaluations run at chosen instants (07:00 slots, the overdue boundaries,
 * the DST nights). One scenario deliberately clamps a slot to NOW and
 * waits for the REAL scheduled hop to fire it.
 *
 * Run: node tests/f4/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.)
 */

import { ConvexHttpClient } from "convex/browser";

const DEPLOYMENT = "combative-tapir-941";
const CLIENT_URL = `https://${DEPLOYMENT}.convex.cloud`;

/** One guarded action call with a single retry (the shared project's quota
 * can shed a request; each attempt uses a fresh client). */
async function act(name, args) {
  try {
    return await new ConvexHttpClient(CLIENT_URL).action(name, args);
  } catch (first) {
    console.log(`(retrying ${name} after: ${first?.message ?? String(first)})`);
    await sleep(1_500);
    return await new ConvexHttpClient(CLIENT_URL).action(name, args);
  }
}

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
const envelope = (operation, input) => ({ operation, input, expectedRevisions: [] });
const isOk = (r) => r?._tag === "ok";
const errCode = (r) => (r?._tag === "error" ? r.error.code : `ok:${JSON.stringify(r?.value)}`);
const value = (r) => r?.value;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const seedPlatform = () => act("platform/probe:probeSeed", {});
const seedBoss = (email, label) =>
  act("attention/probe_shared:probeSeedBoss", {
    email,
    displayName: label,
    deviceLabel: `${email.split("@")[0]}-bridge`,
  });
const seedProject = (displayName) =>
  act("sources/accept/probe:probeSeedProject", { displayName });
const seedDatedTask = (args) =>
  act("attention/reminders/probe:probeSeedDatedTask", args);
const reviseDeadline = (args) =>
  act("attention/reminders/probe:probeReviseDeadlineFinding", args);
const republishTaskChanged = (args) =>
  act("attention/reminders/probe:probeRepublishTaskChanged", args);
const recompute = (args) =>
  act("attention/reminders/probe:probeRecomputeTaskReminders", args);
const evaluate = (nowMs) =>
  act("attention/reminders/probe:probeEvaluateDueReminders", {
    envelope: envelope("attention.evaluateDueReminders", { nowMs }),
  });
const snooze = (args, sessionId) =>
  act("attention/reminders/probe:probeSnoozeTaskReminders", {
    envelope: envelope("attention.snoozeTaskReminders", args),
    sessionId,
  });
const changePrefs = (input, sessionId) =>
  act("attention/preferences/probe:probeChangeNotificationPreferences", {
    envelope: envelope("attention.changeNotificationPreferences", input),
    sessionId,
  });
const reminderState = () =>
  act("attention/reminders/probe:probeReminderState", {});

/** The reminder intents of one recipient, keyed by lifecycle state. */
function intentsFor(state, recipientUserId) {
  const all = [
    ...(state.pending ?? []),
    ...(state.delivered ?? []),
    ...(state.suppressed ?? []),
  ];
  return all.filter((intent) => intent.recipientUserId === recipientUserId);
}

const WARSAW = "Europe/Warsaw";

/** One zoned ISO string for a near-future Warsaw instant (CEST runs to Oct 25). */
const zonedIso = (epochMs) =>
  `${new Date(epochMs).toLocaleString("sv-SE", { timeZone: WARSAW }).replace(" ", "T")}.000+02:00[Europe/Warsaw]`;

async function main() {
  // --- Setup: service company, two fixture bosses, one project --------------
  const seeded = await seedPlatform();
  if (!isOk(seeded)) throw new Error(`probeSeed failed: ${JSON.stringify(seeded)}`);
  const runTag = `${Date.now()}`.slice(-6);
  const coord = await seedBoss(`f4-coord-${runTag}@kiero.invalid`, "F4 coordinator");
  const other = await seedBoss(`f4-other-${runTag}@kiero.invalid`, "F4 other boss");
  if (!isOk(coord) || !isOk(other)) throw new Error("boss seeding failed");
  const project = await seedProject("F4 Przypomnienia");
  if (!isOk(project)) throw new Error("project seeding failed");
  const P1 = value(project).projectId;
  const coordUser = value(coord).userId;
  const otherUser = value(other).userId;
  const coordSession = value(coord).sessionId;
  const otherSession = value(other).sessionId;
  const coordMembership = value(coord).membershipId;
  record("setup people", true, `coord=${coordUser} other=${otherUser} project=${P1}`);

  const nowReal = Date.now();
  const warsawDay = (epochMs) =>
    new Date(epochMs).toLocaleDateString("en-CA", { timeZone: WARSAW });

  // --- S1: date-only slots target the coordinator; 07:00 arithmetic ---------
  const s1Day = warsawDay(nowReal + 2 * 86_400_000); // two days ahead, Warsaw
  const s1 = await seedDatedTask({
    projectId: P1,
    title: "S1 wycena z terminem dniowym",
    deadlineDay: s1Day,
    deadlineIso: null,
    coordinatorMembershipId: coordMembership,
  });
  const s1Task = value(s1).taskId;
  const s1RecomputeAt = Date.now();
  const s1Result = await recompute({ taskId: s1Task, nowMs: s1RecomputeAt });
  record("S1a recompute schedules for the coordinator", isOk(s1Result), errCode(s1Result));
  let state = value(await reminderState());
  const s1CoordIntents = intentsFor(state, coordUser).filter((i) => i.taskId === s1Task);
  const s1OtherIntents = intentsFor(state, otherUser).filter((i) => i.taskId === s1Task);
  record(
    "S1b exactly two pending slots for the coordinator, none for others",
    s1CoordIntents.filter((i) => i.state === "pending").length === 2 &&
      s1OtherIntents.length === 0,
    `coord=${s1CoordIntents.map((i) => `${i.state}@${new Date(i.dueAtMs).toISOString()}`)}`,
  );
  // The pre-due slot is 07:00 Warsaw on the term day; CEST => 05:00Z.
  const s1PreDue = s1CoordIntents.find((i) => i.dedupKey.includes(":pre_due:"));
  const s1ExpectedDue = Date.parse(`${s1Day}T05:00:00.000Z`);
  record(
    "S1c the date-only slot fires at 07:00 company time (05:00Z under CEST)",
    s1PreDue?.dueAtMs === s1ExpectedDue,
    `due=${new Date(s1PreDue?.dueAtMs ?? 0).toISOString()} expected=${new Date(s1ExpectedDue).toISOString()}`,
  );
  const s1Eval = await evaluate(s1ExpectedDue);
  state = value(await reminderState());
  const s1Delivered = intentsFor(state, coordUser).filter(
    (i) => i.taskId === s1Task && i.state === "delivered",
  );
  record(
    "S1d the evaluator delivers at the slot instant (fake clock)",
    isOk(s1Eval) && s1Delivered.length === 1,
    `delivered=${s1Delivered.length} :: ${JSON.stringify(s1Delivered[0]?.delivery)}`,
  );

  // --- S2: a timed deadline one hour ahead clamps to now; the REAL hop fires -
  const s2Deadline = Date.now() + 35 * 60_000;
  const s2 = await seedDatedTask({
    projectId: P1,
    title: "S2 termin z godziną",
    deadlineDay: null,
    deadlineIso: zonedIso(s2Deadline),
    coordinatorMembershipId: coordMembership,
  });
  const s2Task = value(s2).taskId;
  const s2Result = await recompute({ taskId: s2Task, nowMs: Date.now() });
  record("S2a created-after-its-reminder clamps to ONE prompt now", isOk(s2Result), errCode(s2Result));
  let s2Delivered = 0;
  let s2Waits = 0;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await sleep(3_000);
    s2Waits = attempt + 1;
    state = value(await reminderState());
    s2Delivered = intentsFor(state, coordUser).filter(
      (i) => i.taskId === s2Task && i.state === "delivered",
    ).length;
    if (s2Delivered === 1) break;
  }
  record(
    "S2b the REAL scheduled hop delivers the clamped prompt (no manual sweep)",
    s2Delivered === 1,
    `delivered=${s2Delivered} after ~${s2Waits * 3}s`,
  );

  // --- S3: the durable edge: republished task event -> drain -> job -> executor
  state = value(await reminderState());
  const s3AnchorBefore = state.schedules.find((s) => s.taskId === s1Task)?.updatedAtMs ?? 0;
  await republishTaskChanged({ taskId: s1Task, revision: 1 });
  let s3State = state;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(2_000);
    s3State = value(await reminderState());
    const anchor = s3State.schedules.find((s) => s.taskId === s1Task);
    if (anchor !== undefined && anchor.updatedAtMs > s3AnchorBefore) break;
  }
  const s3Intents = intentsFor(s3State, coordUser).filter((i) => i.taskId === s1Task);
  record(
    "S3 the republished task event ran the real drain->job->executor edge and collapsed onto the same semantic slots",
    s3Intents.filter((i) => i.state === "delivered").length === 1 &&
      s3Intents.filter((i) => i.state === "pending").length === 1,
    `intents=${s3Intents.map((i) => i.state).join(",")}`,
  );

  // --- S4: a deadline correction (finding revised) re-derives the schedule ---
  const s1Finding = value(s1).deadlineFindingId;
  const s4Day = warsawDay(nowReal + 5 * 86_400_000);
  const s4Revise = await reviseDeadline({
    findingId: s1Finding,
    deadlineDay: s4Day,
    deadlineIso: null,
  });
  record("S4a the deadline correction publishes findingRevised", isOk(s4Revise), errCode(s4Revise));
  let s4State = null;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(2_000);
    s4State = value(await reminderState());
    const anchor = s4State.schedules.find((s) => s.taskId === s1Task);
    if (anchor?.termAnchor === `day:${s4Day}`) break;
  }
  const s4Anchor = s4State.schedules.find((s) => s.taskId === s1Task);
  const s4Intents = intentsFor(s4State, coordUser).filter((i) => i.taskId === s1Task);
  record(
    "S4b the finding-revised job recomputed the schedule at the new term",
    s4Anchor?.termAnchor === `day:${s4Day}` &&
      s4Intents.filter((i) => i.state === "pending").length === 1 &&
      s4Intents.filter((i) => i.state === "suppressed").length === 1,
    `anchor=${s4Anchor?.termAnchor} intents=${s4Intents.map((i) => `${i.state}/${i.suppressedReason ?? ""}`).join(",")}`,
  );

  // --- S5: the personal snooze through the checked dispatch ------------------
  const s5Day = warsawDay(nowReal + 3 * 86_400_000);
  const s5 = await seedDatedTask({
    projectId: P1,
    title: "S5 zadanie bez koordynatora",
    deadlineDay: s5Day,
    deadlineIso: null,
    coordinatorMembershipId: null,
  });
  const s5Task = value(s5).taskId;
  await recompute({ taskId: s5Task, nowMs: Date.now() });
  state = value(await reminderState());
  const s5Both = [coordUser, otherUser].every(
    (user) => intentsFor(state, user).filter((i) => i.taskId === s5Task && i.state === "pending").length === 2,
  );
  record("S5a the unassigned task targets every boss", s5Both, `two slots each`);
  const s5Due = Date.parse(`${s5Day}T05:00:00.000Z`);
  const s5Until = s5Due + 2 * 3_600_000;
  const s5Snooze = await snooze({ taskId: s5Task, untilMs: s5Until }, coordSession);
  record("S5b the snooze command runs through the checked dispatch", isOk(s5Snooze), errCode(s5Snooze));
  await evaluate(s5Due);
  state = value(await reminderState());
  const s5CoordPending = intentsFor(state, coordUser).filter((i) => i.taskId === s5Task && i.state === "pending");
  const s5OtherDelivered = intentsFor(state, otherUser).filter(
    (i) => i.taskId === s5Task && i.state === "delivered",
  );
  record(
    "S5c the snooze defers only the snoozing boss",
    s5CoordPending.length === 2 &&
      s5CoordPending.every((i) => i.dueAtMs >= s5Until) &&
      s5OtherDelivered.length === 1,
    `coordPending=${s5CoordPending.map((i) => new Date(i.dueAtMs).toISOString())} otherDelivered=${s5OtherDelivered.length}`,
  );
  await evaluate(s5Until);
  state = value(await reminderState());
  const s5CoordDelivered = intentsFor(state, coordUser).filter(
    (i) => i.taskId === s5Task && i.state === "delivered",
  );
  record("S5d at expiry the snoozed reminder delivers", s5CoordDelivered.length === 1, `delivered=${s5CoordDelivered.length}`);

  // --- S6: quiet hours defer through the shared seam --------------------------
  const quietPrefs = await changePrefs(
    { quietHours: { startMinuteOfDay: 6 * 60, endMinuteOfDay: 8 * 60 } },
    otherSession,
  );
  record("S6a the personal quiet-hours window set", isOk(quietPrefs), errCode(quietPrefs));
  const s6Day = warsawDay(nowReal + 4 * 86_400_000);
  const s6 = await seedDatedTask({
    projectId: P1,
    title: "S6 godziny ciszy",
    deadlineDay: s6Day,
    deadlineIso: null,
    coordinatorMembershipId: null,
  });
  const s6Task = value(s6).taskId;
  await recompute({ taskId: s6Task, nowMs: Date.now() });
  const s6Due = Date.parse(`${s6Day}T05:00:00.000Z`); // 07:00 Warsaw: inside 06-08
  await evaluate(s6Due);
  state = value(await reminderState());
  const s6Other = intentsFor(state, otherUser).find((i) => i.taskId === s6Task && i.dedupKey.includes(":pre_due:"));
  const s6Coord = intentsFor(state, coordUser).filter((i) => i.taskId === s6Task && i.state === "delivered");
  record(
    "S6b 07:00 defers for the quiet-hours boss only",
    s6Other?.state === "pending" && s6Other.dueAtMs === s6Due + 3_600_000 && s6Coord.length === 1,
    `other=${s6Other?.state}@${new Date(s6Other?.dueAtMs ?? 0).toISOString()} coordDelivered=${s6Coord.length}`,
  );
  await evaluate(s6Due + 3_600_000);
  state = value(await reminderState());
  const s6OtherDelivered = intentsFor(state, otherUser).filter(
    (i) => i.taskId === s6Task && i.state === "delivered",
  );
  record("S6c at the window end the deferred reminder delivers", s6OtherDelivered.length === 1, `delivered=${s6OtherDelivered.length}`);

  // --- S7: closed tasks schedule nothing --------------------------------------
  const s7Done = await seedDatedTask({
    projectId: P1,
    title: "S7 wykonane",
    deadlineDay: s5Day,
    deadlineIso: null,
    coordinatorMembershipId: coordMembership,
    state: "done",
  });
  const s7Cancelled = await seedDatedTask({
    projectId: P1,
    title: "S7 anulowane",
    deadlineDay: s5Day,
    deadlineIso: null,
    coordinatorMembershipId: coordMembership,
    state: "cancelled",
  });
  const s7DoneResult = await recompute({ taskId: value(s7Done).taskId, nowMs: Date.now() });
  const s7CancelledResult = await recompute({ taskId: value(s7Cancelled).taskId, nowMs: Date.now() });
  state = value(await reminderState());
  const s7Intents = [
    ...(state.pending ?? []),
    ...(state.delivered ?? []),
    ...(state.suppressed ?? []),
  ].filter((i) => i.taskId === value(s7Done).taskId || i.taskId === value(s7Cancelled).taskId);
  record(
    "S7 completed and cancelled tasks produce no reminder intent at all",
    isOk(s7DoneResult) && isOk(s7CancelledResult) && s7Intents.length === 0,
    `intents=${s7Intents.length}`,
  );

  // --- S8: three days overdue at creation: ONE prompt, no replay ---------------
  const s8Day = warsawDay(nowReal - 3 * 86_400_000);
  const s8 = await seedDatedTask({
    projectId: P1,
    title: "S8 zaległe",
    deadlineDay: s8Day,
    deadlineIso: null,
    coordinatorMembershipId: coordMembership,
  });
  const s8Task = value(s8).taskId;
  await recompute({ taskId: s8Task, nowMs: Date.now() });
  state = value(await reminderState());
  const s8Pending = intentsFor(state, coordUser).filter((i) => i.taskId === s8Task && i.state === "pending");
  record(
    "S8a the long-overdue task holds exactly ONE clamped slot",
    s8Pending.length === 1,
    `pending=${s8Pending.map((i) => new Date(i.dueAtMs).toISOString())}`,
  );
  await evaluate(Date.now());
  state = value(await reminderState());
  const s8Delivered = intentsFor(state, coordUser).filter((i) => i.taskId === s8Task && i.state === "delivered");
  const s8Next = intentsFor(state, coordUser).filter((i) => i.taskId === s8Task && i.state === "pending");
  const s8NextDay = warsawDay(nowReal + 86_400_000);
  record(
    "S8b one prompt now and the next daily summary tomorrow at 07:00",
    s8Delivered.length === 1 &&
      s8Next.length === 1 &&
      s8Next[0]?.dueAtMs === Date.parse(`${s8NextDay}T05:00:00.000Z`),
    `delivered=${s8Delivered.length} next=${s8Next.map((i) => new Date(i.dueAtMs).toISOString())}`,
  );

  // --- S9: the DST fall-back night on the deployed code ------------------------
  const s9Day = "2026-10-24";
  const s9 = await seedDatedTask({
    projectId: P1,
    title: "S9 zmiana czasu",
    deadlineDay: s9Day,
    deadlineIso: null,
    coordinatorMembershipId: coordMembership,
  });
  const s9Task = value(s9).taskId;
  const s9RecomputeAt = Date.parse("2026-10-20T10:00:00.000Z");
  const s9Result = await recompute({ taskId: s9Task, nowMs: s9RecomputeAt });
  state = value(await reminderState());
  const s9Overdue = intentsFor(state, coordUser).find(
    (i) => i.taskId === s9Task && i.dedupKey.includes(":overdue:"),
  );
  record(
    "S9 the first overdue summary after the fall-back night is 07:00 CET (06:00Z)",
    isOk(s9Result) &&
      s9Overdue?.dueAtMs === Date.parse("2026-10-25T06:00:00.000Z") &&
      s9Overdue?.dedupKey.endsWith(":2026-10-25"),
    `slot=${new Date(s9Overdue?.dueAtMs ?? 0).toISOString()} key=${s9Overdue?.dedupKey}`,
  );

  const pass = summarize();
  process.exitCode = pass ? 0 : 1;
}

main().catch((error) => {
  console.error("live proof crashed:", error?.message ?? error, error?.stack ?? "");
  process.exitCode = 1;
});
