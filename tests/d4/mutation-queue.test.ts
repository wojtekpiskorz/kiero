/**
 * D4 focused tests: the serialized record-mutation queue (review round 2).
 *
 * The composer chains every draft-record mutation that has an await
 * between reading and writing the record (chunk appends, the degraded
 * flag, stop/start persists, photo writes, the debounced text flush) on
 * ONE promise. These tests prove the three properties that close the
 * lost-update class:
 *
 * - tasks run strictly one at a time, in submission order;
 * - each task observes the previous task's writes when its turn starts
 *   (so appends never undercount and a just-set degraded flag survives a
 *   late append);
 * - a rejected task never blocks the chain (the recording path turns its
 *   rejection into the honest storage_degraded flag instead of stalling).
 */

import { describe, expect, it } from "vitest";
import { createMutationQueue } from "../../apps/web/src/features/capture/mutation-queue";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("createMutationQueue (one chain over the record mutations)", () => {
  it("runs tasks strictly one at a time, in submission order", async () => {
    const queue = createMutationQueue();
    const seen: number[] = [];
    const submit = (n: number) =>
      queue(async () => {
        seen.push(n);
        await tick();
        seen.push(-n); // mid-task: an overlapping queue would interleave here
      });
    await Promise.all([submit(1), submit(2), submit(3)]);
    expect(seen).toEqual([1, -1, 2, -2, 3, -3]);
  });

  it("closes the lost-update class: appends never undercount and the degraded flag survives a late append", async () => {
    const queue = createMutationQueue();
    // The composer/store discipline: the task reads the record when its
    // turn starts, awaits the store write, then writes the whole record
    // the store handed back (computed from that turn-start snapshot).
    let record = { totalBytes: 0, degraded: false };
    const append = (bytes: number) =>
      queue(async () => {
        const snapshot = record;
        await tick(); // the chunk write straddles the 1-second cadence
        record = { ...snapshot, totalBytes: snapshot.totalBytes + bytes };
      });
    const setDegraded = () =>
      queue(async () => {
        await tick();
        record = { ...record, degraded: true };
      });
    const inFlight = [append(10), append(20), append(30), setDegraded(), append(40)];
    await Promise.all(inFlight);
    // Unserialized, last-writer-wins loses bytes (snapshots all read 0)
    // and the late append, computed before the flag landed, clears it.
    expect(record.totalBytes).toBe(100);
    expect(record.degraded).toBe(true);
  });

  it("a rejected task never blocks the chain (the honest degraded path continues)", async () => {
    const queue = createMutationQueue();
    const ran: string[] = [];
    const failed = queue(async () => {
      await tick();
      throw new Error("QuotaExceededError");
    });
    const after1 = queue(async () => {
      ran.push("first-after");
    });
    const after2 = queue(async () => {
      ran.push("second-after");
    });
    await expect(failed).rejects.toThrow("QuotaExceededError");
    await after1;
    await after2;
    expect(ran).toEqual(["first-after", "second-after"]);
  });

  it("settles each caller with its own task's outcome", async () => {
    const queue = createMutationQueue();
    await expect(queue(async () => 7)).resolves.toBe(7);
    await expect(
      queue(async () => {
        throw new Error("own failure");
      }),
    ).rejects.toThrow("own failure");
  });
});
