/**
 * Durable notification delivery tables (candidate fragment, A2).
 *
 * Owning implementers: F2 (intents, batching, quiet hours), F3 (push
 * delivery). Intents are durable before any external delivery; rights,
 * freshness and business state are rechecked before sending. Semantic
 * deduplication identity prevents duplicate publication after timeout.
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
      v.literal("clarification"),
      v.literal("task_reminder"),
      v.literal("confirmation"),
    ),
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
    payloadJson: v.string(),
    createdAtMs: shared.tsMs,
  })
    .index("by_due", ["state", "dueAtMs"])
    .index("by_recipient_state", ["recipientUserId", "state"])
    .index("by_dedup", ["dedupKey"]),

  /** Current device subscription of one user for web push. */
  pushSubscriptions: defineTable({
    userId: shared.userId,
    endpoint: v.string(),
    p256dhKeyBase64: v.string(),
    authKeyBase64: v.string(),
    deviceLabel: v.string(),
    createdAtMs: shared.tsMs,
    revokedAtMs: v.optional(shared.tsMs),
  }).index("by_user", ["userId"]),

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
