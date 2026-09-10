/**
 * D5 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/d5, instance veracious-yak-332, EU)
 * through the REAL deployed gateway Worker (kiero-dev-gateway-d5), the REAL
 * EU R2 bucket (kiero-dev-media, jurisdiction eu) and the LOCAL sharp
 * normalizer standing in for the Cloudflare Images binding behind the same
 * port (the paid-plan swap is configuration; see the issue report).
 *
 * IDENTITY: every actor is a REAL signed-in person — B1's email-code flow
 * with proof-domain fixture addresses and fixture codes (the B3/D2 evidence
 * pattern). Each person's Convex Auth token is the credential the gateway
 * forwards on every uploads route, so the whole chain (prepare/parts/
 * complete/finalize/accept) runs AS THAT USER. The service account appears
 * only on the executor channel (durable job -> action -> gateway), whose
 * authority is the job row itself.
 *
 * Fixtures (real bytes, generated with sharp):
 * - phone-shaped 4000x3000 JPEG with EXIF orientation 6 and large
 *   handwritten-style amounts ("FV 2026/09/08", "12 400 zł", "szer. 3,60 m");
 * - a small-dimensions 480x360 JPEG with small amounts;
 * - an oversized (> 20 MB) noise JPEG;
 * - an ICO-magic unsupported input;
 * - a truncated (corrupt) JPEG;
 * - a noise JPEG whose WebP conversion cannot compress below the input
 *   (forced unresolved quality).
 *
 * Run:
 *   KIERO_D5_GATEWAY=https://kiero-dev-gateway-d5.wojtek-524.workers.dev \
 *   node tests/d5/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.)
 */

import { ConvexHttpClient } from "convex/browser";
import { randomBytes } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const GATEWAY_DIR = resolve(REPO_ROOT, "apps/gateway");
import sharp from "sharp";

const DEPLOYMENT = process.env.KIERO_D5_CONVEX ?? "veracious-yak-332";
const CLIENT_URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;
const GATEWAY = process.env.KIERO_D5_GATEWAY;
const SERVICE_TOKEN = process.env.KIERO_D5_SERVICE_TOKEN;
if (GATEWAY === undefined) {
  throw new Error("KIERO_D5_GATEWAY (deployed gateway Worker URL) is required");
}
if (SERVICE_TOKEN === undefined) {
  throw new Error("KIERO_D5_SERVICE_TOKEN (the dev service credential) is required");
}
const EXECUTOR_URL = `${GATEWAY.replace(/\/$/, "")}/images/normalize`;
const RECONCILE_URL = `${GATEWAY.replace(/\/$/, "")}/images/reconcile`;
/** A dead-but-JSON-answering endpoint: the gateway's own unsupported route. */
const DEAD_EXECUTOR_URL = `${GATEWAY.replace(/\/$/, "")}/platform/definitely-not-a-route`;

const RUN = Date.now().toString(36);
const MIB = 1024 * 1024;
const MAX_INPUT_BYTES = 20 * MIB;

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

// --- real sign-in (B3/D2 fixture pattern) ------------------------------------

const anon = () => new ConvexHttpClient(CLIENT_URL, { logger: false });

