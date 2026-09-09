/**
 * The device-session panel (barebones session registry UI).
 *
 * Shows the actor's device sessions with trusted activity time and
 * explicit revocation state, offers self-service revocation ("Wyloguj to
 * urządzenie") and full sign-out. This is also the natural consumer of
 * the registry proof: revoking here denies fresh protected queries and
 * subscriptions immediately.
 */

import { useState } from "react";
import { useAuthActions } from "@convex-dev/auth/react";
import { useMutation, useQuery_experimental as useQueryState } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { signInCopy } from "./state";

const sessionPanelCopy = {
  heading: "Twoje urządzenia",
  currentDevice: "To urządzenie",
  active: "Aktywne",
  revoked: "Unieważnione",
  upstreamGone: "Sesja zamknięta",
  upstreamExpired: "Sesja wygasła",
  upstreamInactive: "Wygasła po 30 dniach nieaktywności",
  revokeThisDevice: "Wyloguj to urządzenie",
  noCompany:
    "Jesteś zalogowany, ale nie należysz jeszcze do żadnej firmy. Członkostwo nadchodzi z zaproszenia.",
  companyContext: (company: { timezone: string; currency: string }): string =>
    `Firma: strefa czasu ${company.timezone}, waluta ${company.currency}.`,
  roleAdmin: "Rola: administrator firmy",
  roleMember: "Rola: członek firmy",
} as const;

function lastSeenPl(ms: number): string {
  return new Date(ms).toLocaleString("pl-PL", { dateStyle: "medium", timeStyle: "short" });
}

export function SessionPanel(props: { sessionId: string }): React.ReactNode {
  const sessions = useQueryState({
    query: api.access.identity.functions.listMySessions,
    args: {},
  });
  const access = useQueryState({
    query: api.access.identity.functions.resolveCurrentAccess,
    args: { sessionId: props.sessionId },
  });
  const revoke = useMutation(api.access.identity.functions.revokeSession);
  const { signOut } = useAuthActions();
  const [signingOut, setSigningOut] = useState(false);

  // The panel's own queries error when THIS session stopped resolving
  // (revoked from here, signed out upstream, expired): the honest
  // fallback is the session-ended state with a way back to sign-in, not
  // a dead screen over erroring queries.
  const sessionEnded = sessions.status === "error" || access.status === "error";

  function requestSignOut(): void {
    setSigningOut(true);
    void signOut().catch(() => {
      setSigningOut(false);
    });
  }

  if (sessionEnded) {
    return (
      <div role="alert">
        <p>{signInCopy.sessionEndedNotice}</p>
        <button type="button" disabled={signingOut} onClick={requestSignOut}>
          {signInCopy.signInAgain}
        </button>
      </div>
    );
  }

  return (
    <section aria-label={sessionPanelCopy.heading}>
      <h2>{sessionPanelCopy.heading}</h2>
      {access.status === "success" && access.data !== null && (
        <p>
          {sessionPanelCopy.companyContext({
            timezone: access.data.companyTimezone,
            currency: access.data.defaultCurrency,
          })}{" "}
          {access.data.membershipRole === "admin"
            ? sessionPanelCopy.roleAdmin
            : sessionPanelCopy.roleMember}
        </p>
      )}
      {access.status === "success" && access.data === null && (
        <p>{sessionPanelCopy.noCompany}</p>
      )}
      <ul>
        {(sessions.status === "success" ? sessions.data : []).map((session) => (
          <li key={session.sessionId}>
            <strong>
              {session.isCurrent ? sessionPanelCopy.currentDevice : session.deviceLabel}
            </strong>{" "}
            <span>
              {session.revokedAtMs !== null
                ? sessionPanelCopy.revoked
                : session.upstreamState === "gone"
                  ? sessionPanelCopy.upstreamGone
                  : session.upstreamState === "expired"
                    ? sessionPanelCopy.upstreamExpired
                    : session.upstreamState === "inactive"
                      ? sessionPanelCopy.upstreamInactive
                      : sessionPanelCopy.active}
            </span>{" "}
            <span>ostatnia aktywność: {lastSeenPl(session.lastSeenAtMs)}</span>{" "}
            {session.revokedAtMs === null && (
              <button
                type="button"
                onClick={() => void revoke({ sessionId: session.sessionId })}
              >
                {sessionPanelCopy.revokeThisDevice}
              </button>
            )}
          </li>
        ))}
      </ul>
      <button type="button" disabled={signingOut} onClick={requestSignOut}>
        {signInCopy.signOutEverywhere}
      </button>
      {signingOut && <p aria-live="polite">{signInCopy.signedOutNotice}</p>}
    </section>
  );
}
