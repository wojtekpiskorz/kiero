/**
 * Per-pass connection decisions (G2 pure): whether ONE projection pass may
 * publish desired states at all, and what the connection's sync row must
 * record when it may not.
 *
 * The connection is rechecked PER PASS (issue #46): the durable
 * revocation stop from the access lane is still a lazy prerequisite, and a
 * refresh whose outcome is UNKNOWN means "do not publish, do not retry
 * blindly" — the pass suspends with no desired-state writes and hands the
 * decision to reconciliation (G3). Partial writes are impossible by
 * construction: the suspend decision is made BEFORE any copy row is read
 * or written.
 */

/** The typed refresh outcomes G1's credential capability reports. */
export type RefreshOutcome =
  | "refreshed"
  | "definitely_lost"
  | "unknown"
  | "membership_lost"
  | "no_connection"
  | "no_credential";

/** The connection facts one pass rechecks (server-resolved only). */
export interface ConnectionRecheck {
  readonly state: "pending_authorization" | "connected" | "disconnected" | "error";
  /** Whether the row's firm is still the boss's active firm. */
  readonly firmStillActive: boolean;
}

/** Why a pass suspends without touching desired state. */
export type SuspensionReason =
  | "no_connection"
  | "not_connected"
  | "membership_lost"
  | "refresh_unknown"
  | "refresh_lost"
  | "no_credential";

/** What one pass does. */
export type ProjectionMode =
  | { readonly kind: "project" }
  | { readonly kind: "suspend"; readonly reason: SuspensionReason };

/**
 * The per-pass mode from the rechecked connection plus the credential
 * capability's outcome. Order matters: a lost membership stops everything
 * (G1 already persisted the stop on the refresh path); an unknown refresh
 * suspends with the reconciliation handoff; only a confirmed refresh (or
 * an honestly absent credential on a still-connected row, which the
 * refresh action reports itself) can project — and "no credential" never
 * can: projection without the capability to publish would be a fake state.
 */
export function decideProjectionMode(
  connection: ConnectionRecheck | null,
  refresh: RefreshOutcome,
): ProjectionMode {
  if (connection === null) {
    return { kind: "suspend", reason: "no_connection" };
  }
  if (!connection.firmStillActive) {
    return { kind: "suspend", reason: "membership_lost" };
  }
  if (connection.state !== "connected") {
    return { kind: "suspend", reason: "not_connected" };
  }
  switch (refresh) {
    case "refreshed":
      return { kind: "project" };
    case "unknown":
      return { kind: "suspend", reason: "refresh_unknown" };
    case "definitely_lost":
      return { kind: "suspend", reason: "refresh_lost" };
    case "membership_lost":
      return { kind: "suspend", reason: "membership_lost" };
    case "no_connection":
      return { kind: "suspend", reason: "no_connection" };
    case "no_credential":
      return { kind: "suspend", reason: "no_credential" };
  }
}

/**
 * The sync-row transition one pass applies. A pass that projected leaves
 * `idle` (desired state is current; G3 does the Google legs); a suspended
 * pass records `needs_reconcile` with its machine reason — the honest
 * "pending changes / needs attention" signal the boss and G3 read.
 * (`syncing` is G3's to set while its Google legs are in flight.)
 */
export function decideSyncStateTransition(
  mode: ProjectionMode,
): { readonly state: "idle" | "needs_reconcile"; readonly suspendedReason: string | null } {
  if (mode.kind === "project") {
    return { state: "idle", suspendedReason: null };
  }
  return { state: "needs_reconcile", suspendedReason: mode.reason };
}
