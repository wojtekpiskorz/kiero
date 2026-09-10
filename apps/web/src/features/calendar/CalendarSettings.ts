/**
 * The Calendar settings and sync diagnostics surface (G4): the personal
 * operation view over G2's projection and G3's reconciliation, on the same
 * /kalendarz screen as G1's connection lifecycle.
 *
 * JSX-free on purpose (createElement only), like the connection panel: the
 * host feature registry chain stays importable by the node test programs.
 *
 * Everything rendered comes from the three lane reads the issue names
 * (G1 calendarStatus drives the surrounding panel; here G3 syncOverview
 * for diagnostics and G2 projectionOverview for the copies list) and every
 * write rides the certified typed dispatches: `calendar.setCopyHidden`
 * (personal hide/restore) and `calendar.reconcileCopy` (check this copy
 * now). No success is ever shown over pending or failed work; the ONLY
 * success sentence appears when every copy is confirmed and no attempt is
 * failed or uncertain.
 *
 * The personal project scope is editable through the certified
 * `calendar.setSelection` write (G5, issue #107): the scope section's
 * mounted follow-up over G4's honest not-yet-available notice. The saved
 * choice is personal and applies at the next synchronization pass.
 */

import { createElement, useState, type ReactNode } from "react";
import { useMutation, useQuery_experimental as useQueryState } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { SessionEnded, envelopeOf, type Notice } from "../company/CompanyGate";
import {
  calendarCopy,
  commandFailureHint,
  copyStatusLabel,
  settingsCopy,
  subjectHref,
  syncNextActionCopy,
  syncNextActions,
  syncStatusLines,
  type CopyRowView,
  type ProjectionOverviewView,
  type SelectionView,
  type SyncOverviewView,
} from "./state";

// ---------------------------------------------------------------------------
// The settings root (two lane reads; the connection panel above owns G1's).
// ---------------------------------------------------------------------------

/**
 * The settings surface: rendered under the connection panel whenever a
 * calendar connection row exists. `actionsEnabled` is honest about whether
 * the copy commands can be served right now (G1's connected state); a
 * stopped connection still shows its diagnostics and cleanup residue.
 */
export function CalendarSettings({ actionsEnabled }: { readonly actionsEnabled: boolean }): ReactNode {
  const sync = useQueryState({ query: api.calendar.sync.functions.syncOverview, args: {} });
  const projection = useQueryState({
    query: api.calendar.projection.functions.projectionOverview,
    args: {},
  });
  if (sync.status === "error" || projection.status === "error") {
    return createElement(SessionEnded);
  }
  if (sync.status !== "success" || projection.status !== "success") {
    return createElement("p", { role: "status" }, calendarCopy.checkingSession);
  }
  const projectionData = projection.data;
  // Without the actor's own connection row there is nothing to operate on;
  // the connection panel above already explains those states. The lean
  // read branches carry `selection: null` (no own connection means no
  // scope to read), so the non-null selection is the projection read's
  // full-branch discriminator; the sync read discriminates on
  // `reconnectNeeded`, which exists on the full branch only.
  if (
    !("reconnectNeeded" in sync.data) ||
    typeof sync.data.reconnectNeeded !== "boolean"
  ) {
    return null;
  }
  const projectionView: ProjectionOverviewView = projectionData;
  const overview: SyncOverviewView = sync.data;
  // The ONE selection gate, after the view annotations: every
  // projectionOverview branch carries `selection` (null on the lean ones),
  // so a plain null check is the whole discriminator here.
  if (projectionView.selection === null) {
    return null;
  }
  const selection: SelectionView = projectionView.selection;
  const children: ReactNode[] = [
    createElement(DiagnosticsSection, {
      overview,
      lastPassState: projectionView.sync?.state ?? null,
      suspendedReason: projectionView.sync?.suspendedReason ?? null,
    }),
    createElement(ScopeSection, { selection }),
    createElement(CopiesSection, { copies: projectionView.copies, actionsEnabled }),
  ];
  return createElement("section", { "aria-labelledby": "calendar-sync-heading" }, ...children);
}

