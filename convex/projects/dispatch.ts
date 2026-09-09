/**
 * Projects command dispatch wiring (C1): the SAME checked path A3 proved and
 * B1/B3/D1 reuse, with this lane's handler registry and policy.
 *
 * `dispatchProjectsCommand` is @kiero/runtime's `dispatchCommand` over the
 * B3-preceded identity resolution: provision-or-refresh the B1 live session,
 * then the canonical chain (user -> earliest active membership -> company)
 * whose rows B3 owns. The resolved context is the ONLY company scope — no
 * client input names a company. The handlers run inside ONE Convex mutation,
 * so each state change and its canonical `projects.*` event commit atomically.
 *
 * Unimplemented projects operations (and unknown operation names) fail
 * closed `unsupported` through the shared runtime path.
 */

import { Schema } from "effect";
import type { ResultEnvelope } from "@kiero/contracts";
import {
  dispatchCommand,
  type HandlerRegistry,
} from "@kiero/runtime";
import type { MutationCtx } from "../_generated/server";
import {
  DEFAULT_DEVICE_LABEL,
  resolveAccessContextWithProvisioning,
} from "../access/identity/resolution";
import { projectsLanePolicy } from "./policy";
import {
  assignCodenameEntry,
  assignContactRoleEntry,
  changeStageEntry,
  identifyProjectEntry,
  performAssignCodename,
  performAssignContactRole,
  performChangeStage,
  performIdentifyProject,
  performSetPause,
  performUpsertContact,
  setPauseEntry,
  upsertContactEntry,
} from "./operations";

/** Handler table for the company-scoped projects dispatch (exported for tests). */
export function projectsHandlers(): HandlerRegistry<MutationCtx> {
  return {
    "projects.identifyProject": {
      intent: "write",
      run: async (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(identifyProjectEntry.input)(input);
        return performIdentifyProject(tx, context, decoded);
      },
    },
    "projects.assignCodename": {
      intent: "write",
      run: async (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(assignCodenameEntry.input)(input);
        return performAssignCodename(tx, context, decoded);
      },
    },
    "projects.changeStage": {
      intent: "write",
      run: async (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(changeStageEntry.input)(input);
        return performChangeStage(tx, context, decoded);
      },
    },
    "projects.setPause": {
      intent: "write",
      run: async (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(setPauseEntry.input)(input);
        return performSetPause(tx, context, decoded);
      },
    },
    "projects.upsertContact": {
      intent: "write",
      run: async (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(upsertContactEntry.input)(input);
        return performUpsertContact(tx, context, decoded);
      },
    },
    "projects.assignContactRole": {
      intent: "write",
      run: async (tx, context, input) => {
        const decoded = Schema.decodeUnknownSync(assignContactRoleEntry.input)(input);
        return performAssignContactRole(tx, context, decoded);
      },
    },
  };
}

/**
 * Dispatches one company-scoped projects command envelope inside ONE Convex
 * mutation transaction, through the checked path with B1's identity source
 * and the C1 policy. Unimplemented operations fail closed `unsupported`.
 */
export async function dispatchProjectsCommand(
  ctx: MutationCtx,
  envelope: unknown,
): Promise<ResultEnvelope> {
  return await dispatchCommand(
    {
      resolveContext: (tx) =>
        resolveAccessContextWithProvisioning(tx.db, tx.auth, Date.now(), DEFAULT_DEVICE_LABEL),
      policy: projectsLanePolicy,
      handlers: projectsHandlers(),
    },
    ctx,
    envelope,
  );
}
