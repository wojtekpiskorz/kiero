/**
 * Guarded proof fixtures (I5): the dev-deployment seeding the live proofs
 * need, NEVER reachable with the probe guard off (proof.ts is the only
 * caller; these mutations exist as `internalMutation` so no external
 * function reference can ever reach them either).
 *
 * The fixtures seed the real tables through the real schema: a minimal
 * company/user/source/upload/attachment chain for retained representations
 * (the D3 inventory seam) and content-free deletion records (the I4 seam).
 * Past-dated manifest rows let retention sweeps run against real "now"
 * without time travel.
 */

import { v } from "convex/values";
import { internalMutation } from "../../_generated/server";
import { retentionMsOfTier, slotOf, tierOfSlot } from "./slot";

const SAFE_KEY = /^[a-z0-9][a-z0-9/._-]{0,512}$/;

/** Seeds one retained representation (with its minimal owning chain). */
export const seedRetainedMedia = internalMutation({
  args: {
    objectKey: v.string(),
    contentHash: v.string(),
    bytes: v.float64(),
    transformVersion: v.string(),
    sourceId: v.optional(v.string()),
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    if (!SAFE_KEY.test(args.objectKey)) {
      return { seeded: false, reason: "object_key_unsafe" };
    }
    const nowMs = Date.now();
    const companyId = await ctx.db.insert("companies", {
      name: `I5 proof ${args.objectKey.slice(-12)}`,
      timezone: "Europe/Warsaw",
      defaultCurrency: "PLN",
      createdAtMs: nowMs,
    });
    const userId = await ctx.db.insert("users", {
      email: `i5-${nowMs}@kiero.invalid`,
      displayName: "I5 proof",
      createdAtMs: nowMs,
    });
    const sourceId =
      args.sourceId !== undefined
        ? ctx.db.normalizeId("sources", args.sourceId) ?? (args.sourceId as never)
        : ((await ctx.db.insert("sources", {
            companyId,
            authorUserId: userId,
            authorText: "I5 proof fixture",
            sentAtMs: nowMs,
            sentAtTimezone: "Europe/Warsaw",
            fullyAcceptedAtMs: nowMs,
            lifecycle: "active",
          })) as never);
    const uploadId = await ctx.db.insert("uploads", {
      companyId,
      userId,
      stage: "finalized",
      partCount: 1,
      createdAtMs: nowMs,
      acceptedSourceId: sourceId,
    });
    const attachmentId = await ctx.db.insert("attachments", {
      uploadId,
      sourceId,
      kind: "image",
      objectKey: args.objectKey,
      createdAtMs: nowMs,
    });
    const representationId = await ctx.db.insert("mediaRepresentations", {
      attachmentId,
      role: "retained",
      objectKey: args.objectKey,
      contentHash: args.contentHash,
      transformVersion: args.transformVersion,
      verifiedAtMs: nowMs,
      createdAtMs: nowMs,
      bytes: args.bytes,
    });
    return { seeded: true, sourceId, attachmentId, representationId, objectKey: args.objectKey };
  },
});

/** Seeds one content-free deletion/revocation record (I4 seam). */
export const seedDeletion = internalMutation({
  args: {
    kind: v.string(),
    targetSourceId: v.optional(v.string()),
    scopeSummary: v.string(),
    ageMinutes: v.float64(),
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    if (args.kind !== "source_purge" && args.kind !== "data_revocation") {
      return { seeded: false, reason: "kind_invalid" };
    }
    const nowMs = Date.now();
    const companyId = await ctx.db.insert("companies", {
      name: "I5 proof deletion owner",
      timezone: "Europe/Warsaw",
      defaultCurrency: "PLN",
      createdAtMs: nowMs,
    });
    const userId = await ctx.db.insert("users", {
      email: `i5-del-${nowMs}@kiero.invalid`,
      displayName: "I5 proof",
      createdAtMs: nowMs,
    });
    const recordId = await ctx.db.insert("deletionRecords", {
      companyId,
      kind: args.kind,
      ...(args.targetSourceId === undefined ? {} : { targetSourceId: args.targetSourceId as never }),
      requestedByUserId: userId,
      scopeSummary: args.scopeSummary,
      createdAtMs: nowMs - args.ageMinutes * 60 * 1000,
    });
    return { seeded: true, recordId };
  },
});

/**
 * Seeds one past-dated manifest row (retention fixtures). Verified rows get
 * a real retention deadline from their slot's tier so the sweep decision is
 * the production one.
 */
export const seedManifest = internalMutation({
  args: {
    slotAgeMinutes: v.float64(),
    state: v.string(),
    mediaObjectKeys: v.array(v.string()),
  },
  handler: async (ctx, args): Promise<Record<string, unknown>> => {
    if (args.state !== "verified" && args.state !== "failed") {
      return { seeded: false, reason: "state_invalid" };
    }
    const nowMs = Date.now();
    const slotMs = slotOf(nowMs - args.slotAgeMinutes * 60 * 1000);
    const tier = tierOfSlot(slotMs);
    const base = {
      snapshotAtMs: slotMs,
      databaseManifestHash: "0".repeat(64),
      slotMs,
      attempts: 1,
      inventoryJson: JSON.stringify(
        args.mediaObjectKeys.map((objectKey) => ({ objectKey, contentHash: "proof", bytes: null, sourceId: null })),
      ),
      ledgerCount: 0,
    };
    const manifestId =
      args.state === "verified"
        ? await ctx.db.insert("recoveryManifests", {
            ...base,
            state: "verified",
            tier,
            verifiedAtMs: slotMs,
            completedAtMs: slotMs,
            expiresAtMs: slotMs + retentionMsOfTier(tier),
            mediaObjectCount: args.mediaObjectKeys.length,
            databaseBytes: 1,
            mediaBytes: args.mediaObjectKeys.length,
            manifestHash: "0".repeat(64),
          })
        : await ctx.db.insert("recoveryManifests", {
            ...base,
            state: "failed",
            failureReason: "proof_fixture",
          });
    return { seeded: true, manifestId, slotMs, tier: args.state === "verified" ? tier : null };
  },
});

/** Removes every recovery-manifest row and the fixture audit trail. */
export const clear = internalMutation({
  args: {},
  handler: async (ctx): Promise<{ removed: number }> => {
    const rows = await ctx.db.query("recoveryManifests").collect();
    for (const row of rows) {
      await ctx.db.delete(row._id);
    }
    return { removed: rows.length };
  },
});
