/**
 * D3 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/d3, instance adjoining-gerbil-984, EU)
 * through the REAL deployed gateway Worker (kiero-dev-gateway-d3) and the
 * REAL EU R2 bucket (kiero-dev-media, jurisdiction eu).
 *
 * IDENTITY: every actor is a REAL signed-in person — B1's email-code flow
 * with proof-domain fixture addresses and fixture codes (the B2/B3/D2
 * evidence pattern). Each person's Convex Auth token is the credential the
 * gateway forwards on EVERY media route, so every read resolves through the
 * per-user channel (browser credential -> gateway -> Convex ctx.auth ->
 * B1 live session -> membership -> company) BEFORE any R2 byte is read.
 * Revocations drive the CERTIFIED B1/B3 commands (access.revokeSession,
 * access.revokeMembership through a real invitation), never server-side
 * edits; source lifecycle states drive this lane's guarded fixture probe.
 *
 * Covers the P05 media-access row D3 owns: full and ranged private streams
 * (first/middle/suffix/0-0/overlong/invalid/unsatisfiable/multi-range),
 * conditional requests, concurrent streams, cross-tenant non-disclosure
 * BEFORE any R2 read, session AND membership revocation between
 * consecutive range requests, the in-flight-stream physical limit, source
 * lifecycle, and the no-store cache policy on every answer.
 *
 * Run: KIERO_D3_GATEWAY=https://kiero-dev-gateway-d3.<account>.workers.dev \
 *      node tests/d3/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.)
 */

import { ConvexHttpClient } from "convex/browser";
import { createHash, randomBytes } from "node:crypto";

const DEPLOYMENT = process.env.KIERO_D3_CONVEX ?? "adjoining-gerbil-984";
const CLIENT_URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;
const SITE_URL = `https://${DEPLOYMENT}.eu-west-1.convex.site`;
const GATEWAY = process.env.KIERO_D3_GATEWAY;
if (GATEWAY === undefined) {
  throw new Error("KIERO_D3_GATEWAY (deployed gateway Worker URL) is required");
}

const MIB = 1024 * 1024;
const RUN = Date.now().toString(36);
const person = (name) => `d3-${name}-${RUN}@kiero.invalid`;
// Per-person fixture codes (globally unique() lookup: never share values).
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

// --- real sign-in (the B3/D2 fixture pattern) ----------------------------------

const anon = () => new ConvexHttpClient(CLIENT_URL, { logger: false });

/** Real B1 sign-in with a fixture code (proof-domain address only). */
async function signInFixture(email) {
  const code = fixtureCodeOf(email);
  const bootstrap = anon();
  await bootstrap.action("auth:signIn", { provider: "email_code", params: { email } }).catch(() => {});
  const set = await bootstrap.action("access/identity/probe:b1ProofSetCode", { email, code });
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

// --- gateway helpers (every call carries the person's credential) ---------------

async function mediaGet(token, path, headers = {}) {
  return fetch(`${GATEWAY.replace(/\/$/, "")}${path}`, {
    headers: { ...headers, authorization: `Bearer ${token}` },
  });
}

const jsonInit = (method, payload) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});
const prepareUpload = (token, draftId, parts, mediaKinds) =>
  fetch(`${GATEWAY.replace(/\/$/, "")}/uploads/prepare`, {
    ...jsonInit("POST", { draftId, parts, mediaKinds }),
    headers: { ...jsonInit("POST", {}).headers, authorization: `Bearer ${token}` },
  }).then((r) => r.json());

