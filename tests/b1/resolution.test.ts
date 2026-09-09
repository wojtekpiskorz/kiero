/**
 * B1 focused verification: the live-session resolution core.
 *
 * Subject parsing, the 30-day inactivity boundary and the upstream
 * authSessions projection — the pure halves of the identity source B1
 * swapped into the A3 canonical resolution seam.
 */

import { describe, expect, it } from "vitest";
import {
  SESSION_INACTIVITY_LIMIT_MS,
  authSessionDecision,
  liveSessionDecision,
  parseConvexAuthSubject,
} from "../../convex/access/identity/resolution";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;

describe("parseConvexAuthSubject", () => {
  it("parses a well-formed <userId>|<sessionId> subject", () => {
    expect(parseConvexAuthSubject("k57abc|s72def")).toEqual({
      authUserId: "k57abc",
      authSessionId: "s72def",
    });
  });

  it("rejects malformed subjects without throwing", () => {
    for (const subject of ["", "abc", "|x", "x|", "a|b|c", "a||b", "||"]) {
      expect(parseConvexAuthSubject(subject), subject).toBeNull();
    }
  });
});

describe("liveSessionDecision (30-day inactivity rule)", () => {
  it("keeps a session active just inside 30 days", () => {
    const lastSeen = NOW - (SESSION_INACTIVITY_LIMIT_MS - 1);
    expect(liveSessionDecision({ revokedAtMs: null, lastSeenAtMs: lastSeen }, NOW)).toEqual({
      tag: "live",
    });
  });

  it("keeps a session active at exactly 30 days (expiry starts beyond)", () => {
    const lastSeen = NOW - SESSION_INACTIVITY_LIMIT_MS;
    expect(liveSessionDecision({ revokedAtMs: null, lastSeenAtMs: lastSeen }, NOW)).toEqual({
      tag: "live",
    });
  });

  it("expires a session one millisecond beyond 30 days", () => {
    const lastSeen = NOW - (SESSION_INACTIVITY_LIMIT_MS + 1);
    expect(liveSessionDecision({ revokedAtMs: null, lastSeenAtMs: lastSeen }, NOW)).toEqual({
      tag: "denied",
      reason: "inactive",
    });
  });

  it("expires a long-inactive session deterministically", () => {
    expect(
      liveSessionDecision({ revokedAtMs: null, lastSeenAtMs: NOW - 31 * DAY }, NOW),
    ).toEqual({ tag: "denied", reason: "inactive" });
  });

  it("revocation wins over fresh activity", () => {
    expect(liveSessionDecision({ revokedAtMs: NOW - 1, lastSeenAtMs: NOW }, NOW)).toEqual({
      tag: "denied",
      reason: "revoked",
    });
  });
});

describe("authSessionDecision (upstream Convex Auth session)", () => {
  const userId = "k57user";

  it("denies a missing upstream session (signed out; JWT may still verify)", () => {
    expect(authSessionDecision(null, userId, NOW)).toEqual({
      tag: "denied",
      reason: "auth_session_missing",
    });
  });

  it("denies a subject that names a different user", () => {
    expect(
      authSessionDecision({ userId: "k57other", expirationTime: NOW + 1000 }, userId, NOW),
    ).toEqual({ tag: "denied", reason: "malformed_subject" });
  });

  it("denies an expired upstream session", () => {
    expect(authSessionDecision({ userId, expirationTime: NOW }, userId, NOW)).toEqual({
      tag: "denied",
      reason: "auth_session_expired",
    });
  });

  it("accepts a live upstream session", () => {
    expect(authSessionDecision({ userId, expirationTime: NOW + 1000 }, userId, NOW)).toEqual({
      tag: "live",
    });
  });
});
