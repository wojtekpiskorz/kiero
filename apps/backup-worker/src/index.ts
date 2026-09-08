/**
 * @kiero/backup-worker — EU backup Container bootstrap skeleton.
 *
 * This executor will own the scheduled backup set build/verify/restore
 * flow (execution charter). No container runtime, scheduler wiring or
 * backup logic exists in this bootstrap; the entry point refuses work
 * explicitly.
 */

export async function main(): Promise<never> {
  throw new Error("backup-worker: not implemented (bootstrap skeleton)");
}
