/**
 * Effect 4 RC execution inside Convex functions.
 *
 * Domain computation runs as an `Effect` program: the typed failure channel
 * is the closed error, defects are sanitized to `unavailable`, and an
 * optional deadline bounds the run. The Convex function never sees a bare
 * throw across this seam: the result is always a `ResultEnvelope`.
 */

import { Cause, Effect, Exit } from "effect";
import type { ClosedError, ResultEnvelope } from "@kiero/contracts";
import { errorResult, okResult } from "@kiero/contracts";
import { unavailableError } from "./errors";

export interface RunDomainOptions {
  /** Bounded execution time; exceeding it fails `unavailable` (retryable). */
  readonly deadlineMs?: number;
}

/**
 * Runs one Effect domain program to a result envelope.
 *
 * - success -> ok envelope
 * - typed ClosedError failure -> error envelope (as-is: it is already closed)
 * - defect / interruption / deadline -> sanitized `unavailable` envelope
 */
export async function runDomainEffect<A>(
  program: Effect.Effect<A, ClosedError>,
  options: RunDomainOptions = {},
): Promise<ResultEnvelope> {
  const bounded =
    options.deadlineMs === undefined
      ? program
      : Effect.timeout(program, options.deadlineMs).pipe(
          Effect.catchIf(
            (error): error is Cause.TimeoutError =>
              typeof error === "object" && error !== null && "_tag" in error &&
              (error as { _tag: string })._tag === "TimeoutError",
            () => Effect.fail(unavailableError(true, "domain_deadline_exceeded")),
          ),
        );
  const exit = await Effect.runPromiseExit(bounded);
  return exitToEnvelope(exit);
}

function exitToEnvelope<A, E>(exit: Exit.Exit<A, E>): ResultEnvelope {
  if (exit._tag === "Success") {
    return okResult(exit.value);
  }
  const failure = Exit.isFailure(exit) ? Cause.findErrorOption(exit.cause) : undefined;
  if (failure !== undefined && failure._tag === "Some" && isClosedError(failure.value)) {
    return errorResult(failure.value);
  }
  // Die / Interrupt / parallel defects: nothing internal crosses the seam.
  return errorResult(unavailableError(true, "internal_failure"));
}

function isClosedError(value: unknown): value is ClosedError {
  return (
    typeof value === "object" &&
    value !== null &&
    "_tag" in value &&
    typeof (value as { _tag: unknown })._tag === "string"
  );
}
