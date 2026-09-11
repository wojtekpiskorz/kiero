/**
 * The withdrawal block of the source dossier (C5's audited surface): the
 * honest record of a completed withdrawal (WithdrawnRecord) and the
 * WithdrawControl that performs it. Split from SourceDetailFeature.ts in
 * E7 review round 1 to keep that file under the size budget (the media.ts
 * and reassign.ts precedents).
 *
 * The control dispatches C5's audited `sources.withdrawSource` through the
 * accept lane's public command: the ONE operation-agnostic sources
 * dispatch table every sources write on this surface rides (the envelope
 * carries the operation), with the explicit disclosure that withdrawal is
 * NOT permanent deletion (CONTEXT.md "Źródło wycofane" keeps content and
 * history).
 */

import { createElement, useState, type ChangeEvent, type ReactNode } from "react";
import { useMutation } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { instantLabel } from "../conversation/state";
import { envelopeOf, type Notice, type SubmitEvent } from "../company/CompanyGate";
import { failureHint, sourceDetailCopy as copy } from "./state";

/** The honest record of one completed withdrawal (the dossier section). */
export function WithdrawnRecord({
  withdrawnBy,
  withdrawnAtMs,
  reason,
}: {
  readonly withdrawnBy: string | null;
  readonly withdrawnAtMs: number | null;
  readonly reason: string | null;
}): ReactNode {
  return createElement(
    "section",
    { "aria-label": copy.withdrawnHeading },
    createElement("h2", null, copy.withdrawnHeading),
    createElement("p", null, copy.withdrawnDisclosedNote),
    createElement("p", null, `${copy.withdrawnByLabel}: ${withdrawnBy ?? "?"}`),
    createElement("p", null, `${copy.withdrawnAtLabel}: ${withdrawnAtMs === null ? "?" : instantLabel(withdrawnAtMs)}`),
    createElement("p", null, `${copy.withdrawnReasonLabel}: ${reason ?? "?"}`),
    createElement("p", null, copy.withdrawnReassignmentNote),
  );
}

/** The audited withdrawal control of one active source (C5). */
export function WithdrawControl({ sourceId }: { readonly sourceId: string }): ReactNode {
  const withdraw = useMutation(api.sources.accept.commands.acceptSourceCommand);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [open, setOpen] = useState(false);

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const trimmed = reason.trim();
    if (saving || trimmed.length === 0) {
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const result = await withdraw({
        envelope: envelopeOf("sources.withdrawSource", {
          sourceId,
          reason: trimmed,
        }),
      });
      if (result._tag === "error") {
        setNotice({
          kind: "error",
          text: failureHint(result.error.code, result.error.message),
        });
        return;
      }
      setNotice({ kind: "ok", text: copy.withdrawDone });
      setReason("");
      setOpen(false);
    } catch {
      setNotice({ kind: "error", text: copy.networkUnavailable });
    } finally {
      setSaving(false);
    }
  }

  return createElement(
    "section",
    { "aria-label": copy.withdrawHeading },
    createElement("h2", null, copy.withdrawHeading),
    createElement("p", null, copy.withdrawIntro),
    open
      ? createElement(
          "form",
          { onSubmit: (event) => void submit(event) },
          createElement("label", { htmlFor: "withdraw-reason" }, copy.withdrawReasonLabel),
          createElement("input", {
            id: "withdraw-reason",
            type: "text",
            placeholder: copy.withdrawReasonPlaceholder,
            value: reason,
            onChange: (event: ChangeEvent<HTMLInputElement>) => setReason(event.target.value),
            required: true,
          }),
          createElement(
            "button",
            { type: "submit", disabled: saving || reason.trim().length === 0 },
            saving ? copy.withdrawSaving : copy.withdrawSubmit,
          ),
          " ",
          createElement("button", { type: "button", onClick: () => setOpen(false) }, copy.cancel),
        )
      : createElement(
          "p",
          null,
          createElement("button", { type: "button", onClick: () => setOpen(true) }, copy.withdrawButton),
        ),
    notice === null
      ? null
      : createElement("p", { role: notice.kind === "error" ? "alert" : "status" }, notice.text),
  );
}
