/**
 * The barebones GM processing feature (H4): the audited processing
 * inspector and the GM retry controls; inspection of one processing run
 * (canonical stages, attempts with the approved model route, versions,
 * derived changes, I2 redacted diagnostics, derived blockers), failed-stage
 * retry that preserves run identity, and deliberate reanalysis as a linked
 * new run; all through the checked dispatch entry
 * (convex/operations/processing/functions.ts) under B4's explicit GM mode.
 *
 * JSX-free on purpose (createElement only): the host feature registry
 * chain is imported by the node test programs, which compile without a JSX
 * flag. No styling, semantic controls only (the UX/UI track owns
 * presentation); the active GM mode is visually unmistakable; a persistent
 * banner heading rendered before every other section (B4's banner copy).
 *
 * This surface deliberately issues NO source-read marking and NO usage
 * mutation: inspection changes boss authorship, read state and alpha
 * metrics not at all.
 */

import {
  createElement,
  useMemo,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { Schema } from "effect";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { useMutation, useQuery_experimental as useQueryState } from "convex/react";
import { Link } from "@tanstack/react-router";
import { operationsOperations, type ResultEnvelope } from "@kiero/contracts";
import { api } from "../../../../../../convex/_generated/api";
import type { GmOverview } from "../../../../../../convex/access/gm/functions";
import { useAppServices } from "../../../app/providers";
import { createConvexClient } from "../../sign-in/client";
import { AuthenticatedGate } from "../../sign-in/SignInGate";
import { signInCopy } from "../../sign-in/state";
import {
  SessionEnded,
  envelopeOf,
  type Notice,
  type SubmitEvent,
} from "../../company/CompanyGate";
import { gmCopy } from "../access/state";
import { gmProcessingCopy, gmProcessingFailureHint } from "./state";

/** The contract entries whose results the surface decodes (typed reads). */
const inspectResult = operationsOperations["operations.inspectProcessingRun"].result;
const retryResult = operationsOperations["operations.retryProcessingStep"].result;
const reanalysisResult = operationsOperations["operations.requestReanalysis"].result;

/** The decoded inspection result the active surface renders. */
type InspectionResult = Schema.Schema.Type<typeof inspectResult>;

function describe(result: ResultEnvelope, okText: string): Notice {
  if (result._tag === "error") {
    const hint = gmProcessingFailureHint(result.error.code);
    return { kind: "error", text: hint ?? result.error.message };
  }
  return { kind: "ok", text: okText };
}

function NoticeArea({ notice }: { notice: Notice | null }): ReactNode {
  if (notice === null) {
    return null;
  }
  return createElement(
    "p",
    { role: notice.kind === "error" ? "alert" : "status" },
    notice.text,
  );
}

/** A labeled text input (the barebones form atom this feature repeats). */
function textField(args: {
  readonly id: string;
  readonly label: string;
  readonly value: string;
  readonly placeholder?: string;
  readonly onChange: (value: string) => void;
}): ReactNode {
  return createElement(
    "p",
    null,
    createElement("label", { htmlFor: args.id }, args.label),
    createElement("input", {
      id: args.id,
      type: "text",
      value: args.value,
      ...(args.placeholder === undefined ? {} : { placeholder: args.placeholder }),
      onChange: (event: ChangeEvent<HTMLInputElement>) => args.onChange(event.target.value),
      required: true,
    }),
  );
}

/** One definition-list row (the barebones fact atom). */
function fact(term: string, detail: string): ReactNode {
  return createElement("div", null, createElement("dt", null, term), createElement("dd", null, detail));
}

// ---------------------------------------------------------------------------
// Root: connection gate + auth provider
// ---------------------------------------------------------------------------

/** The feature root: mounted by the host entry at /gm-przetwarzanie. */
export function GmProcessingFeature(): ReactNode {
  const { config } = useAppServices();
  if (config.connection.state === "unconfigured") {
    return createElement(
      "section",
      null,
      createElement("h1", null, gmProcessingCopy.title),
      createElement("p", null, gmProcessingCopy.connectionUnconfigured),
    );
  }
  if (config.connection.state === "misconfigured") {
    return createElement(
      "section",
      null,
      createElement("h1", null, gmProcessingCopy.title),
      createElement("p", null, gmProcessingCopy.connectionMisconfigured),
    );
  }
  return createElement(ConvexConnectedRoot, { convexUrl: config.connection.convexUrl });
}

function ConvexConnectedRoot({ convexUrl }: { readonly convexUrl: string }): ReactNode {
  const client = useMemo(() => createConvexClient(convexUrl), [convexUrl]);
  return createElement(ConvexAuthProvider, {
    client,
    children: createElement(ProcessingGate),
  });
}

/** Authentication gate: B1's shared sign-in surface; the operator continues here. */
function ProcessingGate(): ReactNode {
  return createElement(AuthenticatedGate, { continuation: GmProcessingSurface });
}

// ---------------------------------------------------------------------------
// The GM processing surface (query-driven mode state)
// ---------------------------------------------------------------------------

function GmProcessingSurface(): ReactNode {
  const overview = useQueryState({
    query: api.access.gm.functions.gmOverview,
    args: {},
  });
  if (overview.status === "error") {
    return createElement(SessionEnded);
  }
  if (overview.status !== "success") {
    return createElement("p", { role: "status" }, gmProcessingCopy.checkingState);
  }
  const data = overview.data;
  if (data.state === "anonymous") {
    // Unreachable behind AuthenticatedGate; kept honest for drift.
    return createElement("p", { role: "alert" }, signInCopy.sessionEndedNotice);
  }
  if (data.state === "not_gm") {
    return createElement(
      "section",
      null,
      createElement("h1", null, gmProcessingCopy.title),
      createElement("p", null, gmCopy.signedIn(data.email)),
      createElement("h2", null, gmProcessingCopy.notGmHeading),
      createElement("p", null, gmProcessingCopy.notGmIntro),
      createElement("p", null, createElement(Link, { to: "/gm" }, gmProcessingCopy.accessPanelLink)),
    );
  }
  return createElement(ActiveGmProcessingSurface, { overview: data });
}

// ---------------------------------------------------------------------------
// Active mode: banner + the three audited operations
// ---------------------------------------------------------------------------

function ActiveGmProcessingSurface({
  overview,
}: {
  readonly overview: Extract<GmOverview, { state: "gm" }>;
}): ReactNode {
  const dispatch = useMutation(api.operations.processing.functions.dispatchGmProcessing);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [inspection, setInspection] = useState<InspectionResult | null>(null);

  // Inspect form state.
  const [inspectRunId, setInspectRunId] = useState("");
  const [inspectBasis, setInspectBasis] = useState("");
  // Retry form state (the expected state mirrors what inspection showed).
  const [retryStepId, setRetryStepId] = useState("");
  const [retryExpectedState, setRetryExpectedState] = useState("failed");
  const [retryBasis, setRetryBasis] = useState("");
  // Reanalysis form state.
  const [reanalysisSourceId, setReanalysisSourceId] = useState("");
  const [reanalysisLatestRun, setReanalysisLatestRun] = useState("");
  const [reanalysisReason, setReanalysisReason] = useState("");

  /**
   * Runs one dispatch call under the shared busy/notice ceremony, returning
   * the envelope (null means the call threw and the network notice is
   * already shown).
   */
  async function runCommand(call: () => Promise<ResultEnvelope>): Promise<ResultEnvelope | null> {
    setBusy(true);
    setNotice(null);
    try {
      return await call();
    } catch {
      setNotice({ kind: "error", text: signInCopy.failures.network });
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function inspect(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setInspection(null);
    const result = await runCommand(() =>
      dispatch({
        envelope: envelopeOf("operations.inspectProcessingRun", {
          processingRunId: inspectRunId,
          basis: inspectBasis,
        }),
      }),
    );
    if (result === null) {
      return;
    }
    if (result._tag === "ok") {
      const decoded = Schema.decodeUnknownSync(inspectResult)(result.value);
      setInspection(decoded);
      setRetryExpectedState(decoded.run.state);
      setNotice({ kind: "ok", text: gmProcessingCopy.inspectNotice });
    } else {
      setNotice(describe(result, ""));
    }
  }

  async function retry(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const result = await runCommand(() =>
      dispatch({
        envelope: envelopeOf("operations.retryProcessingStep", {
          stepId: retryStepId,
          expectedRunState: retryExpectedState,
          basis: retryBasis,
        }),
      }),
    );
    if (result === null) {
      return;
    }
    if (result._tag === "ok") {
      const decoded = Schema.decodeUnknownSync(retryResult)(result.value);
      // Status progression aid: the retried run is one click to re-inspect.
      setInspectRunId(decoded.runId);
      setNotice({ kind: "ok", text: gmProcessingCopy.retryNotice(decoded.runId, decoded.restartedFrom) });
    } else {
      setNotice(describe(result, ""));
    }
  }

  async function reanalyze(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    const result = await runCommand(() =>
      dispatch({
        envelope: envelopeOf("operations.requestReanalysis", {
          sourceId: reanalysisSourceId,
          reason: reanalysisReason,
          expectedLatestRunId: reanalysisLatestRun.trim() === "" ? null : reanalysisLatestRun.trim(),
        }),
      }),
    );
    if (result === null) {
      return;
    }
    if (result._tag === "ok") {
      const decoded = Schema.decodeUnknownSync(reanalysisResult)(result.value);
      setInspectRunId(decoded.processingRunId);
      setNotice({
        kind: "ok",
        text: gmProcessingCopy.reanalysisNotice(decoded.processingRunId, decoded.reanalysisOfRunId),
      });
    } else {
      setNotice(describe(result, ""));
    }
  }

  function inspectionResult(): ReactNode {
    if (inspection === null) {
      return null;
    }
    const data = inspection;
    return createElement(
      "section",
      null,
      createElement("h3", null, `${gmProcessingCopy.resultRunHeading}: ${data.run.runId}`),
      createElement(
        "dl",
        null,
        fact("Rodzaj", gmProcessingCopy.resultRunKind(data.run.kind)),
        fact("Stan", gmProcessingCopy.runStateLabel(data.run.state)),
        fact("Powiązanie", gmProcessingCopy.resultRunLink(data.run.reanalysisOfRunId)),
        fact("Czas", `od ${new Date(data.run.startedAtMs).toLocaleString("pl-PL")}${data.run.finishedAtMs === null ? "" : ` do ${new Date(data.run.finishedAtMs).toLocaleString("pl-PL")}`}`),
        fact("Wersje", gmProcessingCopy.versionsLine(data.run)),
      ),
      createElement("h4", null, gmProcessingCopy.resultSourceHeading),
      createElement(
        "dl",
        null,
        fact("Źródło", data.source.sourceId),
        fact("Autor", data.source.authorUserId),
        fact("Stan", gmProcessingCopy.sourceLine(data.source)),
      ),
      createElement("h4", null, gmProcessingCopy.resultStepsHeading),
      data.steps.length === 0
        ? createElement("p", null, gmProcessingCopy.resultEmpty)
        : createElement(
            "ul",
            null,
            ...data.steps.map((step) =>
              createElement(
                "li",
                { key: step.stepId },
                `${step.stepKind} #${step.sequence}; ${gmProcessingCopy.stepStateLabel(step.state)}; ${step.stepId}`,
              ),
            ),
          ),
      createElement("h4", null, gmProcessingCopy.resultAttemptsHeading),
      data.attempts.length === 0
        ? createElement("p", null, gmProcessingCopy.resultEmpty)
        : createElement(
            "ul",
            null,
            ...data.attempts.map((attempt) =>
              createElement(
                "li",
                { key: `${attempt.stepId}:${attempt.attempt}` },
                `#${attempt.attempt}; ${gmProcessingCopy.attemptOutcomeLabel(attempt.outcome)}${attempt.provider === null ? "" : `; ${attempt.provider}`}${attempt.model === null ? "" : ` / ${attempt.model}`}${attempt.errorKind === null ? "" : `; błąd ${attempt.errorKind}`}`,
              ),
            ),
          ),
      createElement("h4", null, gmProcessingCopy.resultJobsHeading),
      data.jobs.length === 0
        ? createElement("p", null, gmProcessingCopy.resultEmpty)
        : createElement(
            "ul",
            null,
            ...data.jobs.map((job) =>
              createElement(
                "li",
                { key: job.jobId },
                `${job.kind}; ${job.state}; próby ${job.attempts}/${job.maxAttempts}${job.lastErrorKind === null ? "" : `; błąd ${job.lastErrorKind}`}${job.externalOutcome === null ? "" : `; efekt zewnętrzny ${job.externalOutcome}`}`,
              ),
            ),
          ),
      createElement("h4", null, gmProcessingCopy.resultChangesHeading),
      data.derivedChanges.length === 0
        ? createElement("p", null, gmProcessingCopy.resultEmpty)
        : createElement(
            "ul",
            null,
            ...data.derivedChanges.map((change) =>
              createElement(
                "li",
                { key: change.changeSetId },
                `${change.changeSetId}; ${change.state}${change.failedReason === null ? "" : `; ${change.failedReason}`}`,
              ),
            ),
          ),
      createElement("h4", null, gmProcessingCopy.resultDiagnosticsHeading),
      data.diagnostics.length === 0
        ? createElement("p", null, gmProcessingCopy.resultEmpty)
        : createElement(
            "ul",
            null,
            ...data.diagnostics.map((event, index) =>
              createElement(
                "li",
                { key: `${event.atMs}:${index}` },
                `${event.kind}${gmProcessingCopy.diagnosticsRedacted(event.redactionsApplied)}; ${event.metadata.map((entry) => `${entry.key}=${entry.value}`).join(", ")}`,
              ),
            ),
          ),
      createElement("h4", null, gmProcessingCopy.resultBlockersHeading),
      data.blockers.length === 0
        ? createElement("p", null, gmProcessingCopy.resultEmpty)
        : createElement(
            "ul",
            null,
            ...data.blockers.map((blocker, index) =>
              createElement(
                "li",
                { key: `${blocker.code}:${index}` },
                `${blocker.code}${blocker.detail === null ? "" : `; ${blocker.detail}`}`,
              ),
            ),
          ),
    );
  }

  return createElement(
    "section",
    null,
    // The unmistakable banner: B4's GM-mode identification contract.
    createElement(
      "header",
      { role: "banner" },
      createElement("p", null, createElement("strong", null, gmCopy.bannerActive)),
      createElement("p", null, gmCopy.bannerReason(overview.reason)),
      createElement("p", null, gmCopy.bannerSince(overview.enteredAtMs)),
      createElement("p", null, gmProcessingCopy.bannerIntro),
    ),
    createElement(NoticeArea, { notice }),
    createElement("h2", null, gmProcessingCopy.inspectHeading),
    createElement("p", null, gmProcessingCopy.inspectIntro),
    createElement(
      "form",
      { onSubmit: (event) => void inspect(event) },
      textField({
        id: "gm-processing-inspect-run",
        label: gmProcessingCopy.inspectRunLabel,
        value: inspectRunId,
        onChange: setInspectRunId,
      }),
      textField({
        id: "gm-processing-inspect-basis",
        label: gmProcessingCopy.inspectBasisLabel,
        value: inspectBasis,
        onChange: setInspectBasis,
      }),
      createElement("button", { type: "submit", disabled: busy }, busy ? gmProcessingCopy.inspecting : gmProcessingCopy.inspectSubmit),
    ),
    inspectionResult(),
    createElement("h2", null, gmProcessingCopy.retryHeading),
    createElement("p", null, gmProcessingCopy.retryIntro),
    createElement(
      "form",
      { onSubmit: (event) => void retry(event) },
      textField({
        id: "gm-processing-retry-step",
        label: gmProcessingCopy.retryStepLabel,
        value: retryStepId,
        onChange: setRetryStepId,
      }),
      createElement(
        "p",
        null,
        createElement("label", { htmlFor: "gm-processing-retry-expected" }, gmProcessingCopy.retryExpectedStateLabel),
        createElement(
          "select",
          {
            id: "gm-processing-retry-expected",
            value: retryExpectedState,
            onChange: (event: ChangeEvent<HTMLSelectElement>) => setRetryExpectedState(event.target.value),
          },
          ...(["failed", "succeeded", "running", "superseded"] as const).map((state) =>
            createElement("option", { key: state, value: state }, gmProcessingCopy.runStateLabel(state)),
          ),
        ),
      ),
      textField({
        id: "gm-processing-retry-basis",
        label: gmProcessingCopy.retryBasisLabel,
        value: retryBasis,
        onChange: setRetryBasis,
      }),
      createElement("button", { type: "submit", disabled: busy }, gmProcessingCopy.retrySubmit),
    ),
    createElement("h2", null, gmProcessingCopy.reanalysisHeading),
    createElement("p", null, gmProcessingCopy.reanalysisIntro),
    createElement(
      "form",
      { onSubmit: (event) => void reanalyze(event) },
      textField({
        id: "gm-processing-reanalysis-source",
        label: gmProcessingCopy.reanalysisSourceLabel,
        value: reanalysisSourceId,
        onChange: setReanalysisSourceId,
      }),
      textField({
        id: "gm-processing-reanalysis-latest",
        label: gmProcessingCopy.reanalysisLatestRunLabel,
        value: reanalysisLatestRun,
        onChange: setReanalysisLatestRun,
      }),
      textField({
        id: "gm-processing-reanalysis-reason",
        label: gmProcessingCopy.reanalysisReasonLabel,
        value: reanalysisReason,
        onChange: setReanalysisReason,
      }),
      createElement("button", { type: "submit", disabled: busy }, gmProcessingCopy.reanalysisSubmit),
    ),
  );
}
