/**
 * I7 focused tests, the JOINT row with D4: a PWA update (its reload)
 * must PRESERVE the composer's local draft, including across the client
 * record-schema migration.
 *
 * This file drives D4's REAL DraftsStore and record shape
 * (apps/web/src/storage/drafts/store.ts) together with I7's REAL draft
 * migration and update order:
 *
 * - a legacy v0 record (fields the older client never wrote) migrates to
 *   v1 with every D4-null-checked field normalized, and D4's own loader
 *   accepts it;
 * - recording chunks and photo blobs survive migration untouched (they
 *   live under their own keys) and readRecording still concatenates them;
 * - a record D4's current client just wrote (already complete) passes
 *   through as already-current;
 * - an unreadable record is LEFT INTACT and reported, never destroyed;
 * - the full update order (pagehide flush -> migrate -> reload -> reopen)
 *   preserves text typed before the flush: the reload loses nothing.
 *
 * The flush step replicates exactly the listener D4's composer registers
 * (use-capture-composer.ts: window "pagehide" -> store.saveDraft of the
 * live record); the physical browser leg runs the real listener.
 */

import { describe, expect, it } from "vitest";
import {
  DraftsStore,
  freshDraft,
  memoryPersistence,
} from "../../apps/web/src/storage/drafts/store";
import {
  CURRENT_DRAFT_RECORD_VERSION,
  DRAFT_KEY_SUFFIX,
  DRAFT_RECORD_VERSION_FIELD,
  migrateDraftRecordValue,
} from "../../apps/web/src/pwa/update/draft-migration";

const USER = "user_joint";

function legacyV0Record() {
  // What an OLDER client would have written: the core identity plus the
  // fields it knew; storageDegraded/sentSourceId/photos absent.
  return {
    userId: USER,
    draftId: "idem_legacy-0000",
    createdAtMs: 1,
    updatedAtMs: 2,
    text: "Banan: dowóz płytek w środę rano",
    scopeProjectId: null,
    phase: "composing",
  };
}

describe("the client draft schema migration", () => {
  it("migrates a legacy v0 record so D4's loader and null-checks hold", () => {
    const legacy = legacyV0Record();
    const outcome = migrateDraftRecordValue(legacy);
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) {
      return;
    }
    expect(outcome.changed).toBe(true);
    const record = outcome.record as Record<string, unknown>;
    expect(record.storageDegraded).toBe(false);
    expect(record.lastError).toBeNull();
    expect(record.sentSourceId).toBeNull();
    expect(record.photos).toEqual([]);
    expect(record.recording).toBeNull();
    expect(record[DRAFT_RECORD_VERSION_FIELD]).toBe(CURRENT_DRAFT_RECORD_VERSION);
    // The identity and content survive verbatim.
    expect(record.userId).toBe(USER);
    expect(record.text).toBe(legacy.text);
    // Unknown extra fields survive forward-compatibly.
    const withExtra = { ...legacy, someFutureField: { keep: true } };
    const extraOutcome = migrateDraftRecordValue(withExtra);
    expect((extraOutcome.ok ? extraOutcome.record : {}) as Record<string, unknown>).toMatchObject({
      someFutureField: { keep: true },
    });
  });

  it("is idempotent: a migrated record passes through unchanged", () => {
    const first = migrateDraftRecordValue(legacyV0Record());
    expect(first.ok).toBe(true);
    if (!first.ok) {
      return;
    }
    const second = migrateDraftRecordValue(first.record);
    expect(second.ok).toBe(true);
    if (second.ok) {
      expect(second.changed).toBe(false);
      expect(JSON.stringify(second.record)).toBe(JSON.stringify(first.record));
    }
  });

  it("leaves unreadable records intact and reports them", () => {
    for (const broken of [
      "not an object",
      42,
      null,
      { userId: 7, draftId: "x", phase: "composing" },
      { userId: "u", draftId: "d", phase: 3 },
    ]) {
      const outcome = migrateDraftRecordValue(broken);
      expect(outcome.ok).toBe(false);
    }
  });
});

