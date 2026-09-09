/**
 * The device-session panel of the account feature (B2): the multi-device
 * session view over B1's registry (`listMySessions`, with its honest
 * upstream states), per-device revocation through B1's live-session
 * operation, and "revoke every OTHER device" through the B2 loop over the
 * same canonical core. Every label renders from ./state.ts
 * (`accountCopy` — the single copy home).
 */

import { useState } from "react";
import { useMutation, useQuery } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { accountCopy } from "./state";

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
              {session.isCurrent ? accountCopy.sessionCurrentDevice : session.deviceLabel}
            </strong>{" "}
            <span>
              {session.revokedAtMs !== null
                ? accountCopy.sessionRevoked
                : session.upstreamState === "gone"
                  ? accountCopy.sessionUpstreamGone
                  : session.upstreamState === "expired"
                    ? accountCopy.sessionUpstreamExpired
                    : session.upstreamState === "inactive"
                      ? accountCopy.sessionUpstreamInactive
                      : accountCopy.sessionActive}
            </span>{" "}
            <span>
              {accountCopy.sessionLastSeenLabel}: {lastSeenPl(session.lastSeenAtMs)}
            </span>{" "}
            {session.revokedAtMs === null && (
              <button
                type="button"
                onClick={() => void revoke({ sessionId: session.sessionId })}
              >
                {accountCopy.revokeThisDevice}
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
