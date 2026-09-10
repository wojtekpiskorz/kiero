/**
 * Web Push delivery transactions (F3): device registration, the per-device
 * delivery prepare/settle pair, and the revocation hygiene sweep.
 *
 * Every entry runs inside ONE Convex mutation transaction (the F2
 * operations precedent) and re-reads live state at the moment it decides:
 *
 * - registration binds the subscription to the RESOLVED actor's user,
 *   company and session (never to anything the client asserts); the same
 *   endpoint re-registering (browser renewal) refreshes the binding and
 *   keys in place.
 * - the delivery prepare re-checks the recipient's CURRENT membership and
 *   the subscription's CURRENT session and company BEFORE any leg runs,
 *   so a revoked session or membership denies delivery even while the
 *   revocation cleanup has not finished (the structural rule the bounded
 *   solution demands); it also re-reads the preview material and the
 *   hide-preview preference at that same instant, so the payload can
 *   never carry content the recipient may no longer see.
 * - the idempotency key is the (intent, subscription) pair: prepare is a
 *   no-op for devices that already have a delivery row, and only `pending`
 *   rows are ever re-driven, so concurrent retries collapse (one
 *   notification per device) and uncertain outcomes (timeout-after-send)
 *   are never blindly repeated.
 * - terminal 404/410 provider answers revoke the subscription inside the
 *   completing transaction (the "subscriptions expire" problem).
 */

