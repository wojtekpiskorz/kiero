/**
 * Text-source acceptance: the D1 transaction body plus its pure decisions.
 *
 * The transaction (protocol step 3 of the source processing protocol) runs
 * inside ONE Convex mutation: reference checks and current authorization
 * happen first, then the immutable source, its project links, the initial
 * processing run, the text extraction, the canonical `sources.sourceAccepted`
 * event and the durable `processing.extract_fragments` registration commit
 * together through the A3 transactional publication primitives.
 *
 * ATOMICITY IS STRUCTURAL, NOT WRITE-ORDER-DEPENDENT. The checked dispatch
 * converts any handler throw into a sanitized `unavailable` envelope and a
 * Convex mutation that RETURNS commits what it wrote — so "throw somewhere
 * between the writes" would commit a partial acceptance (an accepted source
 * with no event/job). Therefore every step that can throw (registry entry
 * lookups, executor lookup, the payload/input/result schema decodes) runs in
 * `registrationTargets()` BEFORE the first insert; between the first insert
 * and the final registration only pre-validated writes and total decodes of
 * transaction-generated values (Convex ids, `Date.now()`, literal empty
 * arrays) remain. An abort at any point — validation return, pre-insert
 * throw, post-insert crash of the mutation itself — leaves nothing
 * committed: no accepted orphan, no orphan work.
 *
 * The text of a source is its own extraction: the author's words need no
 * model, so acceptance records the `text` extraction version (provider
 * `kiero`, model `author-text`) and the initial analysis run it belongs to.
 * E3 owns executing the registered extract/analyze work with real pipeline
 * versions; D1 only registers it.
 *
 * D2 amendment (attachment-bearing sources, flagged in the issue report):
 * the reference-check phase additionally runs the uploads lane's
 * all-attachments-durable gate (`verifyAttachmentsForAcceptance`) — the
 * upload must be finalized with its declaration fully materialized, every
 * attachment durably completed in R2 and every attachment carrying a
 * VERIFIED received representation — and the commit phase binds the
 * verified attachments (`attachments.sourceId`) and the ledger row
 * (`uploads.acceptedSourceId`) inside the SAME transaction, with the
 * verified ids in the `sources.sourceAccepted` payload. Text-only uploads
 * keep the exact D1 semantics.
 *
 * Pure decisions (fingerprint, replay/conflict, state derivation for reads)
 * live here so tests/d1 can prove them without a deployment.
 */

import { Schema } from "effect";
import {
  errorResult,
  events,
  executors,
  okResult,
  sourcesOperations,
  type ExecutorEntry,
  type ResultEnvelope,
} from "@kiero/contracts";
import {
  forbiddenError,
  idempotencyConflictError,
  unavailableError,
  validationError,
  type RequestContext,
} from "@kiero/runtime";
import type { MutationCtx } from "../../_generated/server";
import type { Id } from "../../_generated/dataModel";
import { publishEvent, registerDurableJob } from "../../platform/publish";
import { verifyAttachmentsForAcceptance } from "../uploads/acceptance_gate";

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

/**
 * A representative table id used only by the pre-insert decode templates: a
 * string of exactly the kind this transaction will later hold (Convex
 * document ids are strings to these branded schemas), so a template decode
 * proves the registry schema still accepts the shapes the transaction
 * produces — BEFORE anything is written.
 */
const REGISTRATION_TEMPLATE_ID = "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f";

/** The registry targets one acceptance must be able to register against. */
export interface RegistrationTargets {
  /** The composed registry entry for `sources.sourceAccepted`. */
  readonly eventEntry: (typeof events)["sources.sourceAccepted"];
  /** The composed executor that owns `processing.extract_fragments`. */
  readonly executor: ExecutorEntry;
}

/**
 * Resolves everything that can THROW during registration — registry entry
 * lookups, the executor lookup, and decode templates proving the event
 * payload, job input and receipt schemas still accept the exact shapes this
 * transaction produces. Callers MUST run this BEFORE the first insert: a
 * failure here is a sanitized `unavailable` envelope with nothing written,
 * while the same failure after the first insert would commit a partial
 * acceptance (the checked dispatch converts handler throws into returned
 * error envelopes, and a returning mutation commits its writes).
 *
 * Missing entries fail closed as typed errors; template mismatches (contract
 * drift) throw before any write and reach the caller sanitized.
 */
