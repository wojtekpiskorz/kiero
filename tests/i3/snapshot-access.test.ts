/**
 * I3 focused verification, part 2: the tenant-scoped snapshot reader and the
 * download access resolution, driven over in-memory stores (the D2/D3
 * harness pattern — the SAME code the deployment runs, no cloud needed).
 *
 * The snapshot matrix pins: one declared snapshot time for everything;
 * another company's rows cannot enter by id; purged sources are excluded
 * and never linked; withdrawn sources stay (CONTEXT.md keeps their history);
 * bounds refuse the whole snapshot; and the retained-or-received media rule
 * agrees with D3's own resolver on shared fixtures (the declared consumer
 * seam).
 *
 * The access matrix pins: a current administrator is granted the ledger
 * record; a member refuses forbidden; a foreign company's export answers
 * EXACTLY like a nonexistent one; expiry and a linked purge refuse the
 * uniform not-found, and the purge flags the row for invalidation.
 */

import { describe, expect, it } from "vitest";
import {
  readCompanySnapshot,
  snapshotDb as _unused,
  sourceArchiveTarget,
  type SnapshotDb,
} from "../../convex/operations/exports/snapshot";
import { serializeSourceReference } from "../../apps/web/src/features/source-detail/source-route";
import { resolveExportAccess, type ExportAccessDb } from "../../convex/operations/exports/access";
import { resolveMediaAccess, mediaAccessDb as _unused2, type MediaAccessDb } from "../../convex/sources/media_access/access";
import { EXPORT_BOUNDS } from "../../convex/operations/exports/protocol";
import type { RequestContext } from "@kiero/runtime";
import type { Doc, Id } from "../../convex/_generated/dataModel";

void _unused;
void _unused2;

// --- fixture rows (typed as the generated docs, built by hand) -----------------

const companyA = { _id: "kc1" as unknown as Id<"companies">, name: "Firma A", timezone: "Europe/Warsaw", defaultCurrency: "PLN", createdAtMs: 1 } as Doc<"companies">;
const companyB = { _id: "kc2" as unknown as Id<"companies">, name: "Firma B", timezone: "Europe/Warsaw", defaultCurrency: "PLN", createdAtMs: 1 } as Doc<"companies">;
const user = { _id: "ku1" as unknown as Id<"users">, email: "a@kiero.invalid", displayName: "Anna", createdAtMs: 1 } as Doc<"users">;

function sourceRow(id: string, companyId: Id<"companies">, lifecycle: "active" | "withdrawn" | "purged"): Doc<"sources"> {
  return {
    _id: id as unknown as Id<"sources">,
    companyId,
    authorUserId: user._id,
    authorText: `treść ${id}`,
    sentAtMs: 2,
    sentAtTimezone: "Europe/Warsaw",
    fullyAcceptedAtMs: 2,
    lifecycle,
    createdAtMs: 1,
  } as unknown as Doc<"sources">;
}

function attachmentRow(id: string, sourceId: string): Doc<"attachments"> {
  return {
    _id: id as unknown as Id<"attachments">,
    uploadId: "u" as unknown as Id<"uploads">,
    sourceId: sourceId as unknown as Id<"sources">,
    kind: "image",
    objectKey: `companies/${sourceId}/${id}`,
    createdAtMs: 1,
    r2ObjectEtag: `etag-${id}`,
    receivedBytes: 10,
  } as unknown as Doc<"attachments">;
}

function representationRow(
  id: string,
  attachmentId: string,
  role: "received" | "retained" | "thumbnail",
  over: Partial<Doc<"mediaRepresentations">> = {},
): Doc<"mediaRepresentations"> {
  return {
    _id: id as unknown as Id<"mediaRepresentations">,
    attachmentId: attachmentId as unknown as Id<"attachments">,
    role,
    objectKey: `media/${attachmentId}/${id}`,
    contentHash: "r2:etag:x",
    transformVersion: "v1",
    createdAtMs: role === "retained" ? 5 : 1,
    verifiedAtMs: 1,
    bytes: role === "retained" ? 8 : undefined,
    mimeType: role === "retained" ? "image/webp" : undefined,
    ...over,
  } as unknown as Doc<"mediaRepresentations">;
}

interface World {
  companies: Doc<"companies">[];
  users: Doc<"users">[];
  memberships: Doc<"memberships">[];
  sources: Doc<"sources">[];
  attachments: Doc<"attachments">[];
  representations: Doc<"mediaRepresentations">[];
  projects: Doc<"projects">[];
  tasks: Doc<"tasks">[];
  events: Doc<"events">[];
  findings: Doc<"findings">[];
}

