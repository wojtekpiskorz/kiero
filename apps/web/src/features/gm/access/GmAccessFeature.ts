/**
 * The barebones GM access feature (B4): enter/exit GM mode with basis, the
 * audited GM surfaces this issue names — company inspection, account
 * recovery (B2's checked command under the GM actor), company onboarding
 * with first-admin invitation, activation, administrator restoration and
 * ending alpha participation — all through the checked dispatch entries
 * (convex/access/gm/functions.ts).
 *
 * JSX-free on purpose (createElement only): the host feature registry
 * chain is imported by the node test programs, which compile without a JSX
 * flag. No styling, semantic controls only (the UX/UI track owns
 * presentation); the active mode is nevertheless visually unmistakable —
 * a persistent banner heading rendered before every other section.
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
import { useAction, useMutation, useQuery_experimental as useQueryState } from "convex/react";
import { accessOperations, type ResultEnvelope } from "@kiero/contracts";
import { api } from "../../../../../../convex/_generated/api";
import type { GmOverview } from "../../../../../../convex/access/gm/functions";
import { useAppServices } from "../../../app/providers";
import { createConvexClient } from "../../sign-in/client";
import { AuthenticatedGate } from "../../sign-in/SignInGate";
import { signInCopy } from "../../sign-in/state";
import { gmCopy, gmFailureHint } from "./state";

/** One command envelope (the checked dispatch input shape). */
function envelopeOf(operation: string, input: unknown) {
  return { operation, input, expectedRevisions: [] };
}

/** The submit-event surface the handlers consume (preventDefault only). */
interface SubmitEvent {
  preventDefault(): void;
}

/** The result notice every surface shows (server Polish copy or a hint). */
interface Notice {
  readonly kind: "ok" | "error";
  readonly text: string;
}

function describe(result: ResultEnvelope, okText: string): Notice {
  if (result._tag === "error") {
    const hint = gmFailureHint(result.error.code);
    return { kind: "error", text: hint ?? result.error.message };
  }
  return { kind: "ok", text: okText };
}

/** The contract entries whose results the surfaces decode (typed reads). */
const inspectResult = accessOperations["access.gmInspectCompany"].result;
const recoverResult = accessOperations["access.recoverAccount"].result;

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

// ---------------------------------------------------------------------------
// Root: connection gate + auth provider
// ---------------------------------------------------------------------------

/** The feature root: mounted by the host entry at /gm. */
export function GmAccessFeature(): ReactNode {
  const { config } = useAppServices();
  if (config.connection.state === "unconfigured") {
    return createElement("section", null, createElement("h1", null, gmCopy.title), createElement("p", null, gmCopy.connectionUnconfigured));
  }
  if (config.connection.state === "misconfigured") {
    return createElement("section", null, createElement("h1", null, gmCopy.title), createElement("p", null, gmCopy.connectionMisconfigured));
  }
  return createElement(ConvexConnectedRoot, { convexUrl: config.connection.convexUrl });
}

function ConvexConnectedRoot({ convexUrl }: { readonly convexUrl: string }): ReactNode {
  const client = useMemo(() => createConvexClient(convexUrl), [convexUrl]);
  return createElement(ConvexAuthProvider, {
    client,
    children: createElement(GmGate),
  });
}

/** Authentication gate: B1's shared sign-in surface; the operator continues here. */
function GmGate(): ReactNode {
  return createElement(AuthenticatedGate, { continuation: GmSurface });
}

// ---------------------------------------------------------------------------
// The GM surface (query-driven mode state)
// ---------------------------------------------------------------------------

function GmSurface(): ReactNode {
  const overview = useQueryState({
    query: api.access.gm.functions.gmOverview,
    args: {},
  });
  if (overview.status !== "success") {
    return createElement("p", { role: "status" }, gmCopy.checkingState);
  }
  const data = overview.data;
  if (data.state === "anonymous") {
    // Unreachable behind AuthenticatedGate; kept honest for drift.
    return createElement("p", { role: "alert" }, signInCopy.sessionEndedNotice);
  }
  if (data.state === "not_gm") {
    return createElement(EnterSurface, { email: data.email });
  }
  return createElement(ActiveGmSurface, { overview: data });
}

// ---------------------------------------------------------------------------
// Entry: the explicit, reason-carrying act
// ---------------------------------------------------------------------------

