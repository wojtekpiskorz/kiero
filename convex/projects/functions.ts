/**
 * The C1 Convex function surface (generated-call APIs).
 *
 * One core set, two callable entries (no drift by construction):
 *
 * - `dispatchProjects` (public mutation): the typed command dispatch for
 *   the company-scoped projects operations (identifyProject, assignCodename,
 *   changeStage, setPause, upsertContact, assignContactRole), with B1
 *   identity resolution and the C1 policy. Each command and its canonical
 *   event commit atomically inside the mutation.
 * - `projectsOverview` (public query): the barebones catalog read. It
 *   resolves the actor through the SAME canonical read-only chain B1/B3
 *   protected reads use, and everything it returns is derived from the
 *   RESOLVED company scope — no company, project or contact id is ever
 *   accepted from client input, so no other tenant's row can appear.
 *
 * The overview splits active from closed projects ("Widoki zamkniętych
 * projektów"): closed ones leave the active list but stay readable here with
 * their aliases, contacts, roles and source links intact.
 */

import { v } from "convex/values";
import { ConvexError } from "convex/values";
import { mutation, query } from "../_generated/server";
import type { ContactKind, ContactRole, ProjectStage, ResultEnvelope } from "@kiero/contracts";
import { unauthenticatedError } from "@kiero/runtime";
import type { Id } from "../_generated/dataModel";
import {
  liveSessionIdentity,
  liveSessionStore,
  resolveLiveSession,
} from "../access/identity/resolution";
import { resolveRequestContext } from "../platform/context";
import { dispatchProjectsCommand } from "./dispatch";
import { isClosedStage } from "../../packages/domain/projects/index";

/** The sanitized denial error every protected read fails with. */
function denialError(reason: string): never {
  throw new ConvexError(unauthenticatedError(`no_live_session_${reason}`));
}