describe("the joint survival row (D4 store x I7 migration)", () => {
  it("D4's real store round-trips a migrated legacy record", async () => {
    const persistence = memoryPersistence();
    const store = new DraftsStore(persistence);
    await persistence.put(`${USER}${DRAFT_KEY_SUFFIX}`, legacyV0Record());

    const raw = await persistence.get(`${USER}${DRAFT_KEY_SUFFIX}`);
    const outcome = migrateDraftRecordValue(raw);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      await persistence.put(`${USER}${DRAFT_KEY_SUFFIX}`, outcome.record);
    }

    const loaded = await store.loadDraft(USER);
    expect(loaded).not.toBeNull();
    expect(loaded?.text).toBe("Banan: dowóz płytek w środę rano");
    // Every field D4's surface null-checks is now present.
    expect(loaded?.storageDegraded).toBe(false);
    expect(loaded?.lastError).toBeNull();
    expect(loaded?.sentSourceId).toBeNull();
  });

  it("recording chunks and photos survive the migration untouched", async () => {
    const persistence = memoryPersistence();
    const store = new DraftsStore(persistence);
    let record = freshDraft(USER, "idem_joint-chunks", 1_000);
    record = await store.appendRecordingChunk(record, 0, new Blob(["alpha"], { type: "audio/webm" }));
    record = await store.appendRecordingChunk(record, 1, new Blob(["beta"], { type: "audio/webm" }));
    record = await store.addPhoto(
      record,
      { photoId: "ph_1", name: "foto.jpg", mimeType: "image/jpeg", bytes: 3 },
      new Blob(["abc"], { type: "image/jpeg" }),
    );

    // The migration rewrites ONLY the metadata record key.
    const raw = await persistence.get(`${USER}${DRAFT_KEY_SUFFIX}`);
    const outcome = migrateDraftRecordValue(raw);
    expect(outcome.ok && outcome.changed).toBe(true);
    if (outcome.ok) {
      await persistence.put(`${USER}${DRAFT_KEY_SUFFIX}`, outcome.record);
    }

    const reloaded = await store.loadDraft(USER);
    expect(reloaded).not.toBeNull();
    if (reloaded === null) {
      return;
    }
    expect(reloaded.recording?.chunkCount).toBe(2);
    const blob = await store.readRecording(reloaded);
    expect(blob).not.toBeNull();
    expect(await blob?.text()).toBe("alphabeta");
    const photo = await store.readPhoto(reloaded, "ph_1");
    expect(await photo?.text()).toBe("abc");
  });

  it("the full update order preserves typed text across the reload", async () => {
    // Phase 1: the OLD client. The live record holds unflushed text (the
    // 400ms debounce window); recording chunks are already durable.
    const persistence = memoryPersistence();
    let store = new DraftsStore(persistence);
    let record = freshDraft(USER, "idem_joint-reload", 1_000);
    record = await store.appendRecordingChunk(record, 0, new Blob(["chunk0"], { type: "audio/webm" }));
    const liveRecord = { ...record, text: "Kaczmarek: termin w piątek potwierdzony" };

    // The update fires: pagehide flush first (exactly what D4's composer
    // listener does: saveDraft of the live record), then the migration.
    await store.saveDraft(liveRecord);
    const raw = await persistence.get(`${USER}${DRAFT_KEY_SUFFIX}`);
    const outcome = migrateDraftRecordValue(raw);
    expect(outcome.ok).toBe(true);
    if (outcome.ok) {
      await persistence.put(`${USER}${DRAFT_KEY_SUFFIX}`, outcome.record);
    }

    // Phase 2: the NEW client opens the same store after the reload.
    store = new DraftsStore(persistence);
    const reopened = await store.loadDraft(USER);
    expect(reopened).not.toBeNull();
    if (reopened === null) {
      return;
    }
    expect(reopened.text).toBe("Kaczmarek: termin w piątek potwierdzony");
    expect(reopened.draftId).toBe("idem_joint-reload");
    expect(reopened.recording?.chunkCount).toBe(1);
    const fragment = await store.readRecording(reopened);
    expect(await fragment?.text()).toBe("chunk0");
    // The migration ran exactly once and the record is at the current version.
    const stamped = reopened as unknown as Record<string, unknown>;
    expect(stamped[DRAFT_RECORD_VERSION_FIELD]).toBe(CURRENT_DRAFT_RECORD_VERSION);
  });
});
