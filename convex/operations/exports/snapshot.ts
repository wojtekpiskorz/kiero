/**
 * The consistent company snapshot reader (I3).
 *
 * ONE Convex transaction reads every business collection of ONE company
 * and returns a single `CompanySnapshot` stamped with the transaction's
 * time. Convex queries and mutations run against a serializable snapshot
 * of the database, so records written concurrently by other transactions
 * either all precede this read or all follow it: the archive can never mix
 * revisions of two moments. Nothing here reads twice, caches or re-reads
 * across transactions.
 *
 * TENANT SCOPE: every collection is reached FROM the company id through
 * the owning fragment's company index, or through a row already proved to
 * belong to the company (source -> attachment -> representation; finding
 * -> revision -> evidence). No table is scanned without a company-scoped
 * anchor, so a foreign tenant's row cannot enter the result by id.
 *
 * WHAT IS EXCLUDED (issue #55): personal read/notification state, Calendar
 * connection/hide/cursor state, sessions, auth rows, provider tokens,
 * platform jobs/outbox, backups, diagnostics; purged sources (their content
 * is gone and they are never linked to an archive); the acceptance
 * idempotency plumbing of sources (`acceptanceKey`/`acceptanceFingerprint`)
 * and users' login identifiers (`googleSubject`), which are technical, not
 * business records. Withdrawn sources stay: CONTEXT.md keeps a withdrawn
 * message's earlier role and correction reason as history.
 *
 * MEDIA: for every attachment of an included source the SAME
 * retained-or-received rule as the D3 read seam decides which verified,
 * not-removed representation the archive copies; the snapshot records the
 * ledger's object key, etag and byte length so the Worker verifies the
 * live object before copying a byte (tests/i3 pin the rule against D3's
 * resolver on shared fixtures).
 *
 * BOUNDS: counts and the encoded JSON size are checked here; exceeding any
 * declared bound refuses the whole snapshot with a typed kind and no
 * partial result.
 *
 * The reader is written over a slim `SnapshotDb` surface (the D2/D3
 * harness pattern) so tests/i3 drive the exact same code over an
 * in-memory store; `snapshotDb(db)` adapts the real Convex reader.
 */

import type { QueryCtx } from "../../_generated/server";
import type { Doc, Id } from "../../_generated/dataModel";
import {
  ARCHIVE_SCHEMA_VERSION,
  EXPORT_BOUNDS,
  mediaArchivePath,
  type CompanySnapshot,
  type SnapshotMediaItem,
  type SnapshotRefusal,
  type SnapshotRow,
} from "./protocol";
import { contentTypeForKind } from "../../sources/media_access/protocol";

/** The read surface the snapshot walks (one method per collection). */
export interface SnapshotDb {
  companyById(id: Id<"companies">): Promise<Doc<"companies"> | null>;
  membershipsOfCompany(companyId: Id<"companies">): Promise<Doc<"memberships">[]>;
  userById(id: Id<"users">): Promise<Doc<"users"> | null>;
  projectsOfCompany(companyId: Id<"companies">): Promise<Doc<"projects">[]>;
  aliasesOfCompany(companyId: Id<"companies">): Promise<Doc<"projectAliases">[]>;
  contactsOfCompany(companyId: Id<"companies">): Promise<Doc<"contacts">[]>;
  contactRolesOfCompany(companyId: Id<"companies">): Promise<Doc<"contactRoles">[]>;
  sourcesOfCompany(companyId: Id<"companies">): Promise<Doc<"sources">[]>;
  projectLinksOfSource(sourceId: Id<"sources">): Promise<Doc<"sourceProjectLinks">[]>;
  extractionsOfSource(sourceId: Id<"sources">): Promise<Doc<"extractions">[]>;
  fragmentsOfSource(sourceId: Id<"sources">): Promise<Doc<"sourceFragments">[]>;
  attachmentsOfSource(sourceId: Id<"sources">): Promise<Doc<"attachments">[]>;
  representationsOfAttachment(attachmentId: Id<"attachments">): Promise<Doc<"mediaRepresentations">[]>;
  findingsOfCompany(companyId: Id<"companies">): Promise<Doc<"findings">[]>;
  revisionsOfFinding(findingId: Id<"findings">): Promise<Doc<"findingRevisions">[]>;
  evidenceOfRevision(revisionId: Id<"findingRevisions">): Promise<Doc<"evidenceLinks">[]>;
  dependenciesOfCompany(companyId: Id<"companies">): Promise<Doc<"findingDependencies">[]>;
  clarificationsOfCompany(companyId: Id<"companies">): Promise<Doc<"clarifications">[]>;
  extensionDefinitionsOfCompany(companyId: Id<"companies">): Promise<Doc<"extensionDefinitions">[]>;
  extensionDefinitionById(id: Id<"extensionDefinitions">): Promise<Doc<"extensionDefinitions"> | null>;
  versionsOfDefinition(definitionId: Id<"extensionDefinitions">): Promise<Doc<"extensionVersions">[]>;
  extensionVersionById(id: Id<"extensionVersions">): Promise<Doc<"extensionVersions"> | null>;
  tasksOfCompany(companyId: Id<"companies">): Promise<Doc<"tasks">[]>;
  checklistItemsOfTask(taskId: Id<"tasks">): Promise<Doc<"checklistItems">[]>;
  eventsOfCompany(companyId: Id<"companies">): Promise<Doc<"events">[]>;
  workRevisionsOfCompany(companyId: Id<"companies">): Promise<Doc<"workRevisions">[]>;
}

