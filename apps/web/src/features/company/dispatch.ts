/**
 * The shared checked-dispatch runner (H2 review round 1): one hook every
 * command-driving surface calls, parameterized by the surface's mutation
 * and hint map. The work forms, the extensions sections and the Co teraz
 * controls previously held three drifting copies (useWorkDispatch,
 * useMemoryDispatch and four hand-rolled blocks); this module is the one
 * home of that shape.
 *
 * The hook stays presentation-free: it maps a ResultEnvelope to the shared
 * notice state (the given hint function renders the closed-error codes of
 * the COMMAND's domain; the server's Polish message shows otherwise) and
 * resolves to the ok VALUE, or null when the command refused or the
 * response was lost. JSX-free (createElement only), node-importable.
 */

import { createElement, useCallback, useState, type ReactNode } from "react";
import type { CommandEnvelope, ResultEnvelope } from "@kiero/contracts";
import { envelopeOf, type Notice } from "./CompanyGate";
import { signInCopy } from "../sign-in/state";

/** One checked-dispatch mutation as useMutation hands it to a surface. */
export type DispatchMutation = (args: { readonly envelope: CommandEnvelope }) => Promise<ResultEnvelope>;

/** The hint function every surface passes: closed code to Polish, or the server message. */
export type FailureHintOf = (code: string | undefined, serverMessage: string) => string;

/** One surface's dispatch state: the checked run plus the shared notice/busy pair. */
export interface CheckedDispatchHandle {
  /**
   * Runs one command through the checked dispatch. Resolves to the ok
   * VALUE, or null when the command refused or the response was lost (the
   * notice carries which).
   */
  readonly run: (operation: string, input: unknown, okText: string) => Promise<unknown>;
  readonly notice: Notice | null;
  readonly busy: boolean;
  readonly setNotice: (notice: Notice | null) => void;
  readonly setBusy: (busy: boolean) => void;
}

/**
 * The one checked-dispatch runner. `dispatch` is the surface's mutation
 * (work, memory, attention...); `hintOf` is the hint map OF THAT COMMAND'S
 * domain, so an attention or memory error can never be mapped through,
 * say, the work surface's codes.
 */
export function useCheckedDispatch(
  dispatch: DispatchMutation,
  hintOf: FailureHintOf,
): CheckedDispatchHandle {
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (operation: string, input: unknown, okText: string): Promise<unknown> => {
      setNotice(null);
      setBusy(true);
      try {
        const result = await dispatch({ envelope: envelopeOf(operation, input) });
        if (result._tag === "error") {
          setNotice({ kind: "error", text: hintOf(result.error.code, result.error.message) });
          return null;
        }
        setNotice({ kind: "ok", text: okText });
        return result.value;
      } catch {
        setNotice({ kind: "error", text: signInCopy.failures.network });
        return null;
      } finally {
        setBusy(false);
      }
    },
    [dispatch, hintOf],
  );

  return { run, notice, busy, setNotice, setBusy };
}

/** The result notice area every dispatching surface renders (alert on error, status on ok). */
export function NoticeArea({ notice }: { readonly notice: Notice | null }): ReactNode {
  if (notice === null) {
    return null;
  }
  return createElement("p", { role: notice.kind === "error" ? "alert" : "status" }, notice.text);
}
