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
 * The personal project scope is displayed honestly (today: all projects)
 * without a fake edit control: the certified write interface for narrowing
 * it (`calendar.setSelection`, flagged in G2's report) does not exist yet,
 * and a missing shared interface is a named prerequisite, not a UI to fake.
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
  syncNextActions,
  syncStatusLines,
  type CopyRowView,
  type ProjectionOverviewView,
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
  const projectionView: ProjectionOverviewView = projection.data;
  // Without the actor's own connection row there is nothing to operate on;
  // the connection panel above already explains those states. The lean
  // read branches carry only `state`, so the full branch's discriminator
  // is the honest narrowing: `reconnectNeeded` exists on the full branch
  // alone, and the assignment below turns server-side shape drift into a
  // compile error instead of a silently blanked section.
  if (!("reconnectNeeded" in sync.data) || typeof sync.data.reconnectNeeded !== "boolean") {
    return null;
  }
  const overview: SyncOverviewView = sync.data;
  const children: ReactNode[] = [
    createElement(DiagnosticsSection, {
      overview,
      lastPassState: projectionView.sync?.state ?? null,
      suspendedReason: projectionView.sync?.suspendedReason ?? null,
    }),
    createElement(ScopeSection, null),
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
    if (action === "reconnect") {
      children.push(createElement("p", { role: "status" }, settingsCopy.reconnectPointer));
    } else if (action === "check_now") {
      children.push(createElement("p", { role: "status" }, settingsCopy.checkNowHint));
    } else {
      children.push(createElement("p", { role: "note" }, settingsCopy.cleanupResidueNote));
    }
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
// The personal project scope (displayed honestly; the write interface is a
// named prerequisite — no fake edit control, criterion 3's spirit).
// ---------------------------------------------------------------------------

export function ScopeSection(): ReactNode {
  return createElement(
    "section",
    { "aria-labelledby": "calendar-scope-heading" },
    createElement("h2", { id: "calendar-scope-heading" }, settingsCopy.scopeHeading),
    createElement("p", null, settingsCopy.scopeIntro),
    createElement("p", { role: "status" }, settingsCopy.scopeAll),
    createElement("p", null, settingsCopy.scopeEditUnavailable),
    createElement("p", null, settingsCopy.personalFieldsNote),
  );
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