/** The in-memory SnapshotDb (one method per collection, exact reads). */
function fakeSnapshotDb(world: World): SnapshotDb {
  const ofCompany = <T extends { companyId: Id<"companies"> }>(rows: T[], companyId: Id<"companies">) =>
    rows.filter((row) => row.companyId === companyId);
  return {
    companyById: async (id) => world.companies.find((c) => c._id === id) ?? null,
    membershipsOfCompany: async (companyId) => ofCompany(world.memberships, companyId),
    userById: async (id) => world.users.find((u) => u._id === id) ?? null,
    projectsOfCompany: async (companyId) => ofCompany(world.projects as Doc<"projects">[], companyId),
    aliasesOfCompany: async () => [],
    contactsOfCompany: async () => [],
    contactRolesOfCompany: async () => [],
    sourcesOfCompany: async (companyId) => ofCompany(world.sources, companyId),
    projectLinksOfSource: async () => [],
    extractionsOfSource: async () => [],
    fragmentsOfSource: async () => [],
    attachmentsOfSource: async (sourceId) =>
      world.attachments.filter((a) => a.sourceId === sourceId),
    representationsOfAttachment: async (attachmentId) =>
      world.representations.filter((r) => r.attachmentId === attachmentId),
    findingsOfCompany: async (companyId) => ofCompany(world.findings as Doc<"findings">[], companyId),
    revisionsOfFinding: async () => [],
    evidenceOfRevision: async () => [],
    dependenciesOfCompany: async () => [],
    clarificationsOfCompany: async () => [],
    extensionDefinitionsOfCompany: async () => [],
    extensionDefinitionById: async () => null,
    versionsOfDefinition: async () => [],
    extensionVersionById: async () => null,
    tasksOfCompany: async (companyId) => ofCompany(world.tasks as Doc<"tasks">[], companyId),
    checklistItemsOfTask: async () => [],
    eventsOfCompany: async (companyId) => ofCompany(world.events as Doc<"events">[], companyId),
    workRevisionsOfCompany: async () => [],
  };
}

function baseWorld(): World {
  return {
    companies: [companyA, companyB],
    users: [user],
    memberships: [
      { _id: "m1" as unknown as Id<"memberships">, companyId: companyA._id, userId: user._id, role: "admin", state: "active", createdAtMs: 1 } as Doc<"memberships">,
      { _id: "m2" as unknown as Id<"memberships">, companyId: companyB._id, userId: user._id, role: "member", state: "active", createdAtMs: 1 } as Doc<"memberships">,
    ],
    sources: [
      sourceRow("s1", companyA._id, "active"),
      sourceRow("s2", companyA._id, "withdrawn"),
      sourceRow("s3", companyA._id, "purged"),
      sourceRow("sB", companyB._id, "active"),
    ],
    attachments: [attachmentRow("at1", "s1"), attachmentRow("at3", "s3"), attachmentRow("atB", "sB")],
    representations: [
      representationRow("r1-received", "at1", "received"),
      representationRow("r1-retained", "at1", "retained"),
      representationRow("r3", "at3", "retained"),
      representationRow("rB", "atB", "retained"),
    ],
    projects: [
      { _id: "p1" as unknown as Id<"projects">, companyId: companyA._id, displayName: "Projekt A", stage: "in_progress", stageRevision: 1, createdAtMs: 1 } as unknown as Doc<"projects">,
      { _id: "pB" as unknown as Id<"projects">, companyId: companyB._id, displayName: "Projekt B", stage: "inquiry", stageRevision: 1, createdAtMs: 1 } as unknown as Doc<"projects">,
    ],
    tasks: [],
    events: [],
    findings: [],
  };
}

