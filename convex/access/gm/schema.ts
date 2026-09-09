/**
 * Audited GM access tables (A2 candidate, certified by A3; amended by B4).
 *
 * Owning implementer: B4 (explicit audited GM access). GM is a global
 * operator permission separate from company membership ("GM", CONTEXT.md);
 * entry is explicit, reason-carrying and audited, and GM activity stays out
 * of alpha success metrics (every GM-written audit row carries the grant id,
 * which is the exclusion tag).
 *
 * B4 amendment (issue #23):
 *
 * - `gmAccessGrants` keeps the A3-certified shape: ONE row per audited GM
 *   mode interval; an OPEN row is the current GM authority. Grants never
 *   expire by time ("time elapsed alone does not end it") and never confer
 *   membership; only `access.exitGmMode` closes one.
 * - `gmCompanyActivations`: the per-company alpha participation authority.
 *   An OPEN row means the firm is a testing firm whose data GM may reach
 *   (each GM operation re-checks it inside the transaction); ending
 *   participation closes the row and removes grant-derived access to that
 *   firm immediately, structurally.
 *
 * Tables: gmAccessGrants, gmCompanyActivations.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared } from "../../schema/shared";

export const gmTables = {
  /** One audited GM mode interval. Open grants are the current GM sessions. */
  gmAccessGrants: defineTable({
    userId: shared.userId,
    reason: v.string(),
    enteredAtMs: shared.tsMs,
    closedAtMs: v.optional(shared.tsMs),
  })
    .index("by_user_open", ["userId", "closedAtMs"])
    .index("by_entered", ["enteredAtMs"]),

  /**
   * One company's alpha participation under GM authority. `endedAtMs`
   * absent = the firm currently participates: GM operations targeting it
   * resolve; the GM overview lists it. Rows survive ending (history), and
   * one company has at most one open row by construction (the opening
   * transaction conflicts on an existing open row).
   */
  gmCompanyActivations: defineTable({
    companyId: shared.companyId,
    /** The GM operator whose action opened the activation (audit lineage). */
    activatedByUserId: shared.userId,
    activatedAtMs: shared.tsMs,
    endedAtMs: v.optional(shared.tsMs),
    /** The GM operator whose action ended the activation, once ended. */
    endedByUserId: v.optional(shared.userId),
  })
    .index("by_company_open", ["companyId", "endedAtMs"])
    .index("by_activated", ["activatedAtMs"]),
} as const;
