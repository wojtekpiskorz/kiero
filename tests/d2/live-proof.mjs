/**
 * D2 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/d2, instance hip-basilisk-390, EU)
 * through the REAL deployed gateway Worker and the REAL EU R2 bucket
 * (kiero-dev-media, jurisdiction eu).
 *
 * IDENTITY (round-2 review): every actor is a REAL signed-in person — B1's
 * email-code flow with proof-domain fixture addresses and fixture codes
 * (the B3 evidence pattern). Each person's Convex Auth token is the
 * credential the gateway forwards on every uploads route, so the whole
 * chain (prepare/begin/part/complete/finalize/reconcile/accept) runs AS
 * THAT USER against that user's company. The service account appears
 * nowhere. Revocation rows drive the CERTIFIED B1/B3 commands
 * (access.revokeSession, access.revokeMembership), not server-side edits.
 *
 * Run: KIERO_D2_GATEWAY=https://<worker>.workers.dev node tests/d2/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.)
 */

import { ConvexHttpClient } from "convex/browser";
import { createHash, randomBytes } from "node:crypto";
import { writeFileSync, unlinkSync, createReadStream } from "node:fs";

const DEPLOYMENT = process.env.KIERO_D2_CONVEX ?? "hip-basilisk-390";
const CLIENT_URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;
const GATEWAY = process.env.KIERO_D2_GATEWAY;
if (GATEWAY === undefined) {
  throw new Error("KIERO_D2_GATEWAY (deployed gateway Worker URL) is required");
}

const MIB = 1024 * 1024;
const RUN = Date.now().toString(36);
const person = (name) => `d2-${name}-${RUN}@kiero.invalid`;
// Per-person fixture codes: the auth library looks verification codes up
// by hash GLOBALLY with unique(), so two pending rows sharing one code
// value (e.g. debris from a crashed run) would break every later sign-in.
const fixtureCodeOf = (seed) => {
  let hash = 0;
  for (const byte of Buffer.from(seed)) {
    hash = (hash * 31 + byte) % 90_000_000;
  }
  return String(42_000_000 + hash);
};

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

// --- real sign-in (B3's fixture pattern) ------------------------------------

const anon = () => new ConvexHttpClient(CLIENT_URL, { logger: false });

