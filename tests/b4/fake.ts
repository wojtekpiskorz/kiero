/**
 * The B4 in-memory fake of the GM store surfaces (tests/b4).
 *
 * Implements `GmTx` (and through it `GmStore`) over plain maps, with the
 * same semantics the Convex adapter provides: one open grant per user is
 * enforced by the cores (the fake records what happened), activations keep
 * history rows, and the audit log records every insert verbatim so the
 * atomicity assertions count rows. Ids are TEST FIXTURE DATA constructed in
 * this one documented helper.
 */

import type {
  GmActivationView,
  GmGrantView,
} from "../../convex/access/gm/cores";
import type {
  GmCompanyView,
  GmJobRow,
  GmRunRow,
  GmTx,
} from "../../convex/access/gm/store";

export interface FakeGrantRow {
  id: string;
  userId: string;
  reason: string;
  enteredAtMs: number;
  closedAtMs: number | null;
}

export interface FakeCompanyRow {
  id: string;
  name: string;
  timezone: string;
  defaultCurrency: string;
  createdAtMs: number;
}

export interface FakeActivationRow {
  id: string;
  companyId: string;
  activatedByUserId: string;
  activatedAtMs: number;
  endedAtMs: number | null;
  endedByUserId: string | null;
}

export interface FakeInvitationRow {
  id: string;
  companyId: string;
  email: string;
  role: "admin" | "member";
  codeHash: string;
  expiresAtMs: number;
  createdAtMs: number;
  issuedByUserId: string;
}

export interface FakeUserRow {
  id: string;
  email: string;
}

export interface FakeGmDb {
  users: Map<string, FakeUserRow>;
  grants: Map<string, FakeGrantRow>;
  companies: Map<string, FakeCompanyRow>;
  activations: FakeActivationRow[];
  invitations: FakeInvitationRow[];
  memberships: Array<{ membershipId: string; companyId: string; userId: string; role: "admin" | "member"; state: "active" | "revoked" }>;
  runs: GmRunRow[];
  jobs: Array<GmJobRow & { readonly companyId: string }>;
  companyOfRun: Map<string, string>;
  audit: Array<{
    actorUserId: string;
    gmGrantId: string;
    companyId: string | null;
    operationName: string;
    gmBasis: string;
    outcome: string;
    atMs: number;
  }>;
}

type MutableMembership = {
  membershipId: string;
  companyId: string;
  userId: string;
  role: "admin" | "member";
  state: "active" | "revoked";
};

function grantViewOf(row: FakeGrantRow): GmGrantView {
  return {
    id: row.id,
    userId: row.userId,
    reason: row.reason,
    enteredAtMs: row.enteredAtMs,
    closedAtMs: row.closedAtMs,
  };
}

function activationViewOf(row: FakeActivationRow): GmActivationView {
  return {
    id: row.id,
    companyId: row.companyId,
    activatedAtMs: row.activatedAtMs,
    endedAtMs: row.endedAtMs,
  };
}

export function fakeGmDb(seed?: Partial<FakeGmDb>): FakeGmDb {
  return {
    users: seed?.users ?? new Map(),
    grants: seed?.grants ?? new Map(),
    companies: seed?.companies ?? new Map(),
    activations: seed?.activations ?? [],
    invitations: seed?.invitations ?? [],
    memberships: seed?.memberships ?? [],
    runs: seed?.runs ?? [],
    jobs: seed?.jobs ?? [],
    companyOfRun: seed?.companyOfRun ?? new Map(),
    audit: seed?.audit ?? [],
  } as FakeGmDb;
}

export function fakeGmUser(overrides: Partial<FakeUserRow> = {}): FakeUserRow {
  return { id: "k57gmoper", email: "operator@kiero.invalid", ...overrides };
}

export function fakeGmCompany(overrides: Partial<FakeCompanyRow> = {}): FakeCompanyRow {
  return {
    id: "k57company1",
    name: "Budowa Kowalscy",
    timezone: "Europe/Warsaw",
    defaultCurrency: "PLN",
    createdAtMs: 1_800_000_000_000,
    ...overrides,
  };
}