describe("the tenant-scoped snapshot reader", () => {
  it("reads one consistent snapshot of one company, excluding the other tenant", async () => {
    const result = await readCompanySnapshot(fakeSnapshotDb(baseWorld()), companyA._id, "exp1", 1_234_567);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const snapshot = result.snapshot;
    expect(snapshot.snapshotAtMs).toBe(1_234_567);
    expect(snapshot.company.name).toBe("Firma A");
    expect(snapshot.sources.map((s) => s.id)).toEqual(["s1", "s2"]);
    expect(snapshot.projects.map((p) => p.id)).toEqual(["p1"]);
    // Purged content is excluded and never linked to an archive.
    expect(snapshot.sources.some((s) => s.id === "s3")).toBe(false);
    expect(snapshot.media.map((m) => m.sourceId)).toEqual(["s1"]);
    // Withdrawn history stays ("Źródło wycofane" keeps its earlier role).
    expect(snapshot.sources.some((s) => s.id === "s2")).toBe(true);
    // No other tenant's ids appear anywhere in the encoded snapshot.
    const encoded = JSON.stringify(snapshot);
    expect(encoded).not.toContain("sB");
    expect(encoded).not.toContain("pB");
    expect(encoded).not.toContain("Firma B");
  });

  it("serves the retained representation and verifies its ledger record", async () => {
    const result = await readCompanySnapshot(fakeSnapshotDb(baseWorld()), companyA._id, "exp1", 1);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const item = result.snapshot.media[0]!;
    expect(item.representationId).toBe("r1-retained");
    expect(item.role).toBe("retained");
    expect(item.bytes).toBe(8);
    expect(item.contentType).toBe("image/webp");
    expect(item.archivePath).toBe("media/s1/r1-retained.webp");
  });

  it("falls back to the verified received record when no retained one exists", async () => {
    const world = baseWorld();
    world.representations = world.representations.filter((r) => r._id !== "r1-retained");
    const result = await readCompanySnapshot(fakeSnapshotDb(world), companyA._id, "exp1", 1);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.snapshot.media[0]?.representationId).toBe("r1-received");
    expect(result.snapshot.media[0]?.bytes).toBe(10); // the attachment receipt
  });

  it("refuses the whole snapshot when a declared bound is exceeded", async () => {
    const world = baseWorld();
    world.sources = Array.from({ length: EXPORT_BOUNDS.maxSources + 1 }, (_, i) =>
      sourceRow(`s${i}`, companyA._id, "active"),
    );
    const result = await readCompanySnapshot(fakeSnapshotDb(world), companyA._id, "exp1", 1);
    expect(result.ok).toBe(false);
    if (result.ok) {
      return;
    }
    expect(result.refusal).toEqual({ kind: "bound_exceeded", bound: "maxSources" });
  });

  it("agrees with D3's own resolver on which representation serves the bytes", async () => {
    const world = baseWorld();
    const mediaDb: MediaAccessDb = {
      normalizeId: (_table, id) => id as Id<never>,
      attachmentById: async (id) => world.attachments.find((a) => a._id === id) ?? null,
      representationById: async (id) => world.representations.find((r) => r._id === id) ?? null,
      sourceById: async (id) => world.sources.find((s) => s._id === id) ?? null,
      representationsOfAttachment: async (attachmentId) =>
        world.representations.filter((r) => r.attachmentId === attachmentId),
    };
    const context = {
      actor: { companyId: companyA._id },
      resolvedAtMs: 1,
    } as unknown as RequestContext;
    const snapshot = await readCompanySnapshot(fakeSnapshotDb(world), companyA._id, "exp1", 1);
    if (!snapshot.ok) {
      throw new Error("snapshot failed");
    }
    for (const item of snapshot.snapshot.media) {
      const granted = await resolveMediaAccess(mediaDb, context, { attachmentId: item.attachmentId });
      expect(granted._tag).toBe("ok");
      if (granted._tag === "ok") {
        // The archive copies exactly the representation the read seam serves.
        expect((granted.value as { representationId: string }).representationId).toBe(item.representationId);
      }
    }
  });

  // -------------------------------------------------------------------------
  // R5 (issue #130): the archive's source records carry the canonical
  // RELATIVE target — the same wire form the app's shared serializer
  // produces, without a host.
  // -------------------------------------------------------------------------

  it("stamps every archived source record with its canonical relative target", async () => {
    const result = await readCompanySnapshot(fakeSnapshotDb(baseWorld()), companyA._id, "exp1", 1);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const targets = new Map<string, string | undefined>(
      result.snapshot.sources.map((row) => [String(row.id), row.canonicalTarget as string | undefined]),
    );
    expect(targets.get("s1")).toBe("/zrodlo?zrodlo=s1");
    // Withdrawn history stays and carries its target like any record.
    expect(targets.get("s2")).toBe("/zrodlo?zrodlo=s2");
    // Purged content is excluded, so it never carries a target.
    expect(targets.has("s3")).toBe(false);
    for (const target of targets.values()) {
      if (target === undefined) {
        continue;
      }
      // Relative only: a leading slash, no scheme, no host, no fragment.
      expect(target.startsWith("/")).toBe(true);
      expect(target.startsWith("//")).toBe(false);
      expect(target).not.toContain("http");
      expect(target).not.toContain("#");
    }
  });

  it("pins the backend twin to the app serializer's wire contract", () => {
    // The Convex half must not import browser feature code, so it carries a
    // runtime-neutral twin; this corpus pins the two outputs equal — the
    // tested wire contract R5's acceptance names.
    const corpus = [
      "s1",
      "k57d4a8eq2x9w7c1vbn8hj6t0a5q3z2f",
      "K57D4A8EQ2X9W7C1VBN8HJ6T0A5Q3Z2F",
      "with-dash_and_underscore",
    ];
    for (const id of corpus) {
      expect(sourceArchiveTarget(id)).toBe(
        serializeSourceReference({ sourceId: id, fragmentId: null, projectId: null }),
      );
    }
  });
});

// --- the download access resolution ---------------------------------------------

