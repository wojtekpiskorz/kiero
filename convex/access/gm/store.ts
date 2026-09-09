/**
 * The GM transaction store surface (B4).
 *
 * The minimal read/write surface the GM transactional cores consume,
 * following the B1/B2 store pattern: plain-string ids (the Convex adapter
 * normalizes branded ids exactly once, at the adapter), direct per-entity
 * methods, no query-chain types — so an in-memory fake (tests/b4) implements
 * it line by line and the cores stay unit-testable without a deployment.
 *
 * The audit writer lives HERE on purpose: `insertAudit` taking the SAME
 * transaction as every effect row is what makes "every GM action writes its
 * protected audit record atomically" structural rather than conventional.
 */

import type {
  GmActivationView,
  GmGrantView,
} from "./cores";

/** The company fields the GM cores read. */
export interface GmCompanyView {
  readonly id: string;
  readonly name: string;
  readonly timezone: string;
  readonly defaultCurrency: string;
}

/** One inspected processing run (bounded projection, no payloads). */
export interface GmRunRow {
  readonly runId: string;
  readonly kind: "initial_analysis" | "reanalysis";
  readonly state: "running" | "succeeded" | "failed" | "superseded";
  readonly startedAtMs: number;
  readonly finishedAtMs: number | null;
}

/** One inspected durable job (bounded projection, no input payloads). */
export interface GmJobRow {
  readonly jobId: string;
  readonly kind: string;
  readonly state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  readonly attempts: number;
  readonly maxAttempts: number;
  readonly lastErrorKind: string | null;
}

/** One membership row the restoration core reads. */
export interface GmMembershipRow {
  readonly membershipId: string;
  readonly companyId: string;
  readonly userId: string;
  readonly role: "admin" | "member";
  readonly state: "active" | "revoked";
}

/** The protected audit row a GM action writes in its own transaction. */
export interface GmAuditRow {
  readonly actorUserId: string;
  readonly gmGrantId: string;
  /** Target company when the action is company-scoped. */
  readonly companyId: string | null;
  readonly operationName: string;
  /** The actor's stated basis ("podstawa"); entering carries the reason. */
  readonly gmBasis: string;
  /** "ok" or the closed error code of the denied attempt. */
  readonly outcome: string;
  readonly atMs: number;
}

/** The read surface the GM cores consume. */
export interface GmStore {
  userById(userId: string): Promise<{ id: string; email: string } | null>;
  grantById(grantId: string): Promise<GmGrantView | null>;
  grantsOfUser(userId: string): Promise<GmGrantView[]>;
  companyById(companyId: string): Promise<GmCompanyView | null>;
  openActivationOf(companyId: string): Promise<GmActivationView | null>;
  /** The latest activation row of any state (re-activation conflict check). */
  membershipsOfCompany(companyId: string): Promise<GmMembershipRow[]>;
  recentRunsOfCompany(companyId: string, limit: number): Promise<GmRunRow[]>;
  recentJobsOfCompany(companyId: string, limit: number): Promise<GmJobRow[]>;
}

/** The write surface the GM transactional cores consume. */
export interface GmTx extends GmStore {
  insertGrant(row: { userId: string; reason: string; enteredAtMs: number }): Promise<string>;
  closeGrant(grantId: string, closedAtMs: number): Promise<boolean>;
  insertCompany(row: {
    name: string;
    timezone: string;
    defaultCurrency: string;
    createdAtMs: number;
  }): Promise<string>;
  insertActivation(row: {
    companyId: string;
    activatedByUserId: string;
    activatedAtMs: number;
  }): Promise<string>;
  endActivation(
    activationId: string,
    endedAtMs: number,
    endedByUserId: string,
  ): Promise<boolean>;
  insertInvitation(row: {
    companyId: string;
    email: string;
    role: "admin" | "member";
    codeHash: string;
    expiresAtMs: number;
    createdAtMs: number;
    issuedByUserId: string;
  }): Promise<string>;
  patchMembershipRole(membershipId: string, role: "admin" | "member"): Promise<boolean>;
  insertAudit(row: GmAuditRow): Promise<void>;
}
