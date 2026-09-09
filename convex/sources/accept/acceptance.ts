/**
 * Text-source acceptance: the D1 transaction body plus its pure decisions.
 *
 * The transaction (protocol step 3 of the source processing protocol) runs
 * inside ONE Convex mutation: reference checks and current authorization
 * happen first, then the immutable source, its project links, the initial
 * processing run, the text extraction, the canonical `sources.sourceAccepted`
 * event and the durable `processing.extract_fragments` registration commit
 * together through the A3 transactional publication primitives. If anything
 * aborts — a thrown validation, a crash, a conflict — nothing commits, so an
 * accepted source can never exist without its durable processing
 * registration (no accepted orphan), and durable work can never exist
 * without the accepted source (no orphan work).
 *
 * The text of a source is its own extraction: the author's words need no
 * model, so acceptance records the `text` extraction version (provider
 * `kiero`, model `author-text`) and the initial analysis run it belongs to.
 * E3 owns executing the registered extract/analyze work with real pipeline
 * versions; D1 only registers it.
 *
 * Pure decisions (fingerprint, replay/conflict, state derivation for reads)
 * live here so tests/d1 can prove them without a deployment.
 */

import { Schema } from "effect";
import {
  errorResult,
  okResult,
  sourcesOperations,
  type ResultEnvelope,
} from "@kiero/contracts";
import {
  forbiddenError,
  idempotencyConflictError,
  validationError,
  type RequestContext,
} from "@kiero/runtime";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { publishEvent, registerDurableJob } from "../../platform/publish";

/** The contract entry this transaction implements (decode/typed authority). */
export const acceptSourceEntry = sourcesOperations["sources.acceptSource"];

/** The input type of `sources.acceptSource` as decoded by the checked path. */
export type AcceptSourceInput = Schema.Schema.Type<typeof acceptSourceEntry.input>;

/** The result type of `sources.acceptSource` (the saved receipt). */
export type AcceptSourceReceipt = Schema.Schema.Type<typeof acceptSourceEntry.result>;

/** Retry policy of the registered durable processing (bounded, like A3). */
export const PROCESSING_RETRY_POLICY = { maxAttempts: 3, backoffBaseMs: 2_000 } as const;

/** Version labels of the D1 acceptance registration (E3 pins its own later). */
export const ACCEPTANCE_PIPELINE_VERSION = "d1.accept/1";
export const TEXT_EXTRACTION_PIPELINE_VERSION = "d1.text/1";
export const TEXT_EXTRACTION_PROVIDER = "kiero";
export const TEXT_EXTRACTION_MODEL = "author-text";

/** Bounded acceptance: at most this many distinct project hints per source. */
export const MAX_PROJECT_HINTS = 32;
/** Bounded acceptance: at most this many characters of author text. */
export const MAX_AUTHOR_TEXT_LENGTH = 100_000;
/** A send intention further than this ahead of server time is implausible. */
export const MAX_FUTURE_SENT_AT_SKEW_MS = 24 * 60 * 60 * 1_000;

// ---------------------------------------------------------------------------
// Pure validation and identity decisions (unit-tested in tests/d1).
// ---------------------------------------------------------------------------

/** A deeper validation outcome: a value or a sanitized validation error. */
export type Validated<T> = { readonly ok: true; readonly value: T } | {
  readonly ok: false;
  readonly code: string;
};

/** Author text must carry words: whitespace-only text is not a message. */
export function validateAuthorText(text: string): Validated<string> {
  if (text.trim().length === 0) {
    return { ok: false, code: "author_text_empty" };
  }
  if (text.length > MAX_AUTHOR_TEXT_LENGTH) {
    return { ok: false, code: "author_text_too_long" };
  }
  return { ok: true, value: text };
}

/**
 * Parses the intended send time. Absent means "now" (server time); a
 * malformed or implausibly future-dated value is rejected. Past values stay
 * acceptable: offline drafts are sent with their original intention.
 */
export function resolveSentAtMs(
  intendedSentAtIso: string | undefined,
  nowMs: number,
): Validated<number> {
  if (intendedSentAtIso === undefined) {
    return { ok: true, value: nowMs };
  }
  const parsed = Date.parse(intendedSentAtIso);
  if (Number.isNaN(parsed)) {
    return { ok: false, code: "sent_at_not_parseable" };
  }
  if (parsed - nowMs > MAX_FUTURE_SENT_AT_SKEW_MS) {
    return { ok: false, code: "sent_at_implausibly_future" };
  }
  return { ok: true, value: parsed };
}

/** The zone snapshot must be a real IANA zone; it anchors relative language. */
export function validateTimezoneSnapshot(zone: string): Validated<string> {
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return { ok: true, value: zone };
  } catch {
    return { ok: false, code: "timezone_snapshot_invalid" };
  }
}