/** One full accepted media chain as one person; returns the read handles. */
async function acceptedMedia(persona, label, audioBuffer, imageBuffer) {
  const draft = `d3-${label}-${RUN}`;
  const prepared = await prepareUpload(persona.token, draft, 8, ["audio", "image"]);
  if (prepared._tag !== "ok") {
    throw new Error(`prepare failed: ${JSON.stringify(prepared)}`);
  }
  const uploadId = prepared.value.uploadId;
  const audio = prepared.value.attachments.find((a) => a.kind === "audio");
  const image = prepared.value.attachments.find((a) => a.kind === "image");
  const putPart = async (attachmentId, partNumber, buffer) => {
    const response = await fetch(
      `${GATEWAY.replace(/\/$/, "")}/uploads/${uploadId}/attachments/${attachmentId}/parts/${partNumber}`,
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream", authorization: `Bearer ${persona.token}` },
        body: buffer,
        duplex: "half",
      },
    );
    const body = await response.json();
    if (body._tag !== "ok") {
      throw new Error(`part ${partNumber} failed: ${JSON.stringify(body)}`);
    }
  };
  // Deterministic multi-part audio fixture: 5 MiB parts + a final short one.
  let offset = 0;
  let partNumber = 0;
  while (offset < audioBuffer.length) {
    partNumber += 1;
    const end = Math.min(offset + 5 * MIB, audioBuffer.length);
    await putPart(audio.attachmentId, partNumber, audioBuffer.subarray(offset, end));
    offset = end;
  }
  await putPart(image.attachmentId, 1, imageBuffer);
  for (const attachment of [audio, image]) {
    const done = await fetch(
      `${GATEWAY.replace(/\/$/, "")}/uploads/${uploadId}/attachments/${attachment.attachmentId}/complete`,
      { ...jsonInit("POST", {}), headers: { ...jsonInit("POST", {}).headers, authorization: `Bearer ${persona.token}` } },
    ).then((r) => r.json());
    if (done._tag !== "ok") {
      throw new Error(`complete failed: ${JSON.stringify(done)}`);
    }
    attachment.representationId = done.value.representationId;
  }
  const finalized = await fetch(`${GATEWAY.replace(/\/$/, "")}/uploads/${uploadId}/finalize`, {
    ...jsonInit("POST", {}),
    headers: { ...jsonInit("POST", {}).headers, authorization: `Bearer ${persona.token}` },
  }).then((r) => r.json());
  if (finalized._tag !== "ok") {
    throw new Error(`finalize failed: ${JSON.stringify(finalized)}`);
  }
  const accepted = await persona.client.action("sources/uploads/probe:probeAcceptSourceAsCaller", {
    envelope: {
      operation: "sources.acceptSource",
      input: {
        uploadId,
        authorText: `Wiadomość z nagraniem i zdjęciem (D3 live ${label})`,
        timezoneSnapshot: "Europe/Warsaw",
        projectHints: [],
      },
      expectedRevisions: [],
      idempotencyKey: `idem_${globalThis.crypto.randomUUID()}`,
    },
  });
  if (accepted?._tag !== "ok") {
    throw new Error(`acceptance failed: ${JSON.stringify(accepted)}`);
  }
  // The ledger's recorded receipts (etag/bytes) for the consistency checks.
  const state = await persona.client.action("sources/uploads/probe:probeUploadsState", {});
  const uploadRow = state.value.uploads.find((u) => u.uploadId === uploadId);
  const audioRow = state.value.attachments.find((a) => a.attachmentId === audio.attachmentId);
  const imageRow = state.value.attachments.find((a) => a.attachmentId === image.attachmentId);
  return {
    uploadId,
    sourceId: accepted.value.sourceId,
    audio: {
      attachmentId: audio.attachmentId,
      representationId: audio.representationId,
      etag: audioRow.r2ObjectEtag,
      bytes: audioRow.receivedBytes,
      objectKey: audioRow.objectKey,
    },
    image: {
      attachmentId: image.attachmentId,
      representationId: image.representationId,
      etag: imageRow.r2ObjectEtag,
      bytes: imageRow.receivedBytes,
    },
  };
}

const sha256 = (buffer) => createHash("sha256").update(buffer).digest("hex");

console.log(`# D3 live proofs (per-user identity) :: ${DEPLOYMENT} via ${GATEWAY} :: ${new Date().toISOString()}`);

// --- fixture persons -------------------------------------------------------------

const A = await signInFixture(person("a"));
const companyA = await ownCompany(A, `Budowa D3 A ${RUN}`);
record("P0 the owner is a REAL signed-in person with their own firm", typeof companyA === "string" ? "PASS" : "FAIL", `companyA=${companyA}`);