/** Builds the fake GmTx over one FakeGmDb (sequential ids per kind). */
export function fakeGmTx(db: FakeGmDb): GmTx {
  // Length-derived ids stay unique even when a test seeds rows directly.
  const nextGrant = () => db.grants.size + 1;
  const nextCompany = () => db.companies.size + 1;
  const nextActivation = () => db.activations.length + 1;
  const nextInvitation = () => db.invitations.length + 1;

  return {
    userById: async (userId) => {
      const user = db.users.get(userId);
      return user === undefined ? null : { id: user.id, email: user.email };
    },
    grantById: async (grantId) => {
      const row = db.grants.get(grantId);
      return row === undefined ? null : grantViewOf(row);
    },
    grantsOfUser: async (userId) =>
      [...db.grants.values()].filter((row) => row.userId === userId).map(grantViewOf),
    companyById: async (companyId) => {
      const row = db.companies.get(companyId);
      return row === undefined
        ? null
        : {
            id: row.id,
            name: row.name,
            timezone: row.timezone,
            defaultCurrency: row.defaultCurrency,
          } satisfies GmCompanyView;
    },
    openActivationOf: async (companyId) => {
      const open = db.activations.filter(
        (row) => row.companyId === companyId && row.endedAtMs === null,
      );
      return open.length > 0 ? activationViewOf(open[0]!) : null;
    },
    latestActivationOf: async (companyId) => {
      const rows = db.activations
        .filter((row) => row.companyId === companyId)
        .sort((a, b) => b.activatedAtMs - a.activatedAtMs);
      const row = rows[0];
      return row === undefined ? null : activationViewOf(row);
    },
    membershipsOfCompany: async (companyId) =>
      db.memberships
        .filter((row) => row.companyId === companyId)
        .sort((a, b) => a.membershipId.localeCompare(b.membershipId)),
    recentRunsOfCompany: async (companyId, limit) =>
      db.runs
        .filter((row) => db.companyOfRun.get(row.runId) === companyId)
        .sort((a, b) => b.startedAtMs - a.startedAtMs)
        .slice(0, limit),
    recentJobsOfCompany: async (companyId, limit) =>
      db.jobs
        .filter((row) => row.companyId === companyId)
        .sort((a, b) => a.jobId.localeCompare(b.jobId))
        .slice(0, limit),
    insertGrant: async (row) => {
      const id = `j97grant${nextGrant()}`;
      db.grants.set(id, { id, ...row, closedAtMs: null });
      return id;
    },
    closeGrant: async (grantId, closedAtMs) => {
      const row = db.grants.get(grantId);
      if (row === undefined || row.closedAtMs !== null) {
        return false;
      }
      row.closedAtMs = closedAtMs;
      return true;
    },
    insertCompany: async (row) => {
      const id = `k57company${nextCompany()}`;
      db.companies.set(id, { id, ...row });
      return id;
    },
    insertActivation: async (row) => {
      const id = `j97activation${nextActivation()}`;
      db.activations.push({ id, ...row, endedAtMs: null, endedByUserId: null });
      return id;
    },
    endActivation: async (activationId, endedAtMs, endedByUserId) => {
      const row = db.activations.find((candidate) => candidate.id === activationId);
      if (row === undefined || row.endedAtMs !== null) {
        return false;
      }
      row.endedAtMs = endedAtMs;
      row.endedByUserId = endedByUserId;
      return true;
    },
    insertInvitation: async (row) => {
      const id = `k57invitation${nextInvitation()}`;
      db.invitations.push({ id, ...row });
      return id;
    },
    patchMembershipRole: async (membershipId, role) => {
      const row: MutableMembership | undefined = db.memberships.find(
        (candidate) => candidate.membershipId === membershipId,
      );
      if (row === undefined) {
        return false;
      }
      row.role = role;
      return true;
    },
    insertAudit: async (row) => {
      db.audit.push({ ...row });
    },
  };
}

/** Seeds one run row for a company (inspection projections read it). */
export function seedRun(db: FakeGmDb, companyId: string, run: Partial<GmRunRow> = {}): GmRunRow {
  const row: GmRunRow = {
    runId: `qs9run${db.runs.length + 1}`,
    kind: "initial_analysis",
    state: "failed",
    startedAtMs: 1_800_000_000_000,
    finishedAtMs: 1_800_000_000_001,
    ...run,
  };
  db.runs.push(row);
  db.companyOfRun.set(row.runId, companyId);
  return row;
}

/** Seeds one job row for a company (inspection projections read it). */
export function seedJob(db: FakeGmDb, companyId: string, job: Partial<GmJobRow> = {}): GmJobRow {
  const row: GmJobRow & { readonly companyId: string } = {
    jobId: `hz5job${db.jobs.length + 1}`,
    kind: "access.cleanup_revocation",
    state: "succeeded",
    attempts: 1,
    maxAttempts: 3,
    lastErrorKind: null,
    ...job,
    companyId,
  };
  db.jobs.push(row);
  return row;
}
