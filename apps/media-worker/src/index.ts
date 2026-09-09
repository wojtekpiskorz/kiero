/**
 * @kiero/media-worker: EU Container executor bootstrap skeleton.
 *
 * This executor will own bounded media processing (execution charter).
 * No container runtime, queue wiring or media logic exists in this
 * bootstrap; the entry point refuses work explicitly.
 */

export async function main(): Promise<never> {
  throw new Error("media-worker: not implemented (bootstrap skeleton)");
}
