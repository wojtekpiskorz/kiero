/**
 * The retention windowing model (I2).
 *
 * PURE MODULE. The accepted window for redacted technical events is 30 days
 * ("Thirty-day retention applies to diagnostics actually ingested"). The
 * window is enforced Convex-side by the pruning mutation and configured
 * sink-side (Axiom dataset retention, 30 days on Personal) in
 * infra/observability/retention.json - both directions are recorded because
 * dataset trimming operates on storage blocks and is not per-event deletion
 * at an exact boundary.
 *
 * Cost entries are accounting, not diagnostics: they are kept far longer so
 * the 400/500 PLN budget history survives the diagnostic window.
 */

/** The accepted diagnostic retention window (30 days). */
export const DIAGNOSTIC_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Cost accounting retention (~13 months of monthly budget history). */
export const COST_RETENTION_MS = 400 * 24 * 60 * 60 * 1000;

/** Bounded delete batch per pruning pass (keeps mutation size predictable). */
export const PRUNE_BATCH_SIZE = 100;

/** Events older than this are no longer worth forwarding to the sink. */
export const FORWARD_WINDOW_MS = 60 * 60 * 1000;

/** The retention cutoff: rows with atMs < cutoff are expired. */
export function retentionCutoffMs(nowMs: number, windowMs: number = DIAGNOSTIC_RETENTION_MS): number {
  return nowMs - windowMs;
}

/** True when a row timestamp is outside the window. */
export function isExpired(atMs: number, nowMs: number, windowMs: number = DIAGNOSTIC_RETENTION_MS): boolean {
  return atMs < retentionCutoffMs(nowMs, windowMs);
}

/** The oldest cost period ("YYYY-MM") still retained, for range pruning. */
export function costPeriodCutoff(nowMs: number): string {
  const cutoff = new Date(nowMs - COST_RETENTION_MS);
  return cutoff.toISOString().slice(0, 7);
}

/** True when a cost period is older than the retained horizon. */
export function isCostPeriodExpired(period: string, nowMs: number): boolean {
  return period < costPeriodCutoff(nowMs);
}