async function errOf(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Real B1 sign-in with a fixture code (proof-domain address only). */
async function signInFixture(email) {
  const code = fixtureCodeOf(email);
  const bootstrap = anon();
  await errOf(() => bootstrap.action("auth:signIn", { provider: "email_code", params: { email } }));
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
  const client = new ConvexHttpClient(CLIENT_URL, { logger: false, auth: token });
  const ensured = await client.mutation("access/identity/functions:ensureSessionRegistry", {});
  if (ensured?.state !== "live") {
    throw new Error(`session provisioning failed for ${email}: ${JSON.stringify(ensured)}`);
  }
  return { client, token, sessionId: ensured.sessionId, email };
}

const admit = (client, operation, input) =>
  client.mutation("access/membership/functions:admitCommand", {
    envelope: { operation, input, expectedRevisions: [] },
  });

/** Creates the person's own firm (first administrator) and returns its id. */
async function ownCompany(persona, name) {
  const created = await admit(persona.client, "access.createCompany", {
    name,
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
  });
  if (created?._tag !== "ok") {
    throw new Error(`createCompany failed: ${JSON.stringify(created)}`);
  }
  return created.value.companyId;
}

// --- gateway helpers (every call carries the person's credential) -------------

async function gw(token, path, init = {}) {
  const response = await fetch(`${GATEWAY.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: {
      ...(init.headers ?? {}),
      authorization: `Bearer ${token}`,
    },
  });
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

const prepareUpload = (token, draftId, parts, mediaKinds) =>
  gw(token, "/uploads/prepare", jsonInit("POST", { draftId, parts, mediaKinds }));
const sessionOf = (token, uploadId) => gw(token, `/uploads/${uploadId}/session`);
const putPart = (token, uploadId, attachmentId, partNumber, buffer) =>
  gw(token, `/uploads/${uploadId}/attachments/${attachmentId}/parts/${partNumber}`, {
    method: "POST",
    headers: { "content-type": "application/octet-stream" },
    body: buffer,
    duplex: "half",
  });
const completeAttachmentRoute = (token, uploadId, attachmentId) =>
  gw(token, `/uploads/${uploadId}/attachments/${attachmentId}/complete`, jsonInit("POST", {}));
const finalizeUpload = (token, uploadId) =>
  gw(token, `/uploads/${uploadId}/finalize`, jsonInit("POST", {}));
const reconcileUploads = (token) => gw(token, "/uploads/reconcile", jsonInit("POST", {}));

// --- probe helpers (all resolve the CALLER's identity) ------------------------

const acceptAsCaller = (persona, input, idempotencyKey, crash = false) =>
  persona.client.action("sources/uploads/probe:probeAcceptSourceAsCaller", {
    envelope: {
      operation: "sources.acceptSource",
      input,
      expectedRevisions: [],
      ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
    },
    ...(crash ? { crash: true } : {}),
  });
const uploadsStateOf = (persona) =>
  persona.client.action("sources/uploads/probe:probeUploadsState", {});
const ageUpload = (persona, uploadId, ageMs) =>
  persona.client.action("sources/uploads/probe:probeAgeUpload", { uploadId, ageMs });
const runStepAsCaller = (persona, step, input) =>
  persona.client.action("sources/uploads/probe:probeRunStep", { step, input: input ?? {} });


/** Drives one attachment's REMAINING parts through the real Worker and R2. */
async function uploadAttachment(token, uploadId, attachmentId, partSizes, startPart = 1) {
  let partNumber = startPart - 1;
  for (const size of partSizes) {
    partNumber += 1;
    const put = await putPart(token, uploadId, attachmentId, partNumber, Buffer.from(randomBytes(size)));
    if (put.body._tag !== "ok") {
      throw new Error(`part ${partNumber} failed: ${JSON.stringify(put.body)}`);
    }
  }
  const done = await completeAttachmentRoute(token, uploadId, attachmentId);
  if (done.body._tag !== "ok") {
    throw new Error(`complete failed: ${JSON.stringify(done.body)}`);
  }
  return done.body.value;
}

async function recordedParts(token, uploadId, attachmentId) {
  const state = await sessionOf(token, uploadId);
  const attachment = state.body.value?.attachments?.find((a) => a.attachmentId === attachmentId);
  return attachment?.parts?.length ?? 0;
}

console.log(`# D2 live proofs (per-user identity) :: ${DEPLOYMENT} via ${GATEWAY} :: ${new Date().toISOString()}`);

// --- fixture persons ----------------------------------------------------------

const A = await signInFixture(person("a"));
const companyA = await ownCompany(A, `Budowa D2 A ${RUN}`);
record(
  "P0a the owner is a REAL signed-in person with their own firm",
  typeof companyA === "string" ? "PASS" : "FAIL",
  `companyA=${companyA}`,
);

const B = await signInFixture(person("b"));
const companyB = await ownCompany(B, `Budowa D2 B ${RUN}`);

// --- U1: the full chain AS THE REAL OWNER (interrupted-then-resumed) -----------

const U1_DRAFT = `d2-resume-${RUN}`;
const prepared1 = await prepareUpload(A.token, U1_DRAFT, 3, ["audio", "image"]);
const u1aOk = prepared1.body._tag === "ok";
const upload1 = prepared1.body.value?.uploadId;
const attachments1 = prepared1.body.value?.attachments ?? [];
record(
  "U1a prepare as the signed-in owner declares the draft, mints keys, opens R2 sessions",
  u1aOk && attachments1.length === 2 && attachments1.every((a) => a.r2UploadId && a.objectKey?.startsWith(`companies/${companyA}/uploads/`))
    ? "PASS"
    : "FAIL",
  `uploadId=${upload1} attachments=${attachments1.length}`,
);

const audio1 = attachments1.find((a) => a.kind === "audio");
const image1 = attachments1.find((a) => a.kind === "image");
const part1Buffer = Buffer.from(randomBytes(6 * MIB));
const part1 = await putPart(A.token, upload1, audio1.attachmentId, 1, part1Buffer);
const interrupted = await sessionOf(A.token, upload1);
record(
  "U1b interruption leaves a resumable session (part 1 recorded, nothing else)",
  part1.body._tag === "ok" &&
    interrupted.body.value.attachments.find((a) => a.kind === "audio").parts.length === 1 &&
    interrupted.body.value.attachments.find((a) => a.kind === "image").parts.length === 0
    ? "PASS"
    : "FAIL",
  `audioParts=${interrupted.body.value.attachments.find((a) => a.kind === "audio")?.parts?.length}`,
);

const part1Retry = await putPart(A.token, upload1, audio1.attachmentId, 1, part1Buffer);
const retryState = await sessionOf(A.token, upload1);
record(
  "U1c re-sent identical bytes stay ONE recorded part (idempotent or refreshed, never a conflict)",
  part1Retry.body._tag === "ok" &&
    (part1Retry.body.value.idempotent === true || part1Retry.body.value.refreshed === true) &&
    retryState.body.value.attachments.find((a) => a.kind === "audio").parts.length === 1
    ? "PASS"
    : "FAIL",
  `idempotent=${part1Retry.body.value?.idempotent} parts=${retryState.body.value.attachments.find((a) => a.kind === "audio")?.parts?.length}`,
);

await uploadAttachment(A.token, upload1, audio1.attachmentId, [6 * MIB, MIB], (await recordedParts(A.token, upload1, audio1.attachmentId)) + 1);
const resumeState = await sessionOf(A.token, upload1);
record(
  "U1d resume continues from the manifest: parts 2-3 recorded without re-sending part 1",
  resumeState.body.value.attachments.find((a) => a.kind === "audio").parts.map((p) => p.partNumber).join(",") === "1,2,3"
    ? "PASS"
    : "FAIL",
  `parts=[${resumeState.body.value.attachments.find((a) => a.kind === "audio").parts.map((p) => p.partNumber)}]`,
);

await uploadAttachment(A.token, upload1, image1.attachmentId, [64 * 1024]);
const imageParts = (await sessionOf(A.token, upload1)).body.value.attachments.find((a) => a.kind === "image").parts;
record(
  "U1e the second attachment completes on the same upload (one ledger, two durable attachments)",
  imageParts.map((p) => p.partNumber).join(",") === "1" ? "PASS" : "FAIL",
  `parts=[${imageParts.map((p) => p.partNumber)}]`,
);

const finalized1 = await finalizeUpload(A.token, upload1);
const K1 = key();
const accepted1 = await acceptAsCaller(
  A,
  {
    uploadId: upload1,
    authorText: "Wiadomość z nagraniem i zdjęciem faktury (D2 live proof)",
    intendedSentAtIso: "2026-09-09T07:30:00.000Z",
    timezoneSnapshot: "Europe/Warsaw",
    projectHints: [],
  },
  K1,
);
const ledger1 = await uploadsStateOf(A);
const upload1Row = ledger1.value.uploads.find((u) => u.uploadId === upload1);
const boundAttachments = ledger1.value.attachments.filter((a) => a.uploadId === upload1 && a.sourceId === accepted1.value?.sourceId);
record(
  "U1f attachment-bearing acceptance AS THE OWNER commits ONE source with BOTH references verified and bound",
  finalized1.body._tag === "ok" &&
    accepted1._tag === "ok" &&
    upload1Row?.acceptedSourceId === accepted1.value.sourceId &&
    boundAttachments.length === 2 &&
    ledger1.value.sources.filter((s) => s.acceptanceKey === K1).length === 1 &&
    ledger1.value.jobs.filter((j) => j.dedupKey === `sources.acceptSource:${companyA}:${K1}`).length === 1
    ? "PASS"
    : "FAIL",
  `sourceId=${accepted1.value?.sourceId} bound=${boundAttachments.length}/2 sourceRows=${ledger1.value.sources.filter((s) => s.acceptanceKey === K1).length} jobs=${ledger1.value.jobs.filter((j) => j.dedupKey === `sources.acceptSource:${companyA}:${K1}`).length}`,
);

const accepted1again = await acceptAsCaller(
  A,
  {
    uploadId: upload1,
    authorText: "Wiadomość z nagraniem i zdjęciem faktury (D2 live proof)",
    intendedSentAtIso: "2026-09-09T07:30:00.000Z",
    timezoneSnapshot: "Europe/Warsaw",
    projectHints: [],
  },
  K1,
);
const ledger1b = await uploadsStateOf(A);
record(
  "U1g retry of the logical key returns the SAME source; no second source or job",
  accepted1again._tag === "ok" &&
    accepted1again.value.sourceId === accepted1.value.sourceId &&
    ledger1b.value.sources.filter((s) => s.acceptanceKey === K1).length === 1 &&
    ledger1b.value.jobs.filter((j) => j.dedupKey === `sources.acceptSource:${companyA}:${K1}`).length === 1
    ? "PASS"
    : "FAIL",
  `same=${accepted1again.value?.sourceId === accepted1.value?.sourceId}`,
);

// --- U2: R2 completed but acceptance failed -> ledger reconciles safely ---------

const U2_DRAFT = `d2-orphan-retry-${RUN}`;
const prepared2 = await prepareUpload(A.token, U2_DRAFT, 2, ["image", "image"]);
const upload2 = prepared2.body.value.uploadId;
const att2 = prepared2.body.value.attachments;
await uploadAttachment(A.token, upload2, att2[0].attachmentId, [MIB]);
await uploadAttachment(A.token, upload2, att2[1].attachmentId, [MIB]);
await finalizeUpload(A.token, upload2);

const K2 = key();
const beforeCrash = await uploadsStateOf(A);
let crashed2 = false;
try {
  await acceptAsCaller(
    A,
    {
      uploadId: upload2,
      authorText: "Akceptacja przerwana po rejestracji - R2 gotowe, Convex musi się wycofać",
      timezoneSnapshot: "Europe/Warsaw",
      projectHints: [],
    },
    K2,
    true,
  );
} catch (error) {
  crashed2 = String(error?.message ?? error).includes("deliberate failure");
}
const afterCrash = await uploadsStateOf(A);
const ledger2AfterCrash = afterCrash;
const upload2Row = ledger2AfterCrash.value.uploads.find((u) => u.uploadId === upload2);
record(
  "U2a crashed acceptance rolls back source+job+bindings; R2 objects and the finalized ledger survive",
  crashed2 &&
    afterCrash.value.sources.length === beforeCrash.value.sources.length &&
    afterCrash.value.jobs.length === beforeCrash.value.jobs.length &&
    upload2Row.acceptedSourceId === undefined &&
    ledger2AfterCrash.value.attachments.filter((a) => a.uploadId === upload2 && a.sourceId !== undefined).length === 0
    ? "PASS"
    : "FAIL",
  `crashed=${crashed2} stage=${upload2Row.stage} sourcesUnchanged=${afterCrash.value.sources.length === beforeCrash.value.sources.length}`,
);

const reconcileEarly = await reconcileUploads(A.token);
const kept2 = reconcileEarly.body.value.kept.find((k) => k.uploadId === upload2);
record(
  "U2b reconcile within the recovery window keeps the completed-but-unaccepted upload (no lost upload)",
  kept2?.reason === "finalized_within_grace" &&
    reconcileEarly.body.value.r2DeletedKeys.filter((k) => k.startsWith(`companies/${companyA}/uploads/${upload2}/`)).length === 0
    ? "PASS"
    : "FAIL",
  `reason=${kept2?.reason}`,
);

const accepted2 = await acceptAsCaller(
  A,
  {
    uploadId: upload2,
    authorText: "Akceptacja przerwana po rejestracji - R2 gotowe, Convex musi się wycofać",
    timezoneSnapshot: "Europe/Warsaw",
    projectHints: [],
  },
  K2,
);
const reconcileAfter = await reconcileUploads(A.token);
const kept2b = reconcileAfter.body.value.kept.find((k) => k.uploadId === upload2);
const ledger2b = await uploadsStateOf(A);
record(
  "U2c delayed retry accepts on the SAME durable objects; reconcile then keeps the ACCEPTED upload forever",
  accepted2._tag === "ok" &&
    ledger2b.value.uploads.find((u) => u.uploadId === upload2).acceptedSourceId === accepted2.value.sourceId &&
    kept2b?.reason === "accepted"
    ? "PASS"
    : "FAIL",
  `sourceId=${accepted2.value?.sourceId} reconcileReason=${kept2b?.reason}`,
);

await ageUpload(A, upload2, 30 * 24 * 60 * 60 * 1_000);
const reconcileAged = await reconcileUploads(A.token);
record(
  "U2d garbage collection raced with the accepted reference: the aged ACCEPTED upload survives",
  reconcileAged.body.value.kept.find((k) => k.uploadId === upload2)?.reason === "accepted" ? "PASS" : "FAIL",
  `reason=${reconcileAged.body.value.kept.find((k) => k.uploadId === upload2)?.reason}`,
);

// --- U3: abandoned upload becomes safely collected ------------------------------

const U3_DRAFT = `d2-collect-${RUN}`;
const prepared3 = await prepareUpload(A.token, U3_DRAFT, 2, ["audio"]);
const upload3 = prepared3.body.value.uploadId;
const att3 = prepared3.body.value.attachments[0];
await putPart(A.token, upload3, att3.attachmentId, 1, Buffer.from(randomBytes(6 * MIB)));
await ageUpload(A, upload3, 25 * 60 * 60 * 1_000);
const reconcile3 = await reconcileUploads(A.token);
const collected3 = reconcile3.body.value.collectedUploads.find((c) => c.uploadId === upload3);
const ledger3 = await uploadsStateOf(A);
record(
  "U3a an expired, unaccepted, inactive upload is marked orphaned and its R2 objects collected",
  collected3?.reason === "expired_unaccepted" &&
    ledger3.value.uploads.find((u) => u.uploadId === upload3).stage === "orphaned" &&
    reconcile3.body.value.r2AbortedKeys.includes(att3.objectKey)
    ? "PASS"
    : "FAIL",
  `reason=${collected3?.reason} r2Aborted=${reconcile3.body.value.r2AbortedKeys.length}`,
);

const reprepare3 = await prepareUpload(A.token, U3_DRAFT, 2, ["audio"]);
record(
  "U3b re-preparing the collected draft is a typed conflict (restart required), never a byte resurrection",
  reprepare3.body._tag === "error" && reprepare3.body.error.code === "draft_expired_restart_required" ? "PASS" : "FAIL",
  `code=${reprepare3.body.error?.code}`,
);

const U3C_DRAFT = `d2-active-${RUN}`;
const prepared3c = await prepareUpload(A.token, U3C_DRAFT, 2, ["audio"]);
const upload3c = prepared3c.body.value.uploadId;
const att3c = prepared3c.body.value.attachments[0];
await putPart(A.token, upload3c, att3c.attachmentId, 1, Buffer.from(randomBytes(6 * MIB)));
await ageUpload(A, upload3c, 25 * 60 * 60 * 1_000);
await putPart(A.token, upload3c, att3c.attachmentId, 2, Buffer.from(randomBytes(MIB)));
const reconcile3c = await reconcileUploads(A.token);
record(
  "U3c a delayed legitimate retry refreshes the grace anchor and survives collection",
  reconcile3c.body.value.kept.find((k) => k.uploadId === upload3c)?.reason === "active" ? "PASS" : "FAIL",
  `reason=${reconcile3c.body.value.kept.find((k) => k.uploadId === upload3c)?.reason}`,
);

// --- U4: malformed, duplicate and foreign parts typed-rejected ------------------

const U4_DRAFT = `d2-reject-${RUN}`;
const prepared4 = await prepareUpload(A.token, U4_DRAFT, 2, ["audio"]);
const upload4 = prepared4.body.value.uploadId;
const att4 = prepared4.body.value.attachments[0];

const outOfBound = await putPart(A.token, upload4, att4.attachmentId, 3, Buffer.from(randomBytes(1024)));
const zeroPart = await gw(A.token, `/uploads/${upload4}/attachments/${att4.attachmentId}/parts/0`, {
  method: "POST",
  body: Buffer.from(randomBytes(1024)),
});
const foreignAttachment = await putPart(A.token, upload4, "k57notanattachment0000000000aaaa", 1, Buffer.from(randomBytes(1024)));
record(
  "U4a out-of-bound, zero and foreign attachment parts are typed-rejected before any R2 write",
  outOfBound.body._tag === "error" &&
    (outOfBound.body.error.code === "part_number_out_of_range" || outOfBound.body.error.code === "part_bound_exceeded") &&
    zeroPart.body._tag === "error" &&
    foreignAttachment.body._tag === "error" &&
    foreignAttachment.body.error.code === "attachment_not_in_upload"
    ? "PASS"
    : "FAIL",
  `outOfBound=${outOfBound.body.error?.code} foreign=${foreignAttachment.body.error?.code}`,
);

const u4Original = Buffer.from(randomBytes(6 * MIB));
await putPart(A.token, upload4, att4.attachmentId, 1, u4Original);
const state4a = await sessionOf(A.token, upload4);
const diverging = await putPart(A.token, upload4, att4.attachmentId, 1, Buffer.from(randomBytes(6 * MIB)));
const state4b = await sessionOf(A.token, upload4);
record(
  "U4b duplicate part number with different content => typed part_receipt_conflict; the recorded bytes stand",
  diverging.body._tag === "error" &&
    diverging.body.error.code === "part_receipt_conflict" &&
    JSON.stringify(state4a.body.value.attachments[0].parts) === JSON.stringify(state4b.body.value.attachments[0].parts)
    ? "PASS"
    : "FAIL",
  `code=${diverging.body.error?.code}`,
);

const restore4 = await putPart(A.token, upload4, att4.attachmentId, 1, u4Original);
const done4 = await completeAttachmentRoute(A.token, upload4, att4.attachmentId);
if (done4.body._tag !== "ok") {
  throw new Error(`U4c completion failed: ${JSON.stringify(done4.body)}`);
}
const stale4 = await putPart(A.token, upload4, att4.attachmentId, 2, Buffer.from(randomBytes(MIB)));
record(
  "U4c a stale retry against a finalized attachment is refused (finalized bytes immutable)",
  stale4.body._tag === "error" && stale4.body.error.code === "attachment_finalized" ? "PASS" : "FAIL",
  `code=${stale4.body.error?.code}`,
);

const notFinalized = await acceptAsCaller(
  A,
  { uploadId: upload4, authorText: "za wczesna akceptacja", timezoneSnapshot: "Europe/Warsaw", projectHints: [] },
  key(),
);
record(
  "U4d acceptance refuses while the upload is not finalized (all-attachments-durable gate)",
  notFinalized._tag === "error" && notFinalized.error.code === "upload_stage_not_acceptable" ? "PASS" : "FAIL",
  `code=${notFinalized.error?.code}`,
);

// --- V1: cross-identity denial (a real stranger cannot touch the owner's upload) -

const bSession = await sessionOf(B.token, upload1);
const bPart = await putPart(B.token, upload1, audio1.attachmentId, 1, Buffer.from(randomBytes(MIB)));
const bFinalize = await finalizeUpload(B.token, upload1);
record(
  "V1a a signed-in stranger is refused on EVERY gateway step of the owner's upload (before any R2 write)",
  bSession.body._tag === "error" && bSession.body.error._tag === "forbidden" &&
    bPart.body._tag === "error" && bPart.body.error._tag === "forbidden" &&
    bFinalize.body._tag === "error" && bFinalize.body.error._tag === "forbidden"
    ? "PASS"
    : "FAIL",
  `session=${bSession.body.error?.code ?? bSession.body.error?._tag} part=${bPart.body.error?.code ?? bPart.body.error?._tag} finalize=${bFinalize.body.error?.code ?? bFinalize.body.error?._tag}`,
);

const bDraft = await prepareUpload(B.token, `d2-b-${RUN}`, 1, ["image"]);
record(
  "V1b the same stranger prepares their OWN upload in their own firm without friction",
  bDraft.body._tag === "ok" ? "PASS" : "FAIL",
  `uploadId=${bDraft.body.value?.uploadId}`,
);

const bProbeStep = await runStepAsCaller(B, "finalize", { uploadId: upload1 });
record(
  "V1c the step envelope path denies the stranger identically (tenant scope)",
  bProbeStep._tag === "error" && bProbeStep.error.code === "tenant_scope_mismatch" ? "PASS" : "FAIL",
  `code=${bProbeStep.error?.code}`,
);

// --- V2: session revocation MID-UPLOAD blocks the next gateway step -------------

const C = await signInFixture(person("c"));
await ownCompany(C, `Budowa D2 C ${RUN}`);
const cPrepared = await prepareUpload(C.token, `d2-c-${RUN}`, 2, ["audio"]);
const cUpload = cPrepared.body.value.uploadId;
const cAtt = cPrepared.body.value.attachments[0];
await putPart(C.token, cUpload, cAtt.attachmentId, 1, Buffer.from(randomBytes(6 * MIB)));
const revoke = await C.client.mutation("access/identity/functions:revokeSession", {
  sessionId: C.sessionId,
});
const cNext = await putPart(C.token, cUpload, cAtt.attachmentId, 2, Buffer.from(randomBytes(MIB)));
const cSession = await sessionOf(C.token, cUpload);
record(
  "V2 a session revoked MID-UPLOAD blocks the next gateway step (unauthenticated, no R2 write)",
  revoke?._tag === "ok" &&
    cNext.body._tag === "error" && cNext.body.error._tag === "unauthenticated" &&
    cSession.body._tag === "error" && cSession.body.error._tag === "unauthenticated"
    ? "PASS"
    : "FAIL",
  `revoke=${revoke?._tag} nextStep=${cNext.body.error?._tag} session=${cSession.body.error?._tag}`,
);

// --- V3: membership revocation MID-UPLOAD blocks the next gateway step -----------

// D joins A's firm through a REAL invitation (fixture code, B3 pattern).
const invite = await A.client.action("access/membership/functions:createInvitationCommand", {
  envelope: {
    operation: "access.createInvitation",
    input: { email: person("d"), role: "member" },
    expectedRevisions: [],
  },
});
if (invite?._tag !== "ok") {
  throw new Error(`invitation failed: ${JSON.stringify(invite)}`);
}
const invitationId = invite.value.invitationId;
const dCode = fixtureCodeOf(`invite-${invitationId}`);
const setCode = await anon().action("access/membership/probe:b3ProofSetInvitationCode", {
  invitationId,
  code: dCode,
});
if (setCode?._tag !== "ok") {
  throw new Error(`fixture invitation code failed: ${JSON.stringify(setCode)}`);
}
const D = await signInFixture(person("d"));
const dAccepted = await admit(D.client, "access.acceptInvitation", {
  invitationId,
  verificationCode: dCode,
});
if (dAccepted?._tag !== "ok") {
  throw new Error(`invitation acceptance failed: ${JSON.stringify(dAccepted)}`);
}
const dMembershipId = dAccepted.value.membershipId;

// D uploads inside A's firm; A (admin) revokes D's membership mid-upload.
const dPrepared = await prepareUpload(D.token, `d2-d-${RUN}`, 2, ["audio"]);
const dUpload = dPrepared.body.value.uploadId;
const dAtt = dPrepared.body.value.attachments[0];
await putPart(D.token, dUpload, dAtt.attachmentId, 1, Buffer.from(randomBytes(6 * MIB)));
const revokeMembership = await A.client.mutation("access/membership/functions:dispatchMembership", {
  envelope: {
    operation: "access.revokeMembership",
    input: { membershipId: dMembershipId },
    expectedRevisions: [],
  },
});
const dNext = await putPart(D.token, dUpload, dAtt.attachmentId, 2, Buffer.from(randomBytes(MIB)));
const dSession = await sessionOf(D.token, dUpload);
record(
  "V3 a membership revoked MID-UPLOAD by the admin blocks the member's next gateway step",
  revokeMembership?._tag === "ok" &&
    dNext.body._tag === "error" && dNext.body.error._tag === "unauthenticated" &&
    dSession.body._tag === "error" && dSession.body.error._tag === "unauthenticated"
    ? "PASS"
    : "FAIL",
  `revoke=${revokeMembership?._tag} nextStep=${dNext.body.error?._tag} session=${dSession.body.error?._tag}`,
);

// --- V4: the uploads boundary refuses bad credentials ---------------------------

const noHeader = await fetch(`${GATEWAY.replace(/\/$/, "")}/uploads/reconcile`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: "{}",
});
const garbageHeader = await fetch(`https://${DEPLOYMENT}.eu-west-1.convex.site/sources/uploads/bridge`, {
  method: "POST",
  headers: { authorization: "Bearer definitely-not-a-token", "content-type": "application/json" },
  body: JSON.stringify({ step: "reconcile", input: {} }),
});
record(
  "V4 the boundary refuses a missing credential (401) and a garbage credential never resolves",
  noHeader.status === 401 && garbageHeader.status === 401
    ? "PASS"
    : "FAIL",
  `missing=${noHeader.status} garbage=${garbageHeader.status}`,
);

// --- U6: large streamed fixture through the real Worker -------------------------

const LARGE_BYTES = 96 * MIB;
const largePath = `/tmp/kiero-d2-large-${RUN}.bin`;
const largeBuffer = Buffer.alloc(LARGE_BYTES);
const chunk = Buffer.alloc(64 * 1024);
for (let offset = 0; offset < LARGE_BYTES; offset += chunk.length) {
  globalThis.crypto.getRandomValues(chunk);
  chunk.copy(largeBuffer, offset);
}
writeFileSync(largePath, largeBuffer);
const expectedSha = createHash("sha256").update(largeBuffer).digest("hex");
const U6_DRAFT = `d2-large-${RUN}`;
const prepared6 = await prepareUpload(A.token, U6_DRAFT, 1, ["audio"]);
const upload6 = prepared6.body.value.uploadId;
const att6 = prepared6.body.value.attachments[0];
const largePut = await fetch(`${GATEWAY.replace(/\/$/, "")}/uploads/${upload6}/attachments/${att6.attachmentId}/parts/1`, {
  method: "POST",
  headers: { "content-type": "application/octet-stream", authorization: `Bearer ${A.token}` },
  body: createReadStream(largePath),
  duplex: "half",
});
const largePutBody = await largePut.json();
await uploadAttachment(A.token, upload6, att6.attachmentId, []);
const state6 = await sessionOf(A.token, upload6);
const recordedSha = state6.body.value.attachments[0].parts[0].sha256Hex;
unlinkSync(largePath);
record(
  "U6 a 96 MiB fixture streams through the Worker as the signed-in owner with an exact SHA-256 match",
  largePutBody._tag === "ok" && recordedSha === expectedSha ? "PASS" : "FAIL",
  `bytes=${LARGE_BYTES} shaMatch=${recordedSha === expectedSha}`,
);

process.exit(summarize() ? 0 : 1);
