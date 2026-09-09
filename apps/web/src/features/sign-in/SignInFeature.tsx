/**
 * The barebones sign-in feature (B1).
 *
 * Semantic controls only — forms, buttons, plain status text, no visual
 * design (the UX/UI track owns that). States are honest:
 *
 * - email-code: two steps (send code, then code + the same email), with
 *   distinct copy for wrong/expired codes, rate limiting, delivery
 *   failures and the method-conflict policy message;
 * - Google: shown only when the deployment reports it configured;
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
  signInCopy,
  type SignInFailure,
} from "./state";
import { SessionPanel } from "./SessionPanel";

/** The sign-in form (email code + Google, semantic controls). */
function SignInForm(): React.ReactNode {
  const { signIn } = useAuthActions();
  const availability = useQuery(api.access.identity.functions.providerAvailability, {});
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<SignInFailure | null>(null);

  const googleAvailable = availability?.google === true;

  async function requestCode(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!isValidEmail(email)) {
      setFailure("invalid_email");
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      await signIn("email_code", { email });
      setSentTo(email);
      setCode("");
    } catch (error) {
      setFailure(classifySignInError(error));
    } finally {
      setPending(false);
    }
  }

  async function verifyCode(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (sentTo === null) {
      return;
    }
    setPending(true);
    setFailure(null);
    try {
      await signIn("email_code", { email: sentTo, code });
    } catch (error) {
      setFailure(classifySignInError(error));
    } finally {
      setPending(false);
    }
  }

  if (sentTo === null) {
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
        <button type="submit" disabled={pending}>
          {pending ? signInCopy.sending : signInCopy.sendCode}
        </button>
        {failure !== null && (
          <p role="alert">{signInCopy.failures[failure]}</p>
        )}
        {googleAvailable ? (
          <button
            type="button"
            onClick={() => void signIn("google").catch((error: unknown) => setFailure(classifySignInError(error)))}
          >
            {signInCopy.googleButton}
          </button>
        ) : (
          <p>{signInCopy.googleUnavailable}</p>
        )}
      </form>
    );
  }

  return (
    <form onSubmit={(event) => void verifyCode(event)}>
      <p>{signInCopy.codeSentNotice(sentTo)}</p>
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
      <button type="submit" disabled={pending}>
        {pending ? signInCopy.verifying : signInCopy.verify}
      </button>
      <button
        type="button"
        onClick={() => {
          setSentTo(null);
          setCode("");
          setFailure(null);
        }}
      >
        {signInCopy.changeEmail}
      </button>
      {failure === "code_wrong_or_expired" && (
        <button
          type="button"
          onClick={() =>
            void signIn("email_code", { email: sentTo })
              .then(() => setCode(""))
              .catch((error: unknown) => setFailure(classifySignInError(error)))
          }
        >
          {signInCopy.resendCode}
        </button>
      )}
      {failure !== null && <p role="alert">{signInCopy.failures[failure]}</p>}
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
    void ensureSession({ deviceLabel: "Przeglądarka" })
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