/** Resolves the read-only actor chain, or throws the sanitized denial. */
async function requireLiveSession(
  db: Parameters<typeof liveSessionStore>[0],
  auth: { getUserIdentity(): Promise<{ subject: string } | null> },
) {
  const live = await resolveLiveSession(liveSessionStore(db), auth, Date.now());
  if (live.tag === "denied") {
    denialError(live.reason);
  }
  return live.session;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

/** The company-scoped typed command dispatch (client path). */
export const dispatchProjects = mutation({
  args: { envelope: v.any() },
  handler: async (ctx, args): Promise<ResultEnvelope> =>
    dispatchProjectsCommand(ctx, args.envelope),
});

// ---------------------------------------------------------------------------
// Reads (barebones catalog)
// ---------------------------------------------------------------------------

/** One alias row of a project, active or retained ("Alias projektu"). */
export interface ProjectAliasView {
  readonly aliasId: Id<"projectAliases">;
  readonly codename: string;
  readonly active: boolean;
  readonly assignedAtMs: number;
  readonly retiredAtMs: number | null;
}

/** One project as the catalog shows it. */
export interface ProjectView {
  readonly projectId: Id<"projects">;
  readonly displayName: string;
  readonly stage: ProjectStage;
  readonly stageRevision: number;
  readonly paused: { readonly reason: string; readonly resumeOn: string | null } | null;
  readonly clientId: Id<"contacts"> | null;
  readonly clientName: string | null;
  readonly closedAtMs: number | null;
  readonly createdAtMs: number;
  /** The active codename (generated `#n` until a boss assigns one). */
  readonly activeCodename: string | null;
  /** Retained alias history, oldest first; still denoting this project. */
  readonly aliases: readonly ProjectAliasView[];
  /** Linked source count (D1 rows); closure preserves the links. */
  readonly sourceLinkCount: number;
}

/** One catalog contact. */
export interface ContactView {
  readonly contactId: Id<"contacts">;
  readonly kind: ContactKind;
  readonly displayName: string;
}

/** One contact-role row. */
export interface ContactRoleView {
  readonly contactRoleId: Id<"contactRoles">;
  readonly projectId: Id<"projects">;
  readonly contactId: Id<"contacts">;
  readonly role: ContactRole;
  readonly createdAtMs: number;
}

/** The projects catalog overview, all of it resolved company scope. */
export interface ProjectsOverview {
  readonly sessionId: Id<"sessions">;
  readonly companyId: Id<"companies">;
  readonly active: readonly ProjectView[];
  readonly closed: readonly ProjectView[];
  readonly contacts: readonly ContactView[];
  readonly roles: readonly ContactRoleView[];
}

/** How many alias/role/source rows one project read keeps (bounded read). */
const MAX_PROJECT_RELATED_ROWS = 100;

/**
 * Authenticated: the barebones projects catalog read. Active and closed
 * projects of the RESOLVED company with their alias history (active codename
 * plus retained renames), the contact catalog and the project roles.
 * Nothing from another tenant can appear: every row is read through
 * company-scoped indexes after the canonical actor resolution.
 */
export const projectsOverview = query({
  args: {},
  handler: async (ctx): Promise<ProjectsOverview> => {
    const session = await requireLiveSession(ctx.db, ctx.auth);
    const context = await resolveRequestContext(
      ctx.db,
      liveSessionIdentity(session, Date.now()),
    );
    if (context === null) {
      // Projects are company knowledge: a verified person without an active
      // firm has no catalog to read (their surface is the admission path).
      denialError("no_company_scope");
    }
    const companyId = ctx.db.normalizeId("companies", context.actor.companyId);
    if (companyId === null) {
      denialError("registry_missing");
    }

    const projectRows = await ctx.db
      .query("projects")
      .withIndex("by_company_stage", (q) => q.eq("companyId", companyId))
      .collect();
    const contactRows = await ctx.db
      .query("contacts")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    const roleRows = await ctx.db
      .query("contactRoles")
      .withIndex("by_company", (q) => q.eq("companyId", companyId))
      .collect();
    const contactNames = new Map(contactRows.map((row) => [row._id, row.displayName] as const));

    const views: ProjectView[] = [];
    for (const project of projectRows) {
      const aliasRows = (
        await ctx.db
          .query("projectAliases")
          .withIndex("by_project", (q) => q.eq("projectId", project._id))
          .collect()
      ).slice(0, MAX_PROJECT_RELATED_ROWS);
      const sourceLinkRows = await ctx.db
        .query("sourceProjectLinks")
        .withIndex("by_project_source", (q) => q.eq("projectId", project._id))
        .collect();
      const activeAlias = aliasRows.find((row) => row.active) ?? null;
      views.push({
        projectId: project._id,
        displayName: project.displayName,
        stage: project.stage,
        stageRevision: project.stageRevision,
        paused:
          project.paused === undefined
            ? null
            : { reason: project.paused.reason, resumeOn: project.paused.resumeOn },
        clientId: project.clientId ?? null,
        clientName: project.clientId === undefined ? null : contactNames.get(project.clientId) ?? null,
        closedAtMs: project.closedAtMs ?? null,
        createdAtMs: project.createdAtMs,
        activeCodename: activeAlias?.codename ?? null,
        aliases: aliasRows
          .slice()
          .sort((a, b) => a.assignedAtMs - b.assignedAtMs)
          .map((row) => ({
            aliasId: row._id,
            codename: row.codename,
            active: row.active,
            assignedAtMs: row.assignedAtMs,
            retiredAtMs: row.retiredAtMs ?? null,
          })),
        sourceLinkCount: sourceLinkRows.length,
      });
    }
    views.sort((a, b) => a.createdAtMs - b.createdAtMs);

    return {
      sessionId: session.sessionId,
      companyId,
      active: views.filter((view) => !isClosedStage(view.stage)),
      closed: views.filter((view) => isClosedStage(view.stage)),
      contacts: contactRows
        .slice()
        .sort((a, b) => a.displayName.localeCompare(b.displayName, "pl"))
        .map((row) => ({ contactId: row._id, kind: row.kind, displayName: row.displayName })),
      roles: roleRows
        .slice()
        .sort((a, b) => a.createdAtMs - b.createdAtMs)
        .map((row) => ({
          contactRoleId: row._id,
          projectId: row.projectId,
          contactId: row.contactId,
          role: row.role,
          createdAtMs: row.createdAtMs,
        })),
    };
  },
});
