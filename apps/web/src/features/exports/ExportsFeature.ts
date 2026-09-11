/**
 * The barebones firm-export feature (I3): the Polish status/download screen
 * issue #55 registers through A4 ("Register a simple Polish status/download
 * screen through A4; defer shared full composition to J").
 *
 * JSX-free on purpose (createElement only): the host feature registry chain
 * is imported by node test programs (the A4/B3/F3 pattern). Every durable
 * change goes through the checked dispatch (`operations.requestExport`,
 * admin-only server-side); the status comes from the authenticated
 * `exportsStatus` query; the download button fetches the gateway route with
 * the signed-in person's own credential (a plain link cannot carry it) and
 * saves the answered bytes locally. Full export UX belongs to the design
 * track.
 */

import { createElement, useMemo, useState, type ReactNode } from "react";
import { ConvexAuthProvider, useAuthToken } from "@convex-dev/auth/react";
import { useMutation, useQuery_experimental as useQueryState } from "convex/react";
import { AuthenticatedGate } from "../sign-in/SignInGate";
import { useAppServices } from "../../app/providers";
import { createConvexClient } from "../sign-in/client";
import { api } from "../../../../../convex/_generated/api";
import type { ResultEnvelope } from "@kiero/contracts";
import { exportsCopy as copy } from "./state";

/** One command envelope (the checked dispatch input shape). */
function envelopeOf(operation: string, input: unknown) {
  return { operation, input, expectedRevisions: [] };
}

/** The feature root: mounted by the host entry at /eksport. */
export function ExportsFeature(): ReactNode {
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
  return createElement(ConvexAuthProvider, { client, children: createElement(ExportsGate) });
}

function ExportsGate(): ReactNode {
  return createElement(AuthenticatedGate, { continuation: ExportsSurface });
}

interface StatusRow {
  readonly exportId: string;
  readonly state: string;
  readonly stateRaw: string;
  readonly createdAtMs: number;
  readonly snapshotAtMs: number | null;
  readonly availableUntilMs: number | null;
  readonly completedAtMs: number | null;
  readonly failureKind: string | null;
  readonly invalidationReason: string | null;
  readonly cleanedAtMs: number | null;
  readonly sourceCount: number | null;
  readonly mediaCount: number | null;
}

function formatTime(ms: number | null): string {
  return ms === null
    ? "-"
    : new Date(ms).toISOString().replace("T", " ").slice(0, 16) + " UTC";
}

function ExportsSurface(): ReactNode {
  const state = useQueryState({ query: api.operations.exports.functions.exportsStatus, args: {} });
  const dispatch = useMutation(api.operations.exports.functions.dispatchExports);
  const token = useAuthToken();
  const { config } = useAppServices();
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ readonly kind: "ok" | "error"; readonly text: string } | null>(null);
  const [downloading, setDownloading] = useState<string | null>(null);

  if (state.status === "error") {
    return createElement("div", { role: "alert" }, createElement("p", null, copy.sessionEnded));
  }
  if (state.status !== "success") {
    return createElement("p", { role: "status" }, copy.checking);
  }
  const rows = (state.data as unknown as { exports: StatusRow[] }).exports;

  async function requestExport(): Promise<void> {
    setBusy(true);
    try {
      const result: ResultEnvelope = await dispatch({
        envelope: envelopeOf("operations.requestExport", {}),
      });
      setNotice(
        result._tag === "ok"
          ? { kind: "ok", text: "Zlecono przygotowanie eksportu." }
          : { kind: "error", text: result.error.message },
      );
    } catch {
      setNotice({ kind: "error", text: copy.unexpected });
    }
    setBusy(false);
  }

  async function download(row: StatusRow): Promise<void> {
    const gatewayUrl = config.gateway.state === "configured" ? config.gateway.gatewayUrl : null;
    if (token === null || gatewayUrl === null) {
      setNotice({ kind: "error", text: copy.gatewayMissing });
      return;
    }
    setDownloading(row.exportId);
    try {
      const response = await fetch(`${config.gateway.state === "configured" ? config.gateway.gatewayUrl : null}/exports/${row.exportId}/download`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (response.status !== 200 && response.status !== 206) {
        let message: string = copy.unexpected;
        try {
          const body = (await response.json()) as ResultEnvelope;
          if (body._tag === "error") {
            message = body.error.message;
          }
        } catch {
          // keep the generic message
        }
        setNotice({ kind: "error", text: message });
        setDownloading(null);
        return;
      }
      const blob = await response.blob();
      const disposition = response.headers.get("content-disposition") ?? "";
      const match = /filename="([^"]+)"/.exec(disposition);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = match?.[1] ?? "kiero-eksport.zip";
      anchor.click();
      URL.revokeObjectURL(url);
      setNotice({ kind: "ok", text: "Pobrano archiwum." });
    } catch {
      setNotice({ kind: "error", text: copy.unexpected });
    }
    setDownloading(null);
  }

  const children: ReactNode[] = [
    createElement("h1", null, copy.title),
    createElement("p", null, copy.intro),
    createElement("p", { role: "note" }, copy.adminNote),
    createElement(
      "button",
      { type: "button", disabled: busy, onClick: () => void requestExport() },
      busy ? copy.requesting : copy.requestButton,
    ),
    createElement("h2", null, copy.historyHeading),
  ];
  if (rows.length === 0) {
    children.push(createElement("p", null, copy.empty));
  } else {
    const items: ReactNode[] = rows.map((row) => {
      const cells: ReactNode[] = [
        createElement("strong", null, row.state),
        createElement("span", null, `${copy.snapshotLabel}: ${formatTime(row.snapshotAtMs ?? row.createdAtMs)}`),
      ];
      if (row.stateRaw === "available") {
        cells.push(createElement("span", null, `${copy.availableUntil}: ${formatTime(row.availableUntilMs)}`));
      }
      if (row.sourceCount !== null) {
        cells.push(createElement("span", null, copy.sourcesCount(row.sourceCount)));
      }
      if (row.mediaCount !== null) {
        cells.push(createElement("span", null, copy.mediaCount(row.mediaCount)));
      }
      if (row.stateRaw === "failed") {
        cells.push(createElement("span", { role: "note" }, copy.failureNote));
      }
      if (row.stateRaw === "invalidated") {
        cells.push(createElement("span", { role: "note" }, copy.invalidationNote));
      }
      if (row.cleanedAtMs !== null) {
        cells.push(createElement("span", { role: "note" }, copy.cleanedNote));
      }
      cells.push(
        createElement(
          "button",
          {
            type: "button",
            disabled: row.stateRaw !== "available" || downloading !== null || config.gateway.state !== "configured",
            onClick: () => void download(row),
          },
          downloading === row.exportId ? copy.downloading : copy.downloadButton,
        ),
      );
      return createElement(
        "li",
        { key: row.exportId },
        createElement("div", { role: "group" }, ...cells),
      );
    });
    children.push(createElement("ul", null, ...items));
  }
  if (config.gateway.state === "configured" ? config.gateway.gatewayUrl : null === null) {
    children.push(createElement("p", { role: "note" }, copy.gatewayMissing));
  }
  if (notice !== null) {
    children.push(
      createElement("p", { role: notice.kind === "error" ? "alert" : "status" }, notice.text),
    );
  }
  return createElement("section", null, ...children);
}