export function registrationTargets(): { ok: true; targets: RegistrationTargets } | {
  ok: false;
  error: ReturnType<typeof unavailableError>;
} {
  const eventEntry = events["sources.sourceAccepted"];
  if (eventEntry === undefined) {
    return { ok: false, error: unavailableError(true, "source_accepted_event_missing") };
  }
  const executor = executors.find((candidate) => candidate.jobKind === "processing.extract_fragments");
  if (executor === undefined) {
    return { ok: false, error: unavailableError(true, "processing_executor_missing") };
  }
  // Decode templates (throw here, before any write, on contract drift):
  // the event payload, the executor input and the receipt the transaction
  // will construct from transaction-generated values.
  Schema.decodeUnknownSync(eventEntry.payload)({
    sourceId: REGISTRATION_TEMPLATE_ID,
    attachmentIds: [],
  });
  Schema.decodeUnknownSync(executor.input)({
    sourceId: REGISTRATION_TEMPLATE_ID,
    extractionId: REGISTRATION_TEMPLATE_ID,
  });
  Schema.decodeUnknownSync(acceptSourceEntry.result)({
    sourceId: REGISTRATION_TEMPLATE_ID,
    fullyAcceptedAtMs: 0,
  });
  return { ok: true, targets: { eventEntry, executor } };
}

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

  // --- replay decision over the logical-source key -------------------------
  // The replay decision precedes the attachment gate ON PURPOSE: a replay of
  // the same key returns the ORIGINAL receipt, and that source's attachments
  // are already bound to it (the binding of the first commit) — re-running
  // the gate on a replay would misread them as foreign bindings.
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

  // --- D2: the all-attachments-durable gate (protocol step 3) --------------
  // Text-only uploads pass through unchanged (D1 semantics). An upload WITH
  // attachments is acceptable only when the upload is finalized, the
  // declaration is fully materialized, EVERY attachment is durably completed
  // (gateway-verified R2 completion) and EVERY attachment carries a VERIFIED
  // received representation. The gate runs BEFORE the first insert, so a
  // failing gate writes nothing (a source can never appear saved while any
  // required attachment is missing or unverified).
  const attachmentGate = await verifyAttachmentsForAcceptance(tx, upload);
  if (!attachmentGate.ok) {
    return errorResult(attachmentGate.error);
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

  // --- pre-flight: every throwing step resolves BEFORE the first insert ----
  const targets = registrationTargets();
  if (!targets.ok) {
    return errorResult(targets.error);
  }

  // --- the atomic commit: source + links + run + extraction + event + job --
  // From here on only pre-validated writes and total decodes of
  // transaction-generated values remain (see the module docstring): an
  // abort can no longer strand a partial acceptance.
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
  // --- D2: bind the verified attachments and the ledger row atomically -----
  // Only pre-validated patches of already-verified ids remain here (the gate
  // resolved every attachment id and its durability before the first insert),
  // so the structural no-partial-commit argument is unchanged: the source,
  // its attachments' binding and the ledger's accepted marker commit together
  // or not at all.
  if (attachmentGate.binding.bindLedger) {
    for (const attachmentId of attachmentGate.binding.attachmentIds) {
      await tx.db.patch(attachmentId, { sourceId });
    }
    await tx.db.patch(uploadId, {
      acceptedSourceId: sourceId,
      lastActivityAtMs: nowMs,
    });
  }
  // One dedup identity for the event, the job and the logical acceptance:
  // publisher-side registration and any later drain edge collapse together.
  const dedupKey =
    idempotencyKey === undefined
      ? `sources.acceptSource:${companyId}:${sourceId}`
      : `sources.acceptSource:${companyId}:${idempotencyKey}`;
  await publishEvent(tx, {
    companyId: context.actor.companyId,
    eventName: "sources.sourceAccepted",
    payload: { sourceId, attachmentIds: attachmentGate.binding.attachmentIds },
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
