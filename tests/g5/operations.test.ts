/**
 * G5 focused verification, part 2: the personal project-selection write
 * (performSetSelection) over the in-memory db (tests/d2/harness.ts, the
 * d5/g3 precedent for transaction tests); the live proof in live-proof.mjs
 * runs the same function against the real dev deployment.
 *
 * The sibling-command discipline, pinned case by case: ownership is the
 * actor's own connection in the actor's own firm (otherwise not_found with
 * no existence leak); every stale or foreign project id is not_found with
 * no row written; duplicated ids fail validation; the write touches ONLY
 * the sync row's selectedProjects, which survives a projection-pass-shaped
 * patch unchanged.
 */

import { beforeEach, describe, expect, it } from "vitest";
import { parseTableId } from "@kiero/contracts";
import type { RequestContext } from "@kiero/runtime";
import { performSetSelection } from "../../convex/calendar/projection/operations";
import { asTx, fakeCtx } from "../d2/harness";

let ctx: ReturnType<typeof fakeCtx>;

const tx = () => asTx(ctx);

function contextFixture(userId: string, companyId: string): RequestContext {
  return {
    actor: {
      userId: parseTableId("users", userId),
      companyId: parseTableId("companies", companyId),
      membershipRole: "admin",
      isGm: false,
      sessionId: parseTableId("sessions", "s1"),
      via: "user",
    },
    resolvedAtMs: Date.now(),
  } as unknown as RequestContext;
}

interface Firm {
  readonly companyId: string;
  readonly userId: string;
  readonly connectionId: string;
  readonly projectIds: string[];
}

/** One boss with a connected calendar in their own firm plus two projects. */
async function seedFirm(label: string): Promise<Firm> {
  const companyId = await ctx.db.insert("companies", {
    name: `g5-${label}`,
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
    createdAtMs: 1,
  });
  const userId = await ctx.db.insert("users", {
    email: `${label}@kiero.invalid`,
    displayName: label,
    createdAtMs: 1,
  });
  const connectionId = await ctx.db.insert("calendarConnections", {
    companyId,
    userId,
    state: "connected",
    updatedAtMs: 1,
  });
  const projectIds = [
    await ctx.db.insert("projects", {
      companyId,
      displayName: `Kaczmarek ${label}`,
      stage: "in_progress",
      createdAtMs: 1,
    }),
    await ctx.db.insert("projects", {
      companyId,
      displayName: `Nowak ${label}`,
      stage: "in_progress",
      createdAtMs: 1,
    }),
  ];
  return { companyId, userId, connectionId, projectIds };
}

async function syncRowOf(connectionId: string): Promise<Record<string, unknown> | null> {
  return await ctx.db
    .query("calendarSyncState")
    .withIndex("by_connection", (q) => q.eq("connectionId", connectionId))
    .first();
}

beforeEach(() => {
  ctx = fakeCtx(["companies", "users", "projects", "calendarConnections", "calendarSyncState"]);
});

describe("the happy writes (criterion 1: the certified dispatch executes)", () => {
  it("stores an explicit selection, creating the sync row when none exists", async () => {
    const firm = await seedFirm("a");
    const result = await performSetSelection(tx(), contextFixture(firm.userId, firm.companyId), {
      mode: "explicit",
      projectIds: [firm.projectIds[0]!],
    });
    expect(result._tag).toBe("ok");
    if (result._tag === "ok") {
      expect(result.value).toEqual({
        mode: "explicit",
        projectIds: [firm.projectIds[0]],
      });
    }
    const row = await syncRowOf(firm.connectionId);
    expect(row?.selectedProjects).toEqual({
      mode: "explicit",
      projectIds: [firm.projectIds[0]],
    });
  });

  it("patches the SAME row on a second write (never duplicates)", async () => {
    const firm = await seedFirm("b");
    const context = contextFixture(firm.userId, firm.companyId);
    await performSetSelection(tx(), context, {
      mode: "explicit",
      projectIds: firm.projectIds,
    });
    const second = await performSetSelection(tx(), context, { mode: "all_projects" });
    expect(second._tag).toBe("ok");
    if (second._tag === "ok") {
      expect(second.value).toEqual({ mode: "all_projects", projectIds: null });
    }
    const rows = await ctx.db.query("calendarSyncState").collect();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.selectedProjects).toEqual({ mode: "all_projects" });
  });

  it("accepts the empty explicit list as the honest opt-out", async () => {
    const firm = await seedFirm("c");
    const result = await performSetSelection(tx(), contextFixture(firm.userId, firm.companyId), {
      mode: "explicit",
      projectIds: [],
    });
    expect(result._tag).toBe("ok");
    const row = await syncRowOf(firm.connectionId);
    expect(row?.selectedProjects).toEqual({ mode: "explicit", projectIds: [] });
  });
});

