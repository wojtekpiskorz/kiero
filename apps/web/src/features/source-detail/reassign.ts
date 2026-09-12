/**
 * The reassignment control (E7's mount, issue #115; R4's stale refusal,
 * issue #129): the boss moves one "Wiadomość źródłowa" between projects or
 * to company-general knowledge by declaring the COMPLETE new project set
 * through the certified `sources.reassignSource` over the same sources
 * dispatch the withdrawal control uses. Split from SourceDetailFeature.ts
 * to keep that file under the size budget (the media.ts precedent).
 *
 * The dispatch entry is the accept lane's public command, exactly like the
 * WithdrawControl on the same dossier page: ONE operation-agnostic
 * dispatch table serves every sources write, and the envelope carries the
 * operation (review round 1 deleted this lane's duplicate entry pair).
 *
 * R4 (issue #129): a COMPLETE replacement carries the observed-placement
 * precondition. The form snapshots the server placement it was populated
 * with (`observed`, the same exposition read that preselected the
 * checkboxes) and every submit declares it as `expectedProjectIds`. A
 * typed `source_placement_stale` refusal means another boss reassigned
 * this source after this form loaded: the selection resets to the
 * authoritative server placement (never a merge — the command declares a
 * complete replacement) with the Polish stale notice, and the boss checks
 * it and submits again. The pure halves (`submitReassignment`,
 * `reassignFormAfter`) are the deterministic test surface, the
 * statement-source precedent.
 *
 * Barebones by scope: one checkbox per company project (the source's
 * current links preselected), zero checked means company-general
 * ("wiedza ogólna firmy"), the committed receipt is authority for the
 * selection state, and the closed conflicts render through the surface's
 * Polish hints.
 */