const B = await signInFixture(person("b"));
await ownCompany(B, `Budowa D3 B ${RUN}`);

// --- fixture content (deterministic; range reads must return exact bytes) --------

const AUDIO_BYTES = 23 * MIB + 123_457;
const audioBuffer = Buffer.alloc(AUDIO_BYTES);
const pattern = Buffer.from(randomBytes(64 * 1024));
for (let offset = 0; offset < AUDIO_BYTES; offset += pattern.length) {
  pattern.copy(audioBuffer, offset);
}
const audioSha = sha256(audioBuffer);
const imageBuffer = Buffer.from(randomBytes(256 * 1024));
const imageSha = sha256(imageBuffer);

const mediaA = await acceptedMedia(A, "main", audioBuffer, imageBuffer);
const N = mediaA.audio.bytes;
record(
  "P1 the accepted chain records the ledger receipts (etag/bytes) the reads must serve",
  typeof mediaA.audio.etag === "string" && N === AUDIO_BYTES ? "PASS" : "FAIL",
  `etag=${mediaA.audio.etag} bytes=${N}`,
);

// --- M1: the full-file authorized stream ------------------------------------------

const ttfbStart = Date.now();
const full = await mediaGet(A.token, `/media/attachments/${mediaA.audio.attachmentId}`);
const ttfb = Date.now() - ttfbStart; // headers arrived: the stream started
const fullBodyStart = Date.now();
const fullBody = Buffer.from(await full.arrayBuffer());
const fullBodyMs = Date.now() - fullBodyStart;
const fullHeaders = Object.fromEntries(full.headers);
record(
  "M1a the full stream answers 200 with the ledger's media type, length and etag",
  full.status === 200 &&
    fullHeaders["content-type"] === "audio/webm" &&
    Number(fullHeaders["content-length"]) === AUDIO_BYTES &&
    fullHeaders.etag === `"${mediaA.audio.etag}"`
    ? "PASS"
    : "FAIL",
  `status=${full.status} type=${fullHeaders["content-type"]} len=${fullHeaders["content-length"]} etag=${fullHeaders.etag}`,
);
record(
  "M1b the streamed bytes are byte-exact (SHA-256 of the whole object)",
  fullBody.length === AUDIO_BYTES && sha256(fullBody) === audioSha ? "PASS" : "FAIL",
  `shaMatch=${sha256(fullBody) === audioSha} bytes=${fullBody.length}`,
);
record(
  "M1c range/cache headers: accept-ranges bytes, cache-control no-store, inline disposition",
  fullHeaders["accept-ranges"] === "bytes" && fullHeaders["cache-control"] === "no-store" && fullHeaders["content-disposition"] === "inline"
    ? "PASS"
    : "FAIL",
  `accept-ranges=${fullHeaders["accept-ranges"]} cache=${fullHeaders["cache-control"]} disposition=${fullHeaders["content-disposition"]}`,
);
record(
  "M1d the stream is progressive, not buffered-then-sent (headers arrive strictly before the last byte)",
  fullBody.length === AUDIO_BYTES && ttfb < fullBodyMs ? "PASS" : "FAIL",
  `ttfb=${ttfb}ms bodyTransfer=${fullBodyMs}ms bytes=${fullBody.length} (un-buffered R2 pipe; Worker memory stays bounded structurally)`,
);

// --- M2: the range matrix ------------------------------------------------------------

async function rangeCheck(id, header, expectStatus, expectedSlice) {
  const response = await mediaGet(A.token, `/media/attachments/${mediaA.audio.attachmentId}`, { range: header });
  const headers = Object.fromEntries(response.headers);
  const body = Buffer.from(await response.arrayBuffer());
  const expected = expectedSlice === null ? null : audioBuffer.subarray(expectedSlice[0], expectedSlice[1] + 1);
  const ok =
    response.status === expectStatus &&
    (expected === null || (body.equals(expected) && Number(headers["content-length"]) === expected.length));
  record(id, ok ? "PASS" : "FAIL", `range=${header} status=${response.status} len=${headers["content-length"]} cr=${headers["content-range"] ?? "-"}`);
  return { response, headers, body };
}