function EnterSurface({ email }: { readonly email: string }): ReactNode {
  const enter = useAction(api.access.gm.functions.enterGmMode);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);

  async function enterGm(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const result = await enter({ envelope: envelopeOf("access.enterGmMode", { reason }) });
      setNotice(describe(result, gmCopy.enteredNotice));
    } catch {
      setNotice({ kind: "error", text: signInCopy.failures.network });
    } finally {
      setBusy(false);
    }
  }

  return createElement(
    "section",
    null,
    createElement("h1", null, gmCopy.title),
    createElement("p", null, gmCopy.signedIn(email)),
    createElement("h2", null, gmCopy.notGmHeading),
    createElement("p", null, gmCopy.notGmIntro),
    createElement(NoticeArea, { notice }),
    createElement("form", { onSubmit: (event) => void enterGm(event) },
      textField({
        id: "gm-enter-reason",
        label: gmCopy.reasonLabel,
        value: reason,
        placeholder: gmCopy.reasonPlaceholder,
        onChange: setReason,
      }),
      createElement("button", { type: "submit", disabled: busy }, busy ? gmCopy.enteringGm : gmCopy.enterGm),
    ),
  );
}

// ---------------------------------------------------------------------------
// Active mode: banner + directory + the audited GM operations
// ---------------------------------------------------------------------------

