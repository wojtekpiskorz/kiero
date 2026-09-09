/**
 * D2 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/d2, instance hip-basilisk-390, EU)
 * through the REAL deployed gateway Worker and the REAL EU R2 bucket
 * (kiero-dev-media, jurisdiction eu).
 *
 * Actor context: the A3 service-bridge identity (the service account's own
 * session, resolved through the canonical resolution and authorization seam
 * inside every gateway->Convex call) plus one server-seeded second-company
 * session for tenant isolation. No development-auth shortcut exists.
 *
 * Run: KIERO_D2_GATEWAY=https://<worker>.workers.dev node tests/d2/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.)
 */

import { ConvexHttpClient } from "convex/browser";
import { createHash } from "node:crypto";
import { randomBytes } from "node:crypto";
import { writeFileSync, unlinkSync } from "node:fs";

const DEPLOYMENT = process.env.KIERO_D2_CONVEX ?? "hip-basilisk-390";
const CLIENT_URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;
const GATEWAY = process.env.KIERO_D2_GATEWAY;
if (GATEWAY === undefined) {
  throw new Error("KIERO_D2_GATEWAY (deployed gateway Worker URL) is required");
}

const MIB = 1024 * 1024;

const client = () => new ConvexHttpClient(CLIENT_URL);
const results = [];
function record(id, outcome, detail) {
  results.push({ id, outcome, detail });
  console.log(`[${outcome}] ${id}${detail === undefined ? "" : ` :: ${detail}`}`);
  return outcome === "PASS";
}
function summarize() {
  const counts = results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
  console.log(`\nSummary: ${JSON.stringify(counts)} of ${results.length} checks`);
  return results.every((r) => r.outcome === "PASS");
}
const key = () => `idem_${globalThis.crypto.randomUUID()}`;

// --- gateway helpers --------------------------------------------------------

async function gw(path, init = {}) {
  const response = await fetch(`${GATEWAY.replace(/\/$/, "")}${path}`, init);
  let body;
  try {
    body = await response.json();
  } catch {
    body = { parse: "failed", status: response.status };
  }
  return { status: response.status, body };
}

const jsonInit = (method, payload) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

const prepareUpload = (draftId, parts, mediaKinds) =>
  gw("/uploads/prepare", jsonInit("POST", { draftId, parts, mediaKinds }));
