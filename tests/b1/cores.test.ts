/**
 * B1 focused verification: the db-halves of the live-session cores and
 * the revocation core, against an in-memory fake of the narrowed store
 * surfaces (LiveSessionTx / RevocationSurface). These mirror the live
 * proof assertions (docs evidence: provision, bump, revocation denial,
 * inactivity, upstream removal) so the behavior is pinned without a
 * deployment too.
 *
 * Fake Convex ids are TEST FIXTURE DATA constructed in one documented
 * helper — not values crossing an external boundary (the no-cast rule
 * governs provider/callback/input decoding, which stays schema-decoded).
 */

import { describe, expect, it } from "vitest";
import type { Doc, Id } from "../../convex/_generated/dataModel";
import {
  SESSION_INACTIVITY_LIMIT_MS,
  provisionOrRefreshLiveSession,
  resolveLiveSession,
  type AuthReader,
  type LiveSessionTx,
} from "../../convex/access/identity/resolution";
import { revokeSessionCore, type RevocationSurface } from "../../convex/access/identity/operations";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

/**
 * Test-fixture ids (fake data, not external input — the no-cast rule
 * governs external-boundary decoding, which stays schema-decoded).
 */
const USER = "k57user1" as Id<"users">;
const OTHER_USER = "k57user2" as Id<"users">;
const AUTH_SESSION = "js7session1" as Id<"authSessions">;
const SESSION = "rd7registry1" as Id<"sessions">;
const NEW_SESSION = "rd7new1" as Id<"sessions">;
const COMPANY = "k57company1" as Id<"companies">;

type FakeRegistryRow = Doc<"sessions">;
type FakeUserRow = Doc<"users">;
type FakeAuthSessionRow = Doc<"authSessions">;

const userRow = (id: Id<"users">): FakeUserRow => ({
  _id: id,
  _creationTime: NOW - 40 * DAY,
  email: "b1@kiero.invalid",
  displayName: "B1",
  createdAtMs: NOW - 40 * DAY,
});

const authSessionRow = (userId: Id<"users">, expirationTime: number): FakeAuthSessionRow => ({
  _id: AUTH_SESSION,
  _creationTime: NOW - DAY,
  userId,
  expirationTime,
});

const registryRow = (overrides: Partial<FakeRegistryRow>): FakeRegistryRow => ({
  _id: SESSION,
  _creationTime: NOW - 40 * DAY,
  userId: USER,
  startedAtMs: NOW - DAY,
  lastSeenAtMs: NOW,
  deviceLabel: "Przeglądarka",
  authSessionId: AUTH_SESSION,
  ...overrides,
});

function fakeLiveSessionTx(rows: {
  authSessions?: Map<Id<"authSessions">, FakeAuthSessionRow>;
  users?: Map<Id<"users">, FakeUserRow>;
  sessions?: Map<Id<"sessions">, FakeRegistryRow>;
}): LiveSessionTx & { inserted: FakeRegistryRow[]; patched: { id: Id<"sessions">; lastSeenAtMs: number }[] } {
  const authSessions = rows.authSessions ?? new Map<Id<"authSessions">, FakeAuthSessionRow>();
  const users = rows.users ?? new Map<Id<"users">, FakeUserRow>([[USER, userRow(USER)]]);
  const sessions = rows.sessions ?? new Map<Id<"sessions">, FakeRegistryRow>();
  const inserted: FakeRegistryRow[] = [];
  const patched: { id: Id<"sessions">; lastSeenAtMs: number }[] = [];
  return {
    inserted,
    patched,
    // Well-formedness only (mirrors normalizeId); row existence surfaces
    // through the getters below.
    normalizeAuthSessionId: (value) => (value.length > 0 ? (value as Id<"authSessions">) : null),
    normalizeUserId: (value) => (value.length > 0 ? (value as Id<"users">) : null),
    authSessionById: async (value) => authSessions.get(value) ?? null,
    userById: async (value) => users.get(value) ?? null,
    registryByAuthSession: async (value) => {
      for (const row of sessions.values()) {
        if (row.authSessionId === value) {
          return row;
        }
      }
      return null;
    },
    registryRowById: async (value) => sessions.get(value) ?? null,
    insertRegistry: async (row) => {
      const full: FakeRegistryRow = { _id: NEW_SESSION, _creationTime: NOW, ...row };
      sessions.set(NEW_SESSION, full);
      inserted.push(full);
      return NEW_SESSION;
    },
    patchRegistry: async (value, patch) => {
      patched.push({ id: value, lastSeenAtMs: patch.lastSeenAtMs ?? NaN });
      const row = sessions.get(value);
      if (row !== undefined && patch.lastSeenAtMs !== undefined) {
        sessions.set(value, { ...row, lastSeenAtMs: patch.lastSeenAtMs });
      }
    },
  };
}

