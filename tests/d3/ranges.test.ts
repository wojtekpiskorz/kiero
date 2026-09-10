/**
 * D3 focused verification: the PURE read decisions of the media protocol
 * (RFC 9110 byte ranges and conditional requests) — first, middle, suffix,
 * zero-length, overlong, invalid, unsatisfiable and multi-range inputs,
 * plus the If-None-Match / If-Range evaluation order and the served-content
 * vocabulary. No deployment needed: these are the decisions the gateway
 * route follows verbatim.
 */

import { describe, expect, it } from "vitest";
import {
  MEDIA_CACHE_CONTROL,
  contentTypeForKind,
  decideMediaRead,
  decideRange,
  ifNoneMatchMatches,
  ifRangePermits,
  quotedEtag,
} from "../../convex/sources/media_access/protocol";

const TOTAL = 10_000;

describe("decideRange (single byte ranges)", () => {
  it("serves a first range (bytes=0-499)", () => {
    expect(decideRange("bytes=0-499", TOTAL)).toEqual({ decision: "range", first: 0, last: 499 });
  });

  it("serves a middle range (bytes=4000-4999)", () => {
    expect(decideRange("bytes=4000-4999", TOTAL)).toEqual({
      decision: "range",
      first: 4000,
      last: 4999,
    });
  });

  it("serves the minimal one-byte range (bytes=0-0)", () => {
    expect(decideRange("bytes=0-0", TOTAL)).toEqual({ decision: "range", first: 0, last: 0 });
  });

  it("serves an open-ended range to the last byte (bytes=9999-)", () => {
    expect(decideRange("bytes=9999-", TOTAL)).toEqual({
      decision: "range",
      first: 9999,
      last: 9999,
    });
  });

  it("serves a whole-file open range (bytes=0-)", () => {
    expect(decideRange("bytes=0-", TOTAL)).toEqual({ decision: "range", first: 0, last: 9999 });
  });

  it("caps an overlong end to the last byte (bytes=100-999999)", () => {
    expect(decideRange("bytes=100-999999", TOTAL)).toEqual({
      decision: "range",
      first: 100,
      last: 9999,
    });
  });

  it("serves a suffix range (bytes=-500)", () => {
    expect(decideRange("bytes=-500", TOTAL)).toEqual({
      decision: "range",
      first: TOTAL - 500,
      last: TOTAL - 1,
    });
  });

  it("serves the whole file when the suffix exceeds the length (bytes=-50000)", () => {
    expect(decideRange("bytes=-50000", TOTAL)).toEqual({ decision: "range", first: 0, last: 9999 });
  });

  it("treats surrounding whitespace leniently", () => {
    expect(decideRange("  bytes=0-499  ", TOTAL)).toEqual({
      decision: "range",
      first: 0,
      last: 499,
    });
  });

  it("matches the range unit case-insensitively", () => {
    expect(decideRange("BYTES=0-499", TOTAL)).toEqual({
      decision: "range",
      first: 0,
      last: 499,
    });
  });
});

describe("decideRange (unsatisfiable and invalid inputs)", () => {
  it("answers unsatisfiable when the first byte is beyond the last byte", () => {
    expect(decideRange("bytes=10000-", TOTAL)).toEqual({
      decision: "unsatisfiable",
      totalBytes: TOTAL,
    });
    expect(decideRange("bytes=10000-10050", TOTAL)).toEqual({
      decision: "unsatisfiable",
      totalBytes: TOTAL,
    });
  });

  it("answers unsatisfiable for a zero-length suffix (bytes=-0)", () => {
    expect(decideRange("bytes=-0", TOTAL)).toEqual({ decision: "unsatisfiable", totalBytes: TOTAL });
  });

  it("answers unsatisfiable for every range against a zero-length representation", () => {
    expect(decideRange("bytes=0-", 0)).toEqual({ decision: "unsatisfiable", totalBytes: 0 });
    expect(decideRange("bytes=-1", 0)).toEqual({ decision: "unsatisfiable", totalBytes: 0 });
  });

  it("ignores multi-range requests whole (documented policy: full 200)", () => {
    expect(decideRange("bytes=0-1,5-6", TOTAL)).toEqual({ decision: "full" });
    expect(decideRange("bytes=0-0,-1", TOTAL)).toEqual({ decision: "full" });
  });

  it("ignores syntactically invalid specifiers", () => {
    for (const header of [
      "bytes=abc",
      "bytes=5-2",
      "bytes=-",
      "bytes=--5",
      "bytes=1-2-3",
      "bytes=+1-5",
      "bytes=  ,  ",
      "bytes=1_000-",
      "octets=0-499",
    ]) {
      expect(decideRange(header, TOTAL), header).toEqual({ decision: "full" });
    }
  });
});

