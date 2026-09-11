/**
 * Shared plumbing for the sources lanes' guarded probe surfaces (D1; D2/D3
 * and later lanes reuse it instead of growing copies).
 *
 * One place for: the deployment-variable guard (the A3 probe pattern —
 * platform's own copy stays in convex/platform/probe.ts, which the sources
 * lanes do not own), the service-session resolution through the A3-proved
 * bridge identity, and the seeded-identity email → user → live session →
 * canonical request-context chain. Sessions are created server-side by the
 * seeding mutations; no identity is ever accepted from client input, and a
 * missing/revoked/incomplete chain resolves to null, which callers surface
 * as the sanitized `forbidden` service-identity error.
 *
 * E7 append (flagged, review round 1, issue #115): the fixture and
 * inspection BODIES the later lanes' probes share: one witnessed
 * (optionally project-linked) source, the service-company project seeder,
 * the second-company identity chain, and the bounded tenant-scoped walks
 * (sources with links, findings with revisions, recompute jobs, reanalysis
 * runs, outbox events). Grown here because E7's probe transcribed
 * ~200 lines of C5's probe verbatim; each lane keeps only its deltas
 * (its proof stamp, its fixture set, its wire-row mapping).
 */

import { errorResult, type ResultEnvelope } from "@kiero/contracts";
import { forbiddenError, unsupportedError, type RequestContext } from "@kiero/runtime";
import { api } from "../_generated/api";
import type { ActionCtx, MutationCtx, QueryCtx } from "../_generated/server";
import type { Id, Doc } from "../_generated/dataModel";
import { bridgeIdentity, resolveRequestContext, type ResolutionDb } from "../platform/context";

/** The A3 platform proof service account (seeded by platform/probe:probeSeed). */
export const SERVICE_EMAIL = "platform-service@kiero.invalid";

/** The D1 tenant-isolation fixture account (seeded by ./probe seedIsolation). */
export const ISOLATION_EMAIL = "d1-isolation@kiero.invalid";

/** The D1 tenant-isolation fixture company name. */
export const ISOLATION_COMPANY = "Kiero Dev Proof B (D1 isolation)";

/** The deployment guard, identical to the A3 platform probes. */
export function probeGuardEnabled(): boolean {
  return process.env.KIERO_PROBE_ENABLED === "1";
}

/** The guarded-entry refusal envelope (probe mechanics disabled). */
export function probeDisabled(): ResultEnvelope {
  return errorResult(unsupportedError("sources.probe", "probe_guard_disabled"));
}

/** The sanitized refusal for an unresolvable service identity. */
export function serviceIdentityUnavailable(): ResultEnvelope {
  return errorResult(forbiddenError("service_identity_unavailable"));
}

/** Resolves the service account's session id (the A3 fixture identity). */
export async function serviceSessionId(ctx: ActionCtx): Promise<string | null> {
  const session = await ctx.runQuery(api.platform.probe.serviceSession, {});
  return session === null ? null : session.sessionId;
}

/**
 * Resolves an explicitly seeded session id, falling back to the service
 * session. Explicit ids come only from server-side seeding mutations.
 */
export async function resolveProbeSession(
  ctx: ActionCtx,
  sessionId: string | undefined,
): Promise<string | null> {
  return sessionId ?? (await serviceSessionId(ctx));
}

/**
 * The seeded-identity chain for one email: user row → latest non-revoked
 * session → canonical request context through the verified bridge identity.
 * Returns null for any broken chain (unknown email, no live session,
 * revoked session, no active membership, missing company).
 */
export async function bridgeContextForEmail(
  db: ResolutionDb,
  email: string,
): Promise<RequestContext | null> {
  const user = await db
    .query("users")
    .withIndex("by_email", (q) => q.eq("email", email))
    .first();
  if (user === null) {
    return null;
  }
  const session = await db
    .query("sessions")
    .withIndex("by_user_started", (q) => q.eq("userId", user._id))
    .order("desc")
    .filter((q) => q.eq(q.field("revokedAtMs"), undefined))
    .first();
  if (session === null) {
    return null;
  }
  return resolveRequestContext(db, bridgeIdentity(session._id, Date.now()));
}

// ---------------------------------------------------------------------------
// E7 append (flagged): the shared fixture bodies.
// ---------------------------------------------------------------------------

/** The lane-specific stamp every seeded fixture row carries. */
export interface ProofStamp {
  readonly timezone: string;
  readonly sentAtMs: number;
  readonly pipelineVersion: string;
  /** The acceptance-fingerprint prefix (e.g. `e7-proof:`). */
  readonly fingerprintPrefix: string;
}

