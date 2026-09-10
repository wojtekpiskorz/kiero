/**
 * D4 focused tests: the durable draft store.
 *
 * Proves the recoverability semantics the issue names:
 * - one stable draft record per person, persist/load roundtrip;
 * - INCREMENTAL recording chunk persistence (every chunk lands under its
 *   own key as it arrives — the recoverable fragment after interruption);
 * - the concatenated recording reads back exactly the persisted chunks in
 *   order, and a MISSING chunk is a typed corrupt error, never a silent
 *   truncated upload;
 * - photo add/read/remove and full draft clearing;
 * - storage failure classification (quota / corrupt / unavailable) — the
 *   closed vocabulary the UI must speak about, never a silent swallow.
 *
 * The production IndexedDB adapter is the thin shell over the same
 * DraftsStore semantics; it is exercised by the live browser proof
 * (tests/d4/live-proof.mjs).
 */

import { describe, expect, it } from "vitest";
import {
  DraftsStore,
  classifyStorageFailure,
  freshDraft,
  memoryPersistence,
} from "../../apps/web/src/storage/drafts/store";

const USER = "k57user0000000000000000000";

function newStore() {
  const persistence = memoryPersistence();
  return { store: new DraftsStore(persistence), persistence };
}

describe("draft record lifecycle", () => {
  it("persists and loads one draft per person (roundtrip)", async () => {
    const { store } = newStore();
    expect(await store.loadDraft(USER)).toBeNull();
    const draft = freshDraft(USER, "idem_aaa", 1000);
    await store.saveDraft({ ...draft, text: "Banan: dowóz w środę" });
    const loaded = await store.loadDraft(USER);
    expect(loaded?.draftId).toBe("idem_aaa");
    expect(loaded?.text).toBe("Banan: dowóz w środę");
    expect(loaded?.phase).toBe("composing");
  });

  it("treats a malformed draft record as corrupt, never as empty", async () => {
    const { store, persistence } = newStore();
    await persistence.put(`${USER}#draft`, "not-a-record");
    await expect(store.loadDraft(USER)).rejects.toMatchObject({
      kind: "corrupt",
    });
  });
});

describe("incremental recording persistence", () => {
  it("persists every chunk under its own key as it arrives", async () => {
    const { store, persistence } = newStore();
    let draft = freshDraft(USER, "idem_bbb", 1000);
    await store.saveDraft(draft);
    const chunks = [new Blob(["aa"]), new Blob(["bb"]), new Blob(["cc"])];
    for (let seq = 0; seq < chunks.length; seq += 1) {
      draft = await store.appendRecordingChunk(draft, seq, chunks[seq]!);
    }
    expect(draft.recording?.chunkCount).toBe(3);
    expect(draft.recording?.totalBytes).toBe(6);
    // The interruption guarantee: each chunk is durable on its own.
    for (let seq = 0; seq < 3; seq += 1) {
      expect(persistence.entries.has(`${USER}#rec#${seq}`)).toBe(true);
    }
    const recovered = await store.readRecording(draft);
    expect(recovered).not.toBeNull();
    expect(await new Response(recovered!).text()).toBe("aabbcc");
  });

  it("leaves a recoverable fragment after a partial interruption (2 of 3 chunks)", async () => {
    const { store } = newStore();
    let draft = freshDraft(USER, "idem_ccc", 1000);
    draft = await store.appendRecordingChunk(draft, 0, new Blob(["x".repeat(64)]));
    draft = await store.appendRecordingChunk(draft, 1, new Blob(["y".repeat(64)]));
    // The tab dies here: reopening loads the SAME persisted surface and
    // reads exactly the fragment that survived.
    const reloaded = await store.loadDraft(USER);
    expect(reloaded?.recording?.chunkCount).toBe(2);
    const blob = await store.readRecording(reloaded!);
    expect(blob?.size).toBe(128);
  });

  it("reports a MISSING chunk as corrupt (never a silent truncated upload)", async () => {
    const { store, persistence } = newStore();
    let draft = freshDraft(USER, "idem_ddd", 1000);
    draft = await store.appendRecordingChunk(draft, 0, new Blob(["a"]));
    draft = await store.appendRecordingChunk(draft, 1, new Blob(["b"]));
    // Eviction removes chunk 1 behind the record's back.
    await persistence.delete(`${USER}#rec#1`);
    await expect(store.readRecording(draft)).rejects.toMatchObject({ kind: "corrupt" });
  });

  it("discardRecording drops the fragment completely", async () => {
    const { store, persistence } = newStore();
    let draft = freshDraft(USER, "idem_eee", 1000);
    draft = await store.appendRecordingChunk(draft, 0, new Blob(["a"]));
    draft = await store.appendRecordingChunk(draft, 1, new Blob(["b"]));
    const next = await store.discardRecording(draft);
    expect(next.recording).toBeNull();
    expect([...persistence.entries.keys()].some((key) => key.includes("#rec#"))).toBe(false);
  });
});