function ActiveGmSurface({ overview }: { readonly overview: Extract<GmOverview, { state: "gm" }> }): ReactNode {
  const dispatch = useMutation(api.access.gm.functions.dispatchGm);
  const onboard = useAction(api.access.gm.functions.gmOnboardCommand);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [inspection, setInspection] = useState<unknown>(null);

  // Inspect form state.
  const [inspectCompanyId, setInspectCompanyId] = useState("");
  const [inspectBasis, setInspectBasis] = useState("");
  // Recovery form state.
  const [recoverUserId, setRecoverUserId] = useState("");
  const [recoverBasis, setRecoverBasis] = useState("");
  // Onboard form state.
  const [onboardName, setOnboardName] = useState("");
  const [onboardTimezone, setOnboardTimezone] = useState("Europe/Warsaw");
  const [onboardCurrency, setOnboardCurrency] = useState("PLN");
  const [onboardEmail, setOnboardEmail] = useState("");
  const [onboardBasis, setOnboardBasis] = useState("");
  // Activate form state.
  const [activateCompanyId, setActivateCompanyId] = useState("");
  const [activateBasis, setActivateBasis] = useState("");
  // Restore form state.
  const [restoreCompanyId, setRestoreCompanyId] = useState("");
  const [restoreUserId, setRestoreUserId] = useState("");
  const [restoreBasis, setRestoreBasis] = useState("");
  // End-alpha form state.
  const [endAlphaCompanyId, setEndAlphaCompanyId] = useState("");
  const [endAlphaBasis, setEndAlphaBasis] = useState("");

  async function runDispatch(operation: string, input: unknown, okText: string): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      const result = await dispatch({ envelope: envelopeOf(operation, input) });
      setNotice(describe(result, okText));
    } catch {
      setNotice({ kind: "error", text: signInCopy.failures.network });
    } finally {
      setBusy(false);
    }
  }

  async function exitGm(): Promise<void> {
    if (typeof window !== "undefined" && !window.confirm(gmCopy.exitGmConfirm)) {
      return;
    }
    await runDispatch("access.exitGmMode", { grantId: overview.grantId }, gmCopy.exitedNotice);
  }

  async function inspect(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    setInspection(null);
    try {
      const result = await dispatch({
        envelope: envelopeOf("access.gmInspectCompany", {
          companyId: inspectCompanyId,
          basis: inspectBasis,
        }),
      });
      if (result._tag === "ok") {
        setInspection(Schema.decodeUnknownSync(inspectResult)(result.value));
        setNotice({ kind: "ok", text: gmCopy.enteredNotice });
      } else {
        setNotice(describe(result, ""));
      }
    } catch {
      setNotice({ kind: "error", text: signInCopy.failures.network });
    } finally {
      setBusy(false);
    }
  }

  async function recover(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const result = await dispatch({
        envelope: envelopeOf("access.recoverAccount", {
          userId: recoverUserId,
          verificationBasis: recoverBasis,
        }),
      });
      if (result._tag === "ok") {
        const receipt = Schema.decodeUnknownSync(recoverResult)(result.value);
        setNotice({
          kind: "ok",
          text: gmCopy.recoveredNotice(receipt.revokedSessions, receipt.clearedAccounts),
        });
      } else {
        setNotice(describe(result, ""));
      }
    } catch {
      setNotice({ kind: "error", text: signInCopy.failures.network });
    } finally {
      setBusy(false);
    }
  }

  async function runOnboard(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const result = await onboard({
        envelope: envelopeOf("access.gmOnboardCompany", {
          name: onboardName,
          timezone: onboardTimezone,
          defaultCurrency: onboardCurrency,
          adminEmail: onboardEmail,
          basis: onboardBasis,
        }),
      });
      setNotice(describe(result, gmCopy.onboardedNotice));
    } catch {
      setNotice({ kind: "error", text: signInCopy.failures.network });
    } finally {
      setBusy(false);
    }
  }

  type Inspection = Schema.Schema.Type<typeof inspectResult>;

  function inspectionResult(): ReactNode {
    if (inspection === null) {
      return null;
    }
    const data = inspection as Inspection;
    return createElement(
      "section",
      null,
      createElement("h3", null, gmCopy.inspectResultHeading(data.company.name)),
      createElement("p", null, gmCopy.inspectAdmins(data.activeAdminCount)),
      createElement("h4", null, gmCopy.inspectRunsHeading),
      data.processingRuns.length === 0
        ? createElement("p", null, gmCopy.inspectRunsEmpty)
        : createElement(
            "ul",
            null,
            ...data.processingRuns.map((run) =>
              createElement(
                "li",
                { key: run.runId },
                `${run.kind} — ${run.state} — od ${new Date(run.startedAtMs).toLocaleString("pl-PL")}`,
              ),
            ),
          ),
      createElement("h4", null, gmCopy.inspectJobsHeading),
      data.durableJobs.length === 0
        ? createElement("p", null, gmCopy.inspectJobsEmpty)
        : createElement(
            "ul",
            null,
            ...data.durableJobs.map((job) =>
              createElement(
                "li",
                { key: job.jobId },
                `${job.kind} — ${job.state} — próby ${job.attempts}/${job.maxAttempts}${job.lastErrorKind === null ? "" : ` — błąd ${job.lastErrorKind}`}`,
              ),
            ),
          ),
    );
  }

  return createElement(
    "section",
    null,
    // The unmistakable banner: a persistent strong heading before anything
    // else, present in every GM-mode view.
    createElement(
      "header",
      { role: "banner" },
      createElement("p", null, createElement("strong", null, gmCopy.bannerActive)),
      createElement("p", null, gmCopy.bannerReason(overview.reason)),
      createElement("p", null, gmCopy.bannerSince(overview.enteredAtMs)),
      createElement("p", null, gmCopy.signedIn(overview.email)),
      createElement(
        "p",
        null,
        overview.membershipContext === null
          ? gmCopy.membershipContextNone
          : gmCopy.membershipContextNote(overview.membershipContext.role),
      ),
      createElement("p", null, createElement("button", { type: "button", disabled: busy, onClick: () => void exitGm() }, gmCopy.exitGm)),
    ),
    createElement(NoticeArea, { notice }),
    createElement("h2", null, gmCopy.companiesHeading),
    overview.companies.length === 0
      ? createElement("p", null, gmCopy.companiesEmpty)
      : createElement(
          "ul",
          null,
          ...overview.companies.map((company) =>
            createElement(
              "li",
              { key: company.companyId },
              createElement("p", null, createElement("strong", null, company.name)),
              createElement("p", null, `${company.companyId}`),
              createElement("p", null, gmCopy.companySince(company.activatedAtMs)),
            ),
          ),
        ),
    createElement("h2", null, gmCopy.inspectHeading),
    createElement("p", null, gmCopy.inspectIntro),
    createElement("form", { onSubmit: (event) => void inspect(event) },
      textField({ id: "gm-inspect-company", label: gmCopy.inspectCompanyLabel, value: inspectCompanyId, onChange: setInspectCompanyId }),
      textField({ id: "gm-inspect-basis", label: gmCopy.inspectBasisLabel, value: inspectBasis, onChange: setInspectBasis }),
      createElement("button", { type: "submit", disabled: busy }, busy ? gmCopy.inspecting : gmCopy.inspectSubmit),
    ),
    inspectionResult(),
    createElement("h2", null, gmCopy.recoverHeading),
    createElement("p", null, gmCopy.recoverIntro),
    createElement("form", { onSubmit: (event) => void recover(event) },
      textField({ id: "gm-recover-user", label: gmCopy.recoverUserLabel, value: recoverUserId, onChange: setRecoverUserId }),
      textField({ id: "gm-recover-basis", label: gmCopy.recoverBasisLabel, value: recoverBasis, placeholder: gmCopy.recoverBasisPlaceholder, onChange: setRecoverBasis }),
      createElement("button", { type: "submit", disabled: busy }, busy ? gmCopy.recovering : gmCopy.recoverSubmit),
    ),
    createElement("h2", null, gmCopy.onboardHeading),
    createElement("p", null, gmCopy.onboardIntro),
    createElement("form", { onSubmit: (event) => void runOnboard(event) },
      textField({ id: "gm-onboard-name", label: gmCopy.onboardNameLabel, value: onboardName, onChange: setOnboardName }),
      textField({ id: "gm-onboard-timezone", label: gmCopy.onboardTimezoneLabel, value: onboardTimezone, onChange: setOnboardTimezone }),
      textField({ id: "gm-onboard-currency", label: gmCopy.onboardCurrencyLabel, value: onboardCurrency, onChange: setOnboardCurrency }),
      textField({ id: "gm-onboard-email", label: gmCopy.onboardEmailLabel, value: onboardEmail, onChange: setOnboardEmail }),
      textField({ id: "gm-onboard-basis", label: gmCopy.onboardBasisLabel, value: onboardBasis, onChange: setOnboardBasis }),
      createElement("button", { type: "submit", disabled: busy }, busy ? gmCopy.onboarding : gmCopy.onboardSubmit),
    ),
    createElement("h2", null, gmCopy.activateHeading),
    createElement("p", null, gmCopy.activateIntro),
    createElement("form", { onSubmit: (event) => {
      event.preventDefault();
      void runDispatch("access.gmActivateCompany", { companyId: activateCompanyId, basis: activateBasis }, gmCopy.activatedNotice);
    } },
      textField({ id: "gm-activate-company", label: gmCopy.activateCompanyLabel, value: activateCompanyId, onChange: setActivateCompanyId }),
      textField({ id: "gm-activate-basis", label: gmCopy.activateBasisLabel, value: activateBasis, onChange: setActivateBasis }),
      createElement("button", { type: "submit", disabled: busy }, busy ? gmCopy.activating : gmCopy.activateSubmit),
    ),
    createElement("h2", null, gmCopy.restoreHeading),
    createElement("p", null, gmCopy.restoreIntro),
    createElement("form", { onSubmit: (event) => {
      event.preventDefault();
      void runDispatch("access.gmRestoreAdministrator", { companyId: restoreCompanyId, userId: restoreUserId, basis: restoreBasis }, gmCopy.restoredNotice);
    } },
      textField({ id: "gm-restore-company", label: gmCopy.restoreCompanyLabel, value: restoreCompanyId, onChange: setRestoreCompanyId }),
      textField({ id: "gm-restore-user", label: gmCopy.restoreUserLabel, value: restoreUserId, onChange: setRestoreUserId }),
      textField({ id: "gm-restore-basis", label: gmCopy.restoreBasisLabel, value: restoreBasis, onChange: setRestoreBasis }),
      createElement("button", { type: "submit", disabled: busy }, busy ? gmCopy.restoring : gmCopy.restoreSubmit),
    ),
    createElement("h2", null, gmCopy.endAlphaHeading),
    createElement("p", null, gmCopy.endAlphaIntro),
    createElement("form", { onSubmit: (event) => {
      event.preventDefault();
      if (typeof window !== "undefined" && !window.confirm(gmCopy.endAlphaConfirm)) {
        return;
      }
      void runDispatch("access.gmEndCompanyAlpha", { companyId: endAlphaCompanyId, basis: endAlphaBasis }, gmCopy.endedAlphaNotice);
    } },
      textField({ id: "gm-end-alpha-company", label: gmCopy.endAlphaCompanyLabel, value: endAlphaCompanyId, onChange: setEndAlphaCompanyId }),
      textField({ id: "gm-end-alpha-basis", label: gmCopy.endAlphaBasisLabel, value: endAlphaBasis, onChange: setEndAlphaBasis }),
      createElement("button", { type: "submit", disabled: busy }, busy ? gmCopy.endingAlpha : gmCopy.endAlphaSubmit),
    ),
  );
}