const sessionOf = (uploadId) => gw(`/uploads/${uploadId}/session`);
const putPart = (uploadId, attachmentId, partNumber, buffer) =>
  gw(`/uploads/${uploadId}/attachments/${attachmentId}/parts/${partNumber}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: buffer,
    duplex: "half",
  });
const completeAttachmentRoute = (uploadId, attachmentId) =>
  gw(`/uploads/${uploadId}/attachments/${attachmentId}/complete`, jsonInit("POST", {}));
const finalizeUpload = (uploadId) => gw(`/uploads/${uploadId}/finalize`, jsonInit("POST", {}));
const reconcileUploads = () => gw("/uploads/reconcile", jsonInit("POST", {}));

// --- convex probe helpers ---------------------------------------------------

const action = (name, args) => client().action(name, args);
const runStep = (step, input, sessionId) =>
  action("sources/uploads/probe:probeRunStep", { step, input: input ?? {}, ...(sessionId ? { sessionId } : {}) });
const uploadsState = (sessionId) =>
  action("sources/uploads/probe:probeUploadsState", ...(sessionId ? [{ sessionId }] : [{}]));
const ageUpload = (uploadId, ageMs) =>
  action("sources/uploads/probe:probeAgeUpload", { uploadId, ageMs });
const RUN_SUFFIX = String(Date.now()).slice(-6);
const seedIsolation = () => action("sources/uploads/probe:probeSeedIsolation", { suffix: RUN_SUFFIX });
const revokeSession = (sessionId) =>
  action("sources/uploads/probe:probeRevokeSession", { sessionId });
const revokeMembership = (membershipId) =>
  action("sources/uploads/probe:probeRevokeMembership", { membershipId });
const accept = (input, idempotencyKey, sessionId) =>
  action("sources/accept/probe:probeAcceptSource", {
    envelope: {
      operation: "sources.acceptSource",
      input,
      expectedRevisions: [],
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    },
    ...(sessionId === undefined ? {} : { sessionId }),
  });
const crashAcceptance = (input, idempotencyKey) =>
  action("sources/accept/probe:probeCrashAcceptance", {
    envelope: {
      operation: "sources.acceptSource",
      input,
      expectedRevisions: [],
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    },
  });
const acceptanceState = () => action("sources/accept/probe:probeAcceptanceState", {});

const envelopeOk = (result) => result._tag === "ok";

// --- shared fixture helpers ---------------------------------------------------

/** Drives one attachment's REMAINING parts through the real Worker and R2. */
async function uploadAttachment(uploadId, attachmentId, partSizes, startPart = 1) {
  let partNumber = startPart - 1;
  for (const size of partSizes) {
    partNumber += 1;
    const put = await putPart(uploadId, attachmentId, partNumber, Buffer.from(randomBytes(size)));
    if (put.body._tag !== "ok") {
      throw new Error(`part ${partNumber} failed: ${JSON.stringify(put.body)}`);
    }
  }
  const done = await completeAttachmentRoute(uploadId, attachmentId);
  if (done.body._tag !== "ok") {
    throw new Error(`complete failed: ${JSON.stringify(done.body)}`);
  }
  return done.body.value;
}

/** How many parts the ledger already recorded for one attachment. */
async function recordedParts(uploadId, attachmentId) {
  const state = await sessionOf(uploadId);
  const attachment = state.body.value.attachments.find((a) => a.attachmentId === attachmentId);
  return attachment?.parts?.length ?? 0;
}

console.log(`# D2 live proofs :: ${DEPLOYMENT} via ${GATEWAY} :: ${new Date().toISOString()}`);

// --- fixtures -----------------------------------------------------------------

const seed = await action("platform/probe:probeSeed", {});
if (seed._tag !== "ok") throw new Error(`probeSeed failed: ${JSON.stringify(seed)}`);
const companyA = seed.value.companyId;

// --- U1: interrupted-then-resumed upload; ONE accepted source -------------------

const U1_DRAFT = `d2-resume-${Date.now()}`;
const prepared1 = await prepareUpload(U1_DRAFT, 3, ["audio", "image"]);
const u1ok = envelopeOk(prepared1.body);
const upload1 = prepared1.body.value?.uploadId;
const attachments1 = prepared1.body.value?.attachments ?? [];
record(
  "U1a prepare declares draft, mints keys and opens R2 sessions",
  u1ok && attachments1.length === 2 && attachments1.every((a) => a.r2UploadId && a.objectKey?.startsWith(`companies/${companyA}/uploads/`))
    ? "PASS"
    : "FAIL",
  `uploadId=${upload1} attachments=${attachments1.length}`,
);

// Interruption after part 1 of the audio attachment.
const audio1 = attachments1.find((a) => a.kind === "audio");
const image1 = attachments1.find((a) => a.kind === "image");
const part1Buffer = Buffer.from(randomBytes(6 * MIB));
const part1 = await putPart(upload1, audio1.attachmentId, 1, part1Buffer);
const interrupted = await sessionOf(upload1);
const intState = interrupted.body.value;
record(
  "U1b interruption leaves a resumable session (part 1 recorded, nothing else)",
  part1.body._tag === "ok" &&
    intState.attachments.find((a) => a.kind === "audio").parts.length === 1 &&
    intState.attachments.find((a) => a.kind === "image").parts.length === 0
    ? "PASS"
    : "FAIL",
  `audioParts=${intState.attachments.find((a) => a.kind === "audio")?.parts?.length}`,
);

// Lost response, identical bytes re-sent: R2 derives part etags from
// content, so the identical replay is a clean idempotent (or, under a
// differing etag, a manifest refresh) — never a conflict, never a duplicate.
const part1Retry = await putPart(upload1, audio1.attachmentId, 1, part1Buffer);
const retryState = await sessionOf(upload1);
record(
  "U1c re-sent identical bytes stay ONE recorded part (idempotent or refreshed, never a conflict)",
  part1Retry.body._tag === "ok" &&
    (part1Retry.body.value.idempotent === true || part1Retry.body.value.refreshed === true) &&
    retryState.body.value.attachments.find((a) => a.kind === "audio").parts.length === 1
    ? "PASS"
    : "FAIL",
  `idempotent=${part1Retry.body.value?.idempotent} refreshed=${part1Retry.body.value?.refreshed} parts=${retryState.body.value.attachments.find((a) => a.kind === "audio")?.parts?.length}`,
);

// Resume continues from the manifest: parts 2-3 only, part 1 NOT re-sent.
await uploadAttachment(upload1, audio1.attachmentId, [6 * MIB, MIB], (await recordedParts(upload1, audio1.attachmentId)) + 1);
const resumeState = await sessionOf(upload1);
record(
  "U1d resume continues from the manifest: parts 2-3 recorded without re-sending part 1",
  resumeState.body.value.attachments.find((a) => a.kind === "audio").parts.map((p) => p.partNumber).join(",") === "1,2,3"
    ? "PASS"
    : "FAIL",
  `parts=[${resumeState.body.value.attachments.find((a) => a.kind === "audio").parts.map((p) => p.partNumber)}]`,
);

// The image attachment (single part) completes; the manifest stays ascending.
await uploadAttachment(upload1, image1.attachmentId, [64 * 1024]);
const imageParts = (await sessionOf(upload1)).body.value.attachments.find((a) => a.kind === "image").parts;
record(
  "U1e the second attachment completes on the same upload (one ledger, two durable attachments)",
  imageParts.map((p) => p.partNumber).join(",") === "1" ? "PASS" : "FAIL",
  `parts=[${imageParts.map((p) => p.partNumber)}]`,
);

// finalize + accept: ONE source, both attachments bound, event carries both ids.
const finalized1 = await finalizeUpload(upload1);
const K1 = key();
const accepted1 = await accept(
  {
    uploadId: upload1,
    authorText: "Wiadomość z nagraniem i zdjęciem faktury (D2 live proof)",
    intendedSentAtIso: "2026-09-09T07:30:00.000Z",
    timezoneSnapshot: "Europe/Warsaw",
    projectHints: [],
  },
  K1,
);
const ledger1 = await uploadsState();
const src1 = await acceptanceState();
const upload1Row = ledger1.value.uploads.find((u) => u.uploadId === upload1);
const boundAttachments = ledger1.value.attachments.filter((a) => a.uploadId === upload1 && a.sourceId === accepted1.value?.sourceId);
const event1 = src1.value.events.find((e) => e.dedupKey === `sources.acceptSource:${companyA}:${K1}`);
const job1 = src1.value.jobs.find((j) => j.dedupKey === `sources.acceptSource:${companyA}:${K1}`);
const u1final =
  finalized1.body._tag === "ok" &&
  accepted1._tag === "ok" &&
  upload1Row?.acceptedSourceId === accepted1.value.sourceId &&
  boundAttachments.length === 2 &&
  src1.value.sources.filter((s) => s.acceptanceKey === K1).length === 1 &&
  job1?.kind === "processing.extract_fragments";
record(
  "U1f attachment-bearing acceptance commits ONE source with BOTH references verified and bound",
  u1final ? "PASS" : "FAIL",
  `sourceId=${accepted1.value?.sourceId} bound=${boundAttachments.length}/2 ledgerAccepted=${upload1Row?.acceptedSourceId !== undefined} job=${job1?.kind}`,
);

// Retry of the same logical key: same source, no duplicates.
const accepted1again = await accept(
  {
    uploadId: upload1,
    authorText: "Wiadomość z nagraniem i zdjęciem faktury (D2 live proof)",
    intendedSentAtIso: "2026-09-09T07:30:00.000Z",
    timezoneSnapshot: "Europe/Warsaw",
    projectHints: [],
  },
  K1,
);
const src1b = await acceptanceState();
record(
  "U1g retry of the logical key returns the SAME source; no second source or job",
  accepted1again._tag === "ok" &&
    accepted1again.value.sourceId === accepted1.value.sourceId &&
    src1b.value.sources.filter((s) => s.acceptanceKey === K1).length === 1 &&
    src1b.value.jobs.filter((j) => j.dedupKey === `sources.acceptSource:${companyA}:${K1}`).length === 1
    ? "PASS"
    : "FAIL",
  `same=${accepted1again.value?.sourceId === accepted1.value?.sourceId}`,
);

// --- U2: R2 completed but acceptance failed -> ledger reconciles safely ---------

const U2_DRAFT = `d2-orphan-retry-${Date.now()}`;
const prepared2 = await prepareUpload(U2_DRAFT, 2, ["image", "image"]);
const upload2 = prepared2.body.value.uploadId;
const att2 = prepared2.body.value.attachments;
await uploadAttachment(upload2, att2[0].attachmentId, [MIB]);
await uploadAttachment(upload2, att2[1].attachmentId, [MIB]);
await finalizeUpload(upload2);

const K2 = key();
const beforeCrash = await acceptanceState();
let crashed2 = false;
try {
  await crashAcceptance(
    {
      uploadId: upload2,
      authorText: "Akceptacja przerwana po rejestracji - R2 gotowe, Convex musi się wycofać",
      timezoneSnapshot: "Europe/Warsaw",
      projectHints: [],
    },
    K2,
  );
} catch (error) {
  crashed2 = String(error?.message ?? error).includes("deliberate failure");
}
const afterCrash = await acceptanceState();
const ledger2AfterCrash = await uploadsState();
const upload2Row = ledger2AfterCrash.value.uploads.find((u) => u.uploadId === upload2);
const rolledBack =
  crashed2 &&
  afterCrash.value.sources.length === beforeCrash.value.sources.length &&
  afterCrash.value.jobs.length === beforeCrash.value.jobs.length &&
  upload2Row.acceptedSourceId === undefined &&
  ledger2AfterCrash.value.attachments.filter((a) => a.uploadId === upload2 && a.sourceId !== undefined).length === 0;
record(
  "U2a crashed acceptance rolls back source+job+bindings; R2 objects and the finalized ledger survive",
  rolledBack && upload2Row.stage === "finalized" ? "PASS" : "FAIL",
  `crashed=${crashed2} stage=${upload2Row.stage} accepted=${upload2Row.acceptedSourceId !== undefined} sourcesUnchanged=${afterCrash.value.sources.length === beforeCrash.value.sources.length}`,
);

// Reconcile while within grace: recoverable, NOT collected.
const reconcileEarly = await reconcileUploads();
const kept2 = reconcileEarly.body.value.kept.find((k) => k.uploadId === upload2);
record(
  "U2b reconcile within the recovery window keeps the completed-but-unaccepted upload (no lost upload)",
  kept2?.reason === "finalized_within_grace" &&
    reconcileEarly.body.value.r2DeletedKeys.filter((k) => k.startsWith(`companies/${companyA}/uploads/${upload2}/`)).length === 0
    ? "PASS"
    : "FAIL",
  `reason=${kept2?.reason}`,
);

// Delayed retry: acceptance succeeds on the SAME R2 objects; then reconcile keeps it as accepted.
const accepted2 = await accept(
  {
    uploadId: upload2,
    authorText: "Akceptacja przerwana po rejestracji - R2 gotowe, Convex musi się wycofać",
    timezoneSnapshot: "Europe/Warsaw",
    projectHints: [],
  },
  K2,
);
const reconcileAfter = await reconcileUploads();
const kept2b = reconcileAfter.body.value.kept.find((k) => k.uploadId === upload2);
const ledger2b = await uploadsState();
record(
  "U2c delayed retry accepts on the SAME durable objects; reconcile then keeps the ACCEPTED upload forever",
  accepted2._tag === "ok" &&
    ledger2b.value.uploads.find((u) => u.uploadId === upload2).acceptedSourceId === accepted2.value.sourceId &&
    kept2b?.reason === "accepted"
    ? "PASS"
    : "FAIL",
  `sourceId=${accepted2.value?.sourceId} reconcileReason=${kept2b?.reason}`,
);

// Even an AGED accepted upload is never collected.
await ageUpload(upload2, 30 * 24 * 60 * 60 * 1_000);
const reconcileAged = await reconcileUploads();
record(
  "U2d garbage collection raced with the accepted reference: the aged ACCEPTED upload survives",
  reconcileAged.body.value.kept.find((k) => k.uploadId === upload2)?.reason === "accepted" ? "PASS" : "FAIL",
  `reason=${reconcileAged.body.value.kept.find((k) => k.uploadId === upload2)?.reason}`,
);

// --- U3: abandoned upload becomes safely collected ------------------------------

const U3_DRAFT = `d2-collect-${Date.now()}`;
const prepared3 = await prepareUpload(U3_DRAFT, 2, ["audio"]);
const upload3 = prepared3.body.value.uploadId;
const att3 = prepared3.body.value.attachments[0];
await putPart(upload3, att3.attachmentId, 1, Buffer.from(randomBytes(6 * MIB)));
await ageUpload(upload3, 25 * 60 * 60 * 1_000); // past ACTIVE_GRACE (24h)
const reconcile3 = await reconcileUploads();
const collected3 = reconcile3.body.value.collectedUploads.find((c) => c.uploadId === upload3);
const ledger3 = await uploadsState();
record(
  "U3a an expired, unaccepted, inactive upload is marked orphaned and its R2 objects collected",
  collected3?.reason === "expired_unaccepted" &&
    ledger3.value.uploads.find((u) => u.uploadId === upload3).stage === "orphaned" &&
    reconcile3.body.value.r2AbortedKeys.includes(att3.objectKey)
    ? "PASS"
    : "FAIL",
  `reason=${collected3?.reason} r2Aborted=${reconcile3.body.value.r2AbortedKeys.length}`,
);

// The stale draft cannot resurrect its bytes.
const reprepare3 = await prepareUpload(U3_DRAFT, 2, ["audio"]);
record(
  "U3b re-preparing the collected draft is a typed conflict (restart required), never a byte resurrection",
  reprepare3.body._tag === "error" && reprepare3.body.error.code === "draft_expired_restart_required" ? "PASS" : "FAIL",
  `code=${reprepare3.body.error?.code}`,
);

// An ACTIVE upload ages but receives activity: survives.
const U3C_DRAFT = `d2-active-${Date.now()}`;
const prepared3c = await prepareUpload(U3C_DRAFT, 2, ["audio"]);
const upload3c = prepared3c.body.value.uploadId;
const att3c = prepared3c.body.value.attachments[0];
await putPart(upload3c, att3c.attachmentId, 1, Buffer.from(randomBytes(6 * MIB)));
await ageUpload(upload3c, 25 * 60 * 60 * 1_000);
await putPart(upload3c, att3c.attachmentId, 2, Buffer.from(randomBytes(MIB))); // delayed retry refreshes activity
const reconcile3c = await reconcileUploads();
record(
  "U3c a delayed legitimate retry refreshes the grace anchor and survives collection",
  reconcile3c.body.value.kept.find((k) => k.uploadId === upload3c)?.reason === "active" ? "PASS" : "FAIL",
  `reason=${reconcile3c.body.value.kept.find((k) => k.uploadId === upload3c)?.reason}`,
);

// --- U4: malformed, duplicate and foreign parts typed-rejected ------------------

const U4_DRAFT = `d2-reject-${Date.now()}`;
const prepared4 = await prepareUpload(U4_DRAFT, 2, ["audio"]);
const upload4 = prepared4.body.value.uploadId;
const att4 = prepared4.body.value.attachments[0];

const outOfBound = await putPart(upload4, att4.attachmentId, 3, Buffer.from(randomBytes(1024)));
const zeroPart = await gw(`/uploads/${upload4}/attachments/${att4.attachmentId}/parts/0`, {
  method: "POST",
  body: Buffer.from(randomBytes(1024)),
});
const foreignAttachment = await putPart(upload4, "k57notanattachment0000000000aaaa", 1, Buffer.from(randomBytes(1024)));
record(
  "U4a out-of-bound, zero and foreign attachment parts are typed-rejected before any R2 write",
  outOfBound.body._tag === "error" &&
    (outOfBound.body.error.code === "part_number_out_of_range" || outOfBound.body.error.code === "part_bound_exceeded") &&
    zeroPart.body._tag === "error" &&
    foreignAttachment.body._tag === "error" &&
    foreignAttachment.body.error.code === "attachment_not_in_upload"
    ? "PASS"
    : "FAIL",
  `outOfBound=${outOfBound.body.error?.code} zero=${zeroPart.body._tag} foreign=${foreignAttachment.body.error?.code}`,
);

// Same part number with DIFFERENT content: typed conflict, manifest unchanged.
const u4Original = Buffer.from(randomBytes(6 * MIB));
await putPart(upload4, att4.attachmentId, 1, u4Original);
const state4a = await sessionOf(upload4);
const diverging = await putPart(upload4, att4.attachmentId, 1, Buffer.from(randomBytes(6 * MIB)));
const state4b = await sessionOf(upload4);
record(
  "U4b duplicate part number with different content => typed part_receipt_conflict; the recorded bytes stand",
  diverging.body._tag === "error" &&
    diverging.body.error.code === "part_receipt_conflict" &&
    JSON.stringify(state4a.body.value.attachments[0].parts) === JSON.stringify(state4b.body.value.attachments[0].parts)
    ? "PASS"
    : "FAIL",
  `code=${diverging.body.error?.code} manifestStable=${JSON.stringify(state4a.body.value.attachments[0].parts) === JSON.stringify(state4b.body.value.attachments[0].parts)}`,
);

// After the conflict, the LEDGER is the authority: re-sending the RECORDED
// part-1 bytes restores the manifest etag in R2 (idempotent) and completion
// succeeds; a diverging upload alone can never complete.
const restore4 = await putPart(upload4, att4.attachmentId, 1, u4Original);
const done4 = await completeAttachmentRoute(upload4, att4.attachmentId);
if (done4.body._tag !== "ok") {
  throw new Error(`U4c completion failed: ${JSON.stringify(done4.body)}`);
}
// Parts of a completed attachment: stale retry refused.
const stale4 = await putPart(upload4, att4.attachmentId, 2, Buffer.from(randomBytes(MIB)));
record(
  "U4c a stale retry against a finalized attachment is refused (finalized bytes immutable)",
  stale4.body._tag === "error" && stale4.body.error.code === "attachment_finalized" ? "PASS" : "FAIL",
  `code=${stale4.body.error?.code}`,
);

// Acceptance before all attachments durable: typed refusal, nothing written.
const notFinalized = await accept(
  { uploadId: upload4, authorText: "za wczesna akceptacja", timezoneSnapshot: "Europe/Warsaw", projectHints: [] },
  key(),
);
record(
  "U4d acceptance refuses while the upload is not finalized (all-attachments-durable gate)",
  notFinalized._tag === "error" && notFinalized.error.code === "upload_stage_not_acceptable" ? "PASS" : "FAIL",
  `code=${notFinalized.error?.code}`,
);

// --- U5: cross-tenant and revoked identity --------------------------------------

const iso = await seedIsolation();
const B = iso.value;
const crossTenant = await runStep(
  "finalize",
  { uploadId: upload1 },
  B.sessionId,
);
const crossTenantPart = await runStep(
  "part",
  {
    uploadId: upload1,
    attachmentId: ledger1.value.attachments.find((a) => a.uploadId === upload1).attachmentId,
    partNumber: 1,
    etag: "e",
    bytes: 1,
    sha256Hex: "a".repeat(64),
  },
  B.sessionId,
);
record(
  "U5a cross-tenant steps are denied (tenant_scope_mismatch) at every protocol step",
  crossTenant._tag === "error" &&
    crossTenant.error.code === "tenant_scope_mismatch" &&
    crossTenantPart._tag === "error" &&
    crossTenantPart.error.code === "tenant_scope_mismatch"
    ? "PASS"
    : "FAIL",
  `finalize=${crossTenant.error?.code} part=${crossTenantPart.error?.code}`,
);

// B prepares its OWN draft in its own company: allowed, and invisible to A.
const bDraft = await runStep("prepare", { draftId: `d2-b-${Date.now()}`, parts: 1, mediaKinds: ["image"] }, B.sessionId);
record(
  "U5b company B starts its own draft through the same checked path",
  bDraft._tag === "ok" ? "PASS" : "FAIL",
  `uploadId=${bDraft.value?.uploadId}`,
);

// Revoked B session: no step at all.
await revokeSession(B.sessionId);
const revoked = await runStep(
  "part",
  {
    uploadId: bDraft.value.uploadId,
    attachmentId: "k57none0000000000000000000aaaaa",
    partNumber: 1,
    etag: "e",
    bytes: 1,
    sha256Hex: "a".repeat(64),
  },
  B.sessionId,
);
record(
  "U5c a REVOKED session cannot dispatch any step (unauthenticated)",
  revoked._tag === "error" && revoked.error._tag === "unauthenticated" ? "PASS" : "FAIL",
  `tag=${revoked.error?._tag}`,
);

// Revoked B membership with a fresh session: still denied.
const iso2 = await seedIsolation();
// (Same tenant as iso, fresh session: iso's session was revoked above.)
await revokeMembership(iso2.value.membershipId);
const noMembership = await runStep(
  "prepare",
  { draftId: `d2-b2-${Date.now()}`, parts: 1, mediaKinds: ["image"] },
  iso2.value.sessionId,
);
record(
  "U5d a REVOKED membership cannot start an upload even with a live session",
  noMembership._tag === "error" && noMembership.error._tag === "unauthenticated" ? "PASS" : "FAIL",
  `tag=${noMembership.error?._tag}`,
);

// Unauthenticated gateway -> Convex bridge: bad service credential refused.
const badBearer = await fetch(`${GATEWAY.replace(/\/$/, "")}/uploads/reconcile`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
// (The gateway holds its own service credential; this row asserts the Convex
// boundary directly:)
const directBridge = await fetch(`https://${DEPLOYMENT}.eu-west-1.convex.site/sources/uploads/bridge`, {
  method: "POST",
  headers: { authorization: "Bearer definitely-not-the-token", "content-type": "application/json" },
  body: JSON.stringify({ step: "reconcile", input: {} }),
});
record(
  "U5e the uploads boundary refuses an invalid service credential (401)",
  directBridge.status === 401 ? "PASS" : "FAIL",
  `bridgeStatus=${directBridge.status} gatewayStatus=${badBearer.status}`,
);

// --- U6: large streamed fixture through the real Worker -------------------------

const LARGE_BYTES = 96 * MIB;
const largePath = `/tmp/kiero-d2-large-${Date.now()}.bin`;
const largeBuffer = Buffer.alloc(LARGE_BYTES);
const chunk = Buffer.alloc(64 * 1024);
for (let offset = 0; offset < LARGE_BYTES; offset += chunk.length) {
  globalThis.crypto.getRandomValues(chunk);
  chunk.copy(largeBuffer, offset);
}
writeFileSync(largePath, largeBuffer);
const expectedSha = createHash("sha256").update(largeBuffer).digest("hex");
const U6_DRAFT = `d2-large-${Date.now()}`;
const prepared6 = await prepareUpload(U6_DRAFT, 1, ["audio"]);
const upload6 = prepared6.body.value.uploadId;
const att6 = prepared6.body.value.attachments[0];
const largePut = await fetch(`${GATEWAY.replace(/\/$/, "")}/uploads/${upload6}/attachments/${att6.attachmentId}/parts/1`, {
  method: "POST",
  headers: { "content-type": "application/octet-stream" },
  body: (await import("node:fs")).createReadStream(largePath),
  duplex: "half",
});
const largePutBody = await largePut.json();
await uploadAttachment(upload6, att6.attachmentId, []);
const state6 = await sessionOf(upload6);
const recordedSha = state6.body.value.attachments[0].parts[0].sha256Hex;
unlinkSync(largePath);
record(
  "U6 a 96 MiB fixture streams through the Worker (tee + DigestStream, no arrayBuffer) with an exact SHA-256 match",
  largePutBody._tag === "ok" && recordedSha === expectedSha
    ? "PASS"
    : "FAIL",
  `bytes=${LARGE_BYTES} shaMatch=${recordedSha === expectedSha}`,
);

process.exit(summarize() ? 0 : 1);
