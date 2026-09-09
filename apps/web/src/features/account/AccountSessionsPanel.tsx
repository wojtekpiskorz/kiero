/**
 * The device-session panel of the account feature (B2): the multi-device
 * session view over B1's registry (`listMySessions`, with its honest
 * upstream states), per-device revocation through B1's live-session
 * operation, and "revoke every OTHER device" through the B2 loop over the
 * same canonical core.
 */

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { accountCopy } from "./state";

const sessionStateCopy = {
  active: "Aktywne",
  revoked: "Unieważnione",
  upstreamGone: "Sesja zamknięta",
  upstreamExpired: "Sesja wygasła",
  upstreamInactive: "Wygasła po 30 dniach nieaktywności",
  currentDevice: "To urządzenie",
} as const;

function lastSeenPl(ms: number): string {
  return new Date(ms).toLocaleString("pl-PL", { dateStyle: "medium", timeStyle: "short" });
}

export function AccountSessionsPanel(): React.ReactNode {
  const sessions = useQuery(api.access.identity.functions.listMySessions, {});
  const revoke = useMutation(api.access.identity.functions.revokeSession);
  const revokeOthers = useMutation(api.access.linking.functions.revokeOtherSessions);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function revokeOtherDevices(): Promise<void> {
    setBusy(true);
    try {
      const outcome = await revokeOthers({});
      setNotice(accountCopy.revokedOtherSessions(outcome.revokedCount));
    } catch {
      setNotice(accountCopy.failures.unknown);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-label={accountCopy.sessionsHeading}>
      <h2>{accountCopy.sessionsHeading}</h2>
      <ul>
        {(sessions ?? []).map((session) => (
          <li key={session.sessionId}>
            <strong>
              {session.isCurrent ? sessionStateCopy.currentDevice : session.deviceLabel}
            </strong>{" "}
            <span>
              {session.revokedAtMs !== null
                ? sessionStateCopy.revoked
                : session.upstreamState === "gone"
                  ? sessionStateCopy.upstreamGone
                  : session.upstreamState === "expired"
                    ? sessionStateCopy.upstreamExpired
                    : session.upstreamState === "inactive"
                      ? sessionStateCopy.upstreamInactive
                      : sessionStateCopy.active}
            </span>{" "}
            <span>ostatnia aktywność: {lastSeenPl(session.lastSeenAtMs)}</span>{" "}
            {session.revokedAtMs === null && (
              <button
                type="button"
                onClick={() => void revoke({ sessionId: session.sessionId })}
              >
                Wyloguj to urządzenie
              </button>
            )}
          </li>
        ))}
      </ul>
      <button type="button" disabled={busy} onClick={() => void revokeOtherDevices()}>
        {accountCopy.revokeOtherSessions}
      </button>
      {notice !== null && <p role="status">{notice}</p>}
    </section>
  );
}
