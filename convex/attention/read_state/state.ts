/**
 * Per-person source read-state pure decisions (F1).
 *
 * "Nieprzeczytany wpis" (CONTEXT.md): an entry the user has not yet seen
 * nor explicitly marked read. Seeing the ORIGINAL message changes its state
 * in every view and on every device of that person; one boss reading never
 * changes another boss's state.
 *
 * That invariant is STRUCTURAL in the storage (one `readStates` row per
 * user + logical source, no view or device dimension anywhere — see
 * ./schema.ts), so the pure decisions here only decide transitions and
 * project query results:
 *
 * - a transition decision that makes repeated marks idempotent (same state
 *   => no write, no event), and
 * - an unread projection over D1 `SourceConversationRow.sourceId`s (the
 * same canonical source identity every view row carries).
 */

/** Bounded projection request: one conversation page is far below this. */
export const MAX_PROJECTION_SOURCE_IDS = 256;

/** The stored fields one read-state decision needs. */
export interface ReadStateRow {
  readonly read: boolean;
}

/** Whether a desired mark changes the stored state. */
export function decideReadTransition(
  current: ReadStateRow | null,
  desiredRead: boolean,
): "changed" | "unchanged" {
  if (current === null) {
    // Absence of a row means unread; a desired "unread" mark on an absent
    // row is therefore already the truth and must not create one.
    return desiredRead ? "changed" : "unchanged";
  }
  return current.read === desiredRead ? "unchanged" : "changed";
}

/** One unread-projection entry: the logical source and this person's state. */
export interface ReadStateEntry {
  readonly sourceId: string;
  readonly read: boolean;
  /** When the state was last recorded; null when no row exists (unread). */
  readonly readAtMs: number | null;
}

/** The stored row shape the projection consumes. */
export interface StoredReadState {
  readonly sourceId: string;
  readonly read: boolean;
  readonly readAtMs: number;
}

/**
 * Projects read state over canonical source ids (absence = unread, the
 * glossary definition). Duplicate ids collapse to one entry; order follows
 * the request order so callers can align rows with their view page.
 */
export function projectReadState(
  sourceIds: readonly string[],
  rows: readonly StoredReadState[],
): ReadStateEntry[] {
  const bySource = new Map<string, StoredReadState>();
  for (const row of rows) {
    bySource.set(row.sourceId, row);
  }
  const seen = new Set<string>();
  const entries: ReadStateEntry[] = [];
  for (const sourceId of sourceIds) {
    if (seen.has(sourceId)) {
      continue;
    }
    seen.add(sourceId);
    const row = bySource.get(sourceId);
    entries.push(
      row === undefined
        ? { sourceId, read: false, readAtMs: null }
        : { sourceId, read: row.read, readAtMs: row.readAtMs },
    );
  }
  return entries;
}

/** The unread count of a projection (for badge-style consumers: H1). */
export function countUnread(entries: readonly ReadStateEntry[]): number {
  return entries.filter((entry) => !entry.read).length;
}
