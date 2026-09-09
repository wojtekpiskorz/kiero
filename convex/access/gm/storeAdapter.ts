/**
 * The generated-ctx adapter (B4): maps the Convex mutation/query context
 * onto the GM store surfaces from ./store.ts.
 *
 * `normalizeId` is the proved id bridge (A3): the cores speak plain-string
 * ids, typed index chains live only here. Projections stay bounded and
 * payload-free — inspection reads carry ids, states and timestamps only,
 * never source content or job inputs.
 */

import type { QueryCtx, MutationCtx } from "../../_generated/server";
import type { Doc } from "../../_generated/dataModel";
import type { GmActivationView, GmGrantView } from "./cores";
import type { GmStore, GmTx, GmCompanyView, GmRunRow, GmJobRow, GmMembershipRow } from "./store";

type GmDb = QueryCtx["db"];

function grantViewOf(row: Doc<"gmAccessGrants">): GmGrantView {
  return {
    id: row._id,
    userId: row.userId,
    reason: row.reason,
    enteredAtMs: row.enteredAtMs,
    closedAtMs: row.closedAtMs ?? null,
  };
}

function activationViewOf(row: Doc<"gmCompanyActivations">): GmActivationView {
  return {
    id: row._id,
    companyId: row.companyId,
    activatedAtMs: row.activatedAtMs,
    endedAtMs: row.endedAtMs ?? null,
  };
}

function companyViewOf(row: Doc<"companies">): GmCompanyView {
  return {
    id: row._id,
    name: row.name,
    timezone: row.timezone,
    defaultCurrency: row.defaultCurrency,
  };
}

/** Adapts a Convex reader to the GM read surface. */
export function gmStore(db: GmDb): GmStore {
  return {
    userById: async (userId) => {
      const id = db.normalizeId("users", userId);
      if (id === null) {
        return null;
      }
      const user = await db.get(id);
      return user === null ? null : { id: user._id, email: user.email };
    },
    grantById: async (grantId) => {
      const id = db.normalizeId("gmAccessGrants", grantId);
      if (id === null) {
        return null;
      }
      const row = await db.get(id);
      return row === null ? null : grantViewOf(row);
    },
    grantsOfUser: async (userId) => {
      const id = db.normalizeId("users", userId);
      if (id === null) {
        return [];
      }
      const rows = await db
        .query("gmAccessGrants")
        .withIndex("by_user_open", (q) => q.eq("userId", id))
        .collect();
      return rows.map(grantViewOf);
    },
    companyById: async (companyId) => {
      const id = db.normalizeId("companies", companyId);
      if (id === null) {
        return null;
      }
      const row = await db.get(id);
      return row === null ? null : companyViewOf(row);
    },
    openActivationOf: async (companyId) => {
      const id = db.normalizeId("companies", companyId);
      if (id === null) {
        return null;
      }
      const rows = await db
        .query("gmCompanyActivations")
        .withIndex("by_company_open", (q) => q.eq("companyId", id))
        .collect();
      // Sort in JS by activation time, never by index order: the index's
      // second field is the OPTIONAL endedAtMs, whose placement would decide
      // which row "first()" sees. The newest OPEN row is the authority.
      const open = rows
        .filter((row) => row.endedAtMs === undefined)
        .sort((a, b) => b.activatedAtMs - a.activatedAtMs);
      return open[0] === undefined ? null : activationViewOf(open[0]);
    },
    latestActivationOf: async (companyId) => {
      const id = db.normalizeId("companies", companyId);
      if (id === null) {
        return null;
      }
      const rows = await db
        .query("gmCompanyActivations")
        .withIndex("by_company_open", (q) => q.eq("companyId", id))
        .collect();
      // Same ruling as openActivationOf: ordering by activatedAtMs in JS.
      // (An index-order ".order('desc').first()" here returned the row with
      // the greatest endedAtMs — a CLOSED row — and missed the open one.)
      const sorted = rows.sort((a, b) => b.activatedAtMs - a.activatedAtMs);
      return sorted[0] === undefined ? null : activationViewOf(sorted[0]);
    },
    membershipsOfCompany: async (companyId) => {
      const id = db.normalizeId("companies", companyId);
      if (id === null) {
        return [];
      }
      const rows = await db
        .query("memberships")
        .withIndex("by_company_user", (q) => q.eq("companyId", id))
        .collect();
      const projected: GmMembershipRow[] = rows.map((row) => ({
        membershipId: row._id,
        companyId: row.companyId,
        userId: row.userId,
        role: row.role,
        state: row.state,
      }));
      return projected.sort((a, b) => a.membershipId.localeCompare(b.membershipId));
    },
    recentRunsOfCompany: async (companyId, limit) => {
      const id = db.normalizeId("companies", companyId);
      if (id === null) {
        return [];
      }
      const rows = await db
        .query("processingRuns")
        .withIndex("by_company_state", (q) => q.eq("companyId", id))
        .collect();
      const projected: GmRunRow[] = rows.map((row) => ({
        runId: row._id,
        kind: row.kind,
        state: row.state,
        startedAtMs: row.startedAtMs,
        finishedAtMs: row.finishedAtMs ?? null,
      }));
      return projected.sort((a, b) => b.startedAtMs - a.startedAtMs).slice(0, limit);
    },
    recentJobsOfCompany: async (companyId, limit) => {
      const id = db.normalizeId("companies", companyId);
      if (id === null) {
        return [];
      }
      const rows = await db
        .query("durableJobs")
        .withIndex("by_company", (q) => q.eq("companyId", id))
        .collect();
      const projected: GmJobRow[] = rows.map((row) => ({
        jobId: row._id,
        kind: row.kind,
        state: row.state,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
        lastErrorKind: row.lastErrorKind ?? null,
      }));
      return projected
        .sort((a, b) => a.jobId.localeCompare(b.jobId))
        .slice(0, limit);
    },
  };
}

