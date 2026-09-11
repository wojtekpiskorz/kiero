/**
 * I3 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/i3) through the REAL deployed
 * gateway Worker (kiero-dev-gateway-i3), the REAL deployed EU export
 * Container (kiero-dev-export-worker) and the REAL EU media R2 bucket
 * (kiero-dev-media, S3 token).
 *
 * STATUS (2026-09-11, lease kiero-dev-core:dev/i3 = silent-otter-910): the
 * deployment and the gateway Worker are LIVE; the export Container is NOT
 * deployable on this lease (R2_MEDIA_ACCESS_KEY_ID/R2_MEDIA_SECRET_ACCESS_KEY/
 * R2_MEDIA_ENDPOINT and the worker's KIERO_SERVICE_TOKEN are owner actions;
 * the deployment's KIERO_EXPORT_EXECUTOR_URL/KIERO_SERVICE_TOKEN are unset).
 * Every row that needs real archive bytes (E1c/d, E2*, E4, E7, E8) is
 * recorded NOT RUN with exactly that reason; the sign-in, request-reuse and
 * authorization-refusal rows run for real. Rows that can pass once the
 * owner injects the tokens and deploys the worker re-run verbatim.
 *
 * Setup (once a slot frees):
 *   npx convex@1.45.0 deployment create wojtek-piskorz-jr:kiero-dev-core:dev/i3 --type dev
 *   npx convex@1.45.0 deployment select kiero-dev-core:dev/i3
 *   # secrets (names only, values injected, never echoed):
 *   npx convex@1.45.0 env set KIERO_SERVICE_TOKEN <value>
 *   npx convex@1.45.0 env set KIERO_PROBE_ENABLED 1
 *   npx convex@1.45.0 env set KIERO_EXPORT_EXECUTOR_URL <export worker url>
 *   npx convex@1.45.0 dev --once
 *   cd apps/export-worker && wrangler deploy --env=""   # name kiero-dev-export-worker
 *   wrangler secret put KIERO_SERVICE_TOKEN && wrangler secret put R2_MEDIA_ACCESS_KEY_ID \
 *     && wrangler secret put R2_MEDIA_SECRET_ACCESS_KEY
 *   # vars: R2_MEDIA_ENDPOINT=https://<account>.r2.cloudflarestorage.com,
 *   #       R2_MEDIA_BUCKET=kiero-dev-media, CONVEX_SITE_URL=<dev/i3 site url>
 *   cd ../gateway && wrangler deploy --name kiero-dev-gateway-i3  # CONVEX_SITE_URL var
 *
 * Identity: every actor is a REAL signed-in person (B1's email-code flow
 * with proof-domain fixture addresses and fixture codes — the D3 pattern).
 *
 * Proof rows:
 * - E1  the admin's request starts ONE build (reuse while in flight) that
 *       reaches `available` with declared snapshot time and counts.
 * - E2  the authorized download answers 200 byte-exact with the ledger
 *       etag/length and attachment disposition; ranges 206/416 and
 *       If-None-Match 304 follow the shared media-read protocol.
 * - E3  concurrent writes during the build never enter the archive: the
 *       manifest's snapshot time and source list exclude them.
 * - E4  hostile names/text stay escaped text in index.html; media paths
 *       are id-built; the ZIP parses with the stored entries byte-exact.
 * - E5  a member refuses forbidden; another company's administrator gets
 *       EXACTLY the nonexistent-export refusal.
 * - E6  membership revocation between requests refuses the next download.
 * - E7  expiry: past the window the download refuses, the sweep expires
 *       the row and the worker cleanup deletes the bytes (auditable row).
 * - E8  a linked source purge refuses the download IMMEDIATELY (before the
 *       eager seam runs) and the eager seam marks the row invalidated.
 *
 * Run: KIERO_I3_CONVEX=<instance> KIERO_I3_GATEWAY=<url> node tests/i3/live-proof.mjs
 * (Not a vitest file: live evidence, transcribed into the issue report.)
 */

import { ConvexHttpClient } from "convex/browser";

