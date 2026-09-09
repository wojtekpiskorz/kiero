/**
 * The B2 in-memory fake of the linking store surfaces (tests/b2).
 *
 * Implements `LinkingTx` (and through it `LinkingStore`) over plain maps,
 * with the same semantics the Convex adapters provide: normalizeId becomes
 * a table-prefix check, an explicit undefined in a patch clears the field,
 * the ceremony lifecycle predicates come from the REAL policy module, the
 * issuance throttle delegates to the REAL shared core
 * (`commitIssuanceAttempt`), and revocation delegates to B1's REAL
 * `revokeSessionCore` over a fake `RevocationSurface` (one semantics
 * everywhere).
 *
 * Fake ids are TEST FIXTURE DATA constructed in this one documented helper
 * — not values crossing an external boundary (the no-cast rule governs
 * provider/callback/input decoding, which stays schema-decoded).
 */

import type { Doc } from "../../convex/_generated/dataModel";
import { revokeSessionCore } from "../../convex/access/identity/operations";
import { normalizeEmail } from "../../convex/access/identity/userPolicy";
import { commitIssuanceAttempt } from "../../convex/access/identity/issuanceLimit";
import { attemptActive, attemptStateOpen } from "../../convex/access/linking/policy";
import type {
  AttemptPatch,
  AttemptSnapshot,
  EmailChangeSnapshot,
  LinkingTx,
} from "../../convex/access/linking/store";

export interface FakeUserRow {
  id: string;
  email: string;
  googleSubject: string | null;
  emailVerificationTime: number | null;
}

export interface FakeAttemptRow {
  id: string;
  userId: string;
  email: string;
  initiatingMethod: "google" | "email_code";
  targetMethod: "google" | "email_code";
  state: AttemptSnapshot["state"];
  startedAtMs: number;
  expiresAtMs: number;
  firstProofAtMs: number | null;
  pendingCodeHash: string | null;
  pendingCodeExpiresAtMs: number | null;
  committedAtMs: number | null;
  googleSub: string | null;
  rejectedAtMs: number | null;
  rejectionCode: string | null;
}

export interface FakeEmailChangeRow {
  id: string;
  userId: string;
  newEmail: string;
  previousEmail: string;
  codeHash: string;
  requestedAtMs: number;
  expiresAtMs: number;
  confirmedAtMs: number | null;
}

export interface FakeAuthAccountRow {
  id: string;
  userId: string;
  provider: "email_code" | "google";
  providerAccountId: string;
}

export interface FakeRegistryRow {
  id: string;
  userId: string;
  revokedAtMs: number | null;
}

export interface FakeAuthSessionRow {
  id: string;
  userId: string;
}

export interface FakeRecoveryRow {
  userId: string;
  verificationBasis: string;
  performedBy: string;
  performedAtMs: number;
  revokedSessionIds: string[];
  clearedAccountIds: string[];
  clearedGoogleSubject: boolean;
}

export interface FakeLinkingDb {
  users: Map<string, FakeUserRow>;
  attempts: Map<string, FakeAttemptRow>;
  emailChanges: Map<string, FakeEmailChangeRow>;
  authAccounts: FakeAuthAccountRow[];
  registrySessions: FakeRegistryRow[];
  authSessions: FakeAuthSessionRow[];
  refreshTokens: { id: string; sessionId: string }[];
  rateLimits: Map<string, { lastAttemptTime: number; attemptsLeft: number }>;
  recoveries: FakeRecoveryRow[];
  /** The canonical revocation events published through the real core. */
  publishedRevocations: { sessionId: string }[];
}

export function fakeDb(seed?: Partial<FakeLinkingDb>): FakeLinkingDb {
  return {
    users: seed?.users ?? new Map(),
    attempts: seed?.attempts ?? new Map(),
    emailChanges: seed?.emailChanges ?? new Map(),
    authAccounts: seed?.authAccounts ?? [],
    registrySessions: seed?.registrySessions ?? [],
    authSessions: seed?.authSessions ?? [],
    refreshTokens: seed?.refreshTokens ?? [],
    rateLimits: seed?.rateLimits ?? new Map(),
    recoveries: seed?.recoveries ?? [],
    publishedRevocations: [],
  };
}

