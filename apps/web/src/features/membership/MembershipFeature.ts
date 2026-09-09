/**
 * The barebones membership feature (B3): sign-in gate + company admission
 * + member administration, all through the checked dispatch entries
 * (convex/access/membership/functions.ts).
 *
 * JSX-free on purpose (createElement only): the host feature registry
 * chain (app-features composed from the per-feature entry modules) is
 * imported by the root node test programs, which compile without a JSX
 * flag — the same discipline A4's own shell and B1's state module follow.
 * The sign-in leg composes B1's exported state machine and copy
 * (../sign-in/state.ts), so the mounted sign-in cannot drift from B1's
 * product; the authenticated leg is the B3 membership surface.
 *
 * The unauthenticated visitor reaches sign-in here; the authenticated
 * member reaches the membership surface. No styling, semantic controls
 * only (the UX/UI track owns presentation).
 */

import {
  createElement,
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { ConvexAuthProvider, useAuthActions, useConvexAuth } from "@convex-dev/auth/react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import type {
  CompanyInvitationView,
  MembershipOverview,
  MemberView,
  PendingInvitationView,
} from "../../../../../convex/access/membership/functions";
import { useAppServices } from "../../app/providers";
import { createConvexClient } from "../sign-in/client";
import {
  classifySignInError,
  failureHint,
  isValidEmail,
  membershipCopy,
  pendingLabel,
  sessionDeniedView,
  signInCopy,
  type SignInFailure,
  type SignInState,
} from "./state";

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