describe("photos", () => {
  it("adds, reads and removes photo blobs", async () => {
    const { store, persistence } = newStore();
    const draft = freshDraft(USER, "idem_fff", 1000);
    await store.saveDraft(draft);
    const photo = { photoId: "ph_1", name: "faktura.jpg", mimeType: "image/jpeg", bytes: 3 };
    const withPhoto = await store.addPhoto(draft, photo, new Blob(["abc"], { type: "image/jpeg" }));
    expect(withPhoto.photos).toHaveLength(1);
    expect(persistence.entries.has(`${USER}#photo#ph_1`)).toBe(true);
    const blob = await store.readPhoto(withPhoto, "ph_1");
    expect(await new Response(blob!).text()).toBe("abc");
    const removed = await store.removePhoto(withPhoto, "ph_1");
    expect(removed.photos).toHaveLength(0);
    expect(await store.readPhoto(removed, "ph_1")).toBeNull();
  });
});

describe("storage failure classification", () => {
  it("classifies quota pressure (DOMException name and legacy code 22)", () => {
    const quota = new DOMException("no space", "QuotaExceededError");
    expect(classifyStorageFailure(quota).kind).toBe("quota");
    expect(classifyStorageFailure({ name: "QuotaExceededError" }).kind).toBe("quota");
    expect(classifyStorageFailure({ code: 22 }).kind).toBe("quota");
  });

  it("classifies clone/corruption failures", () => {
    expect(classifyStorageFailure(new DOMException("bad", "DataCloneError")).kind).toBe("corrupt");
    expect(classifyStorageFailure({ name: "DataError" }).kind).toBe("corrupt");
  });

  it("classifies everything else as unavailable", () => {
    expect(classifyStorageFailure(new Error("boom")).kind).toBe("unavailable");
    expect(classifyStorageFailure(undefined).kind).toBe("unavailable");
  });

  it("propagates a quota failure during chunk append (the UI must see it)", async () => {
    const { store, persistence } = newStore();
    const draft = freshDraft(USER, "idem_ggg", 1000);
    await store.saveDraft(draft);
    persistence.failNextWrites(1, new DOMException("full", "QuotaExceededError"));
    await expect(store.appendRecordingChunk(draft, 0, new Blob(["a"]))).rejects.toMatchObject({
      name: "QuotaExceededError",
    });
  });
});

describe("clearDraft", () => {
  it("clears the record and every blob it owned", async () => {
    const { store, persistence } = newStore();
    let draft = freshDraft(USER, "idem_hhh", 1000);
    draft = await store.appendRecordingChunk(draft, 0, new Blob(["a"]));
    draft = await store.addPhoto(
      draft,
      { photoId: "ph_2", name: "p.png", mimeType: "image/png", bytes: 1 },
      new Blob(["z"]),
    );
    await store.clearDraft(draft);
    expect(await store.loadDraft(USER)).toBeNull();
    expect([...persistence.entries.keys()]).toHaveLength(0);
  });
});