interface ExportRow {
  _id: string;
  companyId: string;
  state: "requested" | "building" | "available" | "expired" | "invalidated" | "failed";
  objectKey?: string;
  etag?: string;
  bytes?: number;
  snapshotAtMs?: number;
  availableUntilMs?: number;
  createdAtMs: number;
}

function fakeAccessDb(rows: ExportRow[], lifecycles: Record<string, string | null>): ExportAccessDb {
  return {
    normalizeId: (_table, id) => id as Id<never>,
    exportById: async (id) =>
      (rows.find((row) => row._id === id) as unknown as Doc<"exports">) ?? null,
    linkedSources: async (exportId) => {
      const links = LINKS[exportId] ?? [];
      return links.map((sourceId) => ({ lifecycle: lifecycles[sourceId] ?? null }));
    },
  };
}

const LINKS: Record<string, string[]> = {
  exp1: ["s1", "s2"],
};

const adminContext = (companyId: string, role: "admin" | "member") =>
  ({
    actor: { companyId, membershipRole: role },
    resolvedAtMs: 1,
  }) as unknown as RequestContext;

const availableRow: ExportRow = {
  _id: "exp1",
  companyId: "kc1",
  state: "available",
  objectKey: "exports/kc1/exp1/t.zip",
  etag: "e1",
  bytes: 100,
  snapshotAtMs: 10,
  availableUntilMs: 1_000_000,
  createdAtMs: 5,
};

describe("the download access resolution", () => {
  it("grants a current administrator the ledger record", async () => {
    const outcome = await resolveExportAccess(
      fakeAccessDb([availableRow], { s1: "active", s2: "withdrawn" }),
      adminContext("kc1", "admin"),
      { exportId: "exp1" },
      500_000,
    );
    expect(outcome.result._tag).toBe("ok");
    if (outcome.result._tag === "ok") {
      const grant = outcome.result.value as Record<string, unknown>;
      expect(grant.objectKey).toBe("exports/kc1/exp1/t.zip");
      expect(grant.etag).toBe("e1");
      expect(grant.bytes).toBe(100);
      expect(grant.contentType).toBe("application/zip");
      expect(grant.fileName).toMatch(/^kiero-eksport-.*\.zip$/);
      expect(outcome.invalidateExportId).toBeUndefined();
    }
  });

  it("refuses a member although the row is fine (current administrator only)", async () => {
    const outcome = await resolveExportAccess(
      fakeAccessDb([availableRow], { s1: "active", s2: "active" }),
      adminContext("kc1", "member"),
      { exportId: "exp1" },
      1,
    );
    expect(outcome.result._tag).toBe("error");
    if (outcome.result._tag === "error") {
      expect(outcome.result.error._tag).toBe("forbidden");
    }
  });

  it("answers another company's export EXACTLY like a nonexistent one", async () => {
    const foreign = await resolveExportAccess(
      fakeAccessDb([availableRow], { s1: "active", s2: "active" }),
      adminContext("kc2", "admin"),
      { exportId: "exp1" },
      1,
    );
    const missing = await resolveExportAccess(
      fakeAccessDb([availableRow], {}),
      adminContext("kc1", "admin"),
      { exportId: "nope" },
      1,
    );
    expect(foreign.result._tag).toBe("error");
    expect(missing.result._tag).toBe("error");
    expect(JSON.stringify(foreign.result)).toBe(JSON.stringify(missing.result));
    if (foreign.result._tag === "error" && missing.result._tag === "error") {
      expect(foreign.result.error.code).toBe("export_not_found");
    }
  });

  it("refuses expiry, invalidation and purge uniformly, flagging the purge", async () => {
    const expired = await resolveExportAccess(
      fakeAccessDb([availableRow], { s1: "active", s2: "active" }),
      adminContext("kc1", "admin"),
      { exportId: "exp1" },
      2_000_000,
    );
    expect(expired.result._tag).toBe("error");
    const invalidated = await resolveExportAccess(
      fakeAccessDb([{ ...availableRow, state: "invalidated" }], { s1: "active", s2: "active" }),
      adminContext("kc1", "admin"),
      { exportId: "exp1" },
      1,
    );
    expect(invalidated.result._tag).toBe("error");
    const purged = await resolveExportAccess(
      fakeAccessDb([availableRow], { s1: "purged", s2: "active" }),
      adminContext("kc1", "admin"),
      { exportId: "exp1" },
      1,
    );
    expect(purged.result._tag).toBe("error");
    expect(purged.invalidateExportId).toBe("exp1" as never);
    // All three refusals carry the same closed not-found code.
    for (const outcome of [expired, invalidated, purged]) {
      if (outcome.result._tag === "error") {
        expect(outcome.result.error.code).toBe("export_not_found");
      }
    }
  });
});