function describe(result: unknown, okText: string): Notice {
  if (
    typeof result === "object" &&
    result !== null &&
    "_tag" in result &&
    (result as { _tag: string })._tag === "error"
  ) {
    const error = (result as { error?: { code?: string; message?: string } }).error;
    const hint = failureHint(error?.code);
    return { kind: "error", text: hint ?? error?.message ?? signInCopy.failures.unknown };
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

// ---------------------------------------------------------------------------
// Root: connection gate + auth provider
// ---------------------------------------------------------------------------

/** The feature root: mounted by the host entry at /firma. */
export function MembershipFeature(): ReactNode {
  const { config } = useAppServices();
  if (config.connection.state === "unconfigured") {
    return createElement("section", null, createElement("h1", null, membershipCopy.title), createElement("p", null, membershipCopy.connectionUnconfigured));
  }
  if (config.connection.state === "misconfigured") {
    return createElement("section", null, createElement("h1", null, membershipCopy.title), createElement("p", null, membershipCopy.connectionMisconfigured));
  }
  return createElement(ConvexConnectedRoot, { convexUrl: config.connection.convexUrl });
}

function ConvexConnectedRoot({ convexUrl }: { readonly convexUrl: string }): ReactNode {
  const client = useMemo(() => createConvexClient(convexUrl), [convexUrl]);
  return createElement(ConvexAuthProvider, {
    client,
    children: createElement(MembershipGate),
  });
}

/** Authentication gate: sign-in for visitors, bootstrap + surface for members. */
function MembershipGate(): ReactNode {
  const { isAuthenticated, isLoading } = useConvexAuth();
  if (isLoading) {
    return createElement("section", null, createElement("h1", null, membershipCopy.title), createElement("p", { role: "status" }, membershipCopy.checkingSession));
  }
  if (!isAuthenticated) {
    return createElement(SignInCard);
  }
  return createElement(SessionBootstrap);
}

// ---------------------------------------------------------------------------
// Sign-in leg (B1's state machine and copy, JSX-free markup)
// ---------------------------------------------------------------------------

/** The sign-in card: email code first, Google when the deployment offers it. */
function SignInCard(): ReactNode {
  const { signIn } = useAuthActions();
  const availability = useQuery(api.access.identity.functions.providerAvailability, {});
  const [state, setState] = useState<SignInState>({ step: "choose" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [failure, setFailure] = useState<SignInFailure | null>(null);

  const googleAvailable = availability?.google === true;
  const pending = pendingLabel(state);

  async function requestCode(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (!isValidEmail(email)) {
      setFailure("invalid_email");
      return;
    }
    setState({ step: "submitting-email" });
    setFailure(null);
    try {
      await signIn("email_code", { email });
      setCode("");
      setState({ step: "code-sent", email });
    } catch (error) {
      setFailure(classifySignInError(error));
      setState({ step: "choose" });
    }
  }

  async function verifyCode(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    if (state.step !== "code-sent") {
      return;
    }
    setState({ step: "submitting-code", email: state.email });
    setFailure(null);
    try {
      await signIn("email_code", { email: state.email, code });
    } catch (error) {
      setFailure(classifySignInError(error));
      setState({ step: "code-sent", email: state.email });
    }
  }

  async function resendCode(): Promise<void> {
    if (state.step !== "code-sent" && state.step !== "submitting-code") {
      return;
    }
    const resendEmail = state.email;
    setState({ step: "submitting-email" });
    setFailure(null);
    try {
      await signIn("email_code", { email: resendEmail });
      setCode("");
      setState({ step: "code-sent", email: resendEmail });
    } catch (error) {
      setFailure(classifySignInError(error));
      setState({ step: "code-sent", email: resendEmail });
    }
  }

  function startGoogle(): void {
    setState({ step: "google-pending" });
    setFailure(null);
    void signIn("google").catch((error: unknown) => {
      setFailure(classifySignInError(error));
      setState({ step: "choose" });
    });
  }

  if (state.step === "code-sent" || state.step === "submitting-code") {
    return createElement(
      "section",
      null,
      createElement("h1", null, signInCopy.title),
      createElement("form", { onSubmit: (event) => void verifyCode(event) },
        createElement("p", null, signInCopy.codeSentNotice(state.email)),
        createElement("label", { htmlFor: "membership-invite-signin-code" }, signInCopy.codeLabel),
        createElement("input", {
          id: "membership-invite-signin-code",
          type: "text",
          inputMode: "numeric",
          autoComplete: "one-time-code",
          placeholder: signInCopy.codePlaceholder,
          value: code,
          onChange: (event: ChangeEvent<HTMLInputElement>) => setCode(event.target.value),
          required: true,
        }),
        createElement("button", { type: "submit", disabled: pending !== null }, pending ?? signInCopy.verify),
        createElement("button", {
          type: "button",
          disabled: pending !== null,
          onClick: () => {
            setState({ step: "choose" });
            setCode("");
            setFailure(null);
          },
        }, signInCopy.changeEmail),
        failure === "code_wrong_or_expired"
          ? createElement("button", { type: "button", disabled: pending !== null, onClick: () => void resendCode() }, signInCopy.resendCode)
          : null,
        failure !== null ? createElement("p", { role: "alert" }, signInCopy.failures[failure]) : null,
      ),
    );
  }

  return createElement(
    "section",
    null,
    createElement("h1", null, signInCopy.title),
    createElement("p", null, signInCopy.intro),
    createElement("form", { onSubmit: (event) => void requestCode(event) },
      createElement("label", { htmlFor: "membership-sign-in-email" }, signInCopy.emailLabel),
      createElement("input", {
        id: "membership-sign-in-email",
        type: "email",
        autoComplete: "email",
        placeholder: signInCopy.emailPlaceholder,
        value: email,
        onChange: (event: ChangeEvent<HTMLInputElement>) => setEmail(event.target.value),
        required: true,
      }),
      createElement("button", { type: "submit", disabled: pending !== null }, pending ?? signInCopy.sendCode),
      failure !== null ? createElement("p", { role: "alert" }, signInCopy.failures[failure]) : null,
      googleAvailable
        ? createElement("button", { type: "button", disabled: pending !== null, onClick: startGoogle }, pending ?? signInCopy.googleButton)
        : createElement("p", null, signInCopy.googleUnavailable),
    ),
  );
}

// ---------------------------------------------------------------------------
// Session bootstrap (B1's registry provisioning, then the membership read)
// ---------------------------------------------------------------------------

function SessionBootstrap(): ReactNode {
  const ensureSession = useMutation(api.access.identity.functions.ensureSessionRegistry);
  const [ready, setReady] = useState(false);
  const [deniedNotice, setDeniedNotice] = useState<string | null>(null);
  const { signOut } = useAuthActions();

  useEffect(() => {
    let cancelled = false;
    void ensureSession({})
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result.state === "live") {
          setReady(true);
        } else {
          setDeniedNotice(sessionDeniedView(result.reason).notice);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDeniedNotice(sessionDeniedView("no_identity").notice);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ensureSession]);

  if (deniedNotice !== null) {
    return createElement(
      "section",
      null,
      createElement("p", { role: "alert" }, deniedNotice),
      createElement("button", { type: "button", onClick: () => void signOut() }, signInCopy.signInAgain),
    );
  }
  if (!ready) {
    return createElement("p", { role: "status" }, membershipCopy.verifyingSession);
  }
  return createElement(MembershipSurface);
}

// ---------------------------------------------------------------------------
// The membership surface (query-driven)
// ---------------------------------------------------------------------------

function MembershipSurface(): ReactNode {
  const overview = useQuery(api.access.membership.functions.membershipOverview, {});
  if (overview === undefined) {
    return createElement("p", { role: "status" }, membershipCopy.checkingSession);
  }
  if (overview.state === "no_company") {
    return createElement(AdmissionSurface, { overview });
  }
  return createElement(CompanySurface, { overview });
}

// ---------------------------------------------------------------------------
// Admission: pending invitations + first-company creation
// ---------------------------------------------------------------------------

function AdmissionSurface({ overview }: { readonly overview: Extract<MembershipOverview, { state: "no_company" }> }): ReactNode {
  const admit = useMutation(api.access.membership.functions.admitCommand);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [codeById, setCodeById] = useState<Record<string, string>>({});
  const [name, setName] = useState("");
  const [timezone, setTimezone] = useState("Europe/Warsaw");
  const [currency, setCurrency] = useState("PLN");

  async function run(operation: string, input: unknown, okText: string): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      const result = await admit({ envelope: envelopeOf(operation, input) });
      setNotice(describe(result, okText));
    } catch {
      setNotice({ kind: "error", text: signInCopy.failures.network });
    } finally {
      setBusy(false);
    }
  }

  async function accept(invitation: PendingInvitationView): Promise<void> {
    const code = codeById[invitation.invitationId] ?? "";
    await run(
      "access.acceptInvitation",
      { invitationId: invitation.invitationId, verificationCode: code },
      "Zaproszenie przyjęte. Należysz teraz do firmy.",
    );
  }

  async function reject(invitation: PendingInvitationView): Promise<void> {
    await run("access.rejectInvitation", { invitationId: invitation.invitationId }, "Zaproszenie odrzucone.");
  }

  async function createCompany(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    await run(
      "access.createCompany",
      { name, timezone, defaultCurrency: currency },
      "Firma założona. Jesteś jej pierwszym administratorem.",
    );
  }

  return createElement(
    "section",
    null,
    createElement("h1", null, membershipCopy.title),
    createElement("p", null, membershipCopy.signedInAs(overview.email)),
    createElement("h2", null, membershipCopy.noCompanyHeading),
    createElement("p", null, membershipCopy.noCompanyIntro),
    createElement(NoticeArea, { notice }),
    createElement("h3", null, membershipCopy.pendingInvitationsHeading),
    overview.pendingInvitations.length === 0
      ? createElement("p", null, membershipCopy.noPendingInvitations)
      : createElement(
          "ul",
          null,
          ...overview.pendingInvitations.map((invitation) =>
            createElement(
              "li",
              { key: invitation.invitationId },
              createElement("p", null, createElement("strong", null, membershipCopy.invitationFor(invitation.companyName))),
              createElement("p", null, membershipCopy.invitationRole[invitation.role]),
              createElement("p", null, membershipCopy.invitationValidUntil(invitation.expiresAtMs)),
              createElement("form", {
                onSubmit: (event) => {
                  event.preventDefault();
                  void accept(invitation);
                },
              },
                createElement("label", { htmlFor: `invitation-code-${invitation.invitationId}` }, membershipCopy.invitationCodeLabel),
                createElement("input", {
                  id: `invitation-code-${invitation.invitationId}`,
                  type: "text",
                  inputMode: "numeric",
                  placeholder: membershipCopy.invitationCodePlaceholder,
                  value: codeById[invitation.invitationId] ?? "",
                  onChange: (event: ChangeEvent<HTMLInputElement>) =>
                    setCodeById((current) => ({
                      ...current,
                      [invitation.invitationId]: event.target.value,
                    })),
                  required: true,
                }),
                createElement("button", { type: "submit", disabled: busy }, membershipCopy.acceptInvitation),
              ),
              createElement("p", null, createElement("button", {
                type: "button",
                disabled: busy,
                onClick: () => void reject(invitation),
              }, membershipCopy.rejectInvitation)),
            ),
          ),
        ),
    createElement("h3", null, membershipCopy.createCompanyHeading),
    createElement("p", null, membershipCopy.createCompanyIntro),
    createElement("form", { onSubmit: (event) => void createCompany(event) },
      createElement("label", { htmlFor: "create-company-name" }, membershipCopy.companyNameLabel),
      createElement("input", {
        id: "create-company-name",
        type: "text",
        placeholder: membershipCopy.companyNamePlaceholder,
        value: name,
        onChange: (event: ChangeEvent<HTMLInputElement>) => setName(event.target.value),
        required: true,
      }),
      createElement("label", { htmlFor: "create-company-timezone" }, membershipCopy.companyTimezoneLabel),
      createElement("input", {
        id: "create-company-timezone",
        type: "text",
        value: timezone,
        onChange: (event: ChangeEvent<HTMLInputElement>) => setTimezone(event.target.value),
        required: true,
      }),
      createElement("label", { htmlFor: "create-company-currency" }, membershipCopy.companyCurrencyLabel),
      createElement("input", {
        id: "create-company-currency",
        type: "text",
        value: currency,
        onChange: (event: ChangeEvent<HTMLInputElement>) => setCurrency(event.target.value),
        required: true,
      }),
      createElement("button", { type: "submit", disabled: busy }, busy ? membershipCopy.creatingCompany : membershipCopy.createCompany),
    ),
  );
}

// ---------------------------------------------------------------------------
// The company surface: members, roles, transfer, invitations, leaving
// ---------------------------------------------------------------------------

function CompanySurface({ overview }: { readonly overview: Extract<MembershipOverview, { state: "member" }> }): ReactNode {
  const dispatch = useMutation(api.access.membership.functions.dispatchMembership);
  const invite = useAction(api.access.membership.functions.createInvitationCommand);
  const { signOut } = useAuthActions();
  const [notice, setNotice] = useState<Notice | null>(null);
  const [busy, setBusy] = useState(false);
  const [roleDrafts, setRoleDrafts] = useState<Record<string, string>>({});
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState<"admin" | "member">("member");
  const isAdmin = overview.myRole === "admin";

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

  async function runInvite(event: SubmitEvent): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setNotice(null);
    try {
      const result = await invite({
        envelope: envelopeOf("access.createInvitation", { email: inviteEmail, role: inviteRole }),
      });
      setNotice(describe(result, "Zaproszenie utworzone. Kod zaproszenia wysłaliśmy na podany adres."));
    } catch {
      setNotice({ kind: "error", text: signInCopy.failures.network });
    } finally {
      setBusy(false);
    }
  }

  function confirmOr(confirmation: string): boolean {
    return typeof window === "undefined" ? true : window.confirm(confirmation);
  }

  function memberRow(member: MemberView): ReactNode {
    const draft = roleDrafts[member.membershipId] ?? member.role;
    return createElement(
      "li",
      { key: member.membershipId },
      createElement("p", null, createElement("strong", null, member.displayName), member.isSelf ? ` ${membershipCopy.memberYou}` : "", ` — ${member.email}`),
      createElement("p", null, membershipCopy.invitationRole[member.role]),
      isAdmin
        ? createElement(
            "form",
            {
              onSubmit: (event) => {
                event.preventDefault();
                void runDispatch(
                  "access.changeMembershipRole",
                  { membershipId: member.membershipId, role: draft },
                  "Rola zmieniona.",
                );
              },
            },
            createElement("label", { htmlFor: `role-${member.membershipId}` }, membershipCopy.memberRoleLabel),
            createElement("select", {
              id: `role-${member.membershipId}`,
              value: draft,
              onChange: (event: ChangeEvent<HTMLSelectElement>) =>
                setRoleDrafts((current) => ({ ...current, [member.membershipId]: event.target.value })),
            },
              createElement("option", { value: "member" }, "member"),
              createElement("option", { value: "admin" }, "admin"),
            ),
            createElement("button", { type: "submit", disabled: busy }, membershipCopy.changeRole),
          )
        : null,
      isAdmin && !member.isSelf
        ? createElement("p", null,
            createElement("button", {
              type: "button",
              disabled: busy,
              onClick: () => {
                if (confirmOr(membershipCopy.transferAdminConfirm)) {
                  void runDispatch("access.transferAdministration", { toUserId: member.userId }, "Administracja przekazana.");
                }
              },
            }, membershipCopy.transferAdmin),
            " ",
            createElement("button", {
              type: "button",
              disabled: busy,
              onClick: () => {
                if (confirmOr(membershipCopy.revokeMemberConfirm)) {
                  void runDispatch("access.revokeMembership", { membershipId: member.membershipId }, "Dostęp odebrany.");
                }
              },
            }, membershipCopy.revokeMember),
          )
        : null,
      member.isSelf
        ? createElement("p", null,
            createElement("button", {
              type: "button",
              disabled: busy,
              onClick: () => {
                if (confirmOr(membershipCopy.leaveCompanyConfirm)) {
                  void runDispatch("access.revokeMembership", { membershipId: member.membershipId }, "Opuściłeś firmę.");
                }
              },
            }, membershipCopy.leaveCompany),
            " ",
            createElement("button", { type: "button", onClick: () => void signOut() }, membershipCopy.signOut),
          )
        : null,
    );
  }

  function invitationRow(invitation: CompanyInvitationView): ReactNode {
    return createElement(
      "li",
      { key: invitation.invitationId },
      createElement("p", null, createElement("strong", null, invitation.email), ` — ${membershipCopy.invitationRole[invitation.role]}`),
      createElement("p", null, `${membershipCopy.invitationState[invitation.state]}. ${membershipCopy.invitationValidUntil(invitation.expiresAtMs)}`),
      invitation.state === "pending"
        ? createElement("button", {
            type: "button",
            disabled: busy,
            onClick: () =>
              void runDispatch("access.revokeInvitation", { invitationId: invitation.invitationId }, "Zaproszenie cofnięte."),
          }, membershipCopy.revokeInvitation)
        : null,
    );
  }

  return createElement(
    "section",
    null,
    createElement("h1", null, membershipCopy.companyHeading(overview.company.name)),
    createElement("p", null, membershipCopy.companyMeta(overview.company.timezone, overview.company.defaultCurrency)),
    createElement("p", null, membershipCopy.yourRole[overview.myRole]),
    createElement(NoticeArea, { notice }),
    createElement("h2", null, membershipCopy.membersHeading),
    createElement("ul", null, ...overview.members.map(memberRow)),
    isAdmin && overview.invitations !== null
      ? createElement("div", null,
          createElement("h2", null, membershipCopy.invitationsHeading),
          createElement("p", null, membershipCopy.invitationsAdminNote),
          createElement("form", { onSubmit: (event) => void runInvite(event) },
            createElement("label", { htmlFor: "invite-email" }, membershipCopy.inviteEmailLabel),
            createElement("input", {
              id: "invite-email",
              type: "email",
              placeholder: membershipCopy.inviteEmailPlaceholder,
              value: inviteEmail,
              onChange: (event: ChangeEvent<HTMLInputElement>) => setInviteEmail(event.target.value),
              required: true,
            }),
            createElement("label", { htmlFor: "invite-role" }, membershipCopy.inviteRoleLabel),
            createElement("select", {
              id: "invite-role",
              value: inviteRole,
              onChange: (event: ChangeEvent<HTMLSelectElement>) => setInviteRole(event.target.value === "admin" ? "admin" : "member"),
            },
              createElement("option", { value: "member" }, "member"),
              createElement("option", { value: "admin" }, "admin"),
            ),
            createElement("button", { type: "submit", disabled: busy }, busy ? membershipCopy.inviting : membershipCopy.invite),
          ),
          overview.invitations.length === 0
            ? createElement("p", null, membershipCopy.noInvitations)
            : createElement("ul", null, ...overview.invitations.map(invitationRow)),
        )
      : null,
  );
}
