/**
 * The barebones permanent-deletion feature (I4): the administrator-only
 * impact preview, the explicit confirmation and the pending/complete/failed
 * cleanup status issue #56 registers ("Expose an administrator-only
 * unstyled impact preview and explicit permanent-delete confirmation, with
 * pending/complete/failed external-cleanup state. This is a real
 * registered feature, distinct from ordinary withdrawal").
 *
 * JSX-free on purpose (createElement only): the host feature registry chain
 * is imported by node test programs (the A4/I3 pattern). Every durable
 * change goes through the SAME checked sources dispatch the conversation
 * uses (`sources.purgeSource`, administer intent decided server-side from
 * the CURRENT membership role); the preview and status come from the
 * authenticated administrator-checked queries ("skip" unsubscribes the
 * idle preview). Full deletion UX belongs to the design track.
 */

import { createElement, useMemo, useState, type ReactNode } from "react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { useMutation, useQuery_experimental as useQueryState } from "convex/react";
import { AuthenticatedGate } from "../sign-in/SignInGate";
import { useAppServices } from "../../app/providers";
import { createConvexClient } from "../sign-in/client";
import { api } from "../../../../../convex/_generated/api";
import type { ResultEnvelope } from "@kiero/contracts";
import { deletionCopy as copy, PURGE_CONFIRMATION_PHRASE } from "./state";

/** One command envelope (the checked dispatch input shape). */
function envelopeOf(operation: string, input: unknown) {
  return { operation, input, expectedRevisions: [] };
}

interface ImpactRow {
  readonly sourceId: string;
  readonly lifecycle: "active" | "withdrawn" | "purged";
  readonly attachmentCount: number;
  readonly representationCount: number;
  readonly transcriptCount: number;
  readonly visionOrderCount: number;
  readonly extractionCount: number;
  readonly fragmentCount: number;
  readonly witnessLinkCount: number;
  readonly pendingNotificationCount: number;
  readonly linkedExportCount: number;
}

interface StageRow {
  readonly stageKind: keyof typeof copy.stageLabels;
  readonly state: "pending" | "purged" | "failed";
  readonly attempts: number;
  readonly deadlineAtMs: number;
  readonly lastErrorKind: string | null;
  readonly purgedAtMs: number | null;
}

interface DeletionRow {
  readonly deletionRecordId: string;
  readonly targetSourceId: string;
  readonly createdAtMs: number;
  readonly purgeDeadlineAtMs: number | null;
  readonly stages: readonly StageRow[];
}

