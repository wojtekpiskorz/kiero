/**
 * One serialized queue over the draft record's mutations (D4, review
 * round 2).
 *
 * The class it closes: `appendRecordingChunk` (and every other record
 * mutation with an await between reading and writing the record) computes
 * from a snapshot, while `VoiceRecorder.handleChunk` fires the next chunk
 * without awaiting the previous sink. Unserialized, last-writer-wins
 * could undercount `totalBytes`/`durationMs` or silently clear a
 * just-set `storageDegraded` flag: the one spot where the drafts module's
 * honesty rules could be undone quietly. Chaining every record mutation
 * on ONE promise makes the sequence total again: each task reads the
 * record when its turn comes, so no task ever overwrites another with a
 * stale snapshot.
 *
 * Failure isolation: a rejected task never blocks the queue. The next
 * mutation runs regardless; the recording path turns its rejection into
 * the honest `storage_degraded` flag instead of stalling the chunks.
 */

/** Runs tasks strictly one after the other, in submission order. */
export function createMutationQueue(): <T>(task: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(task: () => Promise<T>): Promise<T> => {
    // The previous task's outcome is irrelevant to whether this one runs.
    const run = tail.then(task, task);
    // The chain itself never carries a rejection forward (unhandled
    // rejection hygiene); the CALLER observes `run`'s own settlement.
    tail = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  };
}
