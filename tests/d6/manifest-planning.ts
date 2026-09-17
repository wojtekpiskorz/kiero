/**
 * The shared d6 planning driver (R34): drives the REAL three-phase manifest
 * path — the query-side load, the ACTION-side resolver (the fetch-bearing
 * half: the stubbed global fetch feeds exactly this), then the transactional
 * mutation with the resolved duration.
 */

import {
  ensureManifestTransaction,
  loadManifestTarget,
  resolveManifestDuration,
} from "../../convex/processing/audio/executor";
import { asReaderDb, asTx, type FakeCtx } from "../d2/harness";

export async function planManifest(ctx: FakeCtx, transcriptId: string) {
  const loaded = await loadManifestTarget(asReaderDb(ctx), transcriptId as never);
  const resolved = loaded.ok
    ? await resolveManifestDuration(loaded.target)
    : { ok: false as const, code: loaded.code };
  return ensureManifestTransaction(asTx(ctx), transcriptId as never, resolved);
}
