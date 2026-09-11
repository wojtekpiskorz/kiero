/**
 * The reassignment control (E7's mount, issue #115): the boss moves one
 * "Wiadomość źródłowa" between projects or to company-general knowledge by
 * declaring the COMPLETE new project set through the certified
 * `sources.reassignSource` over the same sources dispatch the withdrawal
 * control uses. Split from SourceDetailFeature.ts to keep that file under
 * the size budget (the media.ts precedent).
 *
 * Barebones by scope: one checkbox per company project (the source's
 * current links preselected), zero checked means company-general
 * ("wiedza ogólna firmy"), the committed receipt is authority for the
 * selection state, and the closed conflicts render through the surface's
 * Polish hints.
 */

import { createElement, useState, type ReactNode } from "react";
import { Schema } from "effect";
import { sourcesOperations } from "@kiero/contracts";
import { useMutation } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { envelopeOf, type Notice, type SubmitEvent } from "../company/CompanyGate";
import { failureHint, sourceDetailCopy as copy } from "./state";

/** The project-placement control of the source dossier. */
export function ReassignControl({
  sourceId,
  projectNames,
  currentProjectIds,
}: {
  readonly sourceId: string;
  readonly projectNames: ReadonlyMap<string, string>;
  readonly currentProjectIds: readonly string[];
}): ReactNode {
  const reassign = useMutation(api.sources.reassign.commands.reassignSourceCommand);
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(currentProjectIds),
  );
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  function toggle(projectId: string): void {
    setSelected((previous) => {
      const next = new Set(previous);
      if (next.has(projectId)) {
        next.delete(projectId);
      } else {
        next.add(projectId);
      }
      return next;
    });
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (saving) {
      return;
    }
    setSaving(true);
    setNotice(null);
    try {
      const result = await reassign({
        envelope: envelopeOf("sources.reassignSource", {
          sourceId,
          projectIds: [...selected],
        }),
      });
      if (result._tag === "error") {
        setNotice({
          kind: "error",
          text: failureHint(result.error.code, result.error.message),
        });
        return;
      }
      // The committed set is authority (deduplicated server side); decode
      // through the contract's own receipt schema, like every wire value
      // this surface renders.
      const receipt = Schema.decodeUnknownSync(
        sourcesOperations["sources.reassignSource"].result,
      )(result.value);
      setSelected(new Set(receipt.projectIds));
      setNotice({ kind: "ok", text: copy.reassignmentDone });
    } catch {
      setNotice({ kind: "error", text: copy.networkUnavailable });
    } finally {
      setSaving(false);
    }
  }

  return createElement(
    "section",
    { "aria-label": copy.reassignmentHeading },
    createElement("h2", null, copy.reassignmentHeading),
    createElement("p", null, copy.reassignmentIntro),
    createElement(
      "form",
      { onSubmit: (event) => void submit(event) },
      projectNames.size === 0
        ? createElement("p", null, copy.noProjects)
        : createElement(
            "ul",
            null,
            ...[...projectNames.entries()].map(([projectId, displayName]) =>
              createElement(
                "li",
                { key: projectId },
                createElement(
                  "label",
                  null,
                  createElement("input", {
                    type: "checkbox",
                    checked: selected.has(projectId),
                    onChange: () => toggle(projectId),
                    "data-testid": `reassign-project-${projectId}`,
                  }),
                  ` ${displayName}`,
                ),
              ),
            ),
          ),
      createElement(
        "p",
        { role: "status" },
        selected.size === 0 ? copy.reassignmentNoProjectsHint : "",
      ),
      createElement(
        "button",
        { type: "submit", disabled: saving },
        saving ? copy.reassignmentSaving : copy.reassignmentSubmit,
      ),
    ),
    notice === null
      ? null
      : createElement("p", { role: notice.kind === "error" ? "alert" : "status" }, notice.text),
  );
}
