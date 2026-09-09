/**
 * Checked command dispatch: the one path every operation invocation takes.
 *
 * Order of checks (each failure returns immediately, sanitized):
 *  1. the envelope decodes against `CommandEnvelope`;
 *  2. the operation exists in the composed registry (`unsupported` otherwise);
 *  3. an implementation is registered for it (`unsupported` otherwise: the
 *     fail-closed placeholder contract);
 *  4. the request context resolves from a verified identity
 *     (`unauthenticated` otherwise, there is no other way in);
 *  5. the authorization seam allows the request (`forbidden` otherwise);
 *  6. the input decodes against the operation's contract schema
 *     (`validation` otherwise, and the handler is NEVER invoked, so invalid
 *     input reaches no domain effect);
 *  7. the handler runs; anything it throws is sanitized to `unavailable`.
 *
 * The result is always a `ResultEnvelope`; a bare internal error never
 * crosses this seam.
 */

import {
  CommandEnvelope,
  errorResult,
  operations,
  type ResultEnvelope,
} from "@kiero/contracts";
import { decodeInput } from "./decode";
import { sanitizeUnknownError, unsupportedError } from "./errors";
import type { AccessIntent, AccessPolicy, RequestContext } from "./context";

/** Command metadata a handler may need beyond the decoded input. */
export interface CommandMeta {
  /** The command's idempotency key, when the caller supplied one. */
  readonly idempotencyKey?: string;
}

/**
 * One implemented operation handler: receives decoded input, returns an
 * envelope. `Context` lets a dispatch carry extra resolved fields (e.g. the
 * Convex-normalized company id) alongside the base request context.
 */
export type OperationHandler<Ctx, Context extends RequestContext = RequestContext> = (
  ctx: Ctx,
  context: Context,
  input: unknown,
  meta: CommandMeta,
) => Promise<ResultEnvelope>;

/** One registered implementation: the handler plus the intent it runs under. */
export interface OperationBinding<Ctx, Context extends RequestContext = RequestContext> {
  readonly intent: AccessIntent;
  readonly run: OperationHandler<Ctx, Context>;
}

/** The implementation registry: keys are full operation names. */
export type HandlerRegistry<Ctx, Context extends RequestContext = RequestContext> = Record<
  string,
  OperationBinding<Ctx, Context>
>;

/** What a dispatch needs: resolution, policy and implemented handlers. */
export interface CommandDeps<Ctx, Context extends RequestContext = RequestContext> {
  readonly resolveContext: (ctx: Ctx) => Promise<Context | null>;
  readonly policy: AccessPolicy;
  readonly handlers: HandlerRegistry<Ctx, Context>;
}

/**
 * Dispatches one command envelope through the checked path.
 * `unknown` envelope input is allowed: decoding is step 1.
 */
export async function dispatchCommand<Ctx, Context extends RequestContext = RequestContext>(
  deps: CommandDeps<Ctx, Context>,
  ctx: Ctx,
  envelope: unknown,
): Promise<ResultEnvelope> {
  const decodedEnvelope = decodeInput(CommandEnvelope, envelope);
  if (!decodedEnvelope.ok) {
    return decodedEnvelope.error;
  }
  const command = decodedEnvelope.value;

  const entry = operations[command.operation];
  if (entry === undefined) {
    return errorResult(unsupportedError(command.operation, "unknown_operation"));
  }
  const binding = deps.handlers[command.operation];
  if (binding === undefined) {
    return errorResult(unsupportedError(command.operation));
  }

  const context = await deps.resolveContext(ctx);
  const decision = await deps.policy.authorize(context, { intent: binding.intent });
  if (!decision.allowed) {
    return errorResult(decision.error);
  }
  if (context === null) {
    // Unreachable when the policy is sane; kept fail-closed regardless.
    return errorResult(unsupportedError(command.operation, "no_context"));
  }

  const decodedInput = decodeInput(entry.input, command.input);
  if (!decodedInput.ok) {
    return decodedInput.error;
  }

  try {
    return await binding.run(ctx, context, decodedInput.value, {
      ...(command.idempotencyKey === undefined ? {} : { idempotencyKey: command.idempotencyKey }),
    });
  } catch (cause) {
    return errorResult(sanitizeUnknownError(cause));
  }
}