/** Adapts one Convex mutation transaction to the GM write surface. */
export function gmTx(tx: MutationCtx): GmTx {
  const store = gmStore(tx.db);
  return {
    ...store,
    insertGrant: async (row) => {
      const userId = tx.db.normalizeId("users", row.userId);
      if (userId === null) {
        throw new Error("gm: invalid user id");
      }
      return await tx.db.insert("gmAccessGrants", {
        userId,
        reason: row.reason,
        enteredAtMs: row.enteredAtMs,
      });
    },
    closeGrant: async (grantId, closedAtMs) => {
      const id = tx.db.normalizeId("gmAccessGrants", grantId);
      if (id === null) {
        return false;
      }
      const row = await tx.db.get(id);
      if (row === null || row.closedAtMs !== undefined) {
        return false;
      }
      await tx.db.patch(id, { closedAtMs });
      return true;
    },
    insertCompany: async (row) => {
      return await tx.db.insert("companies", {
        name: row.name,
        timezone: row.timezone,
        defaultCurrency: row.defaultCurrency,
        createdAtMs: row.createdAtMs,
      });
    },
    insertActivation: async (row) => {
      const companyId = tx.db.normalizeId("companies", row.companyId);
      const activatedByUserId = tx.db.normalizeId("users", row.activatedByUserId);
      if (companyId === null || activatedByUserId === null) {
        throw new Error("gm: invalid activation reference");
      }
      return await tx.db.insert("gmCompanyActivations", {
        companyId,
        activatedByUserId,
        activatedAtMs: row.activatedAtMs,
      });
    },
    endActivation: async (activationId, endedAtMs, endedByUserId) => {
      const id = tx.db.normalizeId("gmCompanyActivations", activationId);
      const byUser = tx.db.normalizeId("users", endedByUserId);
      if (id === null || byUser === null) {
        return false;
      }
      const row = await tx.db.get(id);
      if (row === null || row.endedAtMs !== undefined) {
        return false;
      }
      await tx.db.patch(id, { endedAtMs, endedByUserId: byUser });
      return true;
    },
    insertInvitation: async (row) => {
      const companyId = tx.db.normalizeId("companies", row.companyId);
      const issuedByUserId = tx.db.normalizeId("users", row.issuedByUserId);
      if (companyId === null || issuedByUserId === null) {
        throw new Error("gm: invalid invitation reference");
      }
      return await tx.db.insert("invitations", {
        companyId,
        email: row.email,
        role: row.role,
        state: "pending",
        codeHash: row.codeHash,
        expiresAtMs: row.expiresAtMs,
        createdAtMs: row.createdAtMs,
        issuedByUserId,
      });
    },
    patchMembershipRole: async (membershipId, role) => {
      const id = tx.db.normalizeId("memberships", membershipId);
      if (id === null) {
        return false;
      }
      const row = await tx.db.get(id);
      if (row === null) {
        return false;
      }
      await tx.db.patch(id, { role });
      return true;
    },
    insertAudit: async (row) => {
      const actorUserId = tx.db.normalizeId("users", row.actorUserId);
      const gmGrantId = tx.db.normalizeId("gmAccessGrants", row.gmGrantId);
      if (actorUserId === null || gmGrantId === null) {
        throw new Error("gm: invalid audit reference");
      }
      // null companyId is a valid GM audit shape (mode entry/exit and
      // account recovery are not company-scoped); only an unnormalizable
      // non-null reference fails.
      const companyId =
        row.companyId === null
          ? null
          : tx.db.normalizeId("companies", row.companyId);
      if (companyId === null && row.companyId !== null) {
        throw new Error("gm: invalid audit company reference");
      }
      await tx.db.insert("auditRecords", {
        actorUserId,
        gmGrantId,
        ...(companyId !== null && { companyId }),
        operationName: row.operationName,
        gmBasis: row.gmBasis,
        outcome: row.outcome,
        atMs: row.atMs,
      });
    },
  };
}
