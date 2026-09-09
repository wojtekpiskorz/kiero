/**
 * The shared, JSX-free sign-in walk (B1 surface): card, session bootstrap
 * and the authenticated gate.
 *
 * Why this file exists: the host feature registry chain is compiled by the
 * root node test programs, which run without a JSX flag, so the mounted
 * sign-in surface must be createElement-based. This module IS that
 * surface, and the JSX twin (./SignInFeature.tsx) composes it too — one
 * walk over the exported state machine and copy (./state.ts), never two
 * that age separately. Host features render `AuthenticatedGate` with
 * their own continuation; the standalone root passes its session panel.
 *
 * Behavior is B1's, verbatim: email-code two-step (send code, then code +
 * the same email), Google only when the deployment reports it configured,
 * distinct copy for wrong/expired codes, rate limiting, delivery failures
 * and the method-conflict policy message; then registry provisioning with
 * B1's honest denial views — including the requiresSignIn distinction
 * (only sessions that truly ended offer the sign-in-again path) — before
 * any authenticated continuation renders with the provisioned session id.
 */

import {
  createElement,
  useEffect,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { useAuthActions, useConvexAuth } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import {
  classifySignInError,
  isValidEmail,
  pendingLabel,
  sessionDeniedView,
  signInCopy,
  type SessionDeniedView,
  type SignInFailure,
  type SignInState,
} from "./state";

/** The submit-event surface the handlers consume (preventDefault only). */
interface SubmitEvent {
  preventDefault(): void;
}

/** The sign-in card: email code first, Google when the deployment offers it. */
export function SignInCard(): ReactNode {
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
        createElement("label", { htmlFor: "sign-in-code" }, signInCopy.codeLabel),
        createElement("input", {
          id: "sign-in-code",
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
      createElement("label", { htmlFor: "sign-in-email" }, signInCopy.emailLabel),
      createElement("input", {
        id: "sign-in-email",
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

/**
 * The authentication gate: sign-in card for visitors; for the freshly
 * authenticated, registry provisioning (B1's `ensureSessionRegistry`,
 * idempotent) with honest denial views, then the caller's authenticated
 * continuation. The continuation receives the provisioned session id —
 * B1's standalone root needs it for its device-session panel; host
 * features may ignore it.
 */
export function AuthenticatedGate({ continuation }: {
  readonly continuation: (sessionId: string) => ReactNode;
}): ReactNode {
  const { isAuthenticated, isLoading } = useConvexAuth();
  if (isLoading) {
    return createElement("p", { role: "status" }, signInCopy.verifying);
  }
  if (!isAuthenticated) {
    return createElement(SignInCard);
  }
  return createElement(SessionBootstrap, { continuation });
}

function SessionBootstrap({ continuation }: {
  readonly continuation: (sessionId: string) => ReactNode;
}): ReactNode {
  const ensureSession = useMutation(api.access.identity.functions.ensureSessionRegistry);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [denied, setDenied] = useState<SessionDeniedView | null>(null);
  const { signOut } = useAuthActions();

  useEffect(() => {
    let cancelled = false;
    // No deviceLabel argument: the server applies its own default.
    void ensureSession({})
      .then((result) => {
        if (cancelled) {
          return;
        }
        if (result.state === "live") {
          setSessionId(result.sessionId);
        } else {
          setDenied(sessionDeniedView(result.reason));
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDenied(sessionDeniedView("no_identity"));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ensureSession]);

  if (denied !== null) {
    // B1's distinction, verbatim: only denials whose only sensible next
    // step is signing in again offer the button; registry_missing shows
    // its notice (the bootstrap retries on the next mount) without a
    // sign-out.
    return createElement(
      "div",
      { role: "alert" },
      createElement("p", null, denied.notice),
      denied.requiresSignIn
        ? createElement("button", { type: "button", onClick: () => void signOut() }, signInCopy.signInAgain)
        : null,
    );
  }
  if (sessionId === null) {
    return createElement("p", { role: "status" }, signInCopy.verifying);
  }
  return continuation(sessionId);
}