export function fakeUser(overrides: Partial<FakeUserRow> = {}): FakeUserRow {
  return {
    id: "k57user1",
    email: "szef@kiero.invalid",
    googleSubject: null,
    emailVerificationTime: null,
    ...overrides,
  };
}

export function fakeAttempt(overrides: Partial<FakeAttemptRow> = {}): FakeAttemptRow {
  return {
    id: "rd7attempt1",
    userId: "k57user1",
    email: "szef@kiero.invalid",
    initiatingMethod: "email_code",
    targetMethod: "google",
    state: "awaiting_first_proof",
    startedAtMs: 1_800_000_000_000,
    expiresAtMs: 1_800_000_000_000 + 15 * 60 * 1000,
    firstProofAtMs: null,
    pendingCodeHash: null,
    pendingCodeExpiresAtMs: null,
    committedAtMs: null,
    googleSub: null,
    rejectedAtMs: null,
    rejectionCode: null,
    ...overrides,
  };
}

function snapshotOf(row: FakeAttemptRow): AttemptSnapshot {
  return {
    id: row.id,
    userId: row.userId,
    email: row.email,
    initiatingMethod: row.initiatingMethod,
    targetMethod: row.targetMethod,
    state: row.state,
    startedAtMs: row.startedAtMs,
    expiresAtMs: row.expiresAtMs,
    firstProofAtMs: row.firstProofAtMs,
    pendingCodeHash: row.pendingCodeHash,
    pendingCodeExpiresAtMs: row.pendingCodeExpiresAtMs,
  };
}

function isOpen(row: FakeAttemptRow): boolean {
  return attemptStateOpen(row);
}