/** One seeded witnessed source: its row ids ("" when a part is absent). */
export interface SeededSource {
  readonly sourceId: string;
  readonly fragmentId: string;
  readonly extractionId: string;
}

/**
 * Ensures one witnessed source (run + text extraction + whole-source
 * fragment), optionally linked to the given projects; idempotent by
 * acceptance key within one proof run. The C5/E7 probe bodies unified.
 */
export async function ensureWitnessedSource(
  db: MutationCtx["db"],
  args: {
    readonly companyId: Id<"companies">;
    readonly userId: Id<"users">;
    readonly acceptanceKey: string;
    readonly authorText: string;
    readonly stamp: ProofStamp;
    /** The project links to insert on creation (the placement under proof). */
    readonly projectIds?: readonly Id<"projects">[];
  },
): Promise<SeededSource> {
  const existing = await db
    .query("sources")
    .withIndex("by_company_acceptance_key", (q) =>
      q.eq("companyId", args.companyId).eq("acceptanceKey", args.acceptanceKey),
    )
    .first();
  if (existing !== null) {
    const fragment = await db
      .query("sourceFragments")
      .withIndex("by_source", (q) => q.eq("sourceId", existing._id))
      .first();
    const extraction = fragment === null ? null : await db.get(fragment.extractionId);
    return {
      sourceId: existing._id,
      fragmentId: fragment?._id ?? "",
      extractionId: extraction?._id ?? "",
    };
  }
  const nowMs = Date.now();
  const sourceId = await db.insert("sources", {
    companyId: args.companyId,
    authorUserId: args.userId,
    authorText: args.authorText,
    sentAtMs: args.stamp.sentAtMs,
    sentAtTimezone: args.stamp.timezone,
    fullyAcceptedAtMs: nowMs,
    lifecycle: "active",
    acceptanceKey: args.acceptanceKey,
    acceptanceFingerprint: `${args.stamp.fingerprintPrefix}${args.acceptanceKey}`,
  });
  const runId = await db.insert("processingRuns", {
    companyId: args.companyId,
    sourceId,
    kind: "initial_analysis",
    pipelineVersion: args.stamp.pipelineVersion,
    promptVersion: "none",
    schemaVersion: "none",
    modelConfigurationVersion: "none",
    state: "succeeded",
    startedAtMs: nowMs,
  });
  const extractionId = await db.insert("extractions", {
    sourceId,
    kind: "text",
    pipelineVersion: args.stamp.pipelineVersion,
    model: "author-text",
    provider: "kiero",
    processingRunId: runId,
    createdAtMs: nowMs,
  });
  const fragmentId = await db.insert("sourceFragments", {
    extractionId,
    sourceId,
    anchor: { _tag: "whole_source" },
    createdAtMs: nowMs,
  });
  for (const projectId of args.projectIds ?? []) {
    await db.insert("sourceProjectLinks", {
      sourceId,
      projectId,
      assignedByUserId: args.userId,
      assignedAtMs: nowMs,
      sentAtMs: args.stamp.sentAtMs,
    });
  }
  return { sourceId, fragmentId, extractionId };
}

/** Ensures one project in a company (idempotent by display name). */
export async function ensureProject(
  db: MutationCtx["db"],
  companyId: Id<"companies">,
  displayName: string,
): Promise<Id<"projects">> {
  const existing = await db
    .query("projects")
    .withIndex("by_company_stage", (q) => q.eq("companyId", companyId))
    .filter((q) => q.eq(q.field("displayName"), displayName))
    .first();
  if (existing !== null) {
    return existing._id;
  }
  return db.insert("projects", {
    companyId,
    displayName,
    stage: "inquiry",
    stageRevision: 1,
    createdAtMs: Date.now(),
  });
}

/** The second-company identity a lane's isolation proof acts as. */
export interface IsolationIdentity {
  readonly email: string;
  readonly companyName: string;
  /** The seeded user's display name. */
  readonly displayName: string;
  /** The seeded bridge session's device label. */
  readonly deviceLabel: string;
}

/**
 * Ensures the second-company fixture chain (the tenant-isolation prover):
 * user → company → active admin membership → live session, idempotent per
 * identity. The C5/E7 isolation seeders unified.
 */
