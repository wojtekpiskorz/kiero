/**
 * Calendar connection table (A2 candidate, certified by A3; lifecycle
 * implemented by G1, issue #45).
 *
 * Owning implementer: G1 (optional authorization and connection lifecycle).
 * Connection lifecycle is separate from sign-in: a boss connects a personal
 * dedicated Google calendar ("Kalendarz Kiero w Google") for ONE company
 * scope. Kiero holds the authoritative agreements; the calendar only
 * projects them one way. Nothing in this table is identity: disconnecting
 * never touches `users`, `sessions` or Convex Auth rows.
 *
 * G1 amendment over the certified A2 shape (this fragment is G1's owned
 * file; the table NAME stays in the closed inventory):
 * - `state` gains `pending_authorization` (server-owned OAuth flow) and the
 *   row now carries the data-dictionary fields: Google account identity,
 *   dedicated calendar id, consent/scopes, last successful contact, and
 *   reconnect/cleanup status.
 * - `googleCalendarId`/`connectedAtMs` become optional: a pending flow has
 *   neither; they appear on the `connected` transition.
 * - OAuth correlation (`oauthStateHash`, PKCE verifier) and credential
 *   material live ONLY on this server-side row and never cross a client
 *   boundary (the state value itself is stored as a SHA-256 hash, exactly
 *   like B3 invitation codes).
 *
 * Tables: calendarConnections.
 */

import { defineTable } from "convex/server";
import { v } from "convex/values";
import { shared } from "../../schema/shared";

/**
 * The closed machine-reason vocabulary while `state === "error"` (the
 * runtime list is RECONNECT_REASONS in ./cores.ts; keep the two aligned —
 * every core reason must appear here so a row can record it, and a schema
 * literal without a core reason would be unreachable dead vocabulary).
 * Typed as a literal union like `state`/`authorizationMode`: the generated
 * document type then carries the vocabulary and consumers stop casting.
 */
export const reconnectReason = v.union(
  v.literal("authorization_denied"),
  v.literal("authorization_expired"),
  v.literal("exchange_failed"),
  v.literal("exchange_unknown"),
  v.literal("scopes_missing"),
  v.literal("creation_failed"),
  v.literal("creation_unknown"),
  v.literal("calendar_read_unknown"),
  v.literal("calendar_access_lost"),
  v.literal("refresh_failed"),
  v.literal("membership_lost"),
);

/** How a row's credential material is stored (see credentialStore.ts). */
export const credentialStorageKind = v.union(
  v.literal("encrypted_aesgcm"),
  v.literal("plaintext_dev"),
  v.literal("none"),
);

export const calendarConnectionTables = {
  /**
   * One boss's optional dedicated Google calendar connection. One row per
   * user (v1: one active firm per user); `companyId` records the firm the
   * connection was opened for and every operation re-checks it against the
   * canonical earliest-active-membership rule.
   */
  calendarConnections: defineTable({
    companyId: shared.companyId,
    userId: shared.userId,
    state: v.union(
      v.literal("pending_authorization"),
      v.literal("connected"),
      v.literal("disconnected"),
      v.literal("error"),
    ),
    /** Dedicated calendar id; known only after a confirmed create/recovery. */
    googleCalendarId: v.optional(v.string()),
    /** Google account identity of the connected principal (id_token `sub`). */
    googleAccountSubject: v.optional(v.string()),
    /** Display address of that Google account (never an identity link). */
    googleAccountEmail: v.optional(v.string()),
    /** Scopes Google actually granted at the last successful exchange. */
    grantedScopes: v.optional(v.array(v.string())),
    // --- OAuth authorization flow (present only while pending) -----------
    /** SHA-256 of the one-time `state` value (single-use correlation). */
    oauthStateHash: v.optional(v.string()),
    /** PKCE code verifier; server-side only, consumed at the exchange. */
    pkceVerifier: v.optional(v.string()),
    /** Why the authorization was started (drives the calendar step). */
    authorizationMode: v.optional(
      v.union(
        v.literal("connect"),
        v.literal("switch"),
        v.literal("recreate"),
      ),
    ),
    authorizationExpiresAtMs: v.optional(shared.tsMs),
    // --- Credential material (never a client-visible value) --------------
    credentialStorage: v.optional(credentialStorageKind),
    /** Encrypted (or dev-plaintext) credential bundle; see credentialStore. */
    credentialCiphertext: v.optional(v.string()),
    accessTokenExpiresAtMs: v.optional(shared.tsMs),
    // --- Reconnect/cleanup bookkeeping -----------------------------------
    /** Machine reason while `state === "error"` (drives the UI's actions). */
    reconnectReason: v.optional(reconnectReason),
    /** Honest cleanup state of Kiero-managed copies after a disconnect. */
    cleanupStatus: v.optional(
      v.union(v.literal("not_applicable"), v.literal("unconfirmed")),
    ),
    lastSuccessfulContactMs: v.optional(shared.tsMs),
    connectedAtMs: v.optional(shared.tsMs),
    disconnectedAtMs: v.optional(shared.tsMs),
    updatedAtMs: shared.tsMs,
  })
    .index("by_user", ["userId"])
    .index("by_company", ["companyId"])
    .index("by_state_hash", ["oauthStateHash"]),
} as const;