// ---------------------------------------------------------------------------
// Diagnostics: last success, pending/failed/uncertain counts, residue.
// (Exported for the deterministic panel renders in tests/g4.)
// ---------------------------------------------------------------------------

export function DiagnosticsSection({
  overview,
  lastPassState,
  suspendedReason,
}: {
  readonly overview: SyncOverviewView;
  readonly lastPassState: "idle" | "syncing" | "needs_reconcile" | null;
  readonly suspendedReason: string | null;
}): ReactNode {
  const children: ReactNode[] = [
    createElement("h2", { id: "calendar-sync-heading" }, settingsCopy.settingsHeading),
    createElement("p", null, settingsCopy.settingsIntro),
  ];
  if (lastPassState === "needs_reconcile" && !overview.reconnectNeeded) {
    // A pass that could not finish leaves honest residue; the counts below
    // say exactly what remains. Access-loss has its own dedicated line.
    children.push(createElement("p", { role: "alert" }, settingsCopy.suspendedLine(suspendedReason)));
  }
  for (const line of syncStatusLines(overview)) {
    children.push(createElement("p", { role: line.role }, line.text));
  }
  // The RECOVERY copy renders from syncNextActions (the same model the
  // surface tests assert): one home decides which recoveries the screen
  // honestly offers, never a blind recreate.
  const actions = syncNextActions(overview);
  for (const action of actions) {
    const line = syncNextActionCopy[action];
    children.push(createElement("p", { role: line.role }, line.text));
  }
  children.push(
    createElement(
      "p",
      null,
      overview.lastConfirmedAtMs === null
        ? settingsCopy.neverSynced
        : settingsCopy.lastSyncedAt(overview.lastConfirmedAtMs),
    ),
  );
  return createElement("section", null, ...children);
}

// ---------------------------------------------------------------------------
// The personal project scope: the certified calendar.setSelection write
// (G5, issue #107) mounted as the honest editor. G4 rendered the
// not-yet-available notice here; this section is its sanctioned follow-up.
// ---------------------------------------------------------------------------

/**
 * The scope editor: two mode radios (all projects vs an explicit checkbox
 * list of the firm's projects from the projects catalog read) and one save
 * button dispatching `calendar.setSelection`. Seeded from the effective
 * selection the projection read carries; the saved choice applies at the
 * NEXT synchronization pass, which the copy states honestly.
 */