/** Adapts the real Convex reader to the snapshot surface (index reads only). */
export function snapshotDb(db: QueryCtx["db"]): SnapshotDb {
  return {
    companyById: (id) => db.get(id),
    membershipsOfCompany: (companyId) =>
      db.query("memberships").withIndex("by_company_user", (q) => q.eq("companyId", companyId)).collect(),
    userById: (id) => db.get(id),
    projectsOfCompany: (companyId) =>
      db.query("projects").withIndex("by_company_stage", (q) => q.eq("companyId", companyId)).collect(),
    aliasesOfCompany: (companyId) =>
      db.query("projectAliases").withIndex("by_company_codename", (q) => q.eq("companyId", companyId)).collect(),
    contactsOfCompany: (companyId) =>
      db.query("contacts").withIndex("by_company", (q) => q.eq("companyId", companyId)).collect(),
    contactRolesOfCompany: (companyId) =>
      db.query("contactRoles").withIndex("by_company", (q) => q.eq("companyId", companyId)).collect(),
    sourcesOfCompany: (companyId) =>
      db.query("sources").withIndex("by_company_order", (q) => q.eq("companyId", companyId)).collect(),
    projectLinksOfSource: (sourceId) =>
      db.query("sourceProjectLinks").withIndex("by_source", (q) => q.eq("sourceId", sourceId)).collect(),
    extractionsOfSource: (sourceId) =>
      db.query("extractions").withIndex("by_source_kind", (q) => q.eq("sourceId", sourceId)).collect(),
    fragmentsOfSource: (sourceId) =>
      db.query("sourceFragments").withIndex("by_source", (q) => q.eq("sourceId", sourceId)).collect(),
    attachmentsOfSource: (sourceId) =>
      db.query("attachments").withIndex("by_source", (q) => q.eq("sourceId", sourceId)).collect(),
    representationsOfAttachment: (attachmentId) =>
      db
        .query("mediaRepresentations")
        .withIndex("by_attachment_role", (q) => q.eq("attachmentId", attachmentId))
        .collect(),
    findingsOfCompany: (companyId) =>
      db.query("findings").withIndex("by_company_scope_key", (q) => q.eq("companyId", companyId)).collect(),
    revisionsOfFinding: (findingId) =>
      db.query("findingRevisions").withIndex("by_finding_revision", (q) => q.eq("findingId", findingId)).collect(),
    evidenceOfRevision: (revisionId) =>
      db.query("evidenceLinks").withIndex("by_revision", (q) => q.eq("findingRevisionId", revisionId)).collect(),
    dependenciesOfCompany: (companyId) =>
      db.query("findingDependencies").withIndex("by_company", (q) => q.eq("companyId", companyId)).collect(),
    clarificationsOfCompany: (companyId) =>
      db.query("clarifications").withIndex("by_company_state", (q) => q.eq("companyId", companyId)).collect(),
    extensionDefinitionsOfCompany: (companyId) =>
      db
        .query("extensionDefinitions")
        .withIndex("by_company_key", (q) => q.eq("companyId", companyId))
        .collect(),
    extensionDefinitionById: (id) => db.get(id),
    versionsOfDefinition: (definitionId) =>
      db
        .query("extensionVersions")
        .withIndex("by_definition_version", (q) => q.eq("definitionId", definitionId))
        .collect(),
    extensionVersionById: (id) => db.get(id),
    tasksOfCompany: (companyId) =>
      db.query("tasks").withIndex("by_project_state", (q) => q.eq("companyId", companyId)).collect(),
    checklistItemsOfTask: (taskId) =>
      db.query("checklistItems").withIndex("by_task", (q) => q.eq("taskId", taskId)).collect(),
    eventsOfCompany: (companyId) =>
      db.query("events").withIndex("by_project_state", (q) => q.eq("companyId", companyId)).collect(),
    workRevisionsOfCompany: (companyId) =>
      db.query("workRevisions").withIndex("by_company", (q) => q.eq("companyId", companyId)).collect(),
  };
}

