/**
 * C3 dev-proof surface (guarded by the deployment's KIERO_PROBE_ENABLED
 * variable, exactly like the C2 findings probes; shared plumbing from
 * convex/sources/probe_shared.ts).
 *
 * No business work happens here; these entries exist so the C3 evidence can
 * run against the REAL dev deployment without a development-auth shortcut:
 * every command goes through the SAME checked dispatch with a server-seeded
 * session, and no identity is ever accepted from client input.
 *
 * - `probeExtensionCommand`: dispatches one memory envelope (extension
 *   operations) through the checked path with the service identity or an
 *   explicitly seeded session.
 * - `seedSharedExtension` / `probeSeedSharedExtension`: the PRODUCT-CODE
 *   stand-in for publishing a shared definition. There is no client path
 *   that can do this — the checked operation surface creates firm-scoped
 *   definitions only — so the shared-catalog fixture is seeded by guarded
 *   server code, exactly like the product publishing flow would.
 * - `extensionState` / `probeExtensionState`: the tenant-scoped inspection
 *   read (visible definitions, every version row, usage rows) the evidence
 *   script asserts on.
 */

import { v } from "convex/values";
import { errorResult, okResult, type ResultEnvelope } from "@kiero/contracts";
import { unsupportedError } from "@kiero/runtime";
import { action, internalMutation, internalQuery } from "../../_generated/server";
import { internal } from "../../_generated/api";
import { bridgeIdentity, resolveRequestContext } from "../../platform/context";
import { resolveProbeSession, serviceIdentityUnavailable } from "../../sources/probe_shared";
import { stableKeyOf } from "@kiero/domain";

function probeGuardEnabled(): boolean {
  return process.env.KIERO_PROBE_ENABLED === "1";
}

function probeDisabled(): ResultEnvelope {
  return errorResult(unsupportedError("memory.extensions.probe", "probe_guard_disabled"));
}

// --- shared-catalog fixture (the product-code publishing stand-in) ----------

/** The shared definition the evidence uses (enum with a closed option set). */
const SHARED_NAME = "Kolor fugi";
const SHARED_FIELDS: {
  fieldId: string;
  label: string;
  kind: "enum";
  options: { optionId: string; label: string }[];
}[] = [
  {
    fieldId: "kolor",
    label: "Kolor fugi",
    kind: "enum",
    options: [
      { optionId: "bezowa", label: "Beżowa" },
      { optionId: "szara", label: "Szara" },
      { optionId: "antracytowa", label: "Antracytowa" },
    ],
  },
];

/**
 * Idempotently ensures the shared definition (guarded; product-code path —
 * no client-facing operation can create shared definitions).
 */
export const seedSharedExtension = internalMutation({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    const stableKey = stableKeyOf(SHARED_NAME);
    const existing = await ctx.db
      .query("extensionDefinitions")
      .filter((q) =>
        q.and(q.eq(q.field("companyId"), undefined), q.eq(q.field("stableKey"), stableKey)),
      )
      .first();
    if (existing !== null && existing.currentVersionId !== undefined) {
      return okResult({
        definitionId: existing._id,
        versionId: existing.currentVersionId,
        created: false,
      });
    }
    const nowMs = Date.now();
    const definitionId = await ctx.db.insert("extensionDefinitions", {
      stableKey,
      createdAtMs: nowMs,
    });
    const versionId = await ctx.db.insert("extensionVersions", {
      definitionId,
      version: 1,
      name: SHARED_NAME,
      fields: SHARED_FIELDS,
      changeNote: "product-published shared definition (proof fixture)",
      createdAtMs: nowMs,
    });
    await ctx.db.patch(definitionId, { currentVersionId: versionId });
    return okResult({ definitionId, versionId, created: true });
  },
});

export const probeSeedSharedExtension = action({
  args: {},
  handler: async (ctx): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.memory.extensions.probe.seedSharedExtension, {});
  },
});

// --- checked-path probe -------------------------------------------------------

/** Dispatches one memory envelope as the service identity (guarded). */
export const probeExtensionCommand = action({
  args: { envelope: v.any(), sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runMutation(internal.memory.findings.functions.dispatchMemoryTransaction, {
      envelope: args.envelope,
      serviceSessionId: sessionId,
    });
  },
});

