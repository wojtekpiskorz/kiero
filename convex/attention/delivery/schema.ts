/**
 * Durable notification delivery tables (A2 candidate, certified by A3).
 *
 * Owning implementers: F2 (intents, batching, quiet hours), F3 (push
 * delivery). Intents are durable before any external delivery; rights,
 * freshness and business state are rechecked before sending. Semantic
 * deduplication identity prevents duplicate publication after timeout.
 *
 * F2 amendment (issue #42, flagged on the F1 precedent): the certified A2
 * candidate carried only clarification/task_reminder/confirmation intents,
 * but the accepted notification decision (issue 7 resolution) makes the
 * ORDINARY source-entry notification the primary durable intent: it starts
 * at durable all-attachment acceptance, waits for the terminal assignment
 * classification, batches per recipient and scope for 60 seconds from
 * acceptance, and dies on revocation/read/mute re-checks at due time.
 * Additive changes:
 *
 * - `semanticKind` gains `source_entry`; `confirmation` stays in the union
 *   but this lane NEVER creates it ("zwykłe potwierdzenia porządkowania
 *   przez agenta nie tworzą dodatkowych pushy" - ordinary agent
 *   confirmations produce no push intent, so no row may carry the kind).
 * - `sourceId`: the logical source a `source_entry` (or an addressed
 *   `clarification`) intent is about.
 * - `suppressedReason`: the machine-readable death reason the due-time
 *   re-checks record (revocation, read, mute, business invalidity).
 * - `deliveryJson`: the COLLAPSED current summary the recipient was told
 *   about at delivery (one summary per recipient and scope bucket, never a
 *   replay of stale items); absent until the intent reaches `delivered`.
 * - `deliveredAtMs`: when the due delivery decision handed the intent to
 *   the delivery adapter seam (F3 owns what happens after).
 * - `by_source` index: the per-source intent listing the probes and F3's
 *   export read.
 *
 * F3 amendment (issue #43, flagged): `pushSubscriptions` gains the
 * user/session/company binding columns and `by_endpoint` (see the table
 * comment); F3's per-device delivery rows live in its own fragment
 * (`convex/attention/push/schema.ts`, pushDeliveries).
 *
 * F3 review repair (PR #104 round 1, flagged append): `by_revoked` over
 * `revokedAtMs` lets the hygiene sweep query the not-yet-revoked range, so
 * disabled rows leave the swept window and the bounded pass converges
 * (the F2 `by_due` precedent: rows exit the queried range as they settle).
 *
 * Tables: notificationIntents, pushSubscriptions, notificationAttempts.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared } from "../../schema/shared";

export const deliveryTables = {
  /** One durable delivery intent with semantic identity and due time. */
  notificationIntents: defineTable({
    companyId: shared.companyId,
    recipientUserId: shared.userId,
    semanticKind: v.union(
      v.literal("source_entry"),
      v.literal("clarification"),
      v.literal("task_reminder"),
      v.literal("confirmation"),
    ),
    /** The logical source this intent is about (source entries, addressed clarifications). */
    sourceId: v.optional(shared.sourceId),
    taskId: v.optional(shared.taskId),
    clarificationId: v.optional(shared.clarificationId),
    /** Stable semantic identity: identical meaning collapses, not identical text. */
    dedupKey: v.string(),
    state: v.union(
      v.literal("pending"),
      v.literal("evaluating"),
      v.literal("suppressed"),
      v.literal("delivered"),
      v.literal("failed"),
    ),
    dueAtMs: shared.tsMs,
    lastEvaluatedAtMs: v.optional(shared.tsMs),
    /** The due-time re-check's machine-readable death reason, when suppressed. */
    suppressedReason: v.optional(v.string()),
    /** The collapsed current summary handed to the delivery adapter, when delivered. */
    deliveryJson: v.optional(v.string()),
    deliveredAtMs: v.optional(shared.tsMs),
    payloadJson: v.string(),
    createdAtMs: shared.tsMs,
  })
    .index("by_due", ["state", "dueAtMs"])
    .index("by_recipient_state", ["recipientUserId", "state"])
    .index("by_dedup", ["dedupKey"])
    .index("by_source", ["sourceId"]),

  /** Current device subscription of one user for web push. */
  // F3 amendment (issue #43, flagged in the sibling pattern - this
  // fragment's header names F3 as the co-owning implementer of push
  // delivery, and this table is the push transport's registry): the
  // subscription binds to the CURRENT user, device/session and company
  // context at registration (never to anything a client asserts), so
  // delivery can deny a revoked session or membership before any cleanup
  // finishes. Re-registering an existing endpoint (browser renewal)
  // refreshes the binding and the keys in place; `by_endpoint` finds it.
  pushSubscriptions: defineTable({
    userId: shared.userId,
    companyId: shared.companyId,
    /** The device/session whose sign-in enabled this device. */
    sessionId: v.optional(v.id("sessions")),
    endpoint: v.string(),
    p256dhKeyBase64: v.string(),
    authKeyBase64: v.string(),
    deviceLabel: v.string(),
    createdAtMs: shared.tsMs,
    revokedAtMs: v.optional(shared.tsMs),
  })
    .index("by_user", ["userId"])
    .index("by_endpoint", ["endpoint"])
    // The hygiene sweep's drained discriminator: it queries the rows whose
    // revokedAtMs is still undefined, and patching that field moves the row
    // out of the swept range (see the F3 review repair note above).
    .index("by_revoked", ["revokedAtMs"]),

  /** External delivery attempt history with known/unknown outcomes. */
  notificationAttempts: defineTable({
    intentId: shared.notificationIntentId,
    attempt: shared.counter,
    // Deliberately NOT one vocabulary with the attention.intentDelivered
    // event outcome: an attempt may end `unknown` (provider timeout after an
    // uncertain side effect), while the intentDelivered event outcome is
    // terminal-only (delivered/suppressed/failed). Do not merge or pin them
    // together.
    outcome: v.union(
      v.literal("delivered"),
      v.literal("failed"),
      v.literal("suppressed"),
      v.literal("unknown"),
    ),
    providerRef: v.optional(v.string()),
    atMs: shared.tsMs,
  }).index("by_intent_attempt", ["intentId", "attempt"]),
} as const;