function authWithSubject(subject: string | null): AuthReader {
  return {
    getUserIdentity: async () => (subject === null ? null : { subject }),
  };
}

describe("provisionOrRefreshLiveSession (fake db)", () => {
  const liveUpstream = () => new Map([[AUTH_SESSION, authSessionRow(USER, NOW + DAY)]]);

  it("provisions the registry row on first authenticated use", async () => {
    const tx = fakeLiveSessionTx({ authSessions: liveUpstream() });
    const result = await provisionOrRefreshLiveSession(
      tx,
      authWithSubject(`${USER}|${AUTH_SESSION}`),
      NOW,
      "Telefon",
    );
    expect(result).toMatchObject({ tag: "live" });
    expect(tx.inserted).toEqual([
      {
        _id: NEW_SESSION,
        _creationTime: NOW,
        userId: USER,
        startedAtMs: NOW,
        lastSeenAtMs: NOW,
        deviceLabel: "Telefon",
        authSessionId: AUTH_SESSION,
      },
    ]);
  });

  it("bumps trusted activity time instead of duplicating the row", async () => {
    const tx = fakeLiveSessionTx({
      authSessions: liveUpstream(),
      sessions: new Map([[SESSION, registryRow({ lastSeenAtMs: NOW - DAY })]]),
    });
    const result = await provisionOrRefreshLiveSession(
      tx,
      authWithSubject(`${USER}|${AUTH_SESSION}`),
      NOW,
      "Przeglądarka",
    );
    expect(result).toMatchObject({ tag: "live" });
    expect(result.tag === "live" && result.session.lastSeenAtMs).toBe(NOW);
    expect(tx.inserted).toHaveLength(0);
    expect(tx.patched).toEqual([{ id: SESSION, lastSeenAtMs: NOW }]);
  });

  it("denies a revoked session even with fresh activity", async () => {
    const tx = fakeLiveSessionTx({
      authSessions: liveUpstream(),
      sessions: new Map([[SESSION, registryRow({ revokedAtMs: NOW - 1 })]]),
    });
    expect(
      await provisionOrRefreshLiveSession(tx, authWithSubject(`${USER}|${AUTH_SESSION}`), NOW, "x"),
    ).toEqual({ tag: "denied", reason: "revoked" });
    expect(tx.patched).toHaveLength(0);
  });

  it("denies beyond 30 days of inactivity and allows just inside", async () => {
    for (const [age, expected] of [
      [SESSION_INACTIVITY_LIMIT_MS - 1, "live"],
      [SESSION_INACTIVITY_LIMIT_MS + 1, "inactive"],
      [31 * DAY, "inactive"],
    ] as const) {
      const tx = fakeLiveSessionTx({
        authSessions: liveUpstream(),
        sessions: new Map([[SESSION, registryRow({ startedAtMs: NOW - 40 * DAY, lastSeenAtMs: NOW - age })]]),
      });
      const result = await provisionOrRefreshLiveSession(
        tx,
        authWithSubject(`${USER}|${AUTH_SESSION}`),
        NOW,
        "x",
      );
      if (expected === "live") {
        expect(result.tag, `age=${age}`).toBe("live");
      } else {
        expect(result, `age=${age}`).toEqual({ tag: "denied", reason: "inactive" });
      }
    }
  });

  it("denies when the upstream session is gone (token may still verify)", async () => {
    const tx = fakeLiveSessionTx({ authSessions: new Map() });
    expect(
      await provisionOrRefreshLiveSession(tx, authWithSubject(`${USER}|${AUTH_SESSION}`), NOW, "x"),
    ).toEqual({ tag: "denied", reason: "auth_session_missing" });
  });

  it("denies a subject whose user half disagrees with the session row", async () => {
    const tx = fakeLiveSessionTx({ authSessions: liveUpstream() });
    expect(
      await provisionOrRefreshLiveSession(
        tx,
        authWithSubject(`${OTHER_USER}|${AUTH_SESSION}`),
        NOW,
        "x",
      ),
    ).toEqual({ tag: "denied", reason: "subject_mismatch" });
  });

  it("refuses to provision a registry row for a ghost user", async () => {
    const tx = fakeLiveSessionTx({
      authSessions: liveUpstream(),
      users: new Map(), // the subject's user row does not exist
    });
    expect(
      await provisionOrRefreshLiveSession(tx, authWithSubject(`${USER}|${AUTH_SESSION}`), NOW, "x"),
    ).toEqual({ tag: "denied", reason: "subject_mismatch" });
    expect(tx.inserted).toHaveLength(0);
  });

  it("denies missing identity and malformed subjects", async () => {
    const tx = fakeLiveSessionTx({ authSessions: liveUpstream() });
    expect(await provisionOrRefreshLiveSession(tx, authWithSubject(null), NOW, "x")).toEqual({
      tag: "denied",
      reason: "no_identity",
    });
    expect(await provisionOrRefreshLiveSession(tx, authWithSubject("garbage"), NOW, "x")).toEqual({
      tag: "denied",
      reason: "malformed_subject",
    });
  });
});