// --- the Convex-validator refusal proof --------------------------------------

/**
 * Attempts a DIRECT insert of a deliberately invalid version snapshot and
 * reports whether the Convex table validator rejected it (guarded). A
 * validator refusal precedes the write, so nothing is stored; when an
 * earlier probe run DID manage to store one (Convex 1.45 cannot bound array
 * lengths, which is how the oversized case first slipped through), this
 * handler also removes its own version-99 debris so the shared leased
 * deployment stays clean for the next run.
 */
export const attemptInvalidVersionRow = internalMutation({
  args: { payload: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const shared = await ctx.db
      .query("extensionDefinitions")
      .filter((q) => q.eq(q.field("companyId"), undefined))
      .first();
    const definitionId = shared?._id;
    if (definitionId === undefined) {
      return errorResult(unsupportedError("memory.extensions.probe", "shared_fixture_missing"));
    }
    let rejected = false;
    try {
      await ctx.db.insert("extensionVersions", {
        definitionId,
        version: 99,
        name: "proof: invalid snapshot",
        fields: args.payload,
        changeNote: "validator refusal proof",
        createdAtMs: Date.now(),
      });
    } catch {
      rejected = true; // the Convex validator refused the row: nothing written
    }
    // Probe-debris cleanup: remove any version-99 rows this probe ever
    // managed to store (they are not real catalog history).
    const debris = await ctx.db
      .query("extensionVersions")
      .withIndex("by_definition_version", (q) =>
        q.eq("definitionId", definitionId).eq("version", 99),
      )
      .collect();
    for (const row of debris) {
      await ctx.db.delete(row._id);
    }
    return okResult({ rejected, debrisRemoved: debris.length });
  },
});

export const probeConvexValidatorRefuses = action({
  args: { payload: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    return ctx.runMutation(internal.memory.extensions.probe.attemptInvalidVersionRow, {
      payload: args.payload,
    });
  },
});

// --- inspection ----------------------------------------------------------------

/** Tenant-scoped extension catalog state for the evidence script (guarded). */
export const extensionState = internalQuery({
  args: { serviceSessionId: v.string() },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    const context = await resolveRequestContext(
      ctx.db,
      bridgeIdentity(args.serviceSessionId, Date.now()),
    );
    if (context === null) {
      return serviceIdentityUnavailable();
    }
    const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
    if (companyId === null) {
      return serviceIdentityUnavailable();
    }
    const own = await ctx.db
      .query("extensionDefinitions")
      .withIndex("by_company_key", (q) => q.eq("companyId", companyId))
      .collect();
    const shared = await ctx.db
      .query("extensionDefinitions")
      .filter((q) => q.eq(q.field("companyId"), undefined))
      .collect();
    const definitions = [];
    for (const definition of [...own, ...shared]) {
      const versions = await ctx.db
        .query("extensionVersions")
        .withIndex("by_definition_version", (q) => q.eq("definitionId", definition._id))
        .order("asc")
        .collect();
      definitions.push({
        definitionId: definition._id,
        stableKey: definition.stableKey,
        shared: definition.companyId === undefined,
        currentVersionId: definition.currentVersionId ?? null,
        versions: versions.map((version) => ({
          versionId: version._id,
          version: version.version,
          name: version.name,
          fields: version.fields,
          changeNote: version.changeNote,
        })),
      });
    }
    const usage = await ctx.db
      .query("extensionUsage")
      .withIndex("by_company_definition", (q) => q.eq("companyId", companyId))
      .collect();
    return okResult({
      definitions,
      usage: usage.map((row) => ({
        definitionId: row.definitionId,
        usedVersionId: row.usedVersionId,
        usageCount: row.usageCount,
        lastUsedAtMs: row.lastUsedAtMs,
      })),
    });
  },
});

export const probeExtensionState = action({
  args: { sessionId: v.optional(v.string()) },
  handler: async (ctx, args): Promise<ResultEnvelope> => {
    if (!probeGuardEnabled()) {
      return probeDisabled();
    }
    const sessionId = await resolveProbeSession(ctx, args.sessionId);
    if (sessionId === null) {
      return serviceIdentityUnavailable();
    }
    return ctx.runQuery(internal.memory.extensions.probe.extensionState, {
      serviceSessionId: sessionId,
    });
  },
});