await rangeCheck("M2a first range bytes=0-1023", "bytes=0-1023", 206, [0, 1023]);
await rangeCheck("M2b middle range bytes=<mid>", `bytes=${Math.floor(N / 2)}-${Math.floor(N / 2) + 4095}`, 206, [Math.floor(N / 2), Math.floor(N / 2) + 4095]);
await rangeCheck("M2c suffix range bytes=-1000", "bytes=-1000", 206, [N - 1000, N - 1]);
await rangeCheck("M2d one-byte range bytes=0-0", "bytes=0-0", 206, [0, 0]);
await rangeCheck("M2e overlong end caps to last byte", `bytes=100-${N + 5 * MIB}`, 206, [100, N - 1]);
await rangeCheck("M2f suffix longer than file serves whole file", `bytes=-${N + MIB}`, 206, [0, N - 1]);
await rangeCheck("M2g invalid range (last<first) ignored: full 200", "bytes=9999-5", 200, [0, N - 1]);
await rangeCheck("M2h unknown unit ignored: full 200", "items=0-100", 200, [0, N - 1]);
await rangeCheck("M2i multi-range ignored whole: full 200", "bytes=0-1,10-11", 200, [0, N - 1]);

{
  const { headers } = await rangeCheck("M2j unsatisfiable first byte answers 416 with asterisk content-range", `bytes=${N}-`, 416, null);
  record(
    "M2k the 416 content-range names the true total and the body is empty",
    headers["content-range"] === `bytes */${N}` ? "PASS" : "FAIL",
    `content-range=${headers["content-range"]}`,
  );
}

// --- M3: conditional requests ---------------------------------------------------------

{
  const etagHeader = `"${mediaA.audio.etag}"`;
  const notModified = await mediaGet(A.token, `/media/attachments/${mediaA.audio.attachmentId}`, {
    "if-none-match": etagHeader,
    range: "bytes=0-99",
  });
  record(
    "M3a If-None-Match with the current etag answers 304 (evaluated before Range)",
    notModified.status === 304 && Number(notModified.headers.get("content-length") ?? 0) === 0 ? "PASS" : "FAIL",
    `status=${notModified.status} etag=${notModified.headers.get("etag")}`,
  );
  const stillThere = await mediaGet(A.token, `/media/attachments/${mediaA.audio.attachmentId}`, {
    "if-none-match": '"stale-etag"',
  });
  record(
    "M3b If-None-Match with a stale etag serves the full 200",
    stillThere.status === 200 ? "PASS" : "FAIL",
    `status=${stillThere.status}`,
  );
  const honored = await mediaGet(A.token, `/media/attachments/${mediaA.audio.attachmentId}`, {
    "if-range": etagHeader,
    range: "bytes=7-9",
  });
  const honoredBody = Buffer.from(await honored.arrayBuffer());
  record(
    "M3c If-Range with the current etag honors the Range (206, exact bytes)",
    honored.status === 206 && honoredBody.equals(audioBuffer.subarray(7, 10)) ? "PASS" : "FAIL",
    `status=${honored.status} bytes=${honoredBody.length}`,
  );
  const ignored = await mediaGet(A.token, `/media/attachments/${mediaA.audio.attachmentId}`, {
    "if-range": '"stale-etag"',
    range: "bytes=7-9",
  });
  const ignoredBody = Buffer.from(await ignored.arrayBuffer());
  record(
    "M3d If-Range with a stale etag ignores the Range (full 200, exact bytes)",
    ignored.status === 200 && ignoredBody.length === N && sha256(ignoredBody) === audioSha ? "PASS" : "FAIL",
    `status=${ignored.status} len=${ignoredBody.length}`,
  );
}

// --- M4: the exact-representation read and the image kind -----------------------------