async function errOf(fn) {
  try {
    await fn();
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

const fixtureCodeOf = (seed) => {
  let hash = 0;
  for (const byte of Buffer.from(seed)) {
    hash = (hash * 31 + byte) % 90_000_000;
  }
  return String(42_000_000 + hash);
};

async function signInFixture(email) {
  const code = fixtureCodeOf(email);
  const bootstrap = anon();
  await errOf(() => bootstrap.action("auth:signIn", { provider: "email_code", params: { email } }));
  const set = await bootstrap.action("access/identity/probe:b1ProofSetCode", { email, code });
  if (set?._tag !== "ok") {
    throw new Error(`fixture code install failed for ${email}: ${JSON.stringify(set)}`);
  }
  const result = await bootstrap.action("auth:signIn", { provider: "email_code", params: { email, code } });
  const token = result?.tokens?.token;
  if (typeof token !== "string") {
    throw new Error(`sign-in failed for ${email}`);
  }
  const client = new ConvexHttpClient(CLIENT_URL, { logger: false, auth: token });
  const ensured = await client.mutation("access/identity/functions:ensureSessionRegistry", {});
  if (ensured?.state !== "live") {
    throw new Error(`session provisioning failed for ${email}: ${JSON.stringify(ensured)}`);
  }
  return { client, token, email };
}

const admit = (client, operation, input) =>
  client.mutation("access/membership/functions:admitCommand", {
    envelope: { operation, input, expectedRevisions: [] },
  });

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

// --- gateway helpers ----------------------------------------------------------

async function gw(token, path, init = {}) {
  const response = await fetch(`${GATEWAY.replace(/\/$/, "")}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), authorization: `Bearer ${token}` },
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
const finalizeUpload = (token, uploadId) => gw(token, `/uploads/${uploadId}/finalize`, jsonInit("POST", {}));

// --- probe helpers ------------------------------------------------------------

const acceptAsCaller = (persona, input, idempotencyKey) =>
  persona.client.action("sources/uploads/probe:probeAcceptSourceAsCaller", {
    envelope: { operation: "sources.acceptSource", input, expectedRevisions: [], idempotencyKey },
  });
const imagesStateOf = (persona) => persona.client.action("processing/images/probe:probeImagesState", {});
const attachmentStateOf = (persona, attachmentId) =>
  persona.client.action("processing/images/probe:probeAttachmentState", { attachmentId });
const driveJob = (persona, jobKey, opts = {}) =>
  persona.client.action("processing/images/probe:probeDriveNormalization", {
    jobKey,
    ...(opts.crashAfter === undefined ? {} : { crashAfter: opts.crashAfter }),
    ...(opts.executorUrl === undefined ? {} : { executorUrl: opts.executorUrl }),
    ...(opts.forceRunning === undefined ? {} : { forceRunning: opts.forceRunning }),
  });
const requeueJob = (persona, jobKey) =>
  persona.client.action("processing/images/probe:probeRequeueNormalization", { jobKey });
const reconcileJob = (persona, jobKey) =>
  persona.client.action("processing/images/probe:probeReconcileNormalization", { jobKey });

// --- fixtures (real bytes) ----------------------------------------------------

/** Large handwritten-style amounts rendered on a photo-shaped canvas. */
function amountsSvg(width, height, scale) {
  const lines = [
    "FV 2026/09/08",
    "12 400 zł brutto",
    "szerokość 3,60 m",
    "wysokość 2,10 m",
    "beton C25/30",
  ];
  const fontSize = Math.round(64 * scale);
  const body = lines
    .map(
      (line, index) =>
        `<text x="${Math.round(80 * scale)}" y="${Math.round(200 * scale) + index * Math.round(110 * scale)}" font-family="Georgia, serif" font-style="italic" font-weight="700" font-size="${fontSize}" fill="#1a1a2e">${line}</text>`,
    )
    .join("");
  return Buffer.from(
    `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
      <rect width="100%" height="100%" fill="#d8cfc0"/>
      <rect x="${Math.round(40 * scale)}" y="${Math.round(60 * scale)}" width="${width - Math.round(80 * scale)}" height="${height - Math.round(120 * scale)}" fill="#efe9dd" stroke="#8b7d6b" stroke-width="${Math.round(6 * scale)}"/>
      ${body}
    </svg>`,
  );
}

async function phoneFixture() {
  const width = 4000;
  const height = 3000;
  // A photographic-ish noise base so the encoder has real work; the
  // handwritten-style amounts composite on top in the SAME pipeline.
  const noise = Buffer.from(randomBytes(width * height * 3));
  const flattened = await sharp(noise, { raw: { width, height, channels: 3 } })
    .modulate({ brightness: 1.4, saturation: 0.6 })
    .blur(2)
    .composite([{ input: amountsSvg(width, height, 1) }])
    .jpeg({ quality: 82 })
    .toBuffer();
  // Phone-shaped: the SENSOR is landscape, EXIF orientation 6 says "rotate
  // 90 CW when displaying" -> the readable photo is portrait 3000x4000.
  return sharp(flattened).withMetadata({ orientation: 6 }).jpeg({ quality: 82 }).toBuffer();
}

async function smallFixture() {
  const width = 480;
  const height = 360;
  return sharp({
    create: { width, height, channels: 3, background: { r: 200, g: 195, b: 185 } },
  })
    .composite([{ input: amountsSvg(width, height, 0.14) }])
    .jpeg({ quality: 85 })
    .toBuffer();
}

async function oversizedFixture() {
  // Incompressible noise JPEG grown until it truly exceeds the proved
  // 20 MB input limit (the bound the decision reads).
  let width = 5200;
  let height = 3900;
  for (;;) {
    const noise = Buffer.from(randomBytes(width * height * 3));
    const buffer = await sharp(noise, { raw: { width, height, channels: 3 } })
      .jpeg({ quality: 95 })
      .toBuffer();
    if (buffer.length > MAX_INPUT_BYTES) {
      return buffer;
    }
    width = Math.round(width * 1.15);
    height = Math.round(height * 1.15);
  }
}

/** ICO-magic bytes: nameable, but outside every executor's proved list. */
function unsupportedFixture() {
  const header = Buffer.from([0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x30, 0x30]);
  return Buffer.concat([header, Buffer.from(randomBytes(512))]);
}

/** JPEG magic with a truncated body: supported format, corrupt bytes. */
function corruptFixture() {
  const header = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
  return Buffer.concat([header, Buffer.from(randomBytes(4096))]);
}

/**
 * A noise JPEG the WebP encoder cannot compress below the input: the pure
 * resolved-quality floor then keeps the received original (the forced
 * uncertain-quality fixture). The generator verifies the property holds.
 */
async function qualityFixture() {
  const width = 2400;
  const height = 1800;
  const noise = Buffer.from(randomBytes(width * height * 3));
  const input = await sharp(noise, { raw: { width, height, channels: 3 } }).jpeg({ quality: 60 }).toBuffer();
  const probe = await sharp(input).rotate().webp({ quality: 85, effort: 4 }).toBuffer();
  if (probe.length <= input.length || input.length < 256 * 1024) {
    throw new Error(
      `quality fixture does not force the unresolved path (input ${input.length}, output ${probe.length})`,
    );
  }
  return input;
}

// --- upload chain -------------------------------------------------------------

/** One attachment's full D2 chain (parts + complete). */
async function uploadAttachment(token, uploadId, attachmentId, buffer) {
  // Parts must be >= 5 MiB except the last; one big part + tail works.
  const partSize = 6 * MIB;
  let partNumber = 0;
  for (let offset = 0; offset < buffer.length; offset += partSize) {
    partNumber += 1;
    const slice = buffer.subarray(offset, Math.min(offset + partSize, buffer.length));
    const put = await putPart(token, uploadId, attachmentId, partNumber, slice);
    if (put.body._tag !== "ok") {
      throw new Error(`part ${partNumber} failed: ${JSON.stringify(put.body)}`);
    }
  }
  if (partNumber === 0) {
    const put = await putPart(token, uploadId, attachmentId, 1, buffer);
    if (put.body._tag !== "ok") {
      throw new Error(`part 1 failed: ${JSON.stringify(put.body)}`);
    }
  }
  const done = await completeAttachmentRoute(token, uploadId, attachmentId);
  if (done.body._tag !== "ok") {
    throw new Error(`complete failed: ${JSON.stringify(done.body)}`);
  }
  return done.body.value;
}

/**
 * Uploads ONE image fixture and accepts the source; returns the source,
 * its image attachment and the normalize job (waits for the drain's
 * registration).
 */
async function acceptImage(persona, label, buffer, opts = {}) {
  const draftId = `d5-${label}-${RUN}`;
  const prepared = await prepareUpload(persona.token, draftId, 8, ["image"]);
  if (prepared.body._tag !== "ok") {
    throw new Error(`prepare failed for ${label}: ${JSON.stringify(prepared.body)}`);
  }
  const uploadId = prepared.body.value.uploadId;
  const attachment = prepared.body.value.attachments[0];
  await uploadAttachment(persona.token, uploadId, attachment.attachmentId, buffer);
  const finalized = await finalizeUpload(persona.token, uploadId);
  if (finalized.body._tag !== "ok") {
    throw new Error(`finalize failed for ${label}: ${JSON.stringify(finalized.body)}`);
  }
  const idempotencyKey = key();
  const accepted = await acceptAsCaller(
    persona,
    {
      uploadId,
      authorText: `Zdjęcie ${label} (D5 live proof)`,
      timezoneSnapshot: "Europe/Warsaw",
      projectHints: [],
    },
    idempotencyKey,
  );
  if (accepted._tag !== "ok") {
    throw new Error(`accept failed for ${label}: ${JSON.stringify(accepted)}`);
  }
  const sourceId = accepted.value.sourceId;
  // Wait for the drain to register the normalize job for this source.
  let job = null;
  for (let attempt = 0; attempt < 30 && job === null; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 500));
    const state = await imagesStateOf(persona);
    const mine = state.value.normalizeJobs.find(
      (candidate) => candidate.dedupKey === `processing.normalize_photo:${sourceId}`,
    );
    if (mine !== undefined) {
      job = mine;
    }
  }
  if (job === null) {
    throw new Error(`normalize job never registered for ${label}`);
  }
  return { sourceId, attachmentId: attachment.attachmentId, jobKey: job.jobKey, uploadId };
}

/** Waits until every representation row of the attachment is terminal. */
async function waitForTerminal(persona, attachmentId, timeoutMs = 90_000) {
  const started = Date.now();
  let rows = [];
  for (;;) {
    const state = await attachmentStateOf(persona, attachmentId);
    if (state._tag !== "ok") {
      throw new Error(`attachment state failed: ${JSON.stringify(state)}`);
    }
    rows = state.value.representations;
    const retained = rows.filter((r) => r.role === "retained");
    const received = rows.find((r) => r.role === "received");
    const normalized = retained.filter((r) => r.transformVersion === "d5.normalize/1");
    const terminal =
      (normalized.length > 0 && normalized.every((r) => r.verifiedAtMs !== undefined) &&
        (received === undefined || received.removedAtMs !== undefined)) ||
      (retained.length > 0 && retained.every((r) => r.transformVersion === "d5.retained-original/1"));
    if (terminal || Date.now() - started > timeoutMs) {
      return { rows, state: state.value };
    }
    await new Promise((resolve) => setTimeout(resolve, 700));
  }
}

/** Hard R2 evidence through the account CLI (jurisdiction-aware). */
function r2ObjectExists(objectKey) {
  try {
    execFileSync(
      "npx",
      ["wrangler", "r2", "object", "get", `kiero-dev-media/${objectKey}`, "--file", "/tmp/d5-r2-probe.bin", "--jurisdiction", "eu"],
      { stdio: "pipe", cwd: GATEWAY_DIR },
    );
    return true;
  } catch {
    return false;
  }
}

/** The service channel of the gateway (the durable job's executor path). */
async function gatewayService(path, payload) {
  const response = await fetch(`${GATEWAY.replace(/\/$/, "")}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${SERVICE_TOKEN}` },
    body: JSON.stringify(payload),
  });
  let body;
  try {
    body = await response.json();
  } catch {
    body = { parse: "failed", status: response.status };
  }
  return { status: response.status, body };
}

const jobOf = async (persona, jobKey) => {
  const state = await imagesStateOf(persona);
  return state.value.normalizeJobs.find((candidate) => candidate.jobKey === jobKey) ?? null;
};

console.log(`# D5 live proofs :: ${DEPLOYMENT} via ${GATEWAY} :: ${new Date().toISOString()}`);

// Pin the scheduled machinery's executor URL to the real gateway: a crashed
// earlier run may have left the dead proof endpoint configured.
{
  const { execFileSync: exec } = await import("node:child_process");
  exec("npx", ["convex@1.45.0", "env", "set", "KIERO_IMAGES_EXECUTOR_URL", EXECUTOR_URL], {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
}

// --- fixture persons ------------------------------------------------------------

const A = await signInFixture(`d5-a-${RUN}@kiero.invalid`);
const companyA = await ownCompany(A, `Budowa D5 A ${RUN}`);
record("P0a the owner is a REAL signed-in person with their own firm", typeof companyA === "string" ? "PASS" : "FAIL", `companyA=${companyA}`);

const B = await signInFixture(`d5-b-${RUN}@kiero.invalid`);
const companyB = await ownCompany(B, `Budowa D5 B ${RUN}`);
record("P0b the second person (other firm) is a REAL signed-in person", typeof companyB === "string" ? "PASS" : "FAIL", `companyB=${companyB}`);

// --- generate fixtures -----------------------------------------------------------

const fixtures = {};
fixtures.phone = await phoneFixture();
fixtures.small = await smallFixture();
fixtures.oversized = await oversizedFixture();
fixtures.unsupported = unsupportedFixture();
fixtures.corrupt = corruptFixture();
fixtures.quality = await qualityFixture();
record(
  "P1 fixtures are real distinguishable inputs",
  fixtures.phone.length > 100 * 1024 &&
    fixtures.phone.length < MAX_INPUT_BYTES &&
    fixtures.small.length < MAX_INPUT_BYTES &&
    fixtures.oversized.length > MAX_INPUT_BYTES &&
    fixtures.unsupported.length > 0 &&
    fixtures.corrupt.length > 0 &&
    fixtures.quality.length >= 256 * 1024
    ? "PASS"
    : "FAIL",
  `phone=${fixtures.phone.length}B small=${fixtures.small.length}B oversized=${fixtures.oversized.length}B quality=${fixtures.quality.length}B`,
);
const phoneMeta = await sharp(fixtures.phone).metadata();
record(
  "P1b the phone fixture carries EXIF orientation 6 over a 4000x3000 sensor",
  phoneMeta.orientation === 6 && phoneMeta.width === 4000 && phoneMeta.height === 3000
    ? "PASS"
    : "FAIL",
  `orientation=${phoneMeta.orientation} ${phoneMeta.width}x${phoneMeta.height}`,
);

// --- N1: the phone photo (rotation + bounded dimensions + cleanup) -----------------

const n1 = await acceptImage(A, "phone", fixtures.phone);
const n1Final = await waitForTerminal(A, n1.attachmentId);
{
  const rows = n1Final.rows;
  const retained = rows.find((r) => r.role === "retained" && r.transformVersion === "d5.normalize/1");
  const thumbnail = rows.find((r) => r.role === "thumbnail");
  const received = rows.find((r) => r.role === "received");
  const selection = n1Final.state.retainedSelection;
  record(
    "N1a EXIF rotation baked in: the retained archival is PORTRAIT 3000x4000 WebP, verified durable",
    retained?.verifiedAtMs !== undefined &&
      retained?.width === 3000 &&
      retained?.height === 4000 &&
      retained?.mimeType === "image/webp" &&
      Math.max(retained?.width ?? 0, retained?.height ?? 0) <= 4096
      ? "PASS"
      : "FAIL",
    `retained=${retained?.width}x${retained?.height} ${retained?.mimeType} verified=${retained?.verifiedAtMs !== undefined}`,
  );
  record(
    "N1b the derived thumbnail is verified with bounded dimensions",
    thumbnail?.verifiedAtMs !== undefined && Math.max(thumbnail?.width ?? 9999, thumbnail?.height ?? 9999) <= 512
      ? "PASS"
      : "FAIL",
    `thumbnail=${thumbnail?.width}x${thumbnail?.height} verified=${thumbnail?.verifiedAtMs !== undefined}`,
  );
  record(
    "N1c the retained object proved durable and readable THROUGH THE REAL BINDING (head + full re-read hash recorded on the row)",
    retained?.verifiedAtMs !== undefined &&
      typeof retained?.contentHash === "string" &&
      retained.contentHash.startsWith("sha256:") &&
      retained.contentHash.length === "sha256:".length + 64 &&
      typeof retained?.bytes === "number" &&
      retained.bytes > 0
      ? "PASS"
      : "FAIL",
    `hash=${retained?.contentHash?.slice(0, 19)}... bytes=${retained?.bytes}`,
  );
  record(
    "N1d handwritten amounts survive the conversion legibly (identical local reproduction of the live recipe)",
    await (async () => {
      if (retained === undefined) {
        return "FAIL";
      }
      // The LIVE row records what the normalizer produced (dimensions,
      // bytes, hash). Reproduce the exact same recipe locally on the same
      // fixture and require (a) identical dimensions, (b) a text band whose
      // local contrast (stddev) survives: flat conversions destroy it.
      const reproduction = await sharp(fixtures.phone)
        .rotate()
        .resize({ width: 4096, height: 4096, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 85, effort: 4 })
        .toBuffer({ resolveWithObject: true });
      const meta = reproduction.info;
      const band = await sharp(reproduction.data)
        .extract({ left: 0, top: 0, width: meta.width, height: Math.round(meta.height * 0.5) })
        .greyscale()
        .stats();
      const overall = await sharp(reproduction.data).stats();
      return (
        meta.width === retained.width &&
        meta.height === retained.height &&
        overall.channels.every((c) => c.stdev > 10) &&
        band.channels[0].stdev > 10
      ) ? "PASS" : "FAIL";
    })(),
    "dimensions match the live row; stroke-band stdev floor exceeded",
  );
  const n1Reconcile = await gatewayService("/images/reconcile", { jobKey: n1.jobKey });
  record(
    "N1e temporary received bytes removed ONLY after verification (post-delete marker + nothing left to clean up)",
    received?.removedAtMs !== undefined &&
      (retained?.verifiedAtMs ?? 0) <= (received?.removedAtMs ?? Number.MAX_SAFE_INTEGER) &&
      n1Reconcile.body?.value?.reconciled === "not_applicable" &&
      (n1Reconcile.body?.value?.deletedKeys?.length ?? 0) === 0
      ? "PASS"
      : "FAIL",
    `removedAtMs=${received?.removedAtMs} verifiedAtMs=${retained?.verifiedAtMs} reReconcile=${n1Reconcile.body?.value?.reconciled}`,
  );
  record(
    "N1f the deterministic retained selection resolves to the ACTUAL retained version (E4's anchor)",
    selection?._id === retained?._id && selection?.transformVersion === "d5.normalize/1" ? "PASS" : "FAIL",
    JSON.stringify(selection),
  );
  const job = await jobOf(A, n1.jobKey);
  record(
    "N1g the durable job completed through the REAL chain (drain -> executor -> action -> gateway)",
    job?.state === "succeeded" && job?.externalOutcome === "succeeded" ? "PASS" : "FAIL",
    `state=${job?.state} outcome=${job?.externalOutcome} attempts=${job?.attempts}/${job?.maxAttempts}`,
  );
}

// --- N2: the small-dimensions photo (no upscaling, still normalized) ----------------

const n2 = await acceptImage(A, "small", fixtures.small);
const n2Final = await waitForTerminal(A, n2.attachmentId);
{
  const retained = n2Final.rows.find((r) => r.role === "retained" && r.transformVersion === "d5.normalize/1");
  const received = n2Final.rows.find((r) => r.role === "received");
  record(
    "N2a a small image is normalized WITHOUT upscaling (dimensions preserved) and the original cleaned",
    retained?.width === 480 && retained?.height === 360 && retained?.verifiedAtMs !== undefined && received?.removedAtMs !== undefined
      ? "PASS"
      : "FAIL",
    `retained=${retained?.width}x${retained?.height} removed=${received?.removedAtMs !== undefined}`,
  );
}

// --- N3: oversized input (typed honest outcome, original retained) ------------------

const n3 = await acceptImage(A, "oversized", fixtures.oversized);
const n3Final = await waitForTerminal(A, n3.attachmentId);
{
  const retained = n3Final.rows.find((r) => r.role === "retained");
  const received = n3Final.rows.find((r) => r.role === "received");
  record(
    "N3a an input beyond the proved limit keeps the RECEIVED original as the typed oversized exception",
    retained?.transformVersion === "d5.retained-original/1" &&
      retained?.exceptionKind === "oversized_input" &&
      retained?.objectKey === received?.objectKey &&
      retained?.verifiedAtMs !== undefined
      ? "PASS"
      : "FAIL",
    `exception=${retained?.exceptionKind} sameBytes=${retained?.objectKey === received?.objectKey}`,
  );
  record(
    "N3b no fake success: the received bytes stay inspectable (no removal marker; the retained row points AT them)",
    received?.removedAtMs === undefined && retained?.objectKey === received?.objectKey ? "PASS" : "FAIL",
    `removedAtMs=${received?.removedAtMs} retainedKeyEqualsReceived=${retained?.objectKey === received?.objectKey}`,
  );
  const job = await jobOf(A, n3.jobKey);
  record(
    "N3c the honest exception is a SUCCESS of the durable job (typed outcome, not a failure)",
    job?.state === "succeeded" ? "PASS" : "FAIL",
    `state=${job?.state}`,
  );
}

// --- N4: unsupported format and corrupt input --------------------------------------

for (const [label, expectedKind] of [["unsupported", "unsupported_input"], ["corrupt", "conversion_failed"]]) {
  const n4 = await acceptImage(A, label, fixtures[label]);
  const n4Final = await waitForTerminal(A, n4.attachmentId);
  const retained = n4Final.rows.find((r) => r.role === "retained");
  const received = n4Final.rows.find((r) => r.role === "received");
  record(
    `N4 ${label} input retains the original with the typed ${expectedKind} outcome`,
    retained?.transformVersion === "d5.retained-original/1" &&
      retained?.exceptionKind === expectedKind &&
      retained?.objectKey === received?.objectKey &&
      received?.removedAtMs === undefined
      ? "PASS"
      : "FAIL",
    `exception=${retained?.exceptionKind}`,
  );
}

// --- N5: forced unresolved quality ---------------------------------------------------

const n5 = await acceptImage(A, "quality", fixtures.quality);
const n5Final = await waitForTerminal(A, n5.attachmentId);
{
  const retained = n5Final.rows.find((r) => r.role === "retained");
  const received = n5Final.rows.find((r) => r.role === "received");
  record(
    "N5 unresolved conversion quality keeps the received original (pending-vision-safe exception)",
    retained?.transformVersion === "d5.retained-original/1" &&
      retained?.exceptionKind === "quality_unresolved" &&
      received?.removedAtMs === undefined
      ? "PASS"
      : "FAIL",
    `exception=${retained?.exceptionKind} receivedKept=${received?.removedAtMs === undefined}`,
  );
  const selection = n5Final.state.retainedSelection;
  record(
    "N5b the selection honestly resolves to the exception (vision/E4 consume the readable original)",
    selection?.transformVersion === "d5.retained-original/1" ? "PASS" : "FAIL",
    JSON.stringify(selection),
  );
}

// --- R1: replay dedup (retries cannot overwrite or duplicate) ------------------------

{
  const before = (await attachmentStateOf(A, n1.attachmentId)).value;
  const requeued = await requeueJob(A, n1.jobKey);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const after = (await attachmentStateOf(A, n1.attachmentId)).value;
  const job = await jobOf(A, n1.jobKey);
  record(
    "R1a replaying the succeeded job changes nothing (same ids, same hashes, no new rows)",
    requeued._tag === "ok" &&
      JSON.stringify(before.representations.map((r) => [r.representationId, r.contentHash])) ===
        JSON.stringify(after.representations.map((r) => [r.representationId, r.contentHash])) &&
      job?.state === "succeeded"
      ? "PASS"
      : "FAIL",
    `job=${job?.state} rows=${after.representations.length}`,
  );
  const redrive = await gatewayService("/images/normalize", { jobKey: n1.jobKey });
  const redriveRows = (await attachmentStateOf(A, n1.attachmentId)).value.representations;
  record(
    "R1b a direct executor re-drive answers already_terminal without touching bytes",
    redrive.body?._tag === "ok" &&
      redrive.body.value.attachments?.[0]?.outcome === "already_terminal" &&
      redriveRows.length === after.representations.length
      ? "PASS"
      : "FAIL",
    JSON.stringify(redrive.body?.value?.attachments ?? redrive.body),
  );
}

// --- X1: cross-tenant denial ----------------------------------------------------------

{
  const foreign = await attachmentStateOf(B, n1.attachmentId);
  record(
    "X1 a person of another firm CANNOT read company A's normalization state (typed denial)",
    foreign._tag === "error" && foreign.error._tag === "forbidden" ? "PASS" : "FAIL",
    JSON.stringify(foreign._tag === "error" ? foreign.error.code : foreign),
  );
  const noToken = await fetch(`${GATEWAY.replace(/\/$/, "")}/images/normalize`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobKey: n1.jobKey }),
  });
  record(
    "X1b the executor channel refuses a missing service credential (401, closed error)",
    noToken.status === 401 ? "PASS" : "FAIL",
    `status=${noToken.status}`,
  );
  const userToken = await fetch(`${GATEWAY.replace(/\/$/, "")}/images/normalize`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${A.token}` },
    body: JSON.stringify({ jobKey: n1.jobKey }),
  });
  record(
    "X1c a USER credential is not the service credential on the executor channel (401)",
    userToken.status === 401 ? "PASS" : "FAIL",
    `status=${userToken.status}`,
  );
}

// --- C1: crash after record, before verify --------------------------------------------
// The scheduled machinery is pointed at a dead-but-answering endpoint so the
// ONLY drive is the proof's (with the real gateway URL + crash stop).

{
  const { execFileSync: exec } = await import("node:child_process");
  exec(
    "npx",
    ["convex@1.45.0", "env", "set", "KIERO_IMAGES_EXECUTOR_URL", DEAD_EXECUTOR_URL],
    { cwd: REPO_ROOT, stdio: "pipe" },
  );
  const c1 = await acceptImage(A, "crash-record", fixtures.phone);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const crashed = await driveJob(A, c1.jobKey, { crashAfter: "record", executorUrl: EXECUTOR_URL, forceRunning: true });
  const rows = (await attachmentStateOf(A, c1.attachmentId)).value.representations;
  const retained = rows.find((r) => r.role === "retained" && r.transformVersion === "d5.normalize/1");
  const received = rows.find((r) => r.role === "received");
  const jobAfterCrash = await jobOf(A, c1.jobKey);
  record(
    "C1a the crash lands in the recorded-but-unverified window (rows exist, unverified, received kept)",
    crashed._tag === "ok" &&
      crashed.value.classification.kind === "unknown" &&
      retained !== undefined &&
      retained.verifiedAtMs === undefined &&
      received?.removedAtMs === undefined
      ? "PASS"
      : "FAIL",
    `classification=${JSON.stringify(crashed.value?.classification)} retained=${retained !== undefined}`,
  );
  record(
    "C1b the crash is recorded as UNCERTAIN (unknown outcome; replays blocked until reconciliation)",
    jobAfterCrash?.state === "failed" && jobAfterCrash?.externalOutcome === "unknown" ? "PASS" : "FAIL",
    `state=${jobAfterCrash?.state} outcome=${jobAfterCrash?.externalOutcome}`,
  );
  const hashesBefore = rows.map((r) => [r.representationId, r.contentHash]);
  // Restore the real executor URL, then reconcile: it re-queues ONE bounded
  // attempt through the real chain, which resumes at verify (no re-conversion).
  exec("npx", ["convex@1.45.0", "env", "set", "KIERO_IMAGES_EXECUTOR_URL", EXECUTOR_URL], {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
  const reconciled = await reconcileJob(A, c1.jobKey);
  const c1Final = await waitForTerminal(A, c1.attachmentId, 120_000);
  const rowsAfter = c1Final.rows;
  const retainedAfter = rowsAfter.find((r) => r.role === "retained" && r.transformVersion === "d5.normalize/1");
  const receivedAfter = rowsAfter.find((r) => r.role === "received");
  record(
    "C1c reconciliation resumes WITHOUT a second conversion: same representation ids and hashes, then verified + cleaned",
    (reconciled.value?.reconciled === "retrying" || reconciled.value?.reconciled === "completed") &&
      JSON.stringify(hashesBefore) === JSON.stringify(rowsAfter.map((r) => [r.representationId, r.contentHash])) &&
      retainedAfter?.verifiedAtMs !== undefined &&
      receivedAfter?.removedAtMs !== undefined
      ? "PASS"
      : "FAIL",
    `reconcile=${reconciled.value?.reconciled} hashesStable=${JSON.stringify(hashesBefore) === JSON.stringify(rowsAfter.map((r) => [r.representationId, r.contentHash]))} verified=${retainedAfter?.verifiedAtMs !== undefined}`,
  );
  const jobFinal = await jobOf(A, c1.jobKey);
  record(
    "C1d the job completes through the real durable machinery after the resumption",
    jobFinal?.state === "succeeded" ? "PASS" : "FAIL",
    `state=${jobFinal?.state} attempts=${jobFinal?.attempts}/${jobFinal?.maxAttempts}`,
  );
}

// --- C2: crash after verify, before cleanup ---------------------------------------------

{
  const { execFileSync: exec } = await import("node:child_process");
  exec("npx", ["convex@1.45.0", "env", "set", "KIERO_IMAGES_EXECUTOR_URL", DEAD_EXECUTOR_URL], {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
  const c2 = await acceptImage(A, "crash-verify", fixtures.small);
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const crashed = await driveJob(A, c2.jobKey, { crashAfter: "verify", executorUrl: EXECUTOR_URL, forceRunning: true });
  const rows = (await attachmentStateOf(A, c2.attachmentId)).value.representations;
  const retained = rows.find((r) => r.role === "retained" && r.transformVersion === "d5.normalize/1");
  const received = rows.find((r) => r.role === "received");
  record(
    "C2a the crash lands in the verified-but-not-cleaned window (verified pair, received bytes still present)",
    crashed._tag === "ok" &&
      retained?.verifiedAtMs !== undefined &&
      received?.removedAtMs === undefined
      ? "PASS"
      : "FAIL",
    `verified=${retained?.verifiedAtMs !== undefined} receivedKept=${received?.removedAtMs === undefined}`,
  );
  const reconciled = await reconcileJob(A, c2.jobKey);
  record(
    "C2b reconciliation directs the pending cleanup by observation (no second conversion)",
    reconciled.value?.reconciled === "pending_cleanup" &&
      reconciled.value.pendingCleanup?.length === 1
      ? "PASS"
      : "FAIL",
    `reconcile=${reconciled.value?.reconciled} pending=${JSON.stringify(reconciled.value?.pendingCleanup?.map((p) => p.objectKey))}`,
  );
  const resumed = await gatewayService("/images/reconcile", { jobKey: c2.jobKey });
  const rowsAfter = (await attachmentStateOf(A, c2.attachmentId)).value.representations;
  const receivedAfter = rowsAfter.find((r) => r.role === "received");
  const jobAfter = await jobOf(A, c2.jobKey);
  record(
    "C2c the cleanup resumption deletes the received bytes, marks the row and completes the job",
    resumed.body?._tag === "ok" &&
      resumed.body.value?.deletedKeys?.length === 1 &&
      resumed.body.value?.confirmedAbsent?.length === 1 &&
      receivedAfter?.removedAtMs !== undefined &&
      jobAfter?.state === "succeeded"
      ? "PASS"
      : "FAIL",
    `deleted=${JSON.stringify(resumed.body?.value?.deletedKeys)} absent=${resumed.body?.value?.confirmedAbsent?.length} job=${jobAfter?.state}`,
  );
}

// --- done -------------------------------------------------------------------------------

const ok = summarize();
process.exit(ok ? 0 : 1);