/** Builds the fake LinkingTx over one FakeLinkingDb (sequential ids). */
export function fakeLinkingTx(db: FakeLinkingDb): LinkingTx {
  let nextId = 1;
  const newId = (prefix: string): string => `${prefix}${nextId++}`;

  const store = {
    userById: async (id: string) => {
      const user = db.users.get(id);
      return user === undefined
        ? null
        : { id: user.id, email: user.email, googleSubject: user.googleSubject };
    },
    usersByEmail: async (email: string) => {
      const normalized = normalizeEmail(email);
      return [...db.users.values()]
        .filter((user) => normalizeEmail(user.email) === normalized)
        .map((user) => ({ id: user.id, email: user.email, googleSubject: user.googleSubject }));
    },
    openAttemptsByEmail: async (email: string) => {
      const normalized = normalizeEmail(email);
      return [...db.attempts.values()]
        .filter((row) => normalizeEmail(row.email) === normalized && isOpen(row))
        .map(snapshotOf);
    },
    activeAttemptByUser: async (userId: string, nowMs: number) => {
      const active = [...db.attempts.values()]
        .filter((row) => row.userId === userId && attemptActive(row, nowMs))
        .sort((a, b) => b.startedAtMs - a.startedAtMs);
      const row = active[0];
      return row === undefined ? null : snapshotOf(row);
    },
    latestAttemptByUser: async (userId: string) => {
      const latest = [...db.attempts.values()]
        .filter((row) => row.userId === userId)
        .sort((a, b) => b.startedAtMs - a.startedAtMs);
      const row = latest[0];
      return row === undefined ? null : snapshotOf(row);
    },
    emailCodeCredentialOwner: async (email: string) => {
      const normalized = normalizeEmail(email);
      const account = db.authAccounts.find(
        (row) => row.provider === "email_code" && row.providerAccountId === normalized,
      );
      return account === undefined ? null : account.userId;
    },
    hasEmailCodeCredential: async (userId: string) =>
      db.authAccounts.some((row) => row.provider === "email_code" && row.userId === userId),
    googleCredentialOwner: async (sub: string) => {
      const account = db.authAccounts.find(
        (row) => row.provider === "google" && row.providerAccountId === sub,
      );
      return account === undefined ? null : account.userId;
    },
    usersWithGoogleSubject: async (sub: string) =>
      [...db.users.values()].filter((user) => user.googleSubject === sub).map((user) => user.id),
    registrySessionsByUser: async (userId: string) =>
      db.registrySessions
        .filter((row) => row.userId === userId)
        .map((row) => ({ id: row.id, revokedAtMs: row.revokedAtMs })),
    pendingEmailChange: async (userId: string): Promise<EmailChangeSnapshot | null> => {
      const pending = [...db.emailChanges.values()]
        .filter((row) => row.userId === userId && row.confirmedAtMs === null)
        .sort((a, b) => b.requestedAtMs - a.requestedAtMs);
      const row = pending[0];
      return row === undefined
        ? null
        : {
            id: row.id,
            newEmail: row.newEmail,
            previousEmail: row.previousEmail,
            codeHash: row.codeHash,
            requestedAtMs: row.requestedAtMs,
            expiresAtMs: row.expiresAtMs,
            confirmed: false,
          };
    },
  };

  return {
    ...store,
    insertAttempt: async (row) => {
      const id = newId("rd7attempt");
      db.attempts.set(id, {
        id,
        userId: row.userId,
        email: row.email,
        initiatingMethod: row.initiatingMethod,
        targetMethod: row.targetMethod,
        state: "awaiting_first_proof",
        startedAtMs: row.startedAtMs,
        expiresAtMs: row.expiresAtMs,
        firstProofAtMs: null,
        pendingCodeHash: null,
        pendingCodeExpiresAtMs: null,
        committedAtMs: null,
        googleSub: null,
        rejectedAtMs: null,
        rejectionCode: null,
      });
      return id;
    },
    patchAttempt: async (id: string, patch: AttemptPatch) => {
      const row = db.attempts.get(id);
      if (row === undefined) {
        throw new Error("fake: no attempt row");
      }
      if (patch.state !== undefined) {
        row.state = patch.state;
      }
      if (patch.firstProofAtMs !== undefined) {
        row.firstProofAtMs = patch.firstProofAtMs;
      }
      if (patch.pendingCodeHash !== undefined) {
        row.pendingCodeHash = patch.pendingCodeHash;
      }
      if (patch.pendingCodeExpiresAtMs !== undefined) {
        row.pendingCodeExpiresAtMs = patch.pendingCodeExpiresAtMs;
      }
      if (patch.googleSub !== undefined) {
        row.googleSub = patch.googleSub;
      }
      if (patch.committedAtMs !== undefined) {
        row.committedAtMs = patch.committedAtMs;
      }
      if (patch.rejectedAtMs !== undefined) {
        row.rejectedAtMs = patch.rejectedAtMs;
      }
      if (patch.rejectionCode !== undefined) {
        row.rejectionCode = patch.rejectionCode;
      }
    },
    patchUser: async (id: string, patch) => {
      const user = db.users.get(id);
      if (user === undefined) {
        throw new Error("fake: no user row");
      }
      if (patch.googleSubject !== undefined) {
        user.googleSubject = patch.googleSubject ?? null;
      }
      if (patch.email !== undefined) {
        user.email = patch.email;
      }
      if (patch.emailVerificationTime !== undefined) {
        user.emailVerificationTime = patch.emailVerificationTime;
      }
    },
    insertEmailCodeAccount: async ({ userId, email, nowMs }) => {
      db.authAccounts.push({
        id: newId("xs7account"),
        userId,
        provider: "email_code",
        providerAccountId: normalizeEmail(email),
      });
      const user = db.users.get(userId);
      if (user !== undefined) {
        user.emailVerificationTime = nowMs;
      }
    },
    repointEmailCodeCredential: async ({ userId, previousEmail, newEmail }) => {
      const account = db.authAccounts.find(
        (row) =>
          row.provider === "email_code" &&
          row.providerAccountId === normalizeEmail(previousEmail),
      );
      if (account === undefined || account.userId !== userId) {
        return false;
      }
      account.providerAccountId = normalizeEmail(newEmail);
      return true;
    },
    insertEmailChange: async (row) => {
      const id = newId("qp9change");
      db.emailChanges.set(id, {
        id,
        userId: row.userId,
        newEmail: row.newEmail,
        previousEmail: row.previousEmail,
        codeHash: row.codeHash,
        requestedAtMs: row.requestedAtMs,
        expiresAtMs: row.expiresAtMs,
        confirmedAtMs: null,
      });
      return id;
    },
    patchEmailChange: async (id: string, patch) => {
      const row = db.emailChanges.get(id);
      if (row === undefined) {
        throw new Error("fake: no email change row");
      }
      if (patch.confirmedAtMs !== undefined) {
        row.confirmedAtMs = patch.confirmedAtMs;
      }
      if (patch.codeHash !== undefined) {
        row.codeHash = patch.codeHash;
      }
      if (patch.expiresAtMs !== undefined) {
        row.expiresAtMs = patch.expiresAtMs;
      }
    },
    applyIssuanceThrottle: (identifier: string, nowMs: number) =>
      // The REAL shared budget core over the fake's rate-limit map (the
      // map is keyed by identifier, so the row's "document id" IS the key).
      commitIssuanceAttempt(
        {
          throttleRow: async (id) => {
            const row = db.rateLimits.get(id);
            return row === undefined ? null : { id, ...row };
          },
          insertThrottleRow: async (id, row) => {
            db.rateLimits.set(id, { ...row });
          },
          patchThrottleRow: async (id, row) => {
            db.rateLimits.set(id, { ...row });
          },
        },
        identifier,
        nowMs,
      ),
    insertRecovery: async (row) => {
      db.recoveries.push({ ...row });
    },
    revokeRegistrySession: async (args) => {
      // The REAL B1 core over a fake surface: self-service check,
      // idempotence and the canonical event semantics all hold here too.
      const surface = {
        getSession: async (id: string): Promise<Doc<"sessions"> | null> => {
          const row = db.registrySessions.find((candidate) => candidate.id === id);
          return row === undefined
            ? null
            : ({
                _id: row.id,
                _creationTime: 0,
                userId: row.userId,
                startedAtMs: 0,
                lastSeenAtMs: 0,
                deviceLabel: "test",
                ...(row.revokedAtMs === null ? {} : { revokedAtMs: row.revokedAtMs }),
              } as Doc<"sessions">);
        },
        revokeSession: async (id: string, revokedAtMs: number) => {
          const row = db.registrySessions.find((candidate) => candidate.id === id);
          if (row === undefined) {
            throw new Error("fake: no registry row");
          }
          row.revokedAtMs = revokedAtMs;
        },
        publishSessionRevoked: async () => {
          db.publishedRevocations.push({ sessionId: args.targetSessionId });
        },
      };
      const outcome = await revokeSessionCore(surface, {
        // Fixture ids cross into B1's branded-id signature here (the same
        // documented test-fixture exception as the surface above).
        actorUserId: args.actorUserId as never,
        targetSessionId: args.targetSessionId as never,
        nowMs: args.nowMs,
        companyIdForEvent: args.companyIdForEvent as never,
      });
      return outcome.result._tag === "ok" ? { revoked: true } : { revoked: false };
    },
    deleteAuthSessionsOfUser: async (userId: string) => {
      const sessions = db.authSessions.filter((row) => row.userId === userId);
      for (const session of sessions) {
        db.refreshTokens = db.refreshTokens.filter((token) => token.sessionId !== session.id);
        db.authSessions = db.authSessions.filter((row) => row.id !== session.id);
      }
      return sessions.length;
    },
    deleteAuthAccountsOfUser: async (userId: string) => {
      const removed = db.authAccounts.filter((row) => row.userId === userId);
      db.authAccounts = db.authAccounts.filter((row) => row.userId !== userId);
      return removed.map((row) => row.id);
    },
  };
}