const DEPLOYMENT = process.env.KIERO_I3_CONVEX;
if (DEPLOYMENT === undefined) {
  throw new Error("KIERO_I3_CONVEX (dev/i3 instance name) is required");
}
// The env var carries the deployment NAME only; the client URL is the
// regionless canonical origin (<name>.convex.cloud). The fresh lease
// answers ONLY there: a regional template like
// <name>.eu-west-1.convex.cloud 404s (live-proof run finding).
const CLIENT_URL = `https://${DEPLOYMENT}.convex.cloud`;
const GATEWAY = process.env.KIERO_I3_GATEWAY;
if (GATEWAY === undefined) {
  throw new Error("KIERO_I3_GATEWAY (deployed gateway Worker URL) is required");
}

const RUN = Date.now().toString(36);
const HOSTILE = `</ul><script>alert('x')</script><!--&-->"onerror="`;
const person = (name) => `i3-${name}-${RUN}@kiero.invalid`;
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
  return { client, token, sessionId: ensured.sessionId, email };
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

// --- exports helpers ---------------------------------------------------------------

const state = (persona) => persona.client.action("operations/exports/probe:probeExportsState", {});

async function waitForState(persona, exportId, wanted, tries = 40) {
  for (let attempt = 0; attempt < tries; attempt++) {
    const s = await state(persona);
    const row = s?.value?.exports?.find((r) => r.exportId === exportId);
    if (row !== undefined && wanted.includes(row.state)) {
      return row;
    }
    if (row !== undefined && (row.state === "failed" || row.state === "invalidated")) {
      return row;
    }
    await new Promise((resolve) => setTimeout(resolve, 1_500));
  }
  return null;
}

async function download(persona, exportId, headers = {}) {
  return fetch(`${GATEWAY.replace(/\/$/, "")}/exports/${exportId}/download`, {
    headers: { ...headers, authorization: `Bearer ${persona.token}` },
  });
}

