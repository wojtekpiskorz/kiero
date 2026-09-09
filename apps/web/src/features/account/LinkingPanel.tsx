/**
 * The linking panel: method inventory, the ceremony walkthrough and its
 * pending proofs (B2). Both directions render from ONE state machine: the
 * ceremony's `nextLeg` (mirrored from the server view) decides whether
 * the expected proof is a mailed code or a Google re-authentication.
 */

import { useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useAction, useMutation, useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import {
  accountCopy,
  accountPendingLabel,
  classifyAccountError,
  type AccountState,
  type LinkRejectionCode,
} from "./state";

type Failure = LinkRejectionCode | "email_delivery_failed" | "network" | "unknown";

export function LinkingPanel(): React.ReactNode {
  const status = useQuery(api.access.linking.functions.linkingStatus, {});
  const begin = useMutation(api.access.linking.functions.beginLinking);
  const cancel = useMutation(api.access.linking.functions.cancelLinking);
  const sendCode = useAction(api.access.linking.functions.sendProofCode);
  const verifyCode = useMutation(api.access.linking.functions.verifyProofCode);
  const availability = useQuery(api.access.identity.functions.providerAvailability, {});
  const { signIn } = useAuthActions();
  const [state, setState] = useState<AccountState>({ step: "idle" });
  const [code, setCode] = useState("");
  const [failure, setFailure] = useState<Failure | null>(null);
  const [linkedNotice, setLinkedNotice] = useState(false);

  const view = status ?? undefined;
  const attempt = view?.activeAttempt ?? null;
  const pending = accountPendingLabel(state);
  const googleAvailable = availability?.google === true;

  async function beginCeremony(targetMethod: "google" | "email_code"): Promise<void> {
    setFailure(null);
    setLinkedNotice(false);
    try {
      await begin({ targetMethod });
    } catch (error) {
      setFailure(classifyAccountError(error));
    }
  }

  async function requestCode(): Promise<void> {
    if (attempt === null) {
      return;
    }
    setState({ step: "sending-code", leg: attempt.nextLeg });
    setFailure(null);
    setCode("");
    try {
      await sendCode({});
      setState({ step: "verifying-code", leg: attempt.nextLeg });
    } catch (error) {
      setFailure(classifyAccountError(error));
      setState({ step: "idle" });
    }
  }

  async function submitCode(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (attempt === null) {
      return;
    }
    setState({ step: "verifying-code", leg: attempt.nextLeg });
    setFailure(null);
    try {
      const outcome = await verifyCode({ code });
      if (outcome.linked) {
        setLinkedNotice(true);
        setCode("");
      }
      setState({ step: "idle" });
    } catch (error) {
      setFailure(classifyAccountError(error));
      setState({ step: "idle" });
    }
  }

  function proveWithGoogle(): void {
    if (attempt === null) {
      return;
    }
    setState({ step: "google-pending" });
    setFailure(null);
    void signIn("google").catch((error: unknown) => {
      setFailure(classifyAccountError(error));
      setState({ step: "idle" });
    });
  }

  async function cancelCeremony(): Promise<void> {
    setFailure(null);
    setCode("");
    try {
      await cancel({});
    } catch (error) {
      setFailure(classifyAccountError(error));
    }
    setState({ step: "idle" });
  }

  return (
    <section aria-label={accountCopy.methodsHeading}>
      <h2>{accountCopy.methodsHeading}</h2>
      <p>
        {accountCopy.emailMethod}:{" "}
        {view?.emailCodeLinked ? accountCopy.methodAttached : accountCopy.methodMissing}
        {" · "}
        {accountCopy.googleMethod}:{" "}
        {view?.googleLinked ? accountCopy.methodAttached : accountCopy.methodMissing}
        {" · "}
        {view?.email ?? "…"}
      </p>
      {linkedNotice && <p role="status">{accountCopy.linkedNotice}</p>}
      {attempt === null ? (
        <div>
          {!view?.googleLinked &&
            (googleAvailable ? (
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => void beginCeremony("google")}
              >
                {accountCopy.addGoogle}
              </button>
            ) : (
              <p>{accountCopy.googleUnavailable}</p>
            ))}
          {!view?.emailCodeLinked && (
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => void beginCeremony("email_code")}
            >
              {accountCopy.addEmailCode}
            </button>
          )}
        </div>
      ) : (
        <div>
          <h3>{accountCopy.ceremonyHeading}</h3>
          <p>
            {attempt.state === "awaiting_first_proof"
              ? attempt.nextLeg === "email_code"
                ? accountCopy.ceremonyFirstProofEmail(view?.email ?? "")
                : accountCopy.ceremonyFirstProofGoogle
              : attempt.nextLeg === "email_code"
                ? accountCopy.ceremonyTargetProofEmail(view?.email ?? "")
                : accountCopy.ceremonyTargetProofGoogle}
          </p>
          {attempt.nextLeg === "email_code" ? (
            <form onSubmit={(event) => void submitCode(event)}>
              <button
                type="button"
                disabled={pending !== null}
                onClick={() => void requestCode()}
              >
                {pending === accountCopy.sending ? pending : accountCopy.sendCode}
              </button>
              <label htmlFor="linking-code">{accountCopy.codeLabel}</label>
              <input
                id="linking-code"
                type="text"
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder={accountCopy.codePlaceholder}
                value={code}
                onChange={(event) => setCode(event.target.value)}
                required
              />
              <button type="submit" disabled={pending !== null}>
                {pending ?? accountCopy.verifyCode}
              </button>
            </form>
          ) : (
            <button type="button" disabled={pending !== null} onClick={proveWithGoogle}>
              {pending ?? accountCopy.verifyCode}
            </button>
          )}
          <button type="button" disabled={pending !== null} onClick={() => void cancelCeremony()}>
            {accountCopy.cancelCeremony}
          </button>
        </div>
      )}
      {failure !== null && <p role="alert">{accountCopy.failures[failure]}</p>}
    </section>
  );
}