describe("resolveLiveSession (read path, fake db)", () => {
  it("returns the live snapshot for a provisioned row", async () => {
    const store = fakeLiveSessionTx({
      authSessions: new Map([[AUTH_SESSION, authSessionRow(USER, NOW + DAY)]]),
      sessions: new Map([[SESSION, registryRow({})]]),
    });
    expect(await resolveLiveSession(store, authWithSubject(`${USER}|${AUTH_SESSION}`), NOW)).toEqual(
      {
        tag: "live",
        session: {
          sessionId: SESSION,
          userId: USER,
          startedAtMs: NOW - DAY,
          lastSeenAtMs: NOW,
          deviceLabel: "Przeglądarka",
        },
      },
    );
  });

  it("denies read-only resolution when the registry row is missing", async () => {
    const store = fakeLiveSessionTx({
      authSessions: new Map([[AUTH_SESSION, authSessionRow(USER, NOW + DAY)]]),
    });
    expect(
      await resolveLiveSession(store, authWithSubject(`${USER}|${AUTH_SESSION}`), NOW),
    ).toEqual({ tag: "denied", reason: "registry_missing" });
  });
});

describe("revokeSessionCore (fake surface)", () => {
  function fakeSurface(row: FakeRegistryRow | null): RevocationSurface & {
    revoked: { id: Id<"sessions">; revokedAtMs: number }[];
    published: { companyId: Id<"companies">; sessionId: Id<"sessions"> }[];
  } {
    const revoked: { id: Id<"sessions">; revokedAtMs: number }[] = [];
    const published: { companyId: Id<"companies">; sessionId: Id<"sessions"> }[] = [];
    return {
      revoked,
      published,
      getSession: async (value) => (row !== null && row._id === value ? row : null),
      revokeSession: async (value, revokedAtMs) => {
        revoked.push({ id: value, revokedAtMs });
      },
      publishSessionRevoked: async (args) => {
        published.push(args);
      },
    };
  }

  const ownRow: FakeRegistryRow = registryRow({});

  it("revokes the actor's own session and publishes the canonical event", async () => {
    const surface = fakeSurface(ownRow);
    const outcome = await revokeSessionCore(surface, {
      actorUserId: USER,
      targetSessionId: SESSION,
      nowMs: NOW,
      companyIdForEvent: COMPANY,
    });
    expect(outcome.result).toEqual({ _tag: "ok", value: { revokedAtMs: NOW } });
    expect(surface.revoked).toEqual([{ id: SESSION, revokedAtMs: NOW }]);
    expect(surface.published).toEqual([{ companyId: COMPANY, sessionId: SESSION }]);
  });

  it("skips publication when no company scope exists", async () => {
    const surface = fakeSurface(ownRow);
    await revokeSessionCore(surface, {
      actorUserId: USER,
      targetSessionId: SESSION,
      nowMs: NOW,
      companyIdForEvent: null,
    });
    expect(surface.published).toHaveLength(0);
    expect(surface.revoked).toHaveLength(1);
  });

  it("refuses to revoke another user's session", async () => {
    const surface = fakeSurface(ownRow);
    const outcome = await revokeSessionCore(surface, {
      actorUserId: OTHER_USER,
      targetSessionId: SESSION,
      nowMs: NOW,
      companyIdForEvent: COMPANY,
    });
    expect(outcome.result._tag).toBe("error");
    expect(surface.revoked).toHaveLength(0);
    expect(surface.published).toHaveLength(0);
  });

  it("fails not_found for an unknown session", async () => {
    const surface = fakeSurface(null);
    const outcome = await revokeSessionCore(surface, {
      actorUserId: USER,
      targetSessionId: SESSION,
      nowMs: NOW,
      companyIdForEvent: COMPANY,
    });
    expect(outcome.result._tag).toBe("error");
  });

  it("is idempotent: re-revocation returns the original time, no second event", async () => {
    const surface = fakeSurface({ ...ownRow, revokedAtMs: NOW - 1000 });
    const outcome = await revokeSessionCore(surface, {
      actorUserId: USER,
      targetSessionId: SESSION,
      nowMs: NOW,
      companyIdForEvent: COMPANY,
    });
    expect(outcome.result).toEqual({ _tag: "ok", value: { revokedAtMs: NOW - 1000 } });
    expect(surface.revoked).toHaveLength(0);
    expect(surface.published).toHaveLength(0);
  });
});
