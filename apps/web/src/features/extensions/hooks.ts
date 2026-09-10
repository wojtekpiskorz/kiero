/**
 * The extensions feature's shared dispatch hook (H2): one memory-command
 * runner for the catalog/define/version/value/correction sections.
 *
 * The command goes through C2/C3's checked memory dispatch; results arrive
 * as `ResultEnvelope`s and map to the server's Polish message plus the
 * extension-surface hints for the load-bearing machine codes. The ok VALUE
 * is returned to the caller (the sections decode their own result shapes
 * at the boundary); `null` means refused or lost.
 */

import { createElement, useCallback, useState, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { envelopeOf, type Notice } from "../company/CompanyGate";
import { signInCopy } from "../sign-in/state";
import { failureHint } from "./state";

export interface MemoryDispatchHandle {
  readonly run: (operation: string, input: unknown, okText: string) => Promise<unknown>;
  readonly notice: Notice | null;
  readonly busy: boolean;
  readonly setNotice: (notice: Notice | null) => void;
  readonly setBusy: (busy: boolean) => void;
}

/** The checked memory-dispatch runner with the shared notice/busy state. */
export function useMemoryDispatch(): MemoryDispatchHandle {
  const dispatch = useMutation(api.memory.findings.functions.dispatchMemoryCommandEntry);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (operation: string, input: unknown, okText: string): Promise<unknown> => {
      setNotice(null);
      setBusy(true);
      try {
        const result = await dispatch({ envelope: envelopeOf(operation, input) });
        if (result._tag === "error") {
          setNotice({ kind: "error", text: failureHint(result.error.code, result.error.message) });
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
    [dispatch],
  );

  return { run, notice, busy, setNotice, setBusy };
}

/** The result notice area every extensions section renders. */
export function NoticeArea({ notice }: { readonly notice: Notice | null }): ReactNode {
  if (notice === null) {
    return null;
  }
  return createElement("p", { role: notice.kind === "error" ? "alert" : "status" }, notice.text);
}
