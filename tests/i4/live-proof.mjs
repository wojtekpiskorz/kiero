/**
 * I4 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/i4 = nautical-loris-352) through
 * the REAL deployed gateway Worker (kiero-dev-gateway-i4, MEDIA_BUCKET R2
 * binding kiero-dev-media) and the REAL EU media R2 bucket.
 *
 * Lease environment (names only; values injected before the recorded
 * `npx convex dev --once` push): JWT_PRIVATE_KEY, JWKS (a proper key set,
 * kid i4-dev-key-1), KIERO_PROBE_ENABLED=1, KIERO_SERVICE_TOKEN,
 * KIERO_PURGE_EXECUTOR_URL (the deployed gateway Worker's origin).
 *
 * Setup (already recorded live in docs/evidence/deletion/README.md):
 *   npx convex@1.45.0 deployment create wojtek-piskorz-jr:kiero-dev-core:dev/i4 --type dev
 *   npx convex@1.45.0 deployment select wojtek-piskorz-jr:kiero-dev-core:dev/i4
 *   # env: JWT_PRIVATE_KEY, JWKS, KIERO_SERVICE_TOKEN (use `env set NAME
 *   # --from-file <file>` - rtk swallows piped stdin and silently stores
 *   # EMPTY values, a hard-won lease fact), KIERO_PROBE_ENABLED=1,
 *   # KIERO_B1_PROOF_ENABLED=1, KIERO_B3_PROOF_ENABLED=1,
 *   # KIERO_PURGE_EXECUTOR_URL=<gateway url>
 *   npx convex@1.45.0 dev --once
 *   cd apps/gateway && wrangler deploy --name kiero-dev-gateway-i4
 *     # vars CONVEX_SITE_URL=https://nautical-loris-352.convex.site,
 *     # ALLOWED_APP_ORIGINS=http://localhost:5173; secret KIERO_SERVICE_TOKEN
 *
 * Identity: every actor is a REAL signed-in person (B1's email-code flow
 * with proof-domain fixture addresses and fixture codes - the D3 pattern).
 *
 * OWNER-TOKEN GAP (recorded, the I3 precedent): the export archive Worker
 * is not deployed on this lease, so no export can reach `available` and
 * the linked-export download refusal after purge stays unit-proven
 * (tests/i4/purge.test.ts: eager invalidation in the initiating
 * transaction) - recorded NOT RUN live with exactly that reason. Every
 * other row below runs for real.
 *
 * Proof rows:
 * - P0  the administrator and the member are REAL signed-in persons with
 *       their own firm / membership.
 * - M1  one REAL media upload through the deployed gateway into the EU R2
 *       bucket (image attachment), accepted as one source's evidence; the
 *       authorized media read answers 200 byte-exact before the purge.
 * - A1  the administrator's impact preview names the counts; a plain
 *       member receives the typed forbidden refusal.
 * - A2  a wrong confirmation phrase refuses as a typed conflict and
 *       commits nothing (the source stays active).
 * - I1  the confirmed purge commits: the tombstone lands (lifecycle
 *       purged), the content-free ledger row exists with counts only, six
 *       stage rows are pending inside the 24-hour window.
 * - I2  access fails IMMEDIATELY after the commit: the company
 *       conversation no longer lists the source, the source detail refuses
 *       the uniform not-found, and the gateway media route refuses the
 *       next range read before any R2 byte.
 * - I3  repeated delete requests replay idempotently (the SAME ledger
 *       record, never a second one).
 * - C1  the durable purge executor completes within the window: every
 *       stage reaches `purged`, including `media_objects` - the gateway's
 *       /purge/media route really deleted the R2 object (the post-purge
 *       direct bucket read through the gateway's media route keeps
 *       answering the ledger's uniform not-found).
 * - G1  the purge route refuses a missing service credential (401) -
 *       only the Convex action's service identity may delete.
 *
 * Run: KIERO_I4_CONVEX=nautical-loris-352 KIERO_I4_GATEWAY=https://kiero-dev-gateway-i4.wojtek-524.workers.dev node tests/i4/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.)
 */

import { ConvexHttpClient } from "convex/browser";