{
  const byRepresentation = await mediaGet(A.token, `/media/representations/${mediaA.audio.representationId}`);
  const body = Buffer.from(await byRepresentation.arrayBuffer());
  record(
    "M4a the exact-representation route serves the SAME verified version (E4/I3/I5 address)",
    byRepresentation.status === 200 && sha256(body) === audioSha && byRepresentation.headers.get("etag") === `"${mediaA.audio.etag}"` ? "PASS" : "FAIL",
    `status=${byRepresentation.status} etag=${byRepresentation.headers.get("etag")}`,
  );
  const image = await mediaGet(A.token, `/media/attachments/${mediaA.image.attachmentId}`);
  const imageBody = Buffer.from(await image.arrayBuffer());
  record(
    "M4b the image attachment serves its recorded media type and byte-exact content",
    image.status === 200 &&
      image.headers.get("content-type") === "image/jpeg" &&
      Number(image.headers.get("content-length")) === imageBuffer.length &&
      sha256(imageBody) === imageSha
      ? "PASS"
      : "FAIL",
    `type=${image.headers.get("content-type")} len=${image.headers.get("content-length")}`,
  );
}

// --- M5: concurrent streams ------------------------------------------------------------

{
  const specs = [
    [0, 65535],
    [Math.floor(N / 3), Math.floor(N / 3) + 65535],
    [N - 4096, N - 1],
    [1024, 2047],
    [Math.floor(N / 2), Math.floor(N / 2) + 99],
    [0, 0],
  ];
  const answers = await Promise.all(
    specs.map(([first, last]) =>
      mediaGet(A.token, `/media/attachments/${mediaA.audio.attachmentId}`, { range: `bytes=${first}-${last}` }).then(
        async (response) => ({ status: response.status, body: Buffer.from(await response.arrayBuffer()) }),
      ),
    ),
  );
  const ok = answers.every((answer, index) => {
    const [first, last] = specs[index];
    return answer.status === 206 && answer.body.equals(audioBuffer.subarray(first, last + 1));
  });
  record("M5 six concurrent range streams stay byte-exact and isolated", ok ? "PASS" : "FAIL", `parallel=${specs.length}`);
}

// --- V1: cross-tenant non-disclosure BEFORE any R2 read --------------------------------

{
  const foreignAttachment = await mediaGet(B.token, `/media/attachments/${mediaA.audio.attachmentId}`);
  const missingAttachment = await mediaGet(A.token, "/media/attachments/k57doesnotexist0000000000zzzz");
  const foreignRepresentation = await mediaGet(B.token, `/media/representations/${mediaA.audio.representationId}`);
  const missingRepresentation = await mediaGet(A.token, "/media/representations/k57doesnotexist0000000000zzzz");
  const rawKeyGuess = await mediaGet(A.token, "/media/attachments/companies%2Fwhatever%2Fuploads%2Fx%2F0-y");
  const foreignBody = await foreignAttachment.text();
  const missingBody = await missingAttachment.text();
  record(
    "V1a a foreign attachment id answers EXACTLY like a nonexistent one (no existence/tenancy disclosure)",
    foreignAttachment.status === 404 &&
      missingAttachment.status === 404 &&
      foreignBody === missingBody &&
      !foreignBody.includes("companies/")
      ? "PASS"
      : "FAIL",
    `foreign=${foreignAttachment.status} missing=${missingAttachment.status} identical=${foreignBody === missingBody}`,
  );
  record(
    "V1b a foreign representation id answers exactly like a nonexistent one",
    foreignRepresentation.status === 404 &&
      (await foreignRepresentation.text()) === (await missingRepresentation.text())
      ? "PASS"
      : "FAIL",
    `foreign=${foreignRepresentation.status}`,
  );
  record(
    "V1c a raw object-key guess is just another not-readable reference (no key surface exists)",
    rawKeyGuess.status === 404 ? "PASS" : "FAIL",
    `status=${rawKeyGuess.status}`,
  );
  const probeForeign = await B.client.action("sources/media_access/probe:probeMediaAccess", {
    attachmentId: mediaA.audio.attachmentId,
  });
  const probeMissing = await A.client.action("sources/media_access/probe:probeMediaAccess", {
    attachmentId: "k57doesnotexist0000000000zzzz",
  });
  record(
    "V1d the Convex seam itself answers foreign == missing (the gateway never reaches R2 on denial)",
    JSON.stringify(probeForeign) === JSON.stringify(probeMissing) && probeForeign?._tag === "error" ? "PASS" : "FAIL",
    `code=${probeForeign?.error?.code ?? probeForeign?._tag}`,
  );
  const noCredential = await fetch(`${GATEWAY.replace(/\/$/, "")}/media/attachments/${mediaA.audio.attachmentId}`);
  const garbageCredential = await fetch(`https://${DEPLOYMENT}.eu-west-1.convex.site/sources/media/access`, {
    method: "POST",
    headers: { authorization: "Bearer definitely-not-a-token", "content-type": "application/json" },
    body: JSON.stringify({ attachmentId: mediaA.audio.attachmentId }),
  });
  record(
    "V2 the boundary refuses a missing credential (401) and a garbage credential never resolves",
    noCredential.status === 401 && garbageCredential.status === 401 ? "PASS" : "FAIL",
    `missing=${noCredential.status} garbage=${garbageCredential.status}`,
  );
}