export type SnapshotResult =
  | { readonly ok: true; readonly snapshot: CompanySnapshot }
  | { readonly ok: false; readonly refusal: SnapshotRefusal };

const refuse = (refusal: SnapshotRefusal): SnapshotResult => ({ ok: false, refusal });

/** Strips Convex system fields and the named technical columns from a row. */
function project(row: Record<string, unknown>, drop: readonly string[] = []): SnapshotRow {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) {
    if (key === "_creationTime" || drop.includes(key) || value === undefined) {
      continue;
    }
    out[key === "_id" ? "id" : key] = value;
  }
  return out;
}

/** The newest verified, not-removed representation of one servable role (D3's rule). */
function newestVerified(
  rows: readonly Doc<"mediaRepresentations">[],
  role: "received" | "retained",
): Doc<"mediaRepresentations"> | null {
  const candidates = rows.filter(
    (row) => row.role === role && row.verifiedAtMs !== undefined && row.removedAtMs === undefined,
  );
  if (candidates.length === 0) {
    return null;
  }
  return candidates.reduce((newest, row) => (row.createdAtMs > newest.createdAtMs ? row : newest));
}

/** The ledger etag of the chosen representation (D3's `etagOf`, same fallback). */
function etagOf(
  representation: Doc<"mediaRepresentations">,
  attachment: Doc<"attachments">,
): string | null {
  const prefix = "r2:etag:";
  if (representation.contentHash.startsWith(prefix)) {
    return representation.contentHash.slice(prefix.length);
  }
  if (representation.role === "received" && attachment.r2ObjectEtag !== undefined) {
    return attachment.r2ObjectEtag;
  }
  return null;
}

/** The ledger byte length of the chosen representation (D3's `bytesOf`). */
function bytesOf(
  representation: Doc<"mediaRepresentations">,
  attachment: Doc<"attachments">,
): number | null {
  if (representation.bytes !== undefined && representation.bytes > 0) {
    return representation.bytes;
  }
  if (representation.role === "received" && attachment.receivedBytes !== undefined) {
    return attachment.receivedBytes;
  }
  return null;
}

/**
 * The media item the archive copies for one attachment, or null when no
 * verified representation with a complete ledger record exists (the
 * attachment is then listed in the JSON but carries no bytes; the index
 * says so honestly instead of copying an unverified object).
 */
export function chooseMediaItem(
  attachment: Doc<"attachments">,
  representations: readonly Doc<"mediaRepresentations">[],
): SnapshotMediaItem | null {
  if (attachment.sourceId === undefined) {
    return null;
  }
  const chosen = newestVerified(representations, "retained") ?? newestVerified(representations, "received");
  if (chosen === null) {
    return null;
  }
  const etag = etagOf(chosen, attachment);
  const bytes = bytesOf(chosen, attachment);
  if (etag === null || bytes === null) {
    return null;
  }
  const contentType = chosen.mimeType ?? contentTypeForKind(attachment.kind);
  return {
    representationId: chosen._id,
    attachmentId: attachment._id,
    sourceId: attachment.sourceId,
    role: chosen.role === "retained" ? "retained" : "received",
    kind: attachment.kind,
    objectKey: chosen.objectKey,
    etag,
    bytes,
    contentType,
    archivePath: mediaArchivePath(attachment.sourceId, chosen._id, contentType),
  };
}

const bounded = (rows: readonly unknown[]): boolean =>
  rows.length <= EXPORT_BOUNDS.maxRecordsPerCollection;

// ---------------------------------------------------------------------------
// R5 (issue #130): the canonical relative source target of the archive
// ---------------------------------------------------------------------------