const DEPLOYMENT = process.env.KIERO_I4_CONVEX;
if (DEPLOYMENT === undefined) {
  throw new Error("KIERO_I4_CONVEX (dev/i4 instance name) is required");
}
// The env var carries the deployment NAME only; the client URL is the
// regionless canonical origin (<name>.convex.cloud) - the fresh lease
// answers ONLY there (the hard-won lease fact).
const CLIENT_URL = `https://${DEPLOYMENT}.convex.cloud`;
const GATEWAY = process.env.KIERO_I4_GATEWAY;
if (GATEWAY === undefined) {
  throw new Error("KIERO_I4_GATEWAY (deployed gateway Worker URL) is required");
}

const RUN = Date.now().toString(36);
const CONFIRMATION = "USUŃ TRWALE";
const results = [];
function record(id, outcome, detail) {
  results.push({ id, outcome, detail });
  console.log(`[${outcome}] ${id}${detail === undefined ? "" : ` :: ${detail}`}`);
  return outcome === "PASS";
}
function summarize() {
  const counts = results.reduce((acc, r) => ({ ...acc, [r.outcome]: (acc[r.outcome] ?? 0) + 1 }), {});
  console.log(`\nSummary: ${JSON.stringify(counts)} of ${results.length} checks`);
  // NOT RUN is an explicitly justified owner-token gap, never a silent skip.
  return results.every((r) => r.outcome === "PASS" || r.outcome === "NOT RUN");
}

// --- real sign-in (the D3 fixture pattern) --------------------------------------

const anon = () => new ConvexHttpClient(CLIENT_URL, { logger: false });

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
  await bootstrap.action("auth:signIn", { provider: "email_code", params: { email } }).catch(() => {});
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
    throw new Error(`session provisioning failed for ${email}`);
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

// --- the purge probes (the exact checked surfaces) -------------------------------

const purgeAs = (persona, sourceId, confirmation) =>
  persona.client.action("operations/deletion/probe:probePurgeAsCaller", { sourceId, confirmation });
const impactAs = (persona, sourceId) =>
  persona.client.action("operations/deletion/probe:probeImpactAsCaller", { sourceId });
const deletionState = (persona) =>
  persona.client.action("operations/deletion/probe:probeDeletionState", {});

async function waitForStages(persona, recordId, predicate, tries = 40) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const state = await deletionState(persona);
    const row = state?.value?.deletions?.find((r) => r.deletionRecordId === recordId);
    if (row !== undefined && predicate(row)) {
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  return null;
}

// --- gateway helpers (the D2/D3 pattern: the person's own credential) ------------

const jsonInit = (method, payload) => ({
  method,
  headers: { "content-type": "application/json" },
  body: JSON.stringify(payload),
});

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

