/**
 * Health and observability reads (A3).
 *
 * `snapshot` is the live subscription target: it exposes runtime version,
 * the registered executors (from the A2/A3 composed registry) and outbox
 * counts, plus a monotone revision (total outbox rows) that changes whenever
 * any platform proof operation runs. Counts are global row counts only,
 * never row content: acceptable for the dev proof; I2 owns the real
 * redacted diagnostics surface before alpha.
 *
 * `outboxStateFor` is the tenant-scoped read the evidence scripts use:
 * outbox rows and durable jobs of one company, plus the external effects
 * for one explicit dedup key (the dedup key encodes the company).
 */

import { v } from "convex/values";
import { internalQuery, query } from "../_generated/server";
import { executors, type OutboxDeliveryState } from "@kiero/contracts";
import { RUNTIME_VERSION } from "@kiero/runtime";
import type { QueryCtx } from "../_generated/server";

async function countOutbox(
  db: QueryCtx["db"],
  deliveryState: OutboxDeliveryState,
): Promise<number> {
  const rows = await db
    .query("outboxEvents")
    .withIndex("by_delivery", (q) => q.eq("deliveryState", deliveryState))
    .collect();
  return rows.length;
}

async function snapshotValue(ctx: QueryCtx) {
  const all = await ctx.db.query("outboxEvents").collect();
  return {
    status: "ok" as const,
    runtimeVersion: RUNTIME_VERSION,
    // Deployment label: queries cannot read env vars; the bridge action
    // fills this from KIERO_DEPLOYMENT_LABEL where it matters.
    deployment: "",
    executors: executors.map((executor) => ({
      executorId: executor.executorId,
      jobKind: executor.jobKind,
    })),
    outbox: {
      pending: await countOutbox(ctx.db, "pending"),
      inFlight: await countOutbox(ctx.db, "in_flight"),
      delivered: await countOutbox(ctx.db, "delivered"),
      failed: await countOutbox(ctx.db, "failed"),
      superseded: await countOutbox(ctx.db, "superseded"),
    },
    revision: all.length,
  };
}

/** Public health/version info for diagnostics and the subscription proof. */
export const health = query({
  args: {},
  handler: async (ctx) => snapshotValue(ctx),
});

/** Internal health snapshot (bridge reads reuse the same implementation). */
export const snapshot = internalQuery({
  args: {},
  handler: async (ctx) => snapshotValue(ctx),
});

/** Tenant-scoped outbox/job/external-effect state for the evidence scripts. */
export const outboxStateFor = internalQuery({
  args: { companyId: v.id("companies"), dedupKey: v.optional(v.string()) },
  handler: async (ctx, args) => {
    const events = await ctx.db
      .query("outboxEvents")
      .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
      .collect();
    const jobs = await ctx.db
      .query("durableJobs")
      .withIndex("by_company", (q) => q.eq("companyId", args.companyId))
      .collect();
    const dedupKey = args.dedupKey === "" ? undefined : args.dedupKey;
    const externalEffects =
      dedupKey === undefined
        ? []
        : await ctx.db
            .query("externalEffects")
            .withIndex("by_dedup", (q) => q.eq("dedupKey", dedupKey))
            .collect();
    return {
      events: events
        .map((row) => ({
          eventId: row.eventId,
          eventName: row.eventName,
          deliveryState: row.deliveryState,
          attempts: row.attempts,
          ...(row.dedupKey === undefined ? {} : { dedupKey: row.dedupKey }),
          ...(row.lastErrorKind === undefined ? {} : { lastErrorKind: row.lastErrorKind }),
        }))
        .sort((a, b) => a.eventId.localeCompare(b.eventId)),
      jobs: jobs
        .map((job) => ({
          jobKey: job.jobKey,
          kind: job.kind,
          state: job.state,
          attempts: job.attempts,
        }))
        .sort((a, b) => a.jobKey.localeCompare(b.jobKey)),
      externalEffects: externalEffects.map((effect) => ({
        dedupKey: effect.dedupKey,
        serviceName: effect.serviceName,
        receivedAtMs: effect.receivedAtMs,
      })),
    };
  },
});