describe("fail-closed ownership (the sibling command discipline)", () => {
  it("is not_found without a connection row (nothing to scope)", async () => {
    const firm = await seedFirm("d");
    const result = await performSetSelection(
      tx(),
      contextFixture(firm.userId, firm.companyId),
      { mode: "all_projects" },
    );
    // The firm above owns a connection; use a boss without one.
    const lonerId = await ctx.db.insert("users", {
      email: "loner@kiero.invalid",
      displayName: "loner",
      createdAtMs: 1,
    });
    const result2 = await performSetSelection(tx(), contextFixture(lonerId, firm.companyId), {
      mode: "all_projects",
    });
    expect(result._tag).toBe("ok");
    expect(result2._tag).toBe("error");
    if (result2._tag === "error" && result2.error._tag === "not_found") {
      expect(result2.error.entity).toBe("calendarConnections");
    } else {
      throw new Error("expected a not_found error naming calendarConnections");
    }
  });

  it("is not_found when the row belongs to another firm (no existence leak)", async () => {
    const firm = await seedFirm("e");
    const other = await seedFirm("f");
    // The actor's resolved company is `other`, the row's firm is `firm`.
    const result = await performSetSelection(tx(), contextFixture(firm.userId, other.companyId), {
      mode: "all_projects",
    });
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("not_found");
    }
    expect(await syncRowOf(firm.connectionId)).toBeNull();
  });

  it("is not_found for a foreign firm's project id, with no row written", async () => {
    const firm = await seedFirm("g");
    const other = await seedFirm("h");
    const result = await performSetSelection(tx(), contextFixture(firm.userId, firm.companyId), {
      mode: "explicit",
      projectIds: [other.projectIds[0]!],
    });
    expect(result._tag).toBe("error");
    if (result._tag === "error" && result.error._tag === "not_found") {
      expect(result.error.entity).toBe("projects");
    } else {
      throw new Error("expected a not_found error naming projects");
    }
    expect(await syncRowOf(firm.connectionId)).toBeNull();
  });

  it("is not_found for a malformed project id (normalizeId rejects it)", async () => {
    const firm = await seedFirm("i");
    const result = await performSetSelection(tx(), contextFixture(firm.userId, firm.companyId), {
      mode: "explicit",
      projectIds: ["not-a-convex-id"],
    });
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("not_found");
    }
    expect(await syncRowOf(firm.connectionId)).toBeNull();
  });

  it("fails validation on duplicated project ids before anything is written", async () => {
    const firm = await seedFirm("j");
    const result = await performSetSelection(tx(), contextFixture(firm.userId, firm.companyId), {
      mode: "explicit",
      projectIds: [firm.projectIds[0]!, firm.projectIds[0]!],
    });
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("validation");
      expect(result.error.code).toBe("duplicate_project_ids");
    }
    expect(await syncRowOf(firm.connectionId)).toBeNull();
  });
});

describe("the pass-consumption seam (criterion 2)", () => {
  it("survives a projection-pass-shaped patch unchanged", async () => {
    const firm = await seedFirm("k");
    await performSetSelection(tx(), contextFixture(firm.userId, firm.companyId), {
      mode: "explicit",
      projectIds: [firm.projectIds[1]!],
    });
    const row = await syncRowOf(firm.connectionId);
    if (row === null) {
      throw new Error("sync row vanished");
    }
    // Exactly the columns applyProjectionPassTransaction patches on a
    // healthy pass: the selection column is not among them.
    await ctx.db.patch(row._id as string, {
      state: "idle",
      suspendedReason: undefined,
      lastPassAtMs: 5_000,
      updatedAtMs: 5_000,
    });
    const after = await syncRowOf(firm.connectionId);
    expect(after?.selectedProjects).toEqual({
      mode: "explicit",
      projectIds: [firm.projectIds[1]],
    });
  });

  it("stores the selection on a disconnected connection too (a Kiero-side preference)", async () => {
    const firm = await seedFirm("l");
    await ctx.db.patch("calendarConnections", firm.connectionId, { state: "disconnected" });
    const result = await performSetSelection(tx(), contextFixture(firm.userId, firm.companyId), {
      mode: "explicit",
      projectIds: [firm.projectIds[0]!],
    });
    expect(result._tag).toBe("ok");
    const row = await syncRowOf(firm.connectionId);
    expect(row?.selectedProjects).toEqual({
      mode: "explicit",
      projectIds: [firm.projectIds[0]],
    });
  });
});