function formatTime(ms: number | null): string {
  return ms === null
    ? "-"
    : new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

/** The feature root: mounted by the host entry at /usuwanie-danych. */
export function DataDeletionFeature(): ReactNode {
  const { config } = useAppServices();
  if (config.connection.state !== "configured") {
    return createElement(
      "section",
      null,
      createElement("h1", null, copy.title),
      createElement(
        "p",
        null,
        config.connection.state === "misconfigured"
          ? config.connection.problem
          : "Nie połączono z backendem.",
      ),
    );
  }
  return createElement(ConvexConnectedRoot, { convexUrl: config.connection.convexUrl });
}

function ConvexConnectedRoot({ convexUrl }: { readonly convexUrl: string }): ReactNode {
  const client = useMemo(() => createConvexClient(convexUrl), [convexUrl]);
  return createElement(ConvexAuthProvider, { client, children: createElement(DeletionGate) });
}

function DeletionGate(): ReactNode {
  return createElement(AuthenticatedGate, { continuation: DeletionSurface });
}

function DeletionSurface(): ReactNode {
  const status = useQueryState({ query: api.operations.deletion.functions.deletionsStatus, args: {} });
  // The preview runs only after the administrator names a source ("skip"
  // unsubscribes the idle preview, the extensions-record pattern).
  const [previewId, setPreviewId] = useState<string | null>(null);
  const impact = useQueryState({
    query: api.operations.deletion.functions.deletionImpactFor,
    args: previewId === null ? "skip" : { sourceId: previewId },
  });
  const purge = useMutation(api.sources.accept.commands.acceptSourceCommand);
  const [sourceId, setSourceId] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ readonly kind: "ok" | "error"; readonly text: string } | null>(null);

  if (status.status === "error") {
    return createElement("div", { role: "alert" }, createElement("p", null, copy.sessionEnded));
  }
  if (status.status !== "success") {
    return createElement("p", { role: "status" }, copy.checking);
  }
  const deletions = (status.data as unknown as { deletions: DeletionRow[] }).deletions;

  async function confirmPurge(): Promise<void> {
    setBusy(true);
    try {
      const result: ResultEnvelope = await purge({
        envelope: envelopeOf("sources.purgeSource", {
          sourceId: previewId ?? "",
          confirmation,
        }),
      });
      setNotice(
        result._tag === "ok"
          ? { kind: "ok", text: "Trwałe usunięcie rozpoczęte." }
          : { kind: "error", text: result.error.message },
      );
      if (result._tag === "ok") {
        setConfirmation("");
      }
    } catch {
      setNotice({ kind: "error", text: copy.unexpected });
    }
    setBusy(false);
  }

  const confirmed = confirmation.trim() === PURGE_CONFIRMATION_PHRASE;
  const children: ReactNode[] = [
    createElement("h1", null, copy.title),
    createElement("p", null, copy.intro),
    createElement("p", { role: "note" }, copy.adminNote),
    createElement("label", null, [
      copy.sourceLabel,
      createElement("input", {
        value: sourceId,
        onChange: (event: { target: { value: string } }) => setSourceId(event.target.value),
      }),
    ]),
    createElement(
      "button",
      {
        type: "button",
        disabled: sourceId.trim().length === 0,
        onClick: () => setPreviewId(sourceId.trim()),
      },
      copy.previewButton,
    ),
  ];
  if (impact.status === "error") {
    children.push(createElement("p", { role: "alert" }, copy.sessionEnded));
  } else if (impact.status === "success") {
    const row = (impact.data as unknown as { value?: ImpactRow }).value ?? (impact.data as unknown as ImpactRow);
    if (row !== null && row !== undefined) {
      const impactItems: ReactNode[] = [
        createElement("li", { key: "media" }, `Załączniki: ${row.attachmentCount}, reprezentacje: ${row.representationCount}`),
        createElement("li", { key: "transcripts" }, `Transkrypcje: ${row.transcriptCount}, zlecenia odczytu: ${row.visionOrderCount}, ekstrakcje: ${row.extractionCount}`),
        createElement("li", { key: "fragments" }, `Fragmenty źródła: ${row.fragmentCount}`),
        createElement("li", { key: "findings" }, `Powiązane ustalenia: ${row.witnessLinkCount}`),
        createElement("li", { key: "notifications" }, `Zawiadomienia w toku: ${row.pendingNotificationCount}`),
        createElement("li", { key: "exports" }, `Eksporty z tą wiadomością: ${row.linkedExportCount}`),
      ];
      children.push(createElement("h2", null, copy.previewHeading));
      children.push(createElement("ul", null, ...impactItems));
      if (row.lifecycle !== "purged") {
        children.push(
          createElement("label", null, [
            copy.confirmationLabel,
            createElement("input", {
              value: confirmation,
              onChange: (event: { target: { value: string } }) => setConfirmation(event.target.value),
            }),
          ]),
        );
        children.push(
          createElement(
            "button",
            { type: "button", disabled: !confirmed || busy, onClick: () => void confirmPurge() },
            busy ? copy.purging : copy.purgeButton,
          ),
        );
      } else {
        children.push(createElement("p", { role: "note" }, "Ta wiadomość jest już trwale usunięta."));
      }
    }
  }
  children.push(createElement("h2", null, copy.historyHeading));
  if (deletions.length === 0) {
    children.push(createElement("p", null, copy.empty));
  } else {
    const items: ReactNode[] = deletions.map((row) => {
      const stageItems: ReactNode[] = row.stages.map((stage) =>
        createElement(
          "li",
          { key: stage.stageKind },
          `${copy.stageLabels[stage.stageKind]}: ${
            stage.state === "purged"
              ? copy.stagePurged
              : stage.state === "failed"
                ? copy.stageFailed
                : copy.stagePending
          } (${copy.attemptsLabel}: ${stage.attempts}${
            stage.state === "failed" && stage.lastErrorKind !== null ? `, ${stage.lastErrorKind}` : ""
          })`,
        ),
      );
      return createElement(
        "li",
        { key: row.deletionRecordId },
        createElement("div", { role: "group" }, [
          createElement("span", null, `${formatTime(row.createdAtMs)}`),
          createElement("span", null, `${copy.deadlineLabel}: ${formatTime(row.purgeDeadlineAtMs)}`),
          createElement("ul", null, ...stageItems),
        ]),
      );
    });
    children.push(createElement("ul", null, ...items));
  }
  if (notice !== null) {
    children.push(
      createElement("p", { role: notice.kind === "error" ? "alert" : "status" }, notice.text),
    );
  }
  return createElement("section", null, ...children);
}
