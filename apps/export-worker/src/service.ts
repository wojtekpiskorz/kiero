/**
 * The export worker's protocol (I3): `/exports/build`, `/exports/cleanup`
 * and `/healthz`, one handler for every surface (the D6 three-surfaces
 * discipline; the worker entry calls exactly this).
 *
 * AUTHORIZATION: the ONLY callers are this deployment's Convex functions
 * (the scheduled build action and the cleanup action), authenticated by the
 * shared service credential (bearer compared in constant time; the value
 * arrives as a Worker secret, never from the repo). No user credential is
 * accepted here and no user data is read by name: the snapshot, the object
 * keys and the export row all come from the Convex build channel, which
 * itself only acts on work an administrator requested through the checked
 * command surface.
 *
 * CONSISTENCY: the whole company snapshot is read by ONE Convex query (its
 * transaction is the snapshot); the media manifest's ledger etag and byte
 * length are verified against the live object BEFORE one byte is copied
 * (fail closed on drift or a missing object: no partial archive is ever
 * published, the multipart upload is aborted).
 *
 * ESCAPING/PATHS: the HTML index escapes every user string and every media
 * path is built from server-owned ids (render.ts, protocol.ts); the ZIP
 * writer emits ASCII paths only.
 */

import {
  archiveObjectKey,
  type CompanySnapshot,
  type SnapshotMediaItem,
} from "../../../convex/operations/exports/protocol.ts";
import { ZipWriter } from "./zip.ts";
import { collectionJsonFiles, manifestJson, renderIndexHtml } from "./render.ts";
import {
  MultipartSink,
  deleteArchiveObject,
  openMediaObject,
  storeConfigured,
  storeOf,
  type ExportStoreEnv,
} from "./r2.ts";
import { errorEnvelope, okEnvelope, type WireEnvelope } from "./envelope.ts";

/** The full env the worker routes need (one store env; names only). */
export type ExportWorkerEnv = ExportStoreEnv;

// --- bearer guard -------------------------------------------------------------

/** Constant-time equality of two strings of any length. */
function tokensEqual(a: string, b: string): boolean {
  const max = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < max; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function bearerOk(request: Request, env: ExportWorkerEnv): boolean {
  const expected = env.KIERO_SERVICE_TOKEN ?? "";
  if (expected === "") {
    return false;
  }
  const header = request.headers.get("authorization") ?? "";
  const presented = header.startsWith("Bearer ") ? header.slice(7) : "";
  return presented !== "" && tokensEqual(presented, expected);
}

// --- Convex bridge client (the ONE transport for backend calls) --------------

async function bridge(
  env: ExportWorkerEnv,
  op: "snapshot" | "publish" | "fail" | "cleanupDone",
  body: Record<string, unknown>,
): Promise<WireEnvelope> {
  const site = env.CONVEX_SITE_URL;
  const token = env.KIERO_SERVICE_TOKEN;
  if (site === undefined || site === "" || token === undefined || token === "") {
    return errorEnvelope("unavailable", "bridge_not_configured", "Brak połączenia z backendem.", false);
  }
  let response: Response;
  try {
    response = await fetch(`${site.replace(/\/$/, "")}/operations/exports/bridge`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ op, ...body }),
    });
  } catch {
    return errorEnvelope("unavailable", "backend_unreachable", "Backend nieosiągalny.", true);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return errorEnvelope("unavailable", "backend_response_invalid", "Odpowiedź backendu nieczytelna.", true);
  }
  if (payload !== null && typeof payload === "object" && "_tag" in payload) {
    return payload as WireEnvelope;
  }
  return errorEnvelope("unavailable", "backend_response_invalid", "Odpowiedź backendu nieczytelna.", true);
}

// --- media streaming ----------------------------------------------------------