import {
  createElement,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { Schema } from "effect";
import {
  sourcesOperations,
  type CommandEnvelope,
  type ResultEnvelope,
} from "@kiero/contracts";
import { useMutation } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { envelopeOf, type Notice, type SubmitEvent } from "../company/CompanyGate";
import { failureHint, sourceDetailCopy as copy } from "./state";

/** The contract entry this control rides (decode/typed authority). */
const reassignSourceEntry = sourcesOperations["sources.reassignSource"];

/** The typed receipt of one accepted reassignment (contract authority). */
export type ReassignSourceReceipt = Schema.Schema.Type<typeof reassignSourceEntry.result>;

/** The one certified reassignment mutation (injectable for the tests). */
export interface ReassignMutations {
  readonly reassignSource: (args: {
    readonly envelope: CommandEnvelope;
  }) => Promise<ResultEnvelope>;
}

/**
 * One submit's outcome: `reassigned` with the committed receipt, `refused`
 * with the closed error (plus whether it is the stale-placement conflict),
 * or `lost` when the response never came back.
 */
export type ReassignOutcome =
  | { readonly _tag: "reassigned"; readonly receipt: ReassignSourceReceipt }
  | { readonly _tag: "refused"; readonly code: string; readonly message: string; readonly stale: boolean }
  | { readonly _tag: "lost" };

/** The typed stale-refusal code (R4's contract constant). */
export const SOURCE_PLACEMENT_STALE = "source_placement_stale";

/**
 * Submits one complete reassignment under its observed-placement
 * precondition. The envelope carries the REQUIRED `expectedProjectIds`
 * (the set the form was populated with); a network-lost response reports
 * `lost` so the caller can retry deliberately after reloading.
 */
export async function submitReassignment(
  mutations: ReassignMutations,
  sourceId: string,
  observed: readonly string[],
  desired: readonly string[],
): Promise<ReassignOutcome> {
  try {
    const result = await mutations.reassignSource({
      envelope: envelopeOf("sources.reassignSource", {
        sourceId,
        projectIds: [...desired],
        expectedProjectIds: [...observed],
      }),
    });
    if (result._tag === "error") {
      return {
        _tag: "refused",
        code: result.error.code,
        message: result.error.message,
        stale: result.error.code === SOURCE_PLACEMENT_STALE,
      };
    }
    // The committed set is authority (deduplicated server side); decode
    // through the contract's own receipt schema, like every wire value
    // this surface renders.
    const receipt = Schema.decodeUnknownSync(reassignSourceEntry.result)(result.value);
    return { _tag: "reassigned", receipt };
  } catch {
    return { _tag: "lost" };
  }
}

/** The form's placement state: the selection, the observed set, staleness. */
export interface ReassignFormState {
  /** The checkboxes the boss is editing (the desired complete set). */
  readonly selected: ReadonlySet<string>;
  /** The server placement this form was last synced to (the precondition). */
  readonly observed: ReadonlySet<string>;
  /** R4: a stale refusal arrived; the authoritative read drives the form. */
  readonly stale: boolean;
}

/**
 * The transition after one submit outcome (pure; the control's own logic).
 *
 * - an accepted receipt is authority: selection AND observed baseline move
 *   to the committed set;
 * - a stale refusal resets BOTH to the authoritative server placement from
 *   the detail read (`serverProjectIds`) — a complete replacement, never a
 *   merge of the stale and current sets;
 * - every other outcome keeps the form exactly as it was.
 */
export function reassignFormAfter(
  state: ReassignFormState,
  outcome: ReassignOutcome,
  serverProjectIds: readonly string[],
): ReassignFormState {
  if (outcome._tag === "reassigned") {
    const committed = new Set(outcome.receipt.projectIds);
    return { selected: committed, observed: committed, stale: false };
  }
  if (outcome._tag === "refused" && outcome.stale) {
    const current = new Set(serverProjectIds);
    return { selected: current, observed: current, stale: true };
  }
  return state;
}

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
  const reassignSource = useMutation(api.sources.accept.commands.acceptSourceCommand);
  // The observed baseline is the placement the populated read carried (the
  // form's initial state initializer runs once, on mount).
  const [form, setForm] = useState<ReassignFormState>(() => {
    const initial = new Set(currentProjectIds);
    return { selected: initial, observed: initial, stale: false };
  });
  const [saving, setSaving] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  // R4's reload: while the form is stale, the authoritative detail read
  // (this surface's live `currentProjectIds` prop, the same snapshot that
  // names the dossier's placement) keeps driving the selection, so a
  // subscription update that lands after the refusal still refreshes it.
  useEffect(() => {
    if (!form.stale) {
      return;
    }
    const authoritative = new Set(currentProjectIds);
    setForm((current) => ({
      ...current,
      selected: authoritative,
      observed: authoritative,
    }));
  }, [form.stale, currentProjectIds]);

  function toggle(projectId: string): void {
    // A deliberate edit ends the stale reset (the precondition still
    // guards the eventual submit).
    setForm((current) => ({
      ...current,
      stale: false,
      selected: (() => {
        const next = new Set(current.selected);
        if (next.has(projectId)) {
          next.delete(projectId);
        } else {
          next.add(projectId);
        }
        return next;
      })(),
    }));
  }

  async function submit(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (saving) {
      return;
    }
    setSaving(true);
    setNotice(null);
    const outcome = await submitReassignment(
      { reassignSource },
      sourceId,
      [...form.observed],
      [...form.selected],
    );
    setForm((current) => reassignFormAfter(current, outcome, currentProjectIds));
    if (outcome._tag === "refused") {
      setNotice({
        kind: "error",
        text: failureHint(outcome.code, outcome.message),
      });
    } else if (outcome._tag === "lost") {
      setNotice({ kind: "error", text: copy.networkUnavailable });
    } else {
      setNotice({ kind: "ok", text: copy.reassignmentDone });
    }
    setSaving(false);
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
                    checked: form.selected.has(projectId),
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
        form.selected.size === 0 ? copy.reassignmentNoProjectsHint : "",
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