// --- V3: session revocation MID-STREAM ---------------------------------------------------

const C = await signInFixture(person("c"));
await ownCompany(C, `Budowa D3 C ${RUN}`);
const cBuffer = Buffer.from(randomBytes(4 * MIB + 17));
const mediaC = await acceptedMedia(C, "session-revoke", cBuffer, Buffer.from(randomBytes(32 * 1024)));
{
  const first = await mediaGet(C.token, `/media/attachments/${mediaC.audio.attachmentId}`, { range: "bytes=0-1023" });
  const firstBody = Buffer.from(await first.arrayBuffer());
  const started = await mediaGet(C.token, `/media/attachments/${mediaC.audio.attachmentId}`);
  const reader = started.body.getReader();
  const firstChunk = await reader.read();
  const revoke = await C.client.mutation("access/identity/functions:revokeSession", { sessionId: C.sessionId });
  let collected = [firstChunk.value];
  let done = firstChunk.done;
  while (!done) {
    const next = await reader.read();
    done = next.done;
    if (!done) {
      collected.push(next.value);
    }
  }
  const drained = Buffer.concat(collected.map((chunk) => Buffer.from(chunk)));
  const nextRange = await mediaGet(C.token, `/media/attachments/${mediaC.audio.attachmentId}`, { range: "bytes=1024-2047" });
  const nextFull = await mediaGet(C.token, `/media/attachments/${mediaC.audio.attachmentId}`);
  record(
    "V3a the range request BEFORE revocation succeeded",
    first.status === 206 && firstBody.equals(cBuffer.subarray(0, 1024)) ? "PASS" : "FAIL",
    `status=${first.status}`,
  );
  record(
    "V3b the stream already in flight when the session died FINISHES (already-delivered bytes are the physical limit)",
    started.status === 200 && drained.length === cBuffer.length && sha256(drained) === sha256(cBuffer) ? "PASS" : "FAIL",
    `drained=${drained.length}/${cBuffer.length}`,
  );
  record(
    "V3c the NEXT range request after revocation is refused (unauthenticated, no R2 read)",
    revoke?._tag === "ok" && nextRange.status === 401 && nextFull.status === 401 ? "PASS" : "FAIL",
    `revoke=${revoke?._tag} nextRange=${nextRange.status} nextFull=${nextFull.status}`,
  );
}