/** Streams one media object into the ZIP, verifying the ledger record first. */
async function copyMediaItem(
  env: ExportWorkerEnv,
  item: SnapshotMediaItem,
  zip: ZipWriter,
): Promise<WireEnvelope> {
  const object = await openMediaObject(env, item.objectKey);
  if (object === null) {
    return errorEnvelope("not_found", "media_object_missing", "Brak pliku mediów.");
  }
  if (object.size !== item.bytes || object.etag !== item.etag) {
    return errorEnvelope("unavailable", "media_ledger_inconsistent", "Niespójność pliku mediów.", false);
  }
  zip.beginFile(item.archivePath, Date.now());
  const reader = object.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    if (value !== undefined) {
      zip.append(value);
    }
  }
  zip.endFile();
  return okEnvelope({ copied: item.archivePath });
}

// --- the routes ----------------------------------------------------------------

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

/** POST /exports/build {jobKey, exportId, buildToken} (service bearer). */
export async function handleBuild(request: Request, env: ExportWorkerEnv): Promise<Response> {
  if (!bearerOk(request, env)) {
    return jsonResponse(401, errorEnvelope("unauthenticated", "service_credential_invalid", "Brak ważnego poświadczenia usługi."));
  }
  let body: { jobKey?: unknown; exportId?: unknown; buildToken?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse(400, errorEnvelope("validation", "build_body_not_json", "Nieprawidłowe żądanie."));
  }
  const exportId = typeof body.exportId === "string" ? body.exportId : "";
  const buildToken = typeof body.buildToken === "string" ? body.buildToken : "";
  if (exportId === "" || buildToken === "") {
    return jsonResponse(400, errorEnvelope("validation", "build_reference_malformed", "Nieprawidłowe żądanie."));
  }
  const failBuild = (kind: string, retryable: boolean): WireEnvelope =>
    errorEnvelope(retryable ? "unavailable" : "unsupported", kind, undefined, retryable ? true : undefined);

  // 1. the snapshot (ONE Convex transaction; refuses stale tokens).
  const snapshotAnswer = await bridge(env, "snapshot", { exportId, buildToken });
  if (snapshotAnswer._tag === "error" && snapshotAnswer.error !== undefined) {
    // A stale token or a terminal row is a definite, non-retryable answer.
    const error = snapshotAnswer.error;
    const retryable = error._tag === "unavailable" && error.retryable === true;
    return jsonResponse(200, failBuild(`snapshot_${error._tag}:${error.code}`, retryable));
  }
  if (snapshotAnswer._tag !== "ok" || snapshotAnswer.value === undefined) {
    return jsonResponse(200, failBuild("snapshot_answer_invalid", false));
  }
  const snapshot = snapshotAnswer.value as CompanySnapshot;
  const companyId = snapshot.company.companyId;
  const objectKey = archiveObjectKey(companyId, exportId, buildToken);
  const store = storeOf(env);
  if (!store.ok) {
    // The media-bucket S3 token is a pending owner action: refuse closed
    // instead of fabricating an archive.
    return jsonResponse(200, failBuild("archive_store_not_configured", false));
  }

  // 2. assemble: JSON, HTML index, then every retained media object.
  const sink = new MultipartSink(store.config, objectKey);
  await sink.begin();
  let zip: ZipWriter | null = new ZipWriter({ push: (chunk) => sink.push(chunk) });
  try {
    zip.addFile("manifest.json", manifestJson(snapshot), snapshot.snapshotAtMs);
    zip.addFile("index.html", renderIndexHtml(snapshot), snapshot.snapshotAtMs);
    for (const file of collectionJsonFiles(snapshot)) {
      zip.addFile(file.path, file.contents, snapshot.snapshotAtMs);
    }
    for (const item of snapshot.media) {
      const copied = await copyMediaItem(env, item, zip);
      if (copied._tag === "error") {
        await sink.abort();
        zip = null;
        const failure = copied.error as { _tag: string; code: string };
        return jsonResponse(200, failBuild(`${failure._tag}:${failure.code}`, false));
      }
    }
    zip.finish();
    zip = null;
  } catch (cause) {
    await sink.abort();
    const message = cause instanceof Error ? cause.message : "unknown";
    const bounded = message.includes("bound");
    return jsonResponse(200, failBuild(bounded ? "archive_bound_exceeded" : "archive_assembly_failed", false));
  }

  // 3. complete the object, then publish exactly once.
  let completed: { etag: string; bytes: number };
  try {
    completed = await sink.complete();
  } catch {
    await sink.abort();
    return jsonResponse(200, failBuild("archive_upload_failed", true));
  }
  const publishAnswer = await bridge(env, "publish", {
    exportId,
    buildToken,
    objectKey,
    etag: completed.etag,
    bytes: completed.bytes,
    snapshotAtMs: snapshot.snapshotAtMs,
    schemaVersion: snapshot.schemaVersion,
    sourceIds: snapshot.sources.map((s) => s.id as string),
    mediaCount: snapshot.media.length,
  });
  if (publishAnswer._tag === "error" && publishAnswer.error !== undefined) {
    // The row moved on (stale token, invalidated by a purge during the
    // build): this object was never linked; remove it.
    await deleteArchiveObject(env, objectKey);
    const invalidation = publishAnswer.error.code.includes("invalidated");
    if (invalidation) {
      return jsonResponse(200, okEnvelope({ published: false, invalidated: true }));
    }
    return jsonResponse(200, failBuild(`publish_${publishAnswer.error.code}`, false));
  }
  if (publishAnswer._tag !== "ok" || publishAnswer.value === undefined) {
    await deleteArchiveObject(env, objectKey);
    return jsonResponse(200, failBuild("publish_answer_invalid", false));
  }
  const value = publishAnswer.value as { published?: boolean; invalidated?: boolean };
  if (value.invalidated === true) {
    await deleteArchiveObject(env, objectKey);
    return jsonResponse(200, okEnvelope({ published: false, invalidated: true }));
  }
  return jsonResponse(200, okEnvelope({ published: true, bytes: completed.bytes }));
}