/** Order-preserving de-duplication of project hints (repeated pills are noise). */
export function dedupeProjectHints(projectIds: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const projectId of projectIds) {
    if (!seen.has(projectId)) {
      seen.add(projectId);
      out.push(projectId);
    }
  }
  return out;
}

/** The logical payload of one acceptance: what a retry must repeat exactly. */
export interface AcceptancePayloadShape {
  readonly authorText: string;
  readonly intendedSentAtIso?: string | undefined;
  readonly timezoneSnapshot: string;
  readonly projectHints: readonly string[];
}

/** Canonical JSON of the logical payload (key order is part of the identity). */
export function canonicalAcceptancePayload(payload: AcceptancePayloadShape): string {
  const normalized = {
    authorText: payload.authorText,
    intendedSentAtIso: payload.intendedSentAtIso ?? null,
    timezoneSnapshot: payload.timezoneSnapshot,
    projectHints: [...payload.projectHints].sort(),
  };
  return JSON.stringify(normalized);
}

/** SHA-256 hex digest of the canonical payload (the replay identity check). */
export async function acceptanceFingerprintHex(
  payload: AcceptancePayloadShape,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonicalAcceptancePayload(payload)),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The existing source row a replay decision needs (or null). */
export interface ExistingAcceptance {
  /** Undefined only for rows this code cannot produce (fails closed). */
  readonly acceptanceFingerprint: string | undefined;
}

/** The three-way replay decision over one logical-source key. */
export type AcceptanceDecision =
  | { readonly decision: "insert" }
  | { readonly decision: "replay" }
  | { readonly decision: "conflict" };

/**
 * One client-generated logical-source key maps to exactly one source: a
 * replay with the SAME fingerprint returns the original receipt (preserving
 * the first send intention), a DIFFERENT fingerprint is a typed idempotency
 * conflict. Never a second source, never an edit. An existing row without a
 * fingerprint (not producible by this code) fails closed as a conflict too.
 */
export function decideAcceptance(
  existing: ExistingAcceptance | null,
  fingerprint: string,
): AcceptanceDecision {
  if (existing === null) {
    return { decision: "insert" };
  }
  if (existing.acceptanceFingerprint === undefined) {
    return { decision: "conflict" };
  }
  return existing.acceptanceFingerprint === fingerprint
    ? { decision: "replay" }
    : { decision: "conflict" };
}

// ---------------------------------------------------------------------------
// The acceptance transaction (runs inside ONE Convex mutation).
// ---------------------------------------------------------------------------

/** Slim row fields the transaction needs from a source row. */
interface SourceRow {
  readonly _id: Id<"sources">;
  readonly fullyAcceptedAtMs: number;
}

function receiptOf(row: SourceRow): AcceptSourceReceipt {
  return Schema.decodeUnknownSync(acceptSourceEntry.result)({
    sourceId: row._id,
    fullyAcceptedAtMs: row.fullyAcceptedAtMs,
  });
}

/**
 * Performs the whole acceptance in the caller's mutation transaction:
 * references and tenant checks, the immutable source, project links, the
 * initial processing run with its text extraction, the canonical event and
 * the durable processing registration — atomically.
 */