/**
 * The archive route prefix and source param key this serializer targets —
 * the SAME literal wire form the app's shared serializer
 * (`apps/web/src/features/source-detail/source-route`) produces. Kept as a
 * runtime-neutral local twin ON PURPOSE: the Convex backend must not import
 * browser feature code, so the two halves share a tested wire contract
 * instead (tests/i3 pin them equal against one corpus). The target stays
 * RELATIVE: no deployment host name ever enters the export.
 */
const SOURCE_ROUTE_PATH = "/zrodlo";
const SOURCE_PARAM = "zrodlo";

/**
 * The canonical relative target of one archived source record: the dossier
 * route with the encoded source id, openable in the app regardless of
 * conversation pagination (R5-P1's export half).
 */
export function sourceArchiveTarget(sourceId: string): string {
  return `${SOURCE_ROUTE_PATH}?${SOURCE_PARAM}=${encodeURIComponent(sourceId)}`;
}

/** Adds the canonical relative target to one projected source row. */
function withSourceTarget(row: SnapshotRow, sourceId: Id<"sources">): SnapshotRow {
  return { ...row, canonicalTarget: sourceArchiveTarget(sourceId) };
}

/**
 * Reads the whole company snapshot in the caller's transaction. `nowMs`
 * is the transaction's time (Convex fixes `Date.now()` per transaction);
 * it becomes the declared `snapshotAtMs`.
 */
