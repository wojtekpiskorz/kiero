/**
 * Platform operation handlers and dispatch wiring (A3).
 *
 * The SAME checked path (@kiero/runtime dispatchCommand) serves direct
 * Convex function calls (Convex Auth identity) and Worker bridge calls
 * (verified service identity):
 *
 * - `dispatchMutationCommand` runs the whole dispatch inside ONE Convex
 *   mutation, so the probe command's canonical event and durable job
 *   registration are atomic with the command's acceptance (the no-orphan
 *   property).
 * - `dispatchBridgeCommand` runs inside the bridge HTTP action after the
 *   bearer credential check: the service session resolves through the same
 *   canonical resolution and policy; reads go through internal queries,
 *   writes through the same transactional mutation entry.
 */

import { Schema } from "effect";
import {
  EventIdSchema,
  DurableJobKeySchema,
  errorResult,
  okResult,
  platformOperations,
  type ResultEnvelope,
} from "@kiero/contracts";
import {
  dispatchCommand,
  membershipPolicy,
  validationError,
  type CommandDeps,
  type HandlerRegistry,
  type RequestContext,
} from "@kiero/runtime";
import { bridgeIdentity, identityFromConvexAuth, resolveRequestContext } from "./context";
import { publishEvent, registerDurableJob } from "./publish";
import { internal } from "../_generated/api";
import type { ActionCtx, MutationCtx } from "../_generated/server";
import type { Id } from "../_generated/dataModel";

const probeEchoResultSchema = Schema.Struct({
  echo: Schema.NonEmptyString,
  eventId: EventIdSchema,
  dedupKey: Schema.String,
  deduplicated: Schema.Boolean,
  jobKey: DurableJobKeySchema,
});

const probeEchoEntry = platformOperations["platform.probeEcho"];
const probeOutboxStateEntry = platformOperations["platform.outboxState"];

/** The probe echo transaction: atomic event publication + job registration. */
async function probeEchoTransaction(
  tx: MutationCtx,
  context: RequestContext,
  message: string,
  idempotencyKey: string | undefined,
): Promise<ResultEnvelope> {
  const dedupKey = idempotencyKey ?? `platform.probe.echo:${context.actor.companyId}:${message}`;
  const publication = await publishEvent(tx, {
    companyId: context.actor.companyId,
    eventName: "platform.echoRequested",
    payload: { message, ...(idempotencyKey === undefined ? {} : { idempotencyKey }) },
    dedupKey,
  });
  const registration = await registerDurableJob(tx, {
    kind: "platform.echo_delivery",
    input: { dedupKey, message },
    companyId: context.actor.companyId,
    policy: { maxAttempts: 3, backoffBaseMs: 2_000 },
    dedupKey,
  });
  return okResult(
    Schema.decodeUnknownSync(probeEchoResultSchema)({
      echo: `echo: ${message}`,
      eventId: publication.eventId,
      dedupKey,
      deduplicated: publication.deduplicated || registration.deduplicated,
      jobKey: registration.jobKey,
    }),
  );
}

/** Handler table for mutation-transaction dispatches. */
function mutationHandlers(): HandlerRegistry<MutationCtx> {
  return {
    "platform.probeEcho": {
      intent: "write",
      run: async (tx, context, input, meta) => {
        const { message } = Schema.decodeUnknownSync(probeEchoEntry.input)(input);
        return probeEchoTransaction(tx, context, message, meta.idempotencyKey);
      },
    },
  };
}

/**
 * Dispatches one command envelope inside a mutation transaction. The
 * optional `serviceSessionId` marks the bridge path (identity already
 * verified at the HTTP boundary); without it, Convex Auth is the only
 * identity source.
 */
export async function dispatchMutationCommand(
  ctx: MutationCtx,
  envelope: unknown,
  serviceSessionId: string | undefined,
): Promise<ResultEnvelope> {
  const resolveContext = async (tx: MutationCtx): Promise<RequestContext | null> => {
    const identity =
      serviceSessionId === undefined
        ? await identityFromConvexAuth(tx.auth, Date.now())
        : bridgeIdentity(serviceSessionId, Date.now());
    return resolveRequestContext(tx.db, identity);
  };
  const deps: CommandDeps<MutationCtx> = {
    resolveContext,
    policy: membershipPolicy,
    handlers: mutationHandlers(),
  };
  return dispatchCommand(deps, ctx, envelope);
}

/** The bridge dispatch context: the HTTP action plus its verified session. */
export interface BridgeCtx {
  readonly action: ActionCtx;
  readonly serviceSessionId: string;
}

/**
 * The resolved bridge context: the request context plus the
 * Convex-normalized company id, which actions cannot compute themselves
 * (no db handle). Carried ON the context, not in a closure.
 */
export type BridgeResolvedContext = RequestContext & {
  readonly normalizedCompanyId: Id<"companies"> | null;
};

/** Dispatches one command envelope from the verified Worker bridge. */
export async function dispatchBridgeCommand(
  ctx: BridgeCtx,
  envelope: unknown,
): Promise<ResultEnvelope> {
  const resolveContext = async (): Promise<BridgeResolvedContext | null> =>
    ctx.action.runQuery(internal.platform.context.resolveServiceContext, {
      sessionId: ctx.serviceSessionId,
    });
  const deps: CommandDeps<BridgeCtx, BridgeResolvedContext> = {
    resolveContext,
    policy: membershipPolicy,
    handlers: {
      "platform.health": {
        intent: "read",
        run: async (bridge) =>
          okResult(await bridge.action.runQuery(internal.platform.health.snapshot, {})),
      },
      "platform.outboxState": {
        intent: "read",
        run: async (bridge, context, input) => {
          const { dedupKey } = Schema.decodeUnknownSync(
            probeOutboxStateEntry.input,
          )(input);
          if (context.normalizedCompanyId === null) {
            return errorResult(validationError("tenant_scope_unresolved"));
          }
          return okResult(
            await bridge.action.runQuery(internal.platform.health.outboxStateFor, {
              companyId: context.normalizedCompanyId,
              ...(dedupKey === undefined ? {} : { dedupKey }),
            }),
          );
        },
      },
      "platform.probeEcho": {
        intent: "write",
        run: async (bridge, _context, _input, meta) => {
          // The write path reuses the transactional entry; the idempotency
          // key rides the envelope so replay dedups in the transaction.
          return bridge.action.runMutation(internal.platform.probe.echoTransaction, {
            envelope: {
              operation: "platform.probeEcho",
              input: _input,
              expectedRevisions: [],
              ...(meta.idempotencyKey === undefined
                ? {}
                : { idempotencyKey: meta.idempotencyKey }),
            },
            serviceSessionId: bridge.serviceSessionId,
          });
        },
      },
    },
  };
  return dispatchCommand(deps, ctx, envelope);
}