export async function ensureIsolationIdentity(
  db: MutationCtx["db"],
  identity: IsolationIdentity,
): Promise<{
  userId: Id<"users">;
  companyId: Id<"companies">;
  sessionId: Id<"sessions">;
}> {
  const existingUser = await db
    .query("users")
    .withIndex("by_email", (q) => q.eq("email", identity.email))
    .first();
  const userId =
    existingUser?._id ??
    (await db.insert("users", {
      email: identity.email,
      displayName: identity.displayName,
      createdAtMs: Date.now(),
    }));
  const existingCompany = await db
    .query("companies")
    .filter((q) => q.eq(q.field("name"), identity.companyName))
    .first();
  const companyId =
    existingCompany?._id ??
    (await db.insert("companies", {
      name: identity.companyName,
      timezone: "Europe/Warsaw",
      defaultCurrency: "PLN",
      createdAtMs: Date.now(),
    }));
  const existingMembership = await db
    .query("memberships")
    .withIndex("by_company_user", (q) => q.eq("companyId", companyId).eq("userId", userId))
    .first();
  // `.first()` yields null (not undefined) when absent: the null check is
  // load-bearing (the C2 probe comment documents the same trap).
  if (existingMembership === null) {
    await db.insert("memberships", {
      companyId,
      userId,
      role: "admin",
      state: "active",
      createdAtMs: Date.now(),
    });
  }
  const existingSession = await db
    .query("sessions")
    .withIndex("by_user_started", (q) => q.eq("userId", userId))
    .order("desc")
    .filter((q) => q.eq(q.field("revokedAtMs"), undefined))
    .first();
  const sessionId =
    existingSession?._id ??
    (await db.insert("sessions", {
      userId,
      startedAtMs: Date.now(),
      lastSeenAtMs: Date.now(),
      deviceLabel: identity.deviceLabel,
    }));
  return { userId, companyId, sessionId };
}

// ---------------------------------------------------------------------------
// E7 append (flagged): the shared tenant-scoped inspection walks. Each lane
// maps its own wire rows; the bounded walks themselves exist once.
// ---------------------------------------------------------------------------

/** The DB reader surface the inspection walks need (query or mutation). */
type InspectionDb = MutationCtx["db"] | QueryCtx["db"];

/** Every source of the company with its CURRENT project links. */
export async function companySourcesWithLinks(
  db: InspectionDb,
  companyId: Id<"companies">,
): Promise<Array<{ source: Doc<"sources">; links: Doc<"sourceProjectLinks">[] }>> {
  const sources = await db
    .query("sources")
    .withIndex("by_company_order", (q) => q.eq("companyId", companyId))
    .collect();
  const rows: Array<{ source: Doc<"sources">; links: Doc<"sourceProjectLinks">[] }> = [];
  for (const source of sources) {
    const links = await db
      .query("sourceProjectLinks")
      .withIndex("by_source", (q) => q.eq("sourceId", source._id))
      .collect();
    rows.push({ source, links });
  }
  return rows;
}

/** Every finding of the company with its full revision history (asc). */
export async function companyFindingRevisions(
  db: InspectionDb,
  companyId: Id<"companies">,
): Promise<Array<{ finding: Doc<"findings">; revisions: Doc<"findingRevisions">[] }>> {
  const findings = await db
    .query("findings")
    .withIndex("by_company_scope_key", (q) => q.eq("companyId", companyId))
    .collect();
  const rows: Array<{ finding: Doc<"findings">; revisions: Doc<"findingRevisions">[] }> = [];
  for (const finding of findings) {
    const revisions = await db
      .query("findingRevisions")
      .withIndex("by_finding_revision", (q) => q.eq("findingId", finding._id))
      .order("asc")
      .collect();
    rows.push({ finding, revisions });
  }
  return rows;
}

/**
 * The company's durable jobs of the memory reactions (recompute and change
 * plan analysis), the two kinds every memory-side proof asserts on.
 */
export async function companyMemoryJobs(
  db: InspectionDb,
  companyId: Id<"companies">,
): Promise<Doc<"durableJobs">[]> {
  return db
    .query("durableJobs")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .filter((q) =>
      q.or(
        q.eq(q.field("kind"), "memory.recompute_dependents"),
        q.eq(q.field("kind"), "processing.analyze_change_plan"),
      ),
    )
    .collect();
}

/** The company's `reanalysis` processing runs (the E3 revalidation seam). */
export async function companyReanalysisRuns(
  db: InspectionDb,
  companyId: Id<"companies">,
): Promise<Doc<"processingRuns">[]> {
  return db
    .query("processingRuns")
    .withIndex("by_company_state", (q) => q.eq("companyId", companyId))
    .filter((q) => q.eq(q.field("kind"), "reanalysis"))
    .collect();
}

/** Every outbox event of the company (the lane filters its own names). */
export async function companyOutboxEvents(
  db: InspectionDb,
  companyId: Id<"companies">,
): Promise<Doc<"outboxEvents">[]> {
  return db
    .query("outboxEvents")
    .withIndex("by_company", (q) => q.eq("companyId", companyId))
    .collect();
}
