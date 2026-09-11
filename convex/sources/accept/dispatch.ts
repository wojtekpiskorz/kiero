/**
 * Sources command dispatch wiring (D1): the SAME checked path A3 proved,
 * with the sources lane's own handler registry.
 *
 * `dispatchSourcesCommand` is @kiero/runtime's `dispatchCommand` over the
 * canonical context resolution (verified identity -> session -> user -> one
 * active membership -> company) and the platform authorization seam
 * (`membershipPolicy` until B1/B3 register the authoritative rules). Two
 * identity sources exist and only two, both verified server-side:
 *
 * - Convex Auth (`ctx.auth`) — the user path; the public mutation uses it
 *   and honestly fails `unauthenticated` until B1 ships the sign-in product.
 * - the service bridge — a verified service session id (the A3-proved
 *   Worker identity), used by the internal transactional entry and the
 *   guarded dev-proof actions. There is no development-auth shortcut.
 *
 * The handler runs inside ONE Convex mutation, so the acceptance, its
 * canonical event and its durable processing registration are atomic.
 */

import { Schema } from "effect";
import type { ResultEnvelope } from "@kiero/contracts";
import {
  dispatchCommand,
  membershipPolicy,
  type CommandDeps,
  type HandlerRegistry,
  type RequestContext,
} from "@kiero/runtime";
import {
  bridgeIdentity,
  resolveRequestContext,
} from "../../platform/context";
import {
  DEFAULT_DEVICE_LABEL,
  resolveAccessContextWithProvisioning,
} from "../../access/identity/resolution";
import type { MutationCtx } from "../../_generated/server";
import { acceptSourceEntry, performAcceptance } from "./acceptance";
import {
  performWithdrawSource,
  withdrawSourceEntry,
  type WithdrawSourceInput,
} from "../../memory/recompute/withdrawal";
import {
  performReassignment,
  reassignSourceEntry,
} from "../reassign/reassignment";
// I4 registration (flagged, the C5/E7 precedent): the permanent-deletion
// operation `sources.purgeSource` implements its declared contract entry
// from the deletion lane's own module (../../operations/deletion/purge.ts):
// the tombstone, the content-free ledger, the purge stages, the canonical
// events and the durable purge registration commit atomically there; this
// table only wires the checked path to it (administer intent: only a
// CURRENT administrator can permanently delete).
import {
  performPurgeSource,
  purgeSourceEntry,
  type PurgeSourceInput,
} from "../../operations/deletion/purge";

/**
 * Handler table for sources mutation-transaction dispatches (exported for tests).
 *
 * C5 registration (additive, flagged on the C3 merged-table precedent): the
 * withdrawal operation `sources.withdrawSource` implements the declared
 * sources contract entry from the recomputation lane's own module — the
 * lifecycle transition, the canonical event and the durable recompute
 * registration commit atomically there; this table only wires the checked
 * path to it.
 *
 * E7 registration (additive, flagged, same precedent): the project
 * reassignment `sources.reassignSource` implements its declared entry from
 * the reassignment lane's own module (../reassign/reassignment): the link
 * set change, its canonical event and the durable scope re-assessment
 * registration commit atomically there.
 */
export function sourcesHandlers(): HandlerRegistry<MutationCtx> {
  return {
    "sources.acceptSource": {
      intent: "write",
      run: async (tx, context, input, meta) => {
        const decoded = Schema.decodeUnknownSync(acceptSourceEntry.input)(input);
        return performAcceptance(tx, context, decoded, meta.idempotencyKey);
      },
    },
    "sources.withdrawSource": {
      intent: "write",
      run: (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(withdrawSourceEntry.input)(input);
        return performWithdrawSource(tx, context, decoded as WithdrawSourceInput);
      },
    },
    "sources.reassignSource": {
      intent: "write",
      run: async (tx, context, input, meta) => {
        const decoded = Schema.decodeUnknownSync(reassignSourceEntry.input)(input);
        return performReassignment(tx, context, decoded, meta.idempotencyKey);
      },
    },
    // I4 registration (flagged, the C5 precedent): permanent deletion is an
    // administer-intent operation - the membership policy decides from the
    // CURRENT resolved role on every request.
    "sources.purgeSource": {
      intent: "administer",
      run: (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(purgeSourceEntry.input)(input);
        return performPurgeSource(tx, context, decoded as PurgeSourceInput);
      },
    },
  };
}

/**
 * Dispatches one sources command envelope inside a mutation transaction.
 * The optional `serviceSessionId` marks the service-bridge path (identity
 * verified before this point); without it, Convex Auth is the only identity
 * source. Unimplemented sources operations fail closed `unsupported`.
 *
 * J1 prerequisite repair (same defect C4 flagged on C2's public entries):
 * the user path resolves through B1's live-session chain
 * (`resolveAccessContextWithProvisioning` — the B3 projects-dispatch
 * pattern), because the platform-generic `identityFromConvexAuth` subject
 * (`<userId>|<authSessions id>`) is not a sessions-registry id and
 * ordinary user tokens failed `no_verified_identity` on this public
 * entry, blocking the app-driven send path the first text checkpoint
 * proves.
 */
export async function dispatchSourcesCommand(
  ctx: MutationCtx,
  envelope: unknown,
  serviceSessionId: string | undefined,
): Promise<ResultEnvelope> {
  const resolveContext = async (tx: MutationCtx): Promise<RequestContext | null> => {
    if (serviceSessionId !== undefined) {
      return resolveRequestContext(tx.db, bridgeIdentity(serviceSessionId, Date.now()));
    }
    return resolveAccessContextWithProvisioning(tx.db, tx.auth, Date.now(), DEFAULT_DEVICE_LABEL);
  };
  const deps: CommandDeps<MutationCtx> = {
    resolveContext,
    policy: membershipPolicy,
    handlers: sourcesHandlers(),
  };
  return dispatchCommand(deps, ctx, envelope);
}
