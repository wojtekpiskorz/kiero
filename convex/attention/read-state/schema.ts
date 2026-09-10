/**
 * Per-person source read state (A2 candidate, certified by A3).
 *
 * Owning implementer: F1. Read state belongs to the logical source and the
 * user: seeing the original message in any view marks it everywhere for that
 * person, on all devices. One boss reading an entry never changes anyone
 * else's state. Reassigning a source to another project keeps its read
 * state and does not create a second notification.
 *
 * Tables: readStates.
 *
 * Layout note (F1, flagged): Convex rejects hyphenated path components for
 * FUNCTION modules ("Path component read-state can only contain
 * alphanumeric characters, underscores, or periods"), so this lane's
 * callable modules live in the sibling `convex/attention/read_state/`
 * directory; only schema fragments (exempt from module path validation)
 * live here, keeping the A3-certified composition import unchanged.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared } from "../../schema/shared";

export const readStateTables = {
  /** Whether one user has seen (or explicitly marked) one logical source. */
  readStates: defineTable({
    companyId: shared.companyId,
    userId: shared.userId,
    sourceId: shared.sourceId,
    read: v.boolean(),
    readAtMs: shared.tsMs,
  })
    .index("by_user_source", ["userId", "sourceId"])
    .index("by_source", ["sourceId"])
    // F1: the audited-GM inspection read lists one company's read states
    // without touching any boss's row (issue 41: GM reads never write).
    .index("by_company", ["companyId"]),
} as const;