export function ScopeSection({ selection }: { readonly selection: SelectionView }): ReactNode {
  const projects = useQueryState({ query: api.projects.functions.projectsOverview, args: {} });
  const setSelection = useMutation(api.calendar.projection.functions.dispatchCalendarProjection);
  const [mode, setMode] = useState<"all_projects" | "explicit">(selection.mode);
  const [checked, setChecked] = useState<ReadonlySet<string>>(
    new Set(selection.projectIds ?? []),
  );
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const loaded = projects.status === "success";

  async function save(): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      const result = await setSelection({
        envelope: envelopeOf("calendar.setSelection", {
          ...(mode === "explicit" ? { mode, projectIds: [...checked] } : { mode }),
        }),
      });
      setNotice(
        result._tag === "ok"
          ? { kind: "ok", text: settingsCopy.scopeSaved }
          : { kind: "error", text: scopeFailureHint(result.error) },
      );
    } catch {
      setNotice({ kind: "error", text: settingsCopy.networkFailure });
    } finally {
      setBusy(false);
    }
  }

  const children: ReactNode[] = [
    createElement("h2", { id: "calendar-scope-heading" }, settingsCopy.scopeHeading),
    createElement("p", null, settingsCopy.scopeIntro),
    createElement(
      "fieldset",
      null,
      createElement("legend", null, settingsCopy.scopeEditMode),
      createElement(
        "label",
        null,
        createElement("input", {
          type: "radio",
          name: "calendar-scope-mode",
          checked: mode === "all_projects",
          onChange: () => setMode("all_projects"),
        }),
        ` ${settingsCopy.scopeModeAll}`,
      ),
      createElement(
        "label",
        null,
        createElement("input", {
          type: "radio",
          name: "calendar-scope-mode",
          checked: mode === "explicit",
          onChange: () => setMode("explicit"),
        }),
        ` ${settingsCopy.scopeModeExplicit}`,
      ),
      ...(mode === "explicit"
        ? [
            loaded
              ? createElement(
                  "ul",
                  null,
                  // Closed projects stay selectable: they keep retained
                  // obligations the projection still copies (G2's rule).
                  ...[...projects.data.active, ...projects.data.closed].map((project) =>
                    createElement(
                      "li",
                      { key: project.projectId },
                      createElement(
                        "label",
                        null,
                        createElement("input", {
                          type: "checkbox",
                          checked: checked.has(project.projectId),
                          onChange: (event: { target: { checked: boolean } }) => {
                            const next = new Set(checked);
                            if (event.target.checked) {
                              next.add(project.projectId);
                            } else {
                              next.delete(project.projectId);
                            }
                            setChecked(next);
                          },
                        }),
                        ` ${project.displayName}`,
                      ),
                    ),
                  ),
                )
              : createElement("p", { role: "status" }, calendarCopy.checkingSession),
            createElement("p", { role: "status" }, settingsCopy.scopeCount(checked.size)),
          ]
        : []),
    ),
    createElement(
      "button",
      { type: "button", disabled: busy || (mode === "explicit" && !loaded), onClick: () => void save() },
      settingsCopy.scopeSave,
    ),
    ...(mode === "explicit" && checked.size === 0
      ? [createElement("p", { role: "note" }, settingsCopy.scopeExplicitEmpty)]
      : []),
    ...(notice === null
      ? []
      : [
          createElement(
            "p",
            { role: notice.kind === "error" ? "alert" : "status" },
            notice.text,
          ),
        ]),
    createElement("p", null, settingsCopy.scopeNextSyncNote),
    createElement("p", null, settingsCopy.personalFieldsNote),
  ];
  return createElement("section", { "aria-labelledby": "calendar-scope-heading" }, ...children);
}

/** Honest Polish text for one selection dispatch failure (the kind is the envelope's _tag; a retry cannot cure a vanished project). */
function scopeFailureHint(error: { readonly _tag?: string }): string {
  if (error._tag === "not_found") {
    return settingsCopy.scopeProjectNotFound;
  }
  return settingsCopy.unexpectedFailure;
}

// ---------------------------------------------------------------------------
// The copies list: personal hide/restore, check-now, and the Kiero deep link.
// ---------------------------------------------------------------------------

