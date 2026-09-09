/**
 * D1 focused tests: text-source acceptance decisions (pure).
 *
 * Immutability, replay and conflict semantics of one logical source are
 * decided by the pure functions in convex/sources/accept/acceptance.ts;
 * the live atomicity proofs run against the real dev deployment (the
 * transcripts in the issue report).
 */

import { describe, expect, it } from "vitest";
import {
  MAX_AUTHOR_TEXT_LENGTH,
  MAX_FUTURE_SENT_AT_SKEW_MS,
  acceptanceFingerprintHex,
  canonicalAcceptancePayload,
  decideAcceptance,
  dedupeProjectHints,
  resolveSentAtMs,
  validateAuthorText,
  validateTimezoneSnapshot,
} from "../../convex/sources/accept/acceptance";

const NOW = Date.parse("2026-09-09T10:00:00.000Z");

describe("author text validation (immutable message content)", () => {
  it("accepts real text", () => {
    expect(validateAuthorText("Dowóz płytek na Buniewice w czwartek")).toEqual({
      ok: true,
      value: "Dowóz płytek na Buniewice w czwartek",
    });
  });

  it("rejects whitespace-only and over-long text", () => {
    expect(validateAuthorText("   \n\t ")).toEqual({ ok: false, code: "author_text_empty" });
    expect(validateAuthorText("a".repeat(MAX_AUTHOR_TEXT_LENGTH + 1))).toEqual({
      ok: false,
      code: "author_text_too_long",
    });
  });
});

describe("send intention resolution", () => {
  it("treats an absent intention as server now", () => {
    expect(resolveSentAtMs(undefined, NOW)).toEqual({ ok: true, value: NOW });
  });

  it("accepts past and near-future intentions, rejects unparseable ones", () => {
    expect(resolveSentAtMs("2026-09-09T08:30:00.000Z", NOW)).toEqual({
      ok: true,
      value: Date.parse("2026-09-09T08:30:00.000Z"),
    });
    expect(resolveSentAtMs(new Date(NOW + 60_000).toISOString(), NOW)).toEqual({
      ok: true,
      value: NOW + 60_000,
    });
    expect(resolveSentAtMs("jutro rano", NOW)).toEqual({ ok: false, code: "sent_at_not_parseable" });
  });

  it("rejects an implausibly future clock (beyond the accepted skew)", () => {
    const future = new Date(NOW + MAX_FUTURE_SENT_AT_SKEW_MS + 3_600_000).toISOString();
    expect(resolveSentAtMs(future, NOW)).toEqual({
      ok: false,
      code: "sent_at_implausibly_future",
    });
  });
});

describe("timezone snapshot validation", () => {
  it("accepts real IANA zones", () => {
    expect(validateTimezoneSnapshot("Europe/Warsaw")).toEqual({
      ok: true,
      value: "Europe/Warsaw",
    });
  });

  it("rejects malformed zones", () => {
    expect(validateTimezoneSnapshot("Mars/Olympus")).toEqual({
      ok: false,
      code: "timezone_snapshot_invalid",
    });
  });
});

describe("project hints (context, deduplicated)", () => {
  it("preserves first-seen order while dropping duplicates", () => {
    expect(dedupeProjectHints(["p2", "p1", "p2", "p3", "p1"])).toEqual(["p2", "p1", "p3"]);
  });
});

describe("logical-source identity (the retry fingerprint)", () => {
  const base = {
    authorText: "Wycena dachu Kaczmarek",
    intendedSentAtIso: "2026-09-09T07:15:00.000Z",
    timezoneSnapshot: "Europe/Warsaw",
    projectHints: ["p1", "p2"],
  };

  it("is deterministic and hint-order independent", async () => {
    const a = await acceptanceFingerprintHex(base);
    const b = await acceptanceFingerprintHex({ ...base, projectHints: ["p2", "p1"] });
    expect(b).toBe(a);
    const again = await acceptanceFingerprintHex(base);
    expect(again).toBe(a);
  });

  it("distinguishes text, send intention, zone and projects", async () => {
    const a = await acceptanceFingerprintHex(base);
    expect(await acceptanceFingerprintHex({ ...base, authorText: "Wycena dachu Kaczmarka" })).not.toBe(a);
    expect(
      await acceptanceFingerprintHex({ ...base, intendedSentAtIso: "2026-09-09T07:20:00.000Z" }),
    ).not.toBe(a);
    expect(await acceptanceFingerprintHex({ ...base, timezoneSnapshot: "Europe/Berlin" })).not.toBe(a);
    expect(await acceptanceFingerprintHex({ ...base, projectHints: ["p1"] })).not.toBe(a);
    // An absent intention is its own canonical value, not an empty string.
    expect(canonicalAcceptancePayload(base)).not.toBe(
      canonicalAcceptancePayload({ ...base, intendedSentAtIso: undefined }),
    );
  });
});

describe("one logical key, one source (replay vs conflict vs edit)", () => {
  it("inserts when no source carries the key", () => {
    expect(decideAcceptance(null, "fp")).toEqual({ decision: "insert" });
  });

  it("replays the original when the fingerprint matches", () => {
    expect(decideAcceptance({ acceptanceFingerprint: "fp" }, "fp")).toEqual({
      decision: "replay",
    });
  });

  it("refuses the same key with a different payload (typed conflict, never an edit)", () => {
    expect(decideAcceptance({ acceptanceFingerprint: "fp" }, "other")).toEqual({
      decision: "conflict",
    });
    // Unreachable in practice (rows always carry a fingerprint): fail closed.
    expect(decideAcceptance({ acceptanceFingerprint: undefined }, "fp")).toEqual({
      decision: "conflict",
    });
  });
});
