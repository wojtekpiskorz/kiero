/**
 * The shared, JSX-free sign-in card and session bootstrap (B1 surface).
 *
 * Why this file exists: host-mounted features compose the sign-in product
 * from ONE implementation instead of transcribing it. The JSX original
 * (./SignInFeature.tsx) cannot be imported through the host feature
 * registry chain — that chain is compiled by the root node test programs,
 * which run without a JSX flag — so this module carries the same walk over
 * the same exported state machine and copy (./state.ts) using
 * createElement only. The mounted membership feature (B3,
 * apps/web/src/features/membership) renders `SignInCard` for visitors and
 * `SessionGate` with its authenticated continuation for members.
 *
 * Behavior is B1's, verbatim: email-code two-step (send code, then code +
 * the same email), Google only when the deployment reports it configured,
 * distinct copy for wrong/expired codes, rate limiting, delivery failures
 * and the method-conflict policy message; then registry provisioning with
 * honest denial views before any authenticated surface renders.
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
 * continuation. Host features pass their own surface as `continuation`.
 */
export function AuthenticatedGate({ continuation }: {
  readonly continuation: () => ReactNode;
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
  readonly continuation: () => ReactNode;
}): ReactNode {
  const ensureSession = useMutation(api.access.identity.functions.ensureSessionRegistry);
  const [ready, setReady] = useState(false);
  const [deniedNotice, setDeniedNotice] = useState<string | null>(null);
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
    return createElement("p", { role: "status" }, signInCopy.verifying);
  }
  return createElement(continuation);
}