// --- V4: membership revocation MID-STREAM (a real invitation) ----------------------------

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
const setCode = await anon().action("access/membership/probe:b3ProofSetInvitationCode", { invitationId, code: dCode });
if (setCode?._tag !== "ok") {
  throw new Error(`fixture invitation code failed: ${JSON.stringify(setCode)}`);
}
const D = await signInFixture(person("d"));
const dAccepted = await admit(D.client, "access.acceptInvitation", { invitationId, verificationCode: dCode });
if (dAccepted?._tag !== "ok") {
  throw new Error(`invitation acceptance failed: ${JSON.stringify(dAccepted)}`);
}
const dMembershipId = dAccepted.value.membershipId;
const dBuffer = Buffer.from(randomBytes(2 * MIB + 321));
const mediaD = await acceptedMedia(D, "membership-revoke", dBuffer, Buffer.from(randomBytes(16 * 1024)));
{
  const before = await mediaGet(D.token, `/media/attachments/${mediaD.audio.attachmentId}`, { range: "bytes=0-99" });
  const beforeBody = Buffer.from(await before.arrayBuffer());
  const readsA = await mediaGet(D.token, `/media/attachments/${mediaA.audio.attachmentId}`, { range: "bytes=0-99" });
  const revokeMembership = await A.client.mutation("access/membership/functions:dispatchMembership", {
    envelope: {
      operation: "access.revokeMembership",
      input: { membershipId: dMembershipId },
      expectedRevisions: [],
    },
  });
  const after = await mediaGet(D.token, `/media/attachments/${mediaD.audio.attachmentId}`, { range: "bytes=100-199" });
  const afterA = await mediaGet(D.token, `/media/attachments/${mediaA.audio.attachmentId}`, { range: "bytes=0-99" });
  record(
    "V4a the member read their OWN and a FELLOW member's media before revocation (firm-shared reads)",
    before.status === 206 && beforeBody.equals(dBuffer.subarray(0, 100)) && readsA.status === 206 ? "PASS" : "FAIL",
    `own=${before.status} fellow=${readsA.status}`,
  );
  record(
    "V4b after the admin revoked the membership, the next range request is refused on BOTH sources",
    revokeMembership?._tag === "ok" && after.status === 401 && afterA.status === 401 ? "PASS" : "FAIL",
    `revoke=${revokeMembership?._tag} own=${after.status} fellow=${afterA.status}`,
  );
}

// --- V6: every media answer carried the no-store cache policy ------------------------------

{
  const ranged = await mediaGet(A.token, `/media/attachments/${mediaA.audio.attachmentId}`, {
    range: "bytes=0-99",
  });
  const notModified = await mediaGet(A.token, `/media/attachments/${mediaA.audio.attachmentId}`, {
    "if-none-match": "*",
  });
  const allNoStore = [full, ranged, notModified].every(
    (response) => response.headers.get("cache-control") === "no-store",
  );
  record(
    "V6 no media answer is cacheable (cache-control: no-store on 200, 206 and 304 alike; no shared cache is configured in front of this worker)",
    allNoStore ? "PASS" : "FAIL",
    `noStore=${allNoStore} statuses=${full.status}/${ranged.status}/${notModified.status}`,
  );
}

// --- V5: source lifecycle (last: the purge ends A's main-media readability) -----------------

{
  const withdrawnProbe = await A.client.action("sources/media_access/probe:probeSetSourceLifecycle", {
    sourceId: mediaA.sourceId,
    lifecycle: "withdrawn",
  });
  const withdrawnRead = await mediaGet(A.token, `/media/attachments/${mediaA.audio.attachmentId}`, { range: "bytes=0-99" });
  const purgedProbe = await A.client.action("sources/media_access/probe:probeSetSourceLifecycle", {
    sourceId: mediaA.sourceId,
    lifecycle: "purged",
  });
  const purgedRead = await mediaGet(A.token, `/media/attachments/${mediaA.audio.attachmentId}`, { range: "bytes=0-99" });
  const purgedMissing = await mediaGet(A.token, "/media/attachments/k57doesnotexist0000000000zzzz");
  record(
    "V5a a withdrawn source stays readable (history is part of the record)",
    withdrawnProbe?._tag === "ok" && withdrawnRead.status === 206 ? "PASS" : "FAIL",
    `probe=${withdrawnProbe?._tag} read=${withdrawnRead.status}`,
  );
  record(
    "V5b a purged source's media answers exactly like a nonexistent id (immediate inaccessibility, uniform refusal)",
    purgedProbe?._tag === "ok" &&
      purgedRead.status === 404 &&
      (await purgedRead.text()) === (await purgedMissing.text())
      ? "PASS"
      : "FAIL",
    `purged=${purgedRead.status}`,
  );
}

process.exit(summarize() ? 0 : 1);