export async function readCompanySnapshot(
  db: SnapshotDb,
  companyId: Id<"companies">,
  exportId: string,
  nowMs: number,
): Promise<SnapshotResult> {
  const company = await db.companyById(companyId);
  if (company === null) {
    return refuse({ kind: "export_not_found" });
  }

  const memberships = await db.membershipsOfCompany(companyId);
  const people: SnapshotRow[] = [];
  const seenUsers = new Set<string>();
  for (const membership of memberships) {
    if (seenUsers.has(membership.userId)) {
      continue;
    }
    seenUsers.add(membership.userId);
    const user = await db.userById(membership.userId);
    if (user !== null) {
      people.push({ id: user._id, displayName: user.displayName, email: user.email });
    }
  }

  const sourcesAll = await db.sourcesOfCompany(companyId);
  const sources = sourcesAll.filter((source) => source.lifecycle !== "purged");
  if (sources.length > EXPORT_BOUNDS.maxSources) {
    return refuse({ kind: "bound_exceeded", bound: "maxSources" });
  }

  const sourceProjectLinks: SnapshotRow[] = [];
  const extractions: SnapshotRow[] = [];
  const sourceFragments: SnapshotRow[] = [];
  const attachments: SnapshotRow[] = [];
  const media: SnapshotMediaItem[] = [];
  let mediaBytes = 0;
  for (const source of sources) {
    for (const link of await db.projectLinksOfSource(source._id)) {
      sourceProjectLinks.push(project(link));
    }
    for (const extraction of await db.extractionsOfSource(source._id)) {
      extractions.push(project(extraction));
    }
    for (const fragment of await db.fragmentsOfSource(source._id)) {
      sourceFragments.push(project(fragment));
    }
    for (const attachment of await db.attachmentsOfSource(source._id)) {
      const representations = await db.representationsOfAttachment(attachment._id);
      const item = chooseMediaItem(attachment, representations);
      attachments.push({
        id: attachment._id,
        sourceId: source._id,
        kind: attachment.kind,
        createdAtMs: attachment.createdAtMs,
        ...(item === null ? { archivePath: null } : { archivePath: item.archivePath, representationId: item.representationId, role: item.role, contentType: item.contentType, bytes: item.bytes }),
      });
      if (item !== null) {
        media.push(item);
        mediaBytes += item.bytes;
      }
    }
  }
  if (media.length > EXPORT_BOUNDS.maxMediaItems) {
    return refuse({ kind: "bound_exceeded", bound: "maxMediaItems" });
  }
  if (mediaBytes > EXPORT_BOUNDS.maxMediaBytesTotal) {
    return refuse({ kind: "bound_exceeded", bound: "maxMediaBytesTotal" });
  }

  const findingsRows = await db.findingsOfCompany(companyId);
  const findingRevisions: SnapshotRow[] = [];
  const evidenceLinks: SnapshotRow[] = [];
  const referencedVersionIds = new Set<string>();
  for (const finding of findingsRows) {
    for (const revision of await db.revisionsOfFinding(finding._id)) {
      findingRevisions.push(project(revision));
      if (revision.value._tag === "extension") {
        referencedVersionIds.add(revision.value.definitionVersionId);
      }
      for (const evidence of await db.evidenceOfRevision(revision._id)) {
        evidenceLinks.push(project(evidence));
      }
    }
  }

  // Extension catalog: this company's definitions with every version, plus
  // the shared-catalog versions its findings reference (product-owned rows,
  // no company data) so historic values keep their interpretation.
  const definitionRows = new Map<string, Doc<"extensionDefinitions">>();
  const versionRows = new Map<string, Doc<"extensionVersions">>();
  for (const definition of await db.extensionDefinitionsOfCompany(companyId)) {
    definitionRows.set(definition._id, definition);
    for (const version of await db.versionsOfDefinition(definition._id)) {
      versionRows.set(version._id, version);
    }
  }
  for (const versionId of referencedVersionIds) {
    if (versionRows.has(versionId)) {
      continue;
    }
    const version = await db.extensionVersionById(versionId as Id<"extensionVersions">);
    if (version === null) {
      continue;
    }
    const definition = await db.extensionDefinitionById(version.definitionId);
    // A definition owned by ANOTHER company can never be referenced by this
    // company's findings (C3's write paths refuse it); fail closed anyway.
    if (definition === null || (definition.companyId !== undefined && definition.companyId !== companyId)) {
      continue;
    }
    versionRows.set(version._id, version);
    definitionRows.set(definition._id, definition);
  }

  const tasksRows = await db.tasksOfCompany(companyId);
  const checklistItems: SnapshotRow[] = [];
  for (const task of tasksRows) {
    for (const item of await db.checklistItemsOfTask(task._id)) {
      checklistItems.push(project(item));
    }
  }

  const collections = {
    memberships: memberships.map((row) => project(row)),
    projects: (await db.projectsOfCompany(companyId)).map((row) => project(row)),
    projectAliases: (await db.aliasesOfCompany(companyId)).map((row) => project(row)),
    contacts: (await db.contactsOfCompany(companyId)).map((row) => project(row)),
    contactRoles: (await db.contactRolesOfCompany(companyId)).map((row) => project(row)),
    sources: sources.map((row) =>
      // R5: every archived source record carries its canonical relative
      // target (no host); the field is additive under the current archive
      // format, whose version constant the I3 lane owns.
      withSourceTarget(project(row, ["acceptanceKey", "acceptanceFingerprint"]), row._id),
    ),
    sourceProjectLinks,
    extractions,
    sourceFragments,
    attachments,
    findings: findingsRows.map((row) => project(row)),
    findingRevisions,
    evidenceLinks,
    findingDependencies: (await db.dependenciesOfCompany(companyId)).map((row) => project(row)),
    clarifications: (await db.clarificationsOfCompany(companyId)).map((row) => project(row)),
    extensionDefinitions: [...definitionRows.values()].map((row) => project(row)),
    extensionVersions: [...versionRows.values()].map((row) => project(row)),
    tasks: tasksRows.map((row) => project(row)),
    checklistItems,
    events: (await db.eventsOfCompany(companyId)).map((row) => project(row)),
    workRevisions: (await db.workRevisionsOfCompany(companyId)).map((row) => project(row)),
  };

  let total = people.length + media.length;
  for (const rows of Object.values(collections)) {
    if (!bounded(rows)) {
      return refuse({ kind: "bound_exceeded", bound: "maxRecordsPerCollection" });
    }
    total += rows.length;
  }
  if (total > EXPORT_BOUNDS.maxTotalRecords) {
    return refuse({ kind: "bound_exceeded", bound: "maxTotalRecords" });
  }

  const snapshot: CompanySnapshot = {
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    snapshotAtMs: nowMs,
    exportId,
    company: {
      companyId: company._id,
      name: company.name,
      timezone: company.timezone,
      defaultCurrency: company.defaultCurrency,
    },
    people,
    ...collections,
    // `attachments` is part of the JSON collections above; the media
    // manifest is the copy list.
    media,
  };
  if (JSON.stringify(snapshot).length > EXPORT_BOUNDS.maxSnapshotJsonBytes) {
    return refuse({ kind: "bound_exceeded", bound: "maxSnapshotJsonBytes" });
  }
  return { ok: true, snapshot };
}
