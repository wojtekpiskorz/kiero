/**
 * The barebones sign-in feature (B1).
 *
 * Semantic controls only — forms, buttons, plain status text, no visual
 * design (the UX/UI track owns that). The screen WALKS the state machine
 * from ./state.ts (`SignInState`): every step and pending label renders
 * from `signInCopy`/`pendingLabel`, never ad-hoc strings. States are
 * honest:
 *
 * - email-code: two steps (send code, then code + the same email), with
 *   distinct copy for wrong/expired codes, rate limiting, delivery
 *   failures and the method-conflict policy message;
 * - Google: shown only when the deployment reports it configured, with
 *   the pending redirect state;
 * - after sign-in: the device-session panel (registry with trusted
 *   activity time, revocation, self-service sign-out).
 */

import { useEffect, useMemo, useState } from "react";
import { ConvexAuthProvider, useAuthActions, useConvexAuth } from "@convex-dev/auth/react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { createConvexClient } from "./client";
import {
  classifySignInError,
  isValidEmail,
  pendingLabel,
  signInCopy,
  type SignInFailure,
  type SignInState,
} from "./state";
import { SessionPanel } from "./SessionPanel";

/** The sign-in form (email code + Google, semantic controls). */
function SignInForm(): React.ReactNode {
  const { signIn } = useAuthActions();
  const availability = useQuery(api.access.identity.functions.providerAvailability, {});
  const [state, setState] = useState<SignInState>({ step: "choose" });
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [failure, setFailure] = useState<SignInFailure | null>(null);

  const googleAvailable = availability?.google === true;
  const pending = pendingLabel(state);

  async function requestCode(event: React.FormEvent<HTMLFormElement>): Promise<void> {
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

  async function verifyCode(event: React.FormEvent<HTMLFormElement>): Promise<void> {
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
    return (
      <form onSubmit={(event) => void verifyCode(event)}>
        <p>{signInCopy.codeSentNotice(state.email)}</p>
        <label htmlFor="sign-in-code">{signInCopy.codeLabel}</label>
        <input
          id="sign-in-code"
          type="text"
          inputMode="numeric"
          autoComplete="one-time-code"
          placeholder={signInCopy.codePlaceholder}
          value={code}
          onChange={(event) => setCode(event.target.value)}
          required
        />
        <button type="submit" disabled={pending !== null}>
          {pending ?? signInCopy.verify}
        </button>
        <button
          type="button"
          disabled={pending !== null}
          onClick={() => {
            setState({ step: "choose" });
            setCode("");
            setFailure(null);
          }}
        >
          {signInCopy.changeEmail}
        </button>
        {failure === "code_wrong_or_expired" && (
          <button type="button" disabled={pending !== null} onClick={() => void resendCode()}>
            {signInCopy.resendCode}
          </button>
        )}
        {failure !== null && <p role="alert">{signInCopy.failures[failure]}</p>}
      </form>
    );
  }

  return (
    <form onSubmit={(event) => void requestCode(event)}>
      <label htmlFor="sign-in-email">{signInCopy.emailLabel}</label>
      <input
        id="sign-in-email"
        type="email"
        autoComplete="email"
        placeholder={signInCopy.emailPlaceholder}
        value={email}
        onChange={(event) => setEmail(event.target.value)}
        required
      />
      <button type="submit" disabled={pending !== null}>
        {pending ?? signInCopy.sendCode}
      </button>
      {failure !== null && <p role="alert">{signInCopy.failures[failure]}</p>}
      {googleAvailable ? (
        <button type="button" disabled={pending !== null} onClick={startGoogle}>
          {pending ?? signInCopy.googleButton}
        </button>
      ) : (
        <p>{signInCopy.googleUnavailable}</p>
      )}
    </form>
  );
}

/** Authenticated shell: bootstrap the session registry, then the panel. */
function AuthenticatedApp(): React.ReactNode {
  const ensureSession = useMutation(api.access.identity.functions.ensureSessionRegistry);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

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
          setError(signInCopy.failures.unknown);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setError(signInCopy.failures.unknown);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [ensureSession]);

  if (error !== null) {
    return <p role="alert">{error}</p>;
  }
  if (sessionId === null) {
    return <p>{signInCopy.verifying}</p>;
  }
  return <SessionPanel sessionId={sessionId} />;
}

/** The feature root: mounted by the app entry at `/`. */
export function SignInFeature(): React.ReactNode {
  const client = useMemo(() => createConvexClient(import.meta.env.VITE_CONVEX_URL), []);
  return (
    <ConvexAuthProvider client={client}>
      <SignInScreen />
    </ConvexAuthProvider>
  );
}

function SignInScreen(): React.ReactNode {
  const { isAuthenticated, isLoading } = useConvexAuth();
  return (
    <main lang="pl">
      <h1>{signInCopy.title}</h1>
      <p>{signInCopy.intro}</p>
      {isLoading ? (
        <p>{signInCopy.verifying}</p>
      ) : isAuthenticated ? (
        <AuthenticatedApp />
      ) : (
        <SignInForm />
      )}
    </main>
  );
}
