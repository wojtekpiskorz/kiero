/**
 * Web Push delivery tables (F3).
 *
 * Owning implementer: F3 (push transport). One row per (notification
 * intent, push subscription): the per-device delivery with its exact
 * payload and settled transport outcome. This is the idempotency the
 * bounded solution demands - "semantic intent plus subscription" - so a
 * retried durable job, a concurrent sweep or a duplicate
 * `attention.intentDelivered` event can never re-send to a device that
 * already received (or terminally failed to receive) the notification.
 *
 * The push subscription table itself lives in the F2 delivery fragment
 * (`convex/attention/delivery/schema.ts`, whose header names F3 as the
 * co-owning implementer of push delivery); F3's flagged amendment there
 * adds the user/session/company binding. Attempt history rows stay in
 * F2's `notificationAttempts` (the shared external-attempt ledger the
 * schema comments assign to this lane's export read).
 *
 * Tables: pushDeliveries, pushProofDevices (proof-only).
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared } from "../../schema/shared";

export const pushTables = {
  /**
   * One per-device delivery of one delivered notification intent.
   * `pending` rows await/d repeat a transport leg; `delivered` and
   * `failed` are terminal; `unknown` is the echo/G3 uncertain state
   * (timeout-after-send): it blocks blind re-sends because the device
   * may already have shown the notification.
   */
  pushDeliveries: defineTable({
    intentId: shared.notificationIntentId,
    subscriptionId: v.id("pushSubscriptions"),
    companyId: shared.companyId,
    recipientUserId: shared.userId,
    state: v.union(
      v.literal("pending"),
      v.literal("delivered"),
      v.literal("failed"),
      v.literal("unknown"),
    ),
    /** Bounded transport attempts taken so far. */
    attempts: shared.counter,
    /** The exact notification JSON the transport sends (evidence + stable retry). */
    payloadJson: v.string(),
    lastErrorKind: v.optional(v.string()),
    createdAtMs: shared.tsMs,
    updatedAtMs: shared.tsMs,
    finishedAtMs: v.optional(shared.tsMs),
  })
    .index("by_intent_subscription", ["intentId", "subscriptionId"])
    .index("by_state_updated", ["state", "updatedAtMs"]),

  /**
   * PROOF-ONLY fake push service devices (F3, the G3 calendarProofEvents
   * precedent): the guarded dev-evidence store for the browser-side half
   * of the protocol - device keypairs, auth secrets and the recorded
   * (decrypted) messages the live proof asserts on. Never read by any
   * production path.
   */
  pushProofDevices: defineTable({
    token: v.string(),
    behavior: v.string(),
    publicBase64Url: v.string(),
    privateJwkJson: v.string(),
    authBase64Url: v.string(),
    messagesJson: v.string(),
    createdAtMs: shared.tsMs,
  }).index("by_token", ["token"]),
} as const;
