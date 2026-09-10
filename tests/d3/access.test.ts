/**
 * D3 focused verification: the media access resolution matrix — WHO may
 * read WHAT, and which refusals are indistinguishable (non-disclosure).
 *
 * The SAME `mediaAccessChecked` path the gateway channel runs (caller
 * identity -> policy -> tenant-scoped resolution) drives against the D2
 * in-memory harness (tests/d2/harness.ts), so the matrix includes the
 * identity-layer denials: anonymous, revoked session, revoked membership
 * and the non-member stranger, plus the ledger-consistency fields of a
 * granted read (etag, byte length, content type, representation role).
 */

import { describe, expect, it } from "vitest";
import { mediaAccessChecked } from "../../convex/sources/media_access/commands";
import {
  authenticateAs,
  asReaderDb,
  fakeCtx,
  LEDGER_TABLES,
  seedAuthedActor,
  type AuthedFixture,
} from "../d2/harness";

// The checked path takes the real resolver's db shape; the fake satisfies
// it structurally (the D2 harness already proves this shape for uploads —
// the real mediaAccessDb adapter's get/withIndex/collect all map onto it).
function checked(ctx: ReturnType<typeof fakeCtx>, input: unknown) {
  return mediaAccessChecked(asReaderDb(ctx) as never, ctx.auth, input);
}

// --- fixtures -----------------------------------------------------------------------

interface ReadableMedia {
  readonly attachmentId: string;
  readonly representationId: string;
  readonly sourceId: string;
  readonly objectKey: string;
  readonly etag: string;
  readonly bytes: number;
}

interface SeededMedia {
  readonly fixture: AuthedFixture;
  readonly media: ReadableMedia;
}

/** One company's author with an accepted audio source and a verified received representation. */
async function seedReadableMedia(
  ctx: ReturnType<typeof fakeCtx>,
  label: string,
  lifecycle: "active" | "withdrawn" | "purged" = "active",
): Promise<SeededMedia> {
  const fixture = await seedAuthedActor(ctx, label);
  const sourceId = await ctx.db.insert("sources", {
    companyId: fixture.companyId,
    authorUserId: fixture.userId,
    authorText: "Nagranie z budowy (D3)",
    sentAtMs: Date.now(),
    sentAtTimezone: "Europe/Warsaw",
    fullyAcceptedAtMs: Date.now(),
    lifecycle,
  });
  const uploadId = await ctx.db.insert("uploads", {
    companyId: fixture.companyId,
    userId: fixture.userId,
    stage: "finalized",
    partCount: 1,
    createdAtMs: Date.now(),
    acceptedSourceId: sourceId,
  });
  const objectKey = `companies/${fixture.companyId}/uploads/${uploadId}/0-fixture`;
  const attachmentId = await ctx.db.insert("attachments", {
    uploadId,
    sourceId,
    kind: "audio",
    objectKey,
    receivedBytes: 12_345,
    completedAtMs: Date.now(),
    r2ObjectEtag: "etag-audio-1",
    contentHash: "r2:etag:etag-audio-1",
  });
  const representationId = await ctx.db.insert("mediaRepresentations", {
    attachmentId,
    role: "received",
    objectKey,
    contentHash: "r2:etag:etag-audio-1",
    transformVersion: "d2.received/1",
    verifiedAtMs: Date.now(),
    createdAtMs: Date.now(),
  });
  return { fixture, media: { attachmentId, representationId, sourceId, objectKey, etag: "etag-audio-1", bytes: 12_345 } };
}

// --- the matrix ----------------------------------------------------------------------