/** POST /exports/cleanup {exportId, objectKey} (service bearer). */
export async function handleCleanup(request: Request, env: ExportWorkerEnv): Promise<Response> {
  if (!bearerOk(request, env)) {
    return jsonResponse(401, errorEnvelope("unauthenticated", "service_credential_invalid", "Brak ważnego poświadczenia usługi."));
  }
  let body: { exportId?: unknown; objectKey?: unknown };
  try {
    body = (await request.json()) as typeof body;
  } catch {
    return jsonResponse(400, errorEnvelope("validation", "cleanup_body_not_json", "Nieprawidłowe żądanie."));
  }
  const exportId = typeof body.exportId === "string" ? body.exportId : "";
  const objectKey = typeof body.objectKey === "string" ? body.objectKey : "";
  if (exportId === "" || objectKey === "" || !objectKey.startsWith("exports/")) {
    return jsonResponse(400, errorEnvelope("validation", "cleanup_reference_malformed", "Nieprawidłowe żądanie."));
  }
  const deleted = await deleteArchiveObject(env, objectKey);
  if (!deleted) {
    return jsonResponse(200, errorEnvelope("unavailable", "archive_delete_failed", "Usuwanie nie powiodło się.", true));
  }
  const done = await bridge(env, "cleanupDone", { exportId });
  if (done._tag === "error" && done.error !== undefined) {
    return jsonResponse(200, done);
  }
  return jsonResponse(200, okEnvelope({ cleaned: true }));
}

/** GET /healthz (no container wake-up, no bucket touch). */
export function handleHealth(env: ExportWorkerEnv): Response {
  return jsonResponse(200, {
    ok: true,
    service: "kiero-export-worker",
    environment: env.ENVIRONMENT ?? "dev",
    bridgeConfigured: (env.CONVEX_SITE_URL ?? "") !== "" && (env.KIERO_SERVICE_TOKEN ?? "") !== "",
    storeConfigured: storeConfigured(env),
  });
}
