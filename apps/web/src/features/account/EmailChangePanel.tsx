/**
 * The email-change panel (B2): request (requires recent authentication,
 * enforced server-side) then confirm with the code mailed to the NEW
 * address. A failed confirmation changes nothing server-side; the panel
 * says so honestly by clearing its own state on failure.
 */

import { useState } from "react";
import { useAction, useMutation } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import {
  accountCopy,
  accountPendingLabel,
  classifyAccountError,
  isValidEmail,
  type AccountState,
} from "./state";

export function EmailChangePanel(): React.ReactNode {
  const request = useAction(api.access.linking.functions.requestEmailChange);
  const confirm = useMutation(api.access.linking.functions.confirmEmailChange);
  const [state, setState] = useState<AccountState>({ step: "idle" });
  const [newEmail, setNewEmail] = useState("");
  const [code, setCode] = useState("");
  const [failure, setFailure] = useState<
    ReturnType<typeof classifyAccountError> | "invalid_email" | null
  >(null);
  const [notice, setNotice] = useState<string | null>(null);

  const pending = accountPendingLabel(state);

  async function requestChange(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!isValidEmail(newEmail)) {
      setFailure("invalid_email");
      return;
    }
    setState({ step: "requesting-email-change" });
    setFailure(null);
    setNotice(null);
    try {
      await request({ newEmail: newEmail.trim() });
      setNotice(accountCopy.emailChangeRequested(newEmail.trim()));
      setState({ step: "confirming-email-change" });
    } catch (error) {
      setFailure(classifyAccountError(error));
      setState({ step: "idle" });
    }
  }

  async function confirmChange(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setState({ step: "confirming-email-change" });
    setFailure(null);
    try {
      const outcome = await confirm({ code });
      setNotice(accountCopy.emailChanged(outcome.newEmail));
      setCode("");
      setNewEmail("");
      setState({ step: "idle" });
    } catch (error) {
      setFailure(classifyAccountError(error));
      setState({ step: "idle" });
    }
  }

  return (
    <section aria-label={accountCopy.emailHeading}>
      <h2>{accountCopy.emailHeading}</h2>
      <form onSubmit={(event) => void requestChange(event)}>
        <label htmlFor="account-new-email">{accountCopy.emailChangeLabel}</label>
        <input
          id="account-new-email"
          type="email"
          autoComplete="email"
          placeholder={accountCopy.emailChangePlaceholder}
          value={newEmail}
          onChange={(event) => setNewEmail(event.target.value)}
          required
        />
        <button type="submit" disabled={pending !== null}>
          {pending ?? accountCopy.requestEmailChange}
        </button>
      </form>
      {state.step === "confirming-email-change" && (
        <form onSubmit={(event) => void confirmChange(event)}>
          <label htmlFor="account-email-code">{accountCopy.emailChangeCodeLabel}</label>
          <input
            id="account-email-code"
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            placeholder={accountCopy.codePlaceholder}
            value={code}
            onChange={(event) => setCode(event.target.value)}
            required
          />
          <button type="submit" disabled={pending !== null}>
            {pending ?? accountCopy.confirmEmailChange}
          </button>
        </form>
      )}
      {notice !== null && <p role="status">{notice}</p>}
      {failure !== null && <p role="alert">{accountCopy.failures[failure]}</p>}
    </section>
  );
}