describe("granted reads (owner and fellow member)", () => {
  it("grants the author the verified received representation with the ledger's recorded fields", async () => {
    const ctx = fakeCtx(LEDGER_TABLES);
    const { fixture, media } = await seedReadableMedia(ctx, "owner");
    authenticateAs(ctx, fixture);
    const result = await checked(ctx, { attachmentId: media.attachmentId });
    expect(result).toEqual({
      _tag: "ok",
      value: {
        attachmentId: media.attachmentId,
        sourceId: media.sourceId,
        representationId: media.representationId,
        role: "received",
        kind: "audio",
        objectKey: media.objectKey,
        etag: "etag-audio-1",
        bytes: 12_345,
        contentType: "audio/webm",
        transformVersion: "d2.received/1",
      },
    });
  });

  it("grants a FELLOW MEMBER of the same company (accepted sources are shared firm history)", async () => {
    const ctx = fakeCtx(LEDGER_TABLES);
    const { media } = await seedReadableMedia(ctx, "author");
    const member = await seedAuthedActor(ctx, "member");
    // Point the member's fixture membership at the author's company.
    await ctx.db.patch("memberships", member.membershipId, { companyId: (await companyOf(ctx, media.sourceId))! });
    authenticateAs(ctx, member);
    const result = await checked(ctx, { attachmentId: media.attachmentId });
    expect(result._tag).toBe("ok");
  });

  it("serves an EXACT representation id (the E4/I3/I5 exact-version read)", async () => {
    const ctx = fakeCtx(LEDGER_TABLES);
    const { fixture, media } = await seedReadableMedia(ctx, "exact");
    authenticateAs(ctx, fixture);
    const result = await checked(ctx, { representationId: media.representationId });
    expect(result._tag).toBe("ok");
    if (result._tag === "ok") {
      expect((result.value as { representationId: string }).representationId).toBe(media.representationId);
    }
  });

  it("prefers the newest VERIFIED retained representation over the received one", async () => {
    const ctx = fakeCtx(LEDGER_TABLES);
    const { fixture, media } = await seedReadableMedia(ctx, "retained");
    const retainedKey = `${media.objectKey}-retained`;
    await ctx.db.insert("mediaRepresentations", {
      attachmentId: media.attachmentId,
      role: "retained",
      objectKey: retainedKey,
      contentHash: "r2:etag:etag-retained-9",
      transformVersion: "d5.retained/1",
      verifiedAtMs: Date.now() + 1,
      createdAtMs: Date.now() + 1,
    });
    authenticateAs(ctx, fixture);
    const result = await checked(ctx, { attachmentId: media.attachmentId });
    expect(result._tag).toBe("ok");
    if (result._tag === "ok") {
      const grant = result.value as { objectKey: string; etag: string; role: string };
      expect(grant.objectKey).toBe(retainedKey);
      expect(grant.etag).toBe("etag-retained-9");
      expect(grant.role).toBe("retained");
    }
  });

  it("ignores an UNVERIFIED retained representation and serves the verified received one", async () => {
    const ctx = fakeCtx(LEDGER_TABLES);
    const { fixture, media } = await seedReadableMedia(ctx, "processing");
    await ctx.db.insert("mediaRepresentations", {
      attachmentId: media.attachmentId,
      role: "retained",
      objectKey: `${media.objectKey}-processing`,
      contentHash: "r2:etag:etag-unverified",
      transformVersion: "d5.retained/1",
      createdAtMs: Date.now() + 2,
      // verifiedAtMs absent: the normalization is still in flight
    });
    authenticateAs(ctx, fixture);
    const result = await checked(ctx, { attachmentId: media.attachmentId });
    expect(result._tag).toBe("ok");
    if (result._tag === "ok") {
      expect((result.value as { objectKey: string }).objectKey).toBe(media.objectKey);
    }
  });

  it("keeps a WITHDRAWN source readable (history is part of the record)", async () => {
    const ctx = fakeCtx(LEDGER_TABLES);
    const { fixture, media } = await seedReadableMedia(ctx, "withdrawn", "withdrawn");
    authenticateAs(ctx, fixture);
    const result = await checked(ctx, { attachmentId: media.attachmentId });
    expect(result._tag).toBe("ok");
  });
});

describe("identity-layer denials (before any attachment row is read)", () => {
  it("refuses an anonymous caller", async () => {
    const ctx = fakeCtx(LEDGER_TABLES);
    const { media } = await seedReadableMedia(ctx, "anon");
    authenticateAs(ctx, null);
    const result = await checked(ctx, { attachmentId: media.attachmentId });
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unauthenticated");
    }
  });

  it("refuses a REVOKED SESSION (mid-stream revocation: the next range request)", async () => {
    const ctx = fakeCtx(LEDGER_TABLES);
    const { fixture, media } = await seedReadableMedia(ctx, "revoked-session");
    authenticateAs(ctx, fixture);
    const before = await checked(ctx, { attachmentId: media.attachmentId });
    expect(before._tag).toBe("ok");
    // B2's revocation: the session registry row dies; the token may still verify.
    await ctx.db.patch("sessions", fixture.sessionId, { revokedAtMs: Date.now() });
    const after = await checked(ctx, { attachmentId: media.attachmentId });
    expect(after._tag).toBe("error");
    if (after._tag === "error") {
      expect(after.error._tag).toBe("unauthenticated");
    }
  });

  it("refuses a REVOKED MEMBERSHIP (mid-stream revocation by the admin)", async () => {
    const ctx = fakeCtx(LEDGER_TABLES);
    const { fixture, media } = await seedReadableMedia(ctx, "revoked-membership");
    authenticateAs(ctx, fixture);
    const before = await checked(ctx, { attachmentId: media.attachmentId });
    expect(before._tag).toBe("ok");
    await ctx.db.patch("memberships", fixture.membershipId, { state: "revoked" });
    const after = await checked(ctx, { attachmentId: media.attachmentId });
    expect(after._tag).toBe("error");
    if (after._tag === "error") {
      expect(after.error._tag).toBe("unauthenticated");
    }
  });
});

