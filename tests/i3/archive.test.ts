/**
 * I3 focused verification, part 1: the pure halves — the ZIP writer
 * (byte-exact structure, streaming CRC, bounds), the escaping/path
 * discipline (hostile content, traversal) and the lifecycle decisions.
 */

import { describe, expect, it } from "vitest";
import { crc32, crc32Update, ZipWriter, type ByteSink } from "../../apps/export-worker/src/zip";
import {
  archiveFileName,
  archiveObjectKey,
  escapeHtml,
  EXPORT_AVAILABILITY_MS,
  mediaArchivePath,
  safePathSegment,
} from "../../convex/operations/exports/protocol";
import {
  decideBeginBuild,
  decideDownload,
  decideExpiry,
  decidePublish,
  decideRequest,
  mintBuildToken,
} from "../../convex/operations/exports/lifecycle";
import { renderIndexHtml, collectionJsonFiles, manifestJson } from "../../apps/export-worker/src/render";
import type { CompanySnapshot, SnapshotRow } from "../../convex/operations/exports/protocol";

/** An independent CRC-32 implementation (the test's own oracle). */
function oracleCrc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of bytes) {
    c ^= byte;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

// --- the ZIP writer ------------------------------------------------------------

class MemorySink implements ByteSink {
  readonly chunks: Uint8Array[] = [];
  push(chunk: Uint8Array): void {
    this.chunks.push(chunk);
  }
  get bytes(): Uint8Array {
    const total = this.chunks.reduce((sum, c) => sum + c.length, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const c of this.chunks) {
      out.set(c, offset);
      offset += c.length;
    }
    return out;
  }
}

/** A minimal central-directory reader (the test's independent decoder). */
function readZipEntries(bytes: Uint8Array): { name: string; data: Uint8Array; crc: number }[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  // Find the end-of-central-directory record (scan back for its signature).
  let eocd = -1;
  for (let i = bytes.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const entries: { name: string; data: Uint8Array; crc: number }[] = [];
  for (let n = 0; n < count; n++) {
    expect(view.getUint32(offset, true)).toBe(0x02014b50);
    const crc = view.getUint32(offset + 16, true);
    const size = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localOffset = view.getUint32(offset + 42, true);
    const name = new TextDecoder("ascii").decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    // The local header mirrors the central record; data starts after it.
    expect(view.getUint32(localOffset, true)).toBe(0x04034b50);
    const localNameLength = view.getUint16(localOffset + 26, true);
    const localExtraLength = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    entries.push({ name, data: bytes.subarray(dataStart, dataStart + size), crc });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

describe("the streaming zip writer", () => {
  it("stores entries byte-exact with correct CRCs and a readable directory", { timeout: 20_000 }, () => {
    const sink = new MemorySink();
    const zip = new ZipWriter(sink);
    const big = new Uint8Array(300 * 1024 + 7);
    for (let i = 0; i < big.length; i++) {
      big[i] = i % 251;
    }
    zip.addFile("index.html", "<html>żółć</html>", 1_700_000_000_000);
    zip.beginFile("media/nagranie.webm", 1_700_000_000_000);
    // Stream in odd chunks: the CRC must not care about chunk boundaries.
    for (let offset = 0; offset < big.length; offset += 123_457) {
      zip.append(big.subarray(offset, Math.min(offset + 123_457, big.length)));
    }
    zip.endFile();
    zip.finish();
    const entries = readZipEntries(sink.bytes);
    expect(entries.map((e) => e.name)).toEqual(["index.html", "media/nagranie.webm"]);
    expect(entries[0]?.data).toEqual(new TextEncoder().encode("<html>żółć</html>"));
    expect(entries[0]?.crc).toEqual(oracleCrc32(new TextEncoder().encode("<html>żółć</html>")));
    expect(entries[1]?.data).toEqual(big);
    expect(entries[1]?.crc).toEqual(oracleCrc32(big));
  });

  it("computes CRC-32 identically to the platform implementation", () => {
    const bytes = new Uint8Array([0x31, 0x32, 0x33, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39]);
    expect(crc32(bytes)).toEqual(0xcbf43926); // the standard check value
    // Streaming in odd chunks equals the whole-sequence CRC.
    let state = 0xffffffff;
    for (let offset = 0; offset < bytes.length; offset += 4) {
      state = crc32Update(state, bytes.subarray(offset, Math.min(offset + 4, bytes.length)));
    }
    expect((state ^ 0xffffffff) >>> 0).toEqual(oracleCrc32(bytes));
  });

  it("refuses the state machine's misuse and closes after finish", () => {
    const zip = new ZipWriter(new MemorySink());
    expect(() => zip.endFile()).toThrow();
    zip.addFile("a.txt", "a", 0);
    zip.finish();
    expect(() => zip.addFile("b.txt", "b", 0)).toThrow();
  });
});

// --- escaping and paths ---------------------------------------------------------

describe("archive path and escaping discipline", () => {
  it("escapes every character that could open markup", () => {
    const hostile = `</ul><script>alert("x")</script><!--'-->&`;
    const escaped = escapeHtml(hostile);
    expect(escaped).not.toContain("<");
    expect(escaped).not.toContain(">");
    expect(escaped).toContain("&lt;/ul&gt;");
    expect(escaped).toContain("&quot;");
    expect(escaped).toContain("&#39;");
  });

  it("neutralizes traversal, absolute paths and separators in segments", () => {
    for (const hostile of ["../..", "..", "../../../../etc/passwd", "a/../b"]) {
      const cleaned = safePathSegment(hostile);
      expect(cleaned).not.toContain("..");
      expect(cleaned).not.toMatch(/[/\\]/);
      expect(cleaned.length).toBeGreaterThan(0);
    }
    expect(safePathSegment("a/b\\c")).toBe("a_b_c");
    expect(safePathSegment("")).toBe("plik");
    expect(safePathSegment("Żółć".repeat(80)).length).toBeLessThanOrEqual(120);
  });

  it("builds media paths from ids only, with closed extensions", () => {
    expect(mediaArchivePath("src123", "rep456", "audio/webm")).toBe("media/src123/rep456.webm");
    expect(mediaArchivePath("s", "r", "application/octet-stream")).toBe("media/s/r.bin");
  });

  it("names archives from the snapshot time and keys them per attempt", () => {
    expect(archiveFileName(0)).toBe("kiero-eksport-1970-01-01_00-00-00.zip");
    const key = archiveObjectKey("c1", "e1", "t1");
    expect(key.startsWith("exports/c1/e1/")).toBe(true);
    expect(key.endsWith("t1.zip")).toBe(true);
    expect(archiveObjectKey("c", "e", "t2")).not.toBe(key);
  });
});

// --- the lifecycle decisions ------------------------------------------------------

describe("the export lifecycle decisions", () => {
  it("reuses an in-flight export instead of starting a parallel build", () => {
    expect(decideRequest([])).toEqual({ decision: "start" });
    expect(decideRequest([{ _id: "k1" as never, state: "building" }])).toEqual({
      decision: "reuse",
      exportId: "k1" as never,
    });
  });

  it("begins builds only on pre-terminal rows", () => {
    for (const state of ["requested", "building"] as const) {
      expect(decideBeginBuild({ state })).toEqual({ decision: "begin" });
    }
    for (const state of ["available", "expired", "invalidated", "failed"] as const) {
      expect(decideBeginBuild({ state })).toEqual({ decision: "already_terminal" });
    }
  });

  it("publishes only the current token over a purged-free archive", () => {
    const row = { state: "building" as const, buildToken: "t1" };
    expect(decidePublish(row, "t1", [{ sourceId: "s1", lifecycle: "active" }])).toEqual({ decision: "publish" });
    expect(decidePublish(row, "t2", [])).toEqual({ decision: "stale_token" });
    expect(decidePublish({ state: "available", buildToken: "t1" }, "t1", [])).toEqual({ decision: "not_building" });
    // A missing source row purges like a purged one (rows never resurrect).
    expect(decidePublish(row, "t1", [{ sourceId: "s9", lifecycle: "purged" }])).toEqual({
      decision: "source_purged",
      sourceId: "s9",
    });
    expect(decidePublish(row, "t1", [{ sourceId: "s9", lifecycle: null }]).decision).toBe("source_purged");
  });

  it("gates downloads on state, window and linked purges", () => {
    const available = {
      state: "available" as const,
      availableUntilMs: 1_000_000,
      objectKey: "exports/c/e/t.zip",
      etag: "etag",
      bytes: 10,
    };
    expect(decideDownload(available, [{ lifecycle: "active" }], 999_999)).toEqual({ decision: "allow" });
    expect(decideDownload(available, [], 1_000_000)).toEqual({ decision: "refuse", reason: "expired" });
    expect(decideDownload(available, [{ lifecycle: "purged" }], 1)).toEqual({
      decision: "refuse",
      reason: "source_purged",
    });
    expect(decideDownload({ ...available, state: "invalidated" as const }, [], 1)).toEqual({
      decision: "refuse",
      reason: "not_available",
    });
    const noEtag = { ...available } as Partial<typeof available>;
    delete (noEtag as { etag?: string }).etag;
    expect(decideDownload(noEtag as typeof available, [], 1).decision).toBe("refuse");
  });

  it("expires exactly at the window's end and mints distinct tokens", () => {
    expect(decideExpiry({ state: "available", availableUntilMs: 100 }, 100)).toBe(true);
    expect(decideExpiry({ state: "available", availableUntilMs: 101 }, 100)).toBe(false);
    expect(decideExpiry({ state: "expired", availableUntilMs: 0 }, 100)).toBe(false);
    expect(EXPORT_AVAILABILITY_MS).toBe(24 * 60 * 60 * 1000);
    const tokens = new Set(Array.from({ length: 50 }, () => mintBuildToken(1)));
    expect(tokens.size).toBe(50);
  });
});

// --- the rendered archive ----------------------------------------------------------

const row = (id: string, extra: Record<string, unknown> = {}): SnapshotRow => ({ id, ...extra });

function fixtureSnapshot(): CompanySnapshot {
  return {
    schemaVersion: "kiero-export/1",
    snapshotAtMs: 1_700_000_012_345,
    exportId: "exp1",
    company: { companyId: "c1", name: `Budowa "Omega" <i>`, timezone: "Europe/Warsaw", defaultCurrency: "PLN" },
    people: [row("u1", { displayName: "Anna '<script>'" })],
    memberships: [row("m1", { userId: "u1", role: "admin", state: "active", createdAtMs: 1 })],
    projects: [row("p1", { displayName: "Kaczmarek <b>", stage: "in_progress" })],
    projectAliases: [row("a1", { projectId: "p1", codename: "Kaczmarek", active: true })],
    contacts: [],
    contactRoles: [],
    sources: [row("s1", { authorUserId: "u1", authorText: "wycena 45 000 < zł", sentAtMs: 5, lifecycle: "active" })],
    sourceProjectLinks: [row("l1", { sourceId: "s1", projectId: "p1" })],
    extractions: [],
    sourceFragments: [],
    attachments: [row("at1", { sourceId: "s1", kind: "image", archivePath: "media/s1/r1.jpg" })],
    findings: [row("f1", { scopeKind: "company", semanticKey: "cena", knowledgeState: { _tag: "known" } })],
    findingRevisions: [row("r1", { findingId: "f1", value: { _tag: "text_note", text: "45k" } })],
    evidenceLinks: [],
    findingDependencies: [],
    clarifications: [],
    extensionDefinitions: [],
    extensionVersions: [],
    tasks: [row("t1", { title: "Zadanie </td>", projectId: "p1", state: "todo" })],
    checklistItems: [],
    events: [],
    workRevisions: [],
    media: [
      {
        representationId: "r1",
        attachmentId: "at1",
        sourceId: "s1",
        role: "retained",
        kind: "image",
        objectKey: "media/x",
        etag: "e1",
        bytes: 3,
        contentType: "image/jpeg",
        archivePath: "media/s1/r1.jpg",
      },
    ],
  };
}

describe("the rendered archive", () => {
  it("renders an unscripted index where hostile strings stay text", () => {
    const html = renderIndexHtml(fixtureSnapshot());
    expect(html).toContain("<!DOCTYPE html>");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/onerror/i);
    // Hostile content appears only in escaped form.
    expect(html).toContain("&lt;script&gt;");
    expect(html).toContain("Kaczmarek &lt;b&gt;");
    expect(html).toContain("&lt;/td&gt;");
    // Media links point at the archive-relative, id-built path only
    // (index.html and media/ share the ZIP root; no ../ escape).
    expect(html).toMatch(/href="media\/s1\/r1\.jpg"/);
    expect(html).not.toMatch(/href="\.\.\//);
    expect(html).not.toContain("objectKey");
  });

  it("writes every collection as JSON plus a declaring manifest", () => {
    const snapshot = fixtureSnapshot();
    const files = collectionJsonFiles(snapshot);
    expect(files.find((f) => f.path === "dane/sources.json")?.contents).toContain("wycena");
    expect(files.map((f) => f.path)).not.toContain("dane/media.json");
    const manifest = JSON.parse(manifestJson(snapshot));
    expect(manifest.schemaVersion).toBe(snapshot.schemaVersion);
    expect(manifest.snapshotAtMs).toBe(snapshot.snapshotAtMs);
    expect(manifest.counts.sources).toBe(1);
    expect(manifest.media[0].archivePath).toBe("media/s1/r1.jpg");
  });
});