describe("ifNoneMatchMatches (weak comparison, RFC 9110 13.1.2)", () => {
  it("matches the exact quoted etag", () => {
    expect(ifNoneMatchMatches(`"abc123"`, "abc123")).toBe(true);
  });

  it("matches the unquoted form and weak-tag form", () => {
    expect(ifNoneMatchMatches("abc123", "abc123")).toBe(true);
    expect(ifNoneMatchMatches(`W/"abc123"`, "abc123")).toBe(true);
  });

  it("matches any of a list", () => {
    expect(ifNoneMatchMatches(`"x", "abc123"`, "abc123")).toBe(true);
  });

  it("matches everything on asterisk", () => {
    expect(ifNoneMatchMatches("*", "abc123")).toBe(true);
  });

  it("does not match a different etag", () => {
    expect(ifNoneMatchMatches(`"other"`, "abc123")).toBe(false);
    expect(ifNoneMatchMatches(`"x", "y"`, "abc123")).toBe(false);
  });
});

describe("ifRangePermits (strong etag comparison only)", () => {
  it("permits on the exact strong etag", () => {
    expect(ifRangePermits(`"abc123"`, "abc123")).toBe(true);
    expect(ifRangePermits("abc123", "abc123")).toBe(true);
  });

  it("refuses a weak-tag comparison (strong-only policy)", () => {
    expect(ifRangePermits(`W/"abc123"`, "abc123")).toBe(false);
  });

  it("refuses different etags and HTTP-dates (no Last-Modified served)", () => {
    expect(ifRangePermits(`"other"`, "abc123")).toBe(false);
    expect(ifRangePermits("Wed, 21 Oct 2015 07:28:00 GMT", "abc123")).toBe(false);
  });
});

describe("decideMediaRead (the one evaluation order)", () => {
  const ETAG = "etag-d3";

  it("answers 304 before any range consideration", () => {
    expect(decideMediaRead({ range: "bytes=0-9", ifNoneMatch: `"${ETAG}"` }, ETAG, TOTAL)).toEqual({
      status: 304,
    });
  });

  it("answers 304 on asterisk even with an unsatisfiable range", () => {
    expect(decideMediaRead({ range: "bytes=99999-", ifNoneMatch: "*" }, ETAG, TOTAL)).toEqual({
      status: 304,
    });
  });

  it("serves full when no Range is present", () => {
    expect(decideMediaRead({}, ETAG, TOTAL)).toEqual({ status: 200 });
  });

  it("serves the range when If-Range matches", () => {
    expect(
      decideMediaRead({ range: "bytes=0-499", ifRange: `"${ETAG}"` }, ETAG, TOTAL),
    ).toEqual({ status: 206, first: 0, last: 499 });
  });

  it("ignores the Range entirely when If-Range does not match", () => {
    expect(decideMediaRead({ range: "bytes=0-499", ifRange: `"stale"` }, ETAG, TOTAL)).toEqual({
      status: 200,
    });
    expect(
      decideMediaRead({ range: "bytes=0-499", ifRange: "Wed, 21 Oct 2015 07:28:00 GMT" }, ETAG, TOTAL),
    ).toEqual({ status: 200 });
  });

  it("answers 416 for an unsatisfiable range without If-Range", () => {
    expect(decideMediaRead({ range: `bytes=${TOTAL}-` }, ETAG, TOTAL)).toEqual({
      status: 416,
      totalBytes: TOTAL,
    });
  });

  it("serves suffix ranges through the full decision path", () => {
    expect(decideMediaRead({ range: "bytes=-100" }, ETAG, TOTAL)).toEqual({
      status: 206,
      first: TOTAL - 100,
      last: TOTAL - 1,
    });
  });

  it("ignores an invalid range through the full decision path (full 200)", () => {
    expect(decideMediaRead({ range: "bytes=9-5" }, ETAG, TOTAL)).toEqual({ status: 200 });
  });
});

describe("served-content vocabulary", () => {
  it("maps the attachment kind to D2's recorded media types", () => {
    expect(contentTypeForKind("audio")).toBe("audio/webm");
    expect(contentTypeForKind("image")).toBe("image/jpeg");
  });

  it("serves strong quoted etags", () => {
    expect(quotedEtag("abc")).toBe(`"abc"`);
  });

  it("pins the no-store cache policy (authorization cannot be cached away)", () => {
    expect(MEDIA_CACHE_CONTROL).toBe("no-store");
  });
});
