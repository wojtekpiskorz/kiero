/**
 * @kiero/export-worker: EU Container executor bootstrap skeleton.
 *
 * This executor will own firm export archive generation (execution
 * charter). No container runtime, queue wiring or export logic exists in
 * this bootstrap; the entry point refuses work explicitly.
 */

export async function main(): Promise<never> {
  throw new Error("export-worker: not implemented (bootstrap skeleton)");
}