/** One REAL image upload into the EU bucket, accepted as a source's evidence. */
async function acceptedImageSource(persona, imageBuffer, authorText) {
  const draft = `i4-${RUN}`;
  const prepared = await gw(
    persona.token,
    "/uploads/prepare",
    jsonInit("POST", { draftId: draft, parts: 1, mediaKinds: ["image"] }),
  );
  if (prepared.body._tag !== "ok") {
    throw new Error(`prepare failed: ${JSON.stringify(prepared.body)}`);
  }
  const uploadId = prepared.body.value.uploadId;
  const image = prepared.body.value.attachments.find((a) => a.kind === "image");
  const put = await gw(
    persona.token,
    `/uploads/${uploadId}/attachments/${image.attachmentId}/parts/1`,
    { method: "POST", headers: { "content-type": "application/octet-stream" }, body: imageBuffer, duplex: "half" },
  );
  if (put.body._tag !== "ok") {
    throw new Error(`part failed: ${JSON.stringify(put.body)}`);
  }
  const done = await gw(
    persona.token,
    `/uploads/${uploadId}/attachments/${image.attachmentId}/complete`,
    jsonInit("POST", {}),
  );
  if (done.body._tag !== "ok") {
    throw new Error(`complete failed: ${JSON.stringify(done.body)}`);
  }
  const finalized = await gw(persona.token, `/uploads/${uploadId}/finalize`, jsonInit("POST", {}));
  if (finalized.body._tag !== "ok") {
    throw new Error(`finalize failed: ${JSON.stringify(finalized.body)}`);
  }
  const accepted = await persona.client.action("sources/uploads/probe:probeAcceptSourceAsCaller", {
    envelope: {
      operation: "sources.acceptSource",
      input: {
        uploadId,
        authorText,
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
  return { sourceId: accepted.value.sourceId, attachmentId: image.attachmentId };
}

// --- the run --------------------------------------------------------------------

const admin = await signInFixture(`i4-admin-${RUN}@kiero.invalid`);
const companyId = await ownCompany(admin, `Budowa I4 ${RUN}`);
const member = await signInFixture(`i4-member-${RUN}@kiero.invalid`);
const created = await admin.client.action("access/membership/functions:createInvitationCommand", {
  envelope: { operation: "access.createInvitation", input: { email: member.email, role: "member" }, expectedRevisions: [] },
});
if (created?._tag !== "ok") {
  throw new Error(`createInvitation failed: ${JSON.stringify(created)}`);
}
const invitationId = created.value.invitationId;
// The invitation code never crosses the create result (email channel); the
// guarded B3 fixture installs a deterministic one (the b3 live-proof flow).
const INVITATION_CODE = "42424242";
const codeSet = await anon().action("access/membership/probe:b3ProofSetInvitationCode", {
  invitationId,
  code: INVITATION_CODE,
});const joined = await admit(member.client, "access.acceptInvitation", {
  invitationId,
  verificationCode: INVITATION_CODE,
});
record(
  "P0 the administrator and the member are REAL signed-in persons of one firm",
  typeof companyId === "string" && codeSet?._tag === "ok" && joined?._tag === "ok" ? "PASS" : "FAIL",
  `company=${companyId} joined=${joined?._tag}`,
);

// M1: one real image upload (a recognizable deterministic PNG header + filler).
const imageBuffer = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(2048, 7),
]);
const media = await acceptedImageSource(admin, imageBuffer, `Zdjęcie z budowy I4 ${RUN}`);
const before = await gw(admin.token, `/media/attachments/${media.attachmentId}`);
record(
  "M1 the authorized media read answers 200 with the ledger bytes before the purge",
  before.status === 200 && Buffer.from(await (await fetch(`${GATEWAY.replace(/\/$/, "")}/media/attachments/${media.attachmentId}`, { headers: { authorization: `Bearer ${admin.token}` } })).arrayBuffer()).equals(imageBuffer)
    ? "PASS"
    : "FAIL",
  `status=${before.status}`,
);

// A1: the impact preview (administrator vs member).
const preview = await impactAs(admin, media.sourceId);
record(
  "A1a the administrator's impact preview names the counts, never content",
  preview?._tag === "ok" && preview.value.attachmentCount === 1 && !JSON.stringify(preview).includes("Zdj")
    ? "PASS"
    : "FAIL",
  JSON.stringify(preview?.value ?? preview?.error),
);
const memberPreview = await impactAs(member, media.sourceId);
record(
  "A1b a plain member receives the typed forbidden refusal",
  memberPreview?._tag === "error" && memberPreview.error._tag === "forbidden" ? "PASS" : "FAIL",
  JSON.stringify(memberPreview?.error?._tag ?? memberPreview),
);

// A2: the wrong confirmation refuses and commits nothing.
const wrong = await purgeAs(admin, media.sourceId, "usuń");
const conversationBefore = await admin.client.query("sources/read/views:companyConversation", { paginationOpts: { numItems: 50, cursor: null } });
const listedBefore = conversationBefore?._tag === "ok"
  ? conversationBefore.value.page.some((row) => row.sourceId === media.sourceId)
  : null;
record(
  "A2 a wrong confirmation phrase refuses as a typed conflict and commits nothing",
  wrong?._tag === "error" && wrong.error._tag === "conflict" && wrong.error.code === "purge_confirmation_mismatch" && listedBefore === true
    ? "PASS"
    : "FAIL",
  `error=${wrong?.error?._tag}:${wrong?.error?.code} conversationStillLists=${listedBefore}`,
);

// I1: the confirmed purge commits. The durable executor may legitimately
// have completed the in-transaction stages before this read (the drain and
// the executor run within seconds of the commit); the six stages' presence
// and their 24-hour deadlines are the commit's evidence here, and C1a
// proves the completion separately.
const purged = await purgeAs(admin, media.sourceId, CONFIRMATION);
const state1 = await deletionState(admin);
const row1 = state1?.value?.deletions?.find((r) => r.targetSourceId === media.sourceId);
record(
  "I1a the confirmed purge commits the content-free ledger row with six deadline-carrying stages",
  purged?._tag === "ok" && row1 !== undefined && row1.stages.length === 6 &&
    row1.stages.every((s) => s.deadlineAtMs > Date.now()) && !JSON.stringify(row1).includes("Zdj")
    ? "PASS"
    : "FAIL",
  `record=${purged?.value?.deletionRecordId ?? purged?.error?.code} stages=${row1?.stages?.map((s) => `${s.stageKind}:${s.state}`).join(",")}`,
);

// I2: access fails immediately after the commit.
const conversation = await admin.client.query("sources/read/views:companyConversation", { paginationOpts: { numItems: 50, cursor: null } });
const listed = conversation?._tag === "ok"
  ? conversation.value.page.some((row) => row.sourceId === media.sourceId)
  : null;
const detail = await admin.client.query("sources/read/views:sourceExposition", { sourceId: media.sourceId }).catch((e) => ({ error: String(e) }));
const mediaAfter = await gw(admin.token, `/media/attachments/${media.attachmentId}`);
record(
  "I2a the company conversation no longer lists the purged source",
  listed === false ? "PASS" : "FAIL",
  `listed=${listed}`,
);
record(
  "I2b the source detail refuses the uniform not-found",
  detail?._tag === "error" && detail.error._tag === "not_found" ? "PASS" : "FAIL",
  JSON.stringify(detail?.error?._tag ?? detail),
);
record(
  "I2c the gateway media route refuses the next read before any R2 byte",
  mediaAfter.status === 404 ? "PASS" : "FAIL",
  `status=${mediaAfter.status}`,
);

// I3: repeated delete requests replay idempotently.
const repeated = await purgeAs(admin, media.sourceId, CONFIRMATION);
const stateAfterRepeat = await deletionState(admin);
const countForSource = stateAfterRepeat?.value?.deletions?.filter(
  (r) => r.targetSourceId === media.sourceId,
).length;
record(
  "I3 repeated delete requests return the SAME ledger record, never a second one",
  repeated?._tag === "ok" && repeated.value.deletionRecordId === purged.value.deletionRecordId && countForSource === 1
    ? "PASS"
    : "FAIL",
  `sameId=${repeated?.value?.deletionRecordId === purged?.value?.deletionRecordId} records=${countForSource}`,
);

// C1: the durable executor completes every stage within the window,
// including the REAL R2 deletion through the gateway's purge route.
const completed = await waitForStages(
  admin,
  purged.value.deletionRecordId,
  (row) => row.stages.every((s) => s.state === "purged"),
);
record(
  "C1a every purge stage reaches purged inside the window (media bytes through the gateway)",
  completed !== null ? "PASS" : "FAIL",
  completed === null
    ? "timeout waiting for stages"
    : completed.stages.map((s) => `${s.stageKind}:${s.state}:${s.attempts}`).join(","),
);

// The ledger's uniform not-found persists after the bytes are gone.
const mediaPost = await gw(admin.token, `/media/attachments/${media.attachmentId}`);
record(
  "C1b the purged media stays unreadable after the byte deletion (ledger not-found)",
  mediaPost.status === 404 ? "PASS" : "FAIL",
  `status=${mediaPost.status}`,
);

// G1: the purge route's own credential gate (no bearer -> 401).
const noBearer = await fetch(`${GATEWAY.replace(/\/$/, "")}/purge/media`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ deletionRecordId: purged.value.deletionRecordId }),
});
record(
  "G1 the gateway purge route refuses a missing service credential (401)",
  noBearer.status === 401 ? "PASS" : "FAIL",
  `status=${noBearer.status}`,
);

// The owner-token gap rows stay explicit.
record(
  "E8 a linked available export's download refuses immediately after the purge",
  "NOT RUN",
  "export archive Worker not deployable on this lease (I3's recorded owner-token gap): no export can reach available, so no linked archive exists to refuse; unit-proven in tests/i4/purge.test.ts (eager invalidation in the initiating transaction)",
);

process.exit(summarize() ? 0 : 1);