export function CopiesSection({
  copies,
  actionsEnabled,
}: {
  readonly copies: readonly CopyRowView[];
  readonly actionsEnabled: boolean;
}): ReactNode {
  const setCopyHidden = useMutation(api.calendar.projection.functions.dispatchCalendarProjection);
  const reconcileCopy = useMutation(api.calendar.sync.functions.dispatchCalendarSync);
  const [busyCopyId, setBusyCopyId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  async function run(command: "hide" | "restore" | "check", copy: CopyRowView): Promise<void> {
    if (busyCopyId !== null) {
      return;
    }
    setBusyCopyId(copy.copyId);
    setNotice(null);
    try {
      const result =
        command === "check"
          ? await reconcileCopy({
              envelope: envelopeOf("calendar.reconcileCopy", { copyId: copy.copyId }),
            })
          : await setCopyHidden({
              envelope: envelopeOf("calendar.setCopyHidden", {
                copyId: copy.copyId,
                hidden: command === "hide",
              }),
            });
      if (result._tag === "error") {
        setNotice({ kind: "error", text: commandFailureHint(result.error.code) });
        return;
      }
      if (command === "hide") {
        setNotice({ kind: "ok", text: settingsCopy.hideDone });
      } else if (command === "restore") {
        setNotice({ kind: "ok", text: settingsCopy.restoreDone });
      } else {
        // The command answers the copy's CURRENT recorded outcome; only a
        // recorded confirmation reads as success, never a queued check.
        const outcome = (result.value as { remoteOutcome?: unknown }).remoteOutcome;
        setNotice({
          kind: "ok",
          text: outcome === "confirmed" ? settingsCopy.checkConfirmed : settingsCopy.checkQueued,
        });
      }
    } catch {
      setNotice({ kind: "error", text: settingsCopy.networkFailure });
    } finally {
      setBusyCopyId(null);
    }
  }

  const children: ReactNode[] = [
    createElement("h2", { id: "calendar-copies-heading" }, settingsCopy.copiesHeading),
    createElement("p", null, settingsCopy.copiesIntro),
  ];
  if (!actionsEnabled) {
    children.push(createElement("p", { role: "note" }, settingsCopy.actionsUnavailableNote));
  }
  if (copies.length === 0) {
    children.push(createElement("p", null, settingsCopy.noCopiesYet));
  } else {
    children.push(
      createElement(
        "ul",
        null,
        ...copies.map((copy) =>
          createElement(
            "li",
            { key: copy.copyId },
            createElement(CopyRow, {
              copy,
              actionsEnabled,
              busy: busyCopyId !== null,
              onHide: () => void run("hide", copy),
              onRestore: () => void run("restore", copy),
              onCheck: () => void run("check", copy),
            }),
          ),
        ),
      ),
    );
  }
  if (notice !== null) {
    children.push(createElement("p", { role: notice.kind === "error" ? "alert" : "status" }, notice.text));
  }
  return createElement("section", { "aria-labelledby": "calendar-copies-heading" }, ...children);
}

function CopyRow({
  copy,
  actionsEnabled,
  busy,
  onHide,
  onRestore,
  onCheck,
}: {
  readonly copy: CopyRowView;
  readonly actionsEnabled: boolean;
  readonly busy: boolean;
  readonly onHide: () => void;
  readonly onRestore: () => void;
  readonly onCheck: () => void;
}): ReactNode {
  const controls: ReactNode[] = [];
  if (copy.hidden) {
    controls.push(
      createElement(
        "button",
        { type: "button", disabled: !actionsEnabled || busy, onClick: onRestore },
        settingsCopy.restoreCopy,
      ),
    );
  } else if (copy.desiredState === "projected") {
    controls.push(
      createElement(
        "button",
        { type: "button", disabled: !actionsEnabled || busy, onClick: onHide },
        settingsCopy.hideCopy,
      ),
    );
  }
  // Check-now is the recovery action for anything not confirmed; a
  // converged copy needs nothing, so no control implies work.
  if (copy.remoteOutcome !== "confirmed") {
    controls.push(
      createElement(
        "button",
        { type: "button", disabled: !actionsEnabled || busy, onClick: onCheck },
        settingsCopy.checkCopy,
      ),
    );
  }
  return createElement(
    "article",
    null,
    createElement(
      "p",
      null,
      createElement("strong", null, `${settingsCopy.subjectLabel[copy.subjectKind]}: `),
      copy.summary ?? settingsCopy.copyFallbackSummary,
    ),
    createElement("p", { role: "status" }, copyStatusLabel(copy)),
    copy.subjectId === null
      ? null
      : createElement(
          "p",
          null,
          createElement(
            "a",
            { href: subjectHref(copy.subjectKind, copy.subjectId) },
            settingsCopy.openSubject[copy.subjectKind],
          ),
        ),
    controls.length === 0 ? null : createElement("div", { role: "group" }, ...controls),
  );
}