import { Schema } from "effect";
import {
  attentionOperations,
  errorResult,
  okResult,
  type ResultEnvelope,
} from "@kiero/contracts";
import { forbiddenError, notFoundError, validationError, type RequestContext } from "@kiero/runtime";
import type { MutationCtx, QueryCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import { preferenceWriteOf } from "../preferences/operations";
import { isBase64Url } from "./protocol";
import {
  composePushPayload,
  settleLegOutcome,
  legMayRetry,
  type DeliveredSummary,
  type PreparedLeg,
  type LegResult,
  type PushNotificationPayload,
} from "./model";

// ---------------------------------------------------------------------------
// Registration (attention.registerPushSubscription / revoke).
// ---------------------------------------------------------------------------

/** The contract entries this module implements (decode/typed authority). */
export const registerPushOperation =
  attentionOperations["attention.registerPushSubscription"];
export type RegisterPushInput = Schema.Schema.Type<typeof registerPushOperation.input>;
export type RegisterPushResult = Schema.Schema.Type<typeof registerPushOperation.result>;
export const revokePushOperation = attentionOperations["attention.revokePushSubscription"];
export type RevokePushInput = Schema.Schema.Type<typeof revokePushOperation.input>;
export type RevokePushResult = Schema.Schema.Type<typeof revokePushOperation.result>;

/** Bounded device label (the settings screen shows it verbatim). */
const MAX_DEVICE_LABEL = 64;

/**
 * The endpoint policy: https push-service endpoints in production, plus
 * loopback http for local development proofs (real browsers only ever
 * register https endpoints).
 */
export function endpointAcceptable(endpoint: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(endpoint);
  } catch {
    return false;
  }
  if (parsed.protocol === "https:") {
    return true;
  }
  return (
    parsed.protocol === "http:" &&
    (parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1" || parsed.hostname === "[::1]")
  );
}

/** Validates one registration input beyond the contract decode. */
export function registrationIssue(input: RegisterPushInput): string | null {
  if (!endpointAcceptable(input.endpoint)) {
    return "endpoint_not_https";
  }
  if (!isBase64Url(input.p256dhKeyBase64) || !isBase64Url(input.authKeyBase64)) {
    return "subscription_keys_not_base64url";
  }
  // An absent label is the honest case: an insert falls back to the
  // default "To urządzenie"; a renewal keeps the stored label.
  if (input.deviceLabel !== undefined) {
    const label = input.deviceLabel;
    if (label.trim() === "" || label.length > MAX_DEVICE_LABEL) {
      return "device_label_invalid";
    }
  }
  return null;
}

/** Registers (or refreshes) the CURRENT actor's device subscription. */
export async function performRegisterPushSubscription(
  tx: MutationCtx,
  context: RequestContext,
  input: RegisterPushInput,
): Promise<ResultEnvelope> {
  const issue = registrationIssue(input);
  if (issue !== null) {
    return errorResult(validationError(issue));
  }
  const companyId = tx.db.normalizeId("companies", context.actor.companyId);
  const userId = tx.db.normalizeId("users", context.actor.userId);
  const sessionId = tx.db.normalizeId("sessions", context.actor.sessionId);
  if (companyId === null || userId === null || sessionId === null) {
    return errorResult(forbiddenError("actor_scope_unresolved"));
  }
  const nowMs = Date.now();
  const existing = await tx.db
    .query("pushSubscriptions")
    .withIndex("by_endpoint", (q) => q.eq("endpoint", input.endpoint))
    .first();
  if (existing !== null) {
    // Browser renewal of one endpoint: refresh the binding and keys in
    // place. A DIFFERENT signed-in user re-registering the same browser
    // endpoint rebinds it (the previous owner's session lost the device);
    // delivery always re-checks live rights anyway.
    await tx.db.patch(existing._id, {
      userId,
      companyId,
      sessionId,
      p256dhKeyBase64: input.p256dhKeyBase64,
      authKeyBase64: input.authKeyBase64,
      deviceLabel: input.deviceLabel ?? existing.deviceLabel,
      revokedAtMs: undefined,
    });
    return okResult(Schema.decodeUnknownSync(registerPushOperation.result)({
      pushSubscriptionId: existing._id,
    }));
  }
  const inserted = await tx.db.insert("pushSubscriptions", {
    userId,
    companyId,
    sessionId,
    endpoint: input.endpoint,
    p256dhKeyBase64: input.p256dhKeyBase64,
    authKeyBase64: input.authKeyBase64,
    deviceLabel: input.deviceLabel ?? "To urządzenie",
    createdAtMs: nowMs,
  });
  return okResult(
    Schema.decodeUnknownSync(registerPushOperation.result)({ pushSubscriptionId: inserted }),
  );
}

/** Disables one of the actor's OWN subscriptions (idempotent). */
export async function performRevokePushSubscription(
  tx: MutationCtx,
  context: RequestContext,
  input: RevokePushInput,
): Promise<ResultEnvelope> {
  const userId = tx.db.normalizeId("users", context.actor.userId);
  const subscriptionId = tx.db.normalizeId("pushSubscriptions", input.pushSubscriptionId);
  if (userId === null || subscriptionId === null) {
    return errorResult(forbiddenError("actor_scope_unresolved"));
  }
  const row = await tx.db.get(subscriptionId);
  if (row === null) {
    return errorResult(notFoundError("pushSubscriptions", "push_subscription_not_found"));
  }
  if (row.userId !== userId) {
    return errorResult(forbiddenError("tenant_scope_mismatch", "pushSubscriptions"));
  }
  if (row.revokedAtMs === undefined) {
    await tx.db.patch(subscriptionId, { revokedAtMs: Date.now() });
  }
  return okResult(Schema.decodeUnknownSync(revokePushOperation.result)({ revoked: "revoked" }));
}

// ---------------------------------------------------------------------------
// Delivery prepare: live re-checks, payload composition, row idempotency.
// ---------------------------------------------------------------------------

/** What the prepare found for one intent. */
export type PrepareOutcome =
  | {
      readonly kind: "prepared";
      readonly legs: PreparedLeg[];
    }
  | { readonly kind: "denied"; readonly reason: string }
  | { readonly kind: "nothing_pending" };

/** The active memberships check (live rights at delivery time). */
async function membershipActive(
  tx: MutationCtx,
  companyId: Id<"companies">,
  userId: Id<"users">,
): Promise<boolean> {
  const membership = await tx.db
    .query("memberships")
    .withIndex("by_company_user", (q) => q.eq("companyId", companyId).eq("userId", userId))
    .filter((q) => q.eq(q.field("state"), "active"))
    .first();
  return membership !== null;
}

/** The currently enabled subscriptions of one recipient in one company. */
async function activeSubscriptionsOf(
  tx: MutationCtx,
  companyId: Id<"companies">,
  userId: Id<"users">,
): Promise<Doc<"pushSubscriptions">[]> {
  const rows = await tx.db
    .query("pushSubscriptions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .filter((q) => q.eq(q.field("companyId"), companyId))
    .collect();
  const enabled: Doc<"pushSubscriptions">[] = [];
  for (const row of rows) {
    if (row.revokedAtMs !== undefined) {
      continue; // disabled device: nothing reaches it
    }
    if (row.sessionId !== undefined) {
      const session = await tx.db.get(row.sessionId);
      if (session === null || session.revokedAtMs !== undefined) {
        // The session that enabled this device is gone: deny delivery
        // NOW, before any cleanup persists it.
        continue;
      }
    }
    enabled.push(row);
  }
  return enabled;
}

/** Reads one summary's live preview material (re-read at delivery time). */
async function payloadInputsOf(
  tx: MutationCtx,
  companyId: Id<"companies">,
  userId: Id<"users">,
  summary: DeliveredSummary,
): Promise<PushNotificationPayload> {
  const projectNames: string[] = [];
  for (const projectIdValue of summary.scope.projectIds) {
    const projectId = tx.db.normalizeId("projects", projectIdValue);
    const project = projectId === null ? null : await tx.db.get(projectId);
    if (project !== null) {
      projectNames.push(project.displayName);
    }
  }
  const sources: {
    readonly sourceId: string;
    readonly authorName: string;
    readonly authorText: string | null;
    readonly audioCount: number;
    readonly photoCount: number;
    readonly stillActive: boolean;
  }[] = [];
  for (const sourceIdValue of summary.sourceIds ?? []) {
    const sourceId = tx.db.normalizeId("sources", sourceIdValue);
    const source = sourceId === null ? null : await tx.db.get(sourceId);
    if (source === null || source.companyId !== companyId) {
      continue;
    }
    const author = await tx.db.get(source.authorUserId);
    const attachments = await tx.db
      .query("attachments")
      .withIndex("by_source", (q) => q.eq("sourceId", source._id))
      .collect();
    sources.push({
      sourceId: source._id,
      authorName: author?.displayName ?? "Szef",
      authorText: source.authorText,
      audioCount: attachments.filter((row) => row.kind === "audio").length,
      photoCount: attachments.filter((row) => row.kind === "image").length,
      stillActive: source.lifecycle === "active",
    });
  }
  const clarifications = [];
  for (const clarificationIdValue of summary.clarificationIds ?? []) {
    const clarificationId = tx.db.normalizeId("clarifications", clarificationIdValue);
    const clarification = clarificationId === null ? null : await tx.db.get(clarificationId);
    if (clarification === null || clarification.companyId !== companyId) {
      continue;
    }
    clarifications.push({
      clarificationId: clarification._id,
      question: clarification.question,
      stillOpen: clarification.state === "open",
    });
  }
  const preferences = await tx.db
    .query("notificationPreferences")
    .withIndex("by_company_user", (q) => q.eq("companyId", companyId).eq("userId", userId))
    .first();
  return composePushPayload({
    summary,
    scope: { kind: summary.scope.kind, projectNames },
    sources,
    clarifications,
    hidePreview: preferenceWriteOf(preferences ?? null).hidePreviewContent,
  });
}

/**
 * Prepares one delivered intent's per-device legs. Idempotent by
 * (intent, subscription): devices with an existing row are skipped, so
 * concurrent jobs/sweeps collapse onto one row set. The payload is
 * composed ONCE per prepare from live reads and stored on every new row.
 */
export async function performPreparePushDelivery(
  tx: MutationCtx,
  intentId: Id<"notificationIntents">,
): Promise<PrepareOutcome> {
  const intent = await tx.db.get(intentId);
  if (intent === null) {
    return { kind: "denied", reason: "intent_not_found" };
  }
  if (intent.state !== "delivered" || intent.deliveryJson === undefined) {
    // Only F2's delivered intents reach the transport: suppressed and
    // failed intents notify nobody, pending ones are not this lane's.
    return { kind: "denied", reason: `intent_${intent.state}` };
  }
  const summary = JSON.parse(intent.deliveryJson) as DeliveredSummary;
  if (summary.semanticKind === "confirmation") {
    // Defensive: the kind exists in the union but F2 never creates it.
    return { kind: "denied", reason: "confirmation_never_pushed" };
  }

  // Live rights at delivery time (before any leg leaves).
  if (!(await membershipActive(tx, intent.companyId, intent.recipientUserId))) {
    return { kind: "denied", reason: "membership_not_active" };
  }
  const subscriptions = await activeSubscriptionsOf(
    tx,
    intent.companyId,
    intent.recipientUserId,
  );
  if (subscriptions.length === 0) {
    return { kind: "denied", reason: "no_active_subscription" };
  }

  const payload: PushNotificationPayload = await payloadInputsOf(
    tx,
    intent.companyId,
    intent.recipientUserId,
    summary,
  );
  const payloadJson = JSON.stringify(payload);
  const nowMs = Date.now();
  const legs: PreparedLeg[] = [];
  for (const subscription of subscriptions) {
    const existing = await tx.db
      .query("pushDeliveries")
      .withIndex("by_intent_subscription", (q) =>
        q.eq("intentId", intent._id).eq("subscriptionId", subscription._id),
      )
      .first();
    if (existing !== null) {
      if (existing.state === "pending") {
        legs.push({
          deliveryId: existing._id,
          subscriptionId: subscription._id,
          endpoint: subscription.endpoint,
          p256dhKeyBase64: subscription.p256dhKeyBase64,
          authKeyBase64: subscription.authKeyBase64,
          payloadJson: existing.payloadJson,
          attempts: existing.attempts,
        });
      }
      continue; // delivered/failed/unknown: settled per-device, never re-driven
    }
    const deliveryId = await tx.db.insert("pushDeliveries", {
      intentId: intent._id,
      subscriptionId: subscription._id,
      companyId: intent.companyId,
      recipientUserId: intent.recipientUserId,
      state: "pending",
      attempts: 0,
      payloadJson,
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
    });
    legs.push({
      deliveryId,
      subscriptionId: subscription._id,
      endpoint: subscription.endpoint,
      p256dhKeyBase64: subscription.p256dhKeyBase64,
      authKeyBase64: subscription.authKeyBase64,
      payloadJson,
      attempts: 0,
    });
  }
  if (legs.length === 0) {
    return { kind: "nothing_pending" };
  }
  return { kind: "prepared", legs };
}

// ---------------------------------------------------------------------------
// Leg completion: attempt ledger + row settlement + terminal subscription
// death.
// ---------------------------------------------------------------------------

/** What completing one batch of legs left behind. */
export interface CompleteLegsResult {
  readonly pendingRemaining: number;
  readonly revokedSubscriptions: number;
}

/** Settles leg results: attempts on the shared ledger, rows, subscriptions. */
export async function performCompletePushLegs(
  tx: MutationCtx,
  results: readonly LegResult[],
): Promise<CompleteLegsResult> {
  const nowMs = Date.now();
  let pendingRemaining = 0;
  let revokedSubscriptions = 0;
  for (const result of results) {
    const row = await tx.db.get(result.deliveryId as Id<"pushDeliveries">);
    if (row === null || row.state !== "pending") {
      continue; // concurrently settled: the per-device row is the authority
    }
    const settled = settleLegOutcome(result);
    const attempts = row.attempts + 1;
    const mayRetry = legMayRetry(attempts, result.report);
    const state = settled.state === "pending" && mayRetry ? "pending" : settled.state === "pending" ? "failed" : settled.state;
    const errorKind =
      state === "failed" && settled.state === "pending" ? "push_attempts_exhausted" : settled.errorKind;
    await tx.db.patch(row._id, {
      state,
      attempts,
      ...(errorKind === null ? { lastErrorKind: undefined } : { lastErrorKind: errorKind }),
      updatedAtMs: nowMs,
      ...(state === "pending" ? {} : { finishedAtMs: nowMs }),
    });
    // The shared external-attempt ledger (F2's notificationAttempts; this
    // lane's export read per the fragment's schema comment).
    await tx.db.insert("notificationAttempts", {
      intentId: row.intentId,
      attempt: attempts,
      outcome: settled.attemptOutcome,
      providerRef: result.subscriptionId,
      atMs: nowMs,
    });
    if (settled.revokeSubscription) {
      const subscription = await tx.db.get(result.subscriptionId as Id<"pushSubscriptions">);
      if (subscription !== null && subscription.revokedAtMs === undefined) {
        await tx.db.patch(subscription._id, { revokedAtMs: nowMs });
        revokedSubscriptions += 1;
      }
    }
    if (state === "pending") {
      pendingRemaining += 1;
    }
  }
  return { pendingRemaining, revokedSubscriptions };
}

// ---------------------------------------------------------------------------
// The revocation hygiene sweep + the stale-pending safety net input.
// ---------------------------------------------------------------------------

/** How many subscriptions one hygiene pass inspects (bounded). */
const HYGIENE_LIMIT = 200;

/**
 * The converging cleanup after revocation: disables subscriptions whose
 * bound session is revoked or whose user lost the active membership of
 * the bound company. Delivery already denies both structurally (the
 * prepare re-check); this pass persists the honest disabled state so a
 * settings screen never shows a dead device as enabled.
 */
export async function performPushHygiene(tx: MutationCtx): Promise<{ disabled: number }> {
  const nowMs = Date.now();
  const rows = await tx.db.query("pushSubscriptions").take(HYGIENE_LIMIT);
  let disabled = 0;
  for (const row of rows) {
    if (row.revokedAtMs !== undefined) {
      continue;
    }
    let dead = false;
    if (row.sessionId !== undefined) {
      const session = await tx.db.get(row.sessionId);
      if (session !== null && session.revokedAtMs !== undefined) {
        dead = true;
      }
    }
    if (!dead && !(await membershipActive(tx, row.companyId, row.userId))) {
      dead = true;
    }
    if (dead) {
      await tx.db.patch(row._id, { revokedAtMs: nowMs });
      disabled += 1;
    }
  }
  return { disabled };
}

/** How stale a pending row must be before the safety net re-drives it. */
export const SWEEP_STALENESS_MS = 60_000;

/** Bounded number of intents one safety-net pass re-drives. */
const SWEEP_INTENT_LIMIT = 20;

/**
 * The stale pending per-device rows (the cron safety net's input):
 * intents whose rows are still pending, older than the staleness bound,
 * with attempts left.
 */
export async function performStalePendingIntentIds(tx: MutationCtx): Promise<
  Id<"notificationIntents">[]
> {
  const rows = await tx.db
    .query("pushDeliveries")
    .withIndex("by_state_updated", (q) =>
      q.eq("state", "pending").lte("updatedAtMs", Date.now() - SWEEP_STALENESS_MS),
    )
    .take(SWEEP_INTENT_LIMIT);
  const ids = new Set<Id<"notificationIntents">>();
  for (const row of rows) {
    ids.add(row.intentId);
  }
  return [...ids];
}

/** The per-user subscription view the settings screen reads. */
export async function subscriptionViewsOf(
  db: QueryCtx["db"],
  userId: Id<"users">,
): Promise<
  {
    readonly subscriptionId: string;
    readonly deviceLabel: string;
    readonly createdAtMs: number;
    readonly revokedAtMs: number | null;
    readonly boundSessionId: string | null;
  }[]
> {
  const rows = await db
    .query("pushSubscriptions")
    .withIndex("by_user", (q) => q.eq("userId", userId))
    .take(50);
  return rows.map((row) => ({
    subscriptionId: row._id,
    deviceLabel: row.deviceLabel,
    createdAtMs: row.createdAtMs,
    revokedAtMs: row.revokedAtMs ?? null,
    boundSessionId: row.sessionId ?? null,
  }));
}