export async function performAcceptance(
  tx: MutationCtx,
  context: RequestContext,
  input: AcceptSourceInput,
  idempotencyKey: string | undefined,
): Promise<ResultEnvelope> {
  const nowMs = Date.now();
  const companyId = tx.db.normalizeId("companies", context.actor.companyId);
  if (companyId === null) {
    return errorResult(validationError("company_scope_unresolved"));
  }
  const authorUserId = tx.db.normalizeId("users", context.actor.userId);
  if (authorUserId === null) {
    return errorResult(validationError("actor_user_unresolved"));
  }

  // --- deeper input validation (the contract schema passed these shapes) ---
  const authorText = validateAuthorText(input.authorText);
  if (!authorText.ok) {
    return errorResult(validationError(authorText.code));
  }
  const sentAt = resolveSentAtMs(input.intendedSentAtIso, nowMs);
  if (!sentAt.ok) {
    return errorResult(validationError(sentAt.code));
  }
  const timezone = validateTimezoneSnapshot(input.timezoneSnapshot);
  if (!timezone.ok) {
    return errorResult(validationError(timezone.code));
  }
  const hints = dedupeProjectHints(input.projectHints);
  if (hints.length > MAX_PROJECT_HINTS) {
    return errorResult(validationError("too_many_project_hints"));
  }

  // --- reference checks: the upload must be the author's company's draft ---
  const uploadId = tx.db.normalizeId("uploads", input.uploadId);
  if (uploadId === null) {
    return errorResult(validationError("upload_reference_not_found"));
  }
  const upload = await tx.db.get(uploadId);
  if (upload === null) {
    return errorResult(validationError("upload_reference_not_found"));
  }
  if (upload.companyId !== companyId) {
    return errorResult(forbiddenError("tenant_scope_mismatch", "uploads"));
  }
  if (upload.userId !== authorUserId) {
    return errorResult(forbiddenError("upload_not_owned_by_actor", "uploads"));
  }
  if (upload.stage !== "draft" && upload.stage !== "finalized") {
    return errorResult(validationError("upload_stage_not_acceptable"));
  }
  // D1 accepts text sources only: attachments (D2) must not be present yet.
  const attachments = await tx.db
    .query("attachments")
    .withIndex("by_upload", (q) => q.eq("uploadId", uploadId))
    .first();
  if (attachments !== null) {
    return errorResult(validationError("attachments_not_supported_yet"));
  }

  // --- replay decision over the logical-source key -------------------------
  const payload = {
    authorText: input.authorText,
    intendedSentAtIso: input.intendedSentAtIso,
    timezoneSnapshot: input.timezoneSnapshot,
    projectHints: hints,
  };
  const fingerprint = await acceptanceFingerprintHex(payload);
  if (idempotencyKey !== undefined) {
    const existingRow = await tx.db
      .query("sources")
      .withIndex("by_company_acceptance_key", (q) =>
        q.eq("companyId", companyId).eq("acceptanceKey", idempotencyKey),
      )
      .first();
    if (existingRow !== null) {
      const decision = decideAcceptance(
        { acceptanceFingerprint: existingRow.acceptanceFingerprint },
        fingerprint,
      );
      if (decision.decision === "conflict") {
        return errorResult(idempotencyConflictError(idempotencyKey));
      }
      // Same logical source: the original receipt, first send intention intact.
      return okResult(receiptOf(existingRow));
    }
  }

  // --- project hint reference checks (context, never authority) ------------
  const linkedProjects: Id<"projects">[] = [];
  for (const hint of hints) {
    const projectId = tx.db.normalizeId("projects", hint);
    if (projectId === null) {
      return errorResult(validationError("project_reference_not_found"));
    }
    const project = await tx.db.get(projectId);
    if (project === null) {
      return errorResult(validationError("project_reference_not_found"));
    }
    if (project.companyId !== companyId) {
      return errorResult(forbiddenError("tenant_scope_mismatch", "projects"));
    }
    linkedProjects.push(projectId);
  }

  // --- the atomic commit: source + links + run + extraction + event + job --
  const sourceId = await tx.db.insert("sources", {
    companyId,
    authorUserId,
    authorText: input.authorText,
    sentAtMs: sentAt.value,
    sentAtTimezone: timezone.value,
    fullyAcceptedAtMs: nowMs,
    lifecycle: "active",
    ...(idempotencyKey === undefined ? {} : { acceptanceKey: idempotencyKey }),
    acceptanceFingerprint: fingerprint,
  });
  for (const projectId of linkedProjects) {
    await tx.db.insert("sourceProjectLinks", {
      sourceId,
      projectId,
      assignedByUserId: authorUserId,
      assignedAtMs: nowMs,
      sentAtMs: sentAt.value,
    });
  }
  const processingRunId = await tx.db.insert("processingRuns", {
    companyId,
    sourceId,
    kind: "initial_analysis",
    pipelineVersion: ACCEPTANCE_PIPELINE_VERSION,
    promptVersion: "none",
    schemaVersion: "none",
    modelConfigurationVersion: "none",
    state: "running",
    startedAtMs: nowMs,
  });
  const extractionId = await tx.db.insert("extractions", {
    sourceId,
    kind: "text",
    pipelineVersion: TEXT_EXTRACTION_PIPELINE_VERSION,
    model: TEXT_EXTRACTION_MODEL,
    provider: TEXT_EXTRACTION_PROVIDER,
    processingRunId,
    createdAtMs: nowMs,
  });
  // One dedup identity for the event, the job and the logical acceptance:
  // publisher-side registration and any later drain edge collapse together.
  const dedupKey =
    idempotencyKey === undefined
      ? `sources.acceptSource:${companyId}:${sourceId}`
      : `sources.acceptSource:${companyId}:${idempotencyKey}`;
  await publishEvent(tx, {
    companyId: context.actor.companyId,
    eventName: "sources.sourceAccepted",
    payload: { sourceId, attachmentIds: [] },
    dedupKey,
  });
  await registerDurableJob(tx, {
    kind: "processing.extract_fragments",
    input: { sourceId, extractionId },
    companyId: context.actor.companyId,
    sourceId,
    processingRunId,
    policy: PROCESSING_RETRY_POLICY,
    dedupKey,
  });
  return okResult(receiptOf({ _id: sourceId, fullyAcceptedAtMs: nowMs }));
}
