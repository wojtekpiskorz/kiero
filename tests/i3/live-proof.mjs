/**
 * I3 live proofs against the REAL leased dev deployment
 * (wojtek-piskorz-jr:kiero-dev-core:dev/i3) through the REAL deployed
 * gateway Worker (kiero-dev-gateway-i3), the REAL deployed EU export
 * Container (kiero-dev-export-worker) and the REAL EU media R2 bucket
 * (kiero-dev-media, S3 token).
 *
 * STATUS (2026-09-11): NOT RUN — BLOCKED before any deployment happened:
 * `npx convex@1.45.0 deployment create wojtek-piskorz-jr:kiero-dev-core:dev/i3
 * --type dev` answers `DeploymentQuotaReached` (team quota 40/40 full). Per
 * the lane's resource rule no other cloud resource was created either. The
 * script is the repeatable procedure for the moment a slot frees (owner
 * action: free one dev deployment slot, then run the Setup block verbatim;
 * the R2 media S3 token must also be injected, as in D6).
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
import { createHash } from "node:crypto";

const DEPLOYMENT = process.env.KIERO_I3_CONVEX;
if (DEPLOYMENT === undefined) {
  throw new Error("KIERO_I3_CONVEX (dev/i3 instance name) is required");
}
const CLIENT_URL = `https://${DEPLOYMENT}.eu-west-1.convex.cloud`;
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
  return results.every((r) => r.outcome === "PASS");
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
const accepted = await A.client.action("sources/uploads/probe:probeAcceptSourceAsCaller", {
  envelope: {
    operation: "sources.acceptSource",
    input: {
      authorText: `Wycena ${HOSTILE} 45 000 zł netto`,
      timezoneSnapshot: "Europe/Warsaw",
      projectHints: [],
    },
    expectedRevisions: [],
    idempotencyKey: `idem_${globalThis.crypto.randomUUID()}`,
  },
});
if (accepted?._tag !== "ok") {
  throw new Error(`text source acceptance failed: ${JSON.stringify(accepted)}`);
}
const sourceA = accepted.value.sourceId;

// E1: request, single in-flight build, available with declared snapshot.
const requested = await A.client.action("operations/exports/probe:probeRequestExportAsCaller", {});
record(
  "E1a the administrator's checked request starts the export (requested)",
  requested?._tag === "ok" ? "PASS" : "FAIL",
  JSON.stringify(requested?.error ?? {}),
);
const exportId = requested?.value?.exportId;
const again = await A.client.action("operations/exports/probe:probeRequestExportAsCaller", {});
record(
  "E1b a second request while in flight REUSES the same export (no parallel builds)",
  again?.value?.exportId === exportId ? "PASS" : "FAIL",
  `${exportId} vs ${again?.value?.exportId}`,
);

// E3: concurrent write DURING the build must stay outside the archive.
const duringBuild = await A.client.action("sources/uploads/probe:probeAcceptSourceAsCaller", {
  envelope: {
    operation: "sources.acceptSource",
    input: {
      authorText: `Wiadomość wysłana PODCZAS budowania ${RUN}`,
      timezoneSnapshot: "Europe/Warsaw",
      projectHints: [],
    },
    expectedRevisions: [],
    idempotencyKey: `idem_${globalThis.crypto.randomUUID()}`,
  },
});
const concurrentSourceId = duringBuild?._tag === "ok" ? duringBuild.value.sourceId : null;

const availableRow = await waitForState(A, exportId, ["available"]);
record(
  "E1c the build reaches available with a declared snapshot time and counts",
  availableRow?.state === "available" && availableRow.snapshotAtMs !== null,
  `state=${availableRow?.state} snapshotAt=${availableRow?.snapshotAtMs} sources=${availableRow?.sourceCount}`,
);
if (availableRow?.state !== "available") {
  process.exit(summarize() ? 0 : 1);
}
record(
  "E1d the concurrent write is NOT part of the archive (mixed-revision guard)",
  availableRow.sourceCount === 1,
  `sourceCount=${availableRow.sourceCount} concurrent=${concurrentSourceId}`,
);

// E2: the authorized full download and the range matrix.
const full = await download(A, exportId);
const fullBytes = Buffer.from(await full.arrayBuffer());
const sha = (b) => createHash("sha256").update(b).digest("hex");
record(
  "E2a the full download answers 200 with the full length and etag, as an attachment",
  full.status === 200 &&
    Number(full.headers.get("content-length")) === fullBytes.length &&
    full.headers.get("etag") === `"${full.headers.get("etag")?.replace(/"/g, "")}"` &&
    (full.headers.get("content-disposition") ?? "").startsWith("attachment; filename=") &&
    full.headers.get("cache-control") === "no-store",
  `status=${full.status} len=${fullBytes.length} bytes=${fullBytes.length}`,
);
record(
  "E2b the archive is a parseable ZIP whose first entry is the manifest",
  fullBytes[0] === 0x50 && fullBytes[1] === 0x4b,
  `magic=${fullBytes.subarray(0, 2).toString("hex")}`,
);
const entries = readStoredEntries(fullBytes);
const manifest = JSON.parse((entries.get("manifest.json") ?? Buffer.from("{}")).toString("utf8"));
record(
  "E2c the manifest declares the snapshot time and schema version of the row",
  manifest.snapshotAtMs === availableRow.snapshotAtMs && typeof manifest.schemaVersion === "string",
  `manifest@${manifest.snapshotAtMs} row@${availableRow.snapshotAtMs}`,
);
record(
  "E2d no concurrent-revision content leaked into any entry",
  ![...entries.values()].some((data) => data.includes("PODCZAS")),
  `entries=${entries.size}`,
);
{
  const ranged = await download(A, exportId, { range: "bytes=0-99" });
  const slice = Buffer.from(await ranged.arrayBuffer());
  record(
    "E2e a range request answers 206 with the exact first 100 bytes",
    ranged.status === 206 && slice.equals(fullBytes.subarray(0, 100)) && ranged.headers.get("content-range") === `bytes 0-99/${fullBytes.length}`,
    `status=${ranged.status} cr=${ranged.headers.get("content-range")}`,
  );
  const unsatisfiable = await download(A, exportId, { range: `bytes=${fullBytes.length}-` });
  record(
    "E2f an unsatisfiable range answers 416 with the asterisk content-range",
    unsatisfiable.status === 416 && unsatisfiable.headers.get("content-range") === `bytes */${fullBytes.length}`,
    `status=${unsatisfiable.status}`,
  );
  const etag = full.headers.get("etag");
  const notModified = await download(A, exportId, { "if-none-match": etag ?? "" });
  record("E2g If-None-Match with the current etag answers 304", notModified.status === 304, `status=${notModified.status}`);
}

// E4: hostile content stays escaped text; paths are id-built.
{
  const html = (entries.get("index.html") ?? Buffer.from("")).toString("utf8");
  record(
    "E4a hostile message text renders escaped with no script markup",
    !/<script/i.test(html) && html.includes("&lt;script&gt;") && html.includes("alert(&#39;x&#39;)"),
    `escaped=${html.includes("&lt;script&gt;")}`,
  );
  const names = [...entries.keys()];
  record(
    "E4b every archive path is traversal-free and separator-free",
    names.every((name) => !name.includes("..") && !name.startsWith("/") && !name.includes("\\")),
    `names=${names.slice(0, 4).join(",")}`,
  );
}

// E5: the authorization matrix.
{
  const missing = await download(A, "k57doesnotexist0000000000zzzz");
  const foreign = await download(B, exportId);
  record(
    "E5a another company's administrator gets EXACTLY the nonexistent refusal",
    foreign.status === 404 && (await foreign.text()) === (await missing.text()),
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
    joined?._tag === "ok" && memberTry.status === 403,
    `joined=${joined?._tag} status=${memberTry.status}`,
  );
  record(
    "E5c a member cannot START an export either",
    (await C.client.action("operations/exports/probe:probeRequestExportAsCaller", {}))?._tag === "error",
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
    before.status === 403 && revoked?._tag === "ok" && after.status === 401,
    `before=${before.status} revoke=${revoked?._tag} after=${after.status}`,
  );
}

// E7: expiry + byte cleanup (the guarded clock fixture, the real sweep path).
{
  const forced = await A.client.action("operations/exports/probe:probeForceExpireAction", { exportId });
  const refused = await download(A, exportId);
  let cleanedRow = (await state(A))?.value?.exports?.find((r) => r.exportId === exportId) ?? null;
  for (let attempt = 0; attempt < 10 && cleanedRow !== null && cleanedRow.cleanedAtMs === null; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    cleanedRow = (await state(A))?.value?.exports?.find((r) => r.exportId === exportId) ?? null;
  }
  record(
    "E7 past the window the download refuses and the bytes are cleaned (status stays auditable)",
    forced?._tag === "ok" && refused.status === 404 && cleanedRow?.state === "expired" && cleanedRow?.cleanedAtMs !== null,
    `forced=${forced?._tag} download=${refused.status} state=${cleanedRow?.state} cleanedAt=${cleanedRow?.cleanedAtMs}`,
  );
}

// E8: a linked purge invalidates access immediately (second export).
{
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
      before.status === 200 && purged?._tag === "ok" && immediately.status === 404,
      `before=${before.status} purge=${purged?._tag} after=${immediately.status}`,
    );
    const eager = await A.client.action("operations/exports/probe:probeInvalidateForSourceAction", { sourceId: sourceA });
    const marked = (await state(A))?.value?.exports?.find((r) => r.exportId === secondId);
    record(
      "E8b the eager seam (I4's consumer edge) marks the row invalidated",
      eager?._tag === "ok" && marked?.state === "invalidated",
      `state=${marked?.state} reason=${marked?.invalidationReason}`,
    );
  }
}

process.exit(summarize() ? 0 : 1);