describe("tenant isolation and non-disclosure (identical refusals)", () => {
  it("answers a NON-MEMBER stranger exactly like a nonexistent id", async () => {
    const ctx = fakeCtx(LEDGER_TABLES);
    const { media } = await seedReadableMedia(ctx, "tenant-a");
    const stranger = await seedAuthedActor(ctx, "stranger-other-firm");
    authenticateAs(ctx, stranger);
    const foreign = await checked(ctx, { attachmentId: media.attachmentId });
    const missing = await checked(ctx, { attachmentId: "k57doesnotexist0000000000zzzz" });
    expect(foreign._tag).toBe("error");
    expect(missing._tag).toBe("error");
    if (foreign._tag === "error" && missing._tag === "error") {
      expect(foreign.error).toEqual(missing.error);
      expect(foreign.error._tag).toBe("not_found");
      expect(JSON.stringify(foreign.error)).not.toContain("companies/");
    }
  });

  it("answers a foreign REPRESENTATION id exactly like a nonexistent one", async () => {
    const ctx = fakeCtx(LEDGER_TABLES);
    const { media } = await seedReadableMedia(ctx, "tenant-rep");
    const stranger = await seedAuthedActor(ctx, "stranger-rep");
    authenticateAs(ctx, stranger);
    const foreign = await checked(ctx, { representationId: media.representationId });
    const missing = await checked(ctx, { representationId: "k57doesnotexist0000000000zzzz" });
    expect(foreign).toEqual(missing);
  });

  it("answers a purged source's attachment exactly like a nonexistent id", async () => {
    const ctx = fakeCtx(LEDGER_TABLES);
    const { fixture, media } = await seedReadableMedia(ctx, "purged", "purged");
    authenticateAs(ctx, fixture);
    const purged = await checked(ctx, { attachmentId: media.attachmentId });
    const missing = await checked(ctx, { attachmentId: "k57doesnotexist0000000000zzzz" });
    expect(purged).toEqual(missing);
  });

  it("answers an unbound (not yet accepted) attachment exactly like a nonexistent id", async () => {
    const ctx = fakeCtx(LEDGER_TABLES);
    const fixture = await seedAuthedActor(ctx, "draft-author");
    const uploadId = await ctx.db.insert("uploads", {
      companyId: fixture.companyId,
      userId: fixture.userId,
      stage: "finalized",
      partCount: 1,
      createdAtMs: Date.now(),
    });
    const attachmentId = await ctx.db.insert("attachments", {
      uploadId,
      kind: "image",
      objectKey: `companies/${fixture.companyId}/uploads/${uploadId}/0-draft`,
      receivedBytes: 100,
      completedAtMs: Date.now(),
      r2ObjectEtag: "etag-draft",
    });
    authenticateAs(ctx, fixture);
    const unbound = await checked(ctx, { attachmentId });
    const missing = await checked(ctx, { attachmentId: "k57doesnotexist0000000000zzzz" });
    expect(unbound).toEqual(missing);
  });

  it("refuses malformed references with a typed validation error (no existence information)", async () => {
    const ctx = fakeCtx(LEDGER_TABLES);
    const { fixture, media } = await seedReadableMedia(ctx, "malformed");
    authenticateAs(ctx, fixture);
    for (const input of [{}, { attachmentId: "", representationId: "" }, { attachmentId: "a", representationId: "b" }, "not-an-object"]) {
      const result = await checked(ctx, input);
      expect(result._tag, JSON.stringify(input)).toBe("error");
      if (result._tag === "error") {
        expect(result.error._tag).toBe("validation");
      }
    }
    expect((await checked(ctx, { attachmentId: "not-a-convex-id" }))._tag).toBe("error");
    // A well-formed id of the right shape stays grantable (sanity).
    expect((await checked(ctx, { attachmentId: media.attachmentId }))._tag).toBe("ok");
  });
});

describe("ledger consistency of the grant", () => {
  it("refuses (fail closed) when the etag record is missing", async () => {
    const ctx = fakeCtx(LEDGER_TABLES);
    const { fixture, media } = await seedReadableMedia(ctx, "no-etag");
    await ctx.db.patch("attachments", media.attachmentId, { r2ObjectEtag: undefined });
    await ctx.db.patch("mediaRepresentations", media.representationId, { contentHash: "sha256:unprefixed-form" });
    authenticateAs(ctx, fixture);
    const result = await checked(ctx, { attachmentId: media.attachmentId });
    expect(result._tag).toBe("error");
  });

  it("refuses (fail closed) when the received byte length record is missing", async () => {
    const ctx = fakeCtx(LEDGER_TABLES);
    const { fixture, media } = await seedReadableMedia(ctx, "no-bytes");
    await ctx.db.patch("attachments", media.attachmentId, { receivedBytes: undefined });
    authenticateAs(ctx, fixture);
    const result = await checked(ctx, { attachmentId: media.attachmentId });
    expect(result._tag).toBe("error");
  });

  it("refuses when the representation's verified flag is missing", async () => {
    const ctx = fakeCtx(LEDGER_TABLES);
    const { fixture, media } = await seedReadableMedia(ctx, "unverified");
    await ctx.db.patch("mediaRepresentations", media.representationId, { verifiedAtMs: undefined });
    authenticateAs(ctx, fixture);
    const result = await checked(ctx, { attachmentId: media.attachmentId });
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("not_found");
    }
  });
});

/** Resolves the company of one source row (test helper). */
async function companyOf(ctx: ReturnType<typeof fakeCtx>, sourceId: string): Promise<string | null> {
  const row = ctx.db.rows("sources").find((entry) => entry._id === sourceId);
  return (row?.companyId as string) ?? null;
}