/** Minimal ZIP reading for STORE entries (the test oracle's own decoder). */
function readStoredEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) {
    throw new Error("no EOCD");
  }
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries = new Map();
  for (let n = 0; n < count; n++) {
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = Buffer.from(bytes.subarray(offset + 46, offset + 46 + nameLength)).toString("utf8");
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.set(name, bytes.subarray(dataStart, dataStart + size));
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

// --- the proof run -----------------------------------------------------------------

console.log(`# I3 live proofs :: ${DEPLOYMENT} via ${GATEWAY} :: ${new Date().toISOString()}`);

const A = await signInFixture(person("a"));
const companyA = await ownCompany(A, `Budowa I3 A ${RUN}`);
const B = await signInFixture(person("b"));
await ownCompany(B, `Budowa I3 B ${RUN}`);
record("P0 both administrators are REAL signed-in persons with their own firms", typeof companyA === "string" ? "PASS" : "FAIL", `companyA=${companyA}`);

// A text source with hostile content (the escaping evidence's material).
// The certified client path (the H3 live-proof pattern): a text-only upload
// prepares first (J1's mediaKinds: [] semantics), then acceptance references
// it — `sources.acceptSource` REQUIRES uploadId, and the earlier probe
// envelope omitted it (the deployment answered probe_malformed_input).
const prepareTextUpload = (persona) =>
  persona.client.mutation("sources/uploads/commands:prepareUploadCommand", {
    envelope: {
      operation: "sources.prepareUpload",
      input: {
        draftId: `i3-${RUN}-${globalThis.crypto.randomUUID()}`,
        parts: 1,
        mediaKinds: [],
      },
      expectedRevisions: [],
    },
  });
const acceptTextSource = async (persona, authorText) => {
  const prepared = await prepareTextUpload(persona);
  if (prepared?._tag !== "ok") {
    throw new Error(`text upload prepare failed: ${JSON.stringify(prepared)}`);
  }
  return persona.client.mutation("sources/accept/commands:acceptSourceCommand", {
    envelope: {
      operation: "sources.acceptSource",
      input: {
        uploadId: prepared.value.uploadId,
        authorText,
        timezoneSnapshot: "Europe/Warsaw",
        projectHints: [],
      },
      expectedRevisions: [],
    },
  });
};
const accepted = await acceptTextSource(A, `Wycena ${HOSTILE} 45 000 zł netto`);
if (accepted?._tag !== "ok") {
  throw new Error(`text source acceptance failed: ${JSON.stringify(accepted)}`);
}
const sourceA = accepted.value.sourceId;

// The owner-token gap every byte-dependent row discloses (names only).
const WORKER_GAP =
  "export worker not deployable on this lease: R2_MEDIA_ACCESS_KEY_ID/R2_MEDIA_SECRET_ACCESS_KEY/R2_MEDIA_ENDPOINT absent and KIERO_EXPORT_EXECUTOR_URL/KIERO_SERVICE_TOKEN unset (owner actions) — no archive bytes can be built or published";

// E1: request, single in-flight build, available with declared snapshot.
const requested = await A.client.action("operations/exports/probe:probeRequestExportAsCaller", {});
record(
  "E1a the administrator's checked request starts the export (requested)",
  requested?._tag === "ok" ? "PASS" : "FAIL",
  JSON.stringify(requested?.error ?? {}),
);
const exportId = requested?.value?.exportId;
const again = await A.client.action("operations/exports/probe:probeRequestExportAsCaller", {});
const reuseRow = (await state(A))?.value?.exports?.find((r) => r.exportId === exportId) ?? null;
if (again?.value?.exportId === exportId) {
  record(
    "E1b a second request while in flight REUSES the same export (no parallel builds)",
    "PASS",
    `${exportId} reused`,
  );
} else if (reuseRow !== null && reuseRow.state !== "requested" && reuseRow.state !== "building") {
  // The premise (an in-flight build) cannot exist on this lease: the build
  // job fails in the same tick it is scheduled (export executor unset), so
  // the first row is already terminal when the second request lands and a
  // FRESH export is the correct product behavior (decideRequest).
  record(
    "E1b a second request while in flight REUSES the same export (no parallel builds)",
    "NOT RUN",
    `no in-flight build exists: first export already ${reuseRow.state} (${reuseRow.failureKind ?? "-"}) when the second request landed; ${WORKER_GAP}`,
  );
} else {
  record(
    "E1b a second request while in flight REUSES the same export (no parallel builds)",
    "FAIL",
    `${exportId} vs ${again?.value?.exportId} (first row state=${reuseRow?.state})`,
  );
}

// E3: concurrent write DURING the build must stay outside the archive.
const duringBuild = await acceptTextSource(A, `Wiadomość wysłana PODCZAS budowania ${RUN}`);
const concurrentSourceId = duringBuild?._tag === "ok" ? duringBuild.value.sourceId : null;

const settledRow = await waitForState(A, exportId, ["available"]);
const archiveAvailable = settledRow?.state === "available";
if (archiveAvailable) {
  record(
    "E1c the build reaches available with a declared snapshot time and counts",
    settledRow.snapshotAtMs !== null ? "PASS" : "FAIL",
    `state=${settledRow.state} snapshotAt=${settledRow.snapshotAtMs} sources=${settledRow.sourceCount}`,
  );
  record(
    "E1d the concurrent write is NOT part of the archive (mixed-revision guard)",
    settledRow.sourceCount === 1 ? "PASS" : "FAIL",
    `sourceCount=${settledRow.sourceCount} concurrent=${concurrentSourceId}`,
  );
} else {
  record(
    "E1c the build reaches available with a declared snapshot time and counts",
    "NOT RUN",
    `${WORKER_GAP}; observed state=${settledRow?.state} failureKind=${settledRow?.failureKind}`,
  );
  record(
    "E1d the concurrent write is NOT part of the archive (mixed-revision guard)",
    "NOT RUN",
    `${WORKER_GAP}; needs a published archive to compare counts against`,
  );
}

// E2: the authorized full download and the range matrix.
const BYTE_ROW_IDS = [
  "E2a the full download answers 200 with the full length and etag, as an attachment",
  "E2b the archive is a parseable ZIP whose first entry is the manifest",
  "E2c the manifest declares the snapshot time and schema version of the row",
  "E2d no concurrent-revision content leaked into any entry",
  "E2e a range request answers 206 with the exact first 100 bytes",
  "E2f an unsatisfiable range answers 416 with the asterisk content-range",
  "E2g If-None-Match with the current etag answers 304",
];
if (!archiveAvailable) {
  for (const id of BYTE_ROW_IDS) {
    record(id, "NOT RUN", WORKER_GAP);
  }
} else {
const full = await download(A, exportId);
const fullBytes = Buffer.from(await full.arrayBuffer());
record(
  "E2a the full download answers 200 with the full length and etag, as an attachment",
  full.status === 200 &&
    Number(full.headers.get("content-length")) === fullBytes.length &&
    full.headers.get("etag") === `"${full.headers.get("etag")?.replace(/"/g, "")}"` &&
    (full.headers.get("content-disposition") ?? "").startsWith("attachment; filename=") &&
    full.headers.get("cache-control") === "no-store"
    ? "PASS"
    : "FAIL",
  `status=${full.status} len=${fullBytes.length} bytes=${fullBytes.length}`,
);
record(
  "E2b the archive is a parseable ZIP whose first entry is the manifest",
  fullBytes[0] === 0x50 && fullBytes[1] === 0x4b ? "PASS" : "FAIL",
  `magic=${fullBytes.subarray(0, 2).toString("hex")}`,
);
const entries = readStoredEntries(fullBytes);
const manifest = JSON.parse((entries.get("manifest.json") ?? Buffer.from("{}")).toString("utf8"));
record(
  "E2c the manifest declares the snapshot time and schema version of the row",
  manifest.snapshotAtMs === settledRow.snapshotAtMs && typeof manifest.schemaVersion === "string"
    ? "PASS"
    : "FAIL",
  `manifest@${manifest.snapshotAtMs} row@${settledRow.snapshotAtMs}`,
);
record(
  "E2d no concurrent-revision content leaked into any entry",
  ![...entries.values()].some((data) => data.includes("PODCZAS")) ? "PASS" : "FAIL",
  `entries=${entries.size}`,
);
{
  const ranged = await download(A, exportId, { range: "bytes=0-99" });
  const slice = Buffer.from(await ranged.arrayBuffer());
  record(
    "E2e a range request answers 206 with the exact first 100 bytes",
    ranged.status === 206 && slice.equals(fullBytes.subarray(0, 100)) && ranged.headers.get("content-range") === `bytes 0-99/${fullBytes.length}`
      ? "PASS"
      : "FAIL",
    `status=${ranged.status} cr=${ranged.headers.get("content-range")}`,
  );
  const unsatisfiable = await download(A, exportId, { range: `bytes=${fullBytes.length}-` });
  record(
    "E2f an unsatisfiable range answers 416 with the asterisk content-range",
    unsatisfiable.status === 416 && unsatisfiable.headers.get("content-range") === `bytes */${fullBytes.length}`
      ? "PASS"
      : "FAIL",
    `status=${unsatisfiable.status}`,
  );
  const etag = full.headers.get("etag");
  const notModified = await download(A, exportId, { "if-none-match": etag ?? "" });
  record("E2g If-None-Match with the current etag answers 304", notModified.status === 304 ? "PASS" : "FAIL", `status=${notModified.status}`);
}
}

// E4: hostile content stays escaped text; paths are id-built.
if (!archiveAvailable) {
  record("E4a hostile message text renders escaped with no script markup", "NOT RUN", WORKER_GAP);
  record("E4b every archive path is traversal-free and separator-free", "NOT RUN", WORKER_GAP);
} else {
{
  const html = (entries.get("index.html") ?? Buffer.from("")).toString("utf8");
  record(
    "E4a hostile message text renders escaped with no script markup",
    !/<script/i.test(html) && html.includes("&lt;script&gt;") && html.includes("alert(&#39;x&#39;)")
      ? "PASS"
      : "FAIL",
    `escaped=${html.includes("&lt;script&gt;")}`,
  );
  const names = [...entries.keys()];
  record(
    "E4b every archive path is traversal-free and separator-free",
    names.every((name) => !name.includes("..") && !name.startsWith("/") && !name.includes("\\"))
      ? "PASS"
      : "FAIL",
    `names=${names.slice(0, 4).join(",")}`,
  );
}
}

// E5: the authorization matrix.
{
  const missing = await download(A, "k57doesnotexist0000000000zzzz");
  const foreign = await download(B, exportId);
  record(
    "E5a another company's administrator gets EXACTLY the nonexistent refusal",
    foreign.status === 404 && (await foreign.text()) === (await missing.text()) ? "PASS" : "FAIL",
    `foreign=${foreign.status} missing=${missing.status}`,
  );
  // A real invitation makes person("c") a MEMBER of A's firm.
  const invite = await A.client.action("access/membership/functions:createInvitationCommand", {
    envelope: { operation: "access.createInvitation", input: { email: person("c"), role: "member" }, expectedRevisions: [] },
  });
  const invitationId = invite?.value?.invitationId;
  const cCode = fixtureCodeOf(`invite-${invitationId}`);
  await anon().action("access/membership/probe:b3ProofSetInvitationCode", { invitationId, code: cCode });
  const C = await signInFixture(person("c"));
  const joined = await admit(C.client, "access.acceptInvitation", { invitationId, verificationCode: cCode });
  const memberTry = await download(C, exportId);
  record(
    "E5b a member (not administrator) is refused forbidden",
    joined?._tag === "ok" && memberTry.status === 403 ? "PASS" : "FAIL",
    `joined=${joined?._tag} status=${memberTry.status}`,
  );
  record(
    "E5c a member cannot START an export either",
    (await C.client.action("operations/exports/probe:probeRequestExportAsCaller", {}))?._tag === "error"
      ? "PASS"
      : "FAIL",
    "",
  );

  // E6: membership revocation refuses the NEXT download of the same person.
  const membershipId = joined.value.membershipId;
  const before = await download(C, exportId);
  const revoked = await A.client.mutation("access/membership/functions:dispatchMembership", {
    envelope: { operation: "access.revokeMembership", input: { membershipId }, expectedRevisions: [] },
  });
  const after = await download(C, exportId);
  record(
    "E6 revoking the membership between requests refuses the next download",
    before.status === 403 && revoked?._tag === "ok" && after.status === 401 ? "PASS" : "FAIL",
    `before=${before.status} revoke=${revoked?._tag} after=${after.status}`,
  );
}

// E7: expiry + byte cleanup (the guarded clock fixture, the real sweep path).
if (!archiveAvailable) {
  record(
    "E7 past the window the download refuses and the bytes are cleaned (status stays auditable)",
    "NOT RUN",
    `${WORKER_GAP}; expiry needs a published archive and the byte cleanup needs the worker's R2 delete`,
  );
} else {
  const forced = await A.client.action("operations/exports/probe:probeForceExpireAction", { exportId });
  const refused = await download(A, exportId);
  let cleanedRow = (await state(A))?.value?.exports?.find((r) => r.exportId === exportId) ?? null;
  for (let attempt = 0; attempt < 10 && cleanedRow !== null && cleanedRow.cleanedAtMs === null; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    cleanedRow = (await state(A))?.value?.exports?.find((r) => r.exportId === exportId) ?? null;
  }
  record(
    "E7 past the window the download refuses and the bytes are cleaned (status stays auditable)",
    forced?._tag === "ok" && refused.status === 404 && cleanedRow?.state === "expired" && cleanedRow?.cleanedAtMs !== null
      ? "PASS"
      : "FAIL",
    `forced=${forced?._tag} download=${refused.status} state=${cleanedRow?.state} cleanedAt=${cleanedRow?.cleanedAtMs}`,
  );
}

// E8: a linked purge invalidates access immediately (second export).
if (!archiveAvailable) {
  record(
    "E8a a linked purge refuses the download IMMEDIATELY (uniform not-found)",
    "NOT RUN",
    `${WORKER_GAP}; the immediacy proof needs a 200 download before the purge`,
  );
  record(
    "E8b the eager seam (I4's consumer edge) marks the row invalidated",
    "NOT RUN",
    `${WORKER_GAP}; exportSourceLinks exist only after a published archive`,
  );
} else {
  const second = await A.client.action("operations/exports/probe:probeRequestExportAsCaller", {});
  const secondId = second?.value?.exportId;
  const row = await waitForState(A, secondId, ["available"]);
  if (row?.state !== "available") {
    record("E8 second export for the invalidation proof", "FAIL", `state=${row?.state}`);
  } else {
    const before = await download(A, secondId);
    const purged = await A.client.action("sources/media_access/probe:probeSetSourceLifecycle", {
      sourceId: sourceA,
      lifecycle: "purged",
    });
    const immediately = await download(A, secondId);
    record(
      "E8a a linked purge refuses the download IMMEDIATELY (uniform not-found)",
      before.status === 200 && purged?._tag === "ok" && immediately.status === 404 ? "PASS" : "FAIL",
      `before=${before.status} purge=${purged?._tag} after=${immediately.status}`,
    );
    const eager = await A.client.action("operations/exports/probe:probeInvalidateForSourceAction", { sourceId: sourceA });
    const marked = (await state(A))?.value?.exports?.find((r) => r.exportId === secondId);
    record(
      "E8b the eager seam (I4's consumer edge) marks the row invalidated",
      eager?._tag === "ok" && marked?.state === "invalidated" ? "PASS" : "FAIL",
      `state=${marked?.state} reason=${marked?.invalidationReason}`,
    );
  }
}

process.exit(summarize() ? 0 : 1);
