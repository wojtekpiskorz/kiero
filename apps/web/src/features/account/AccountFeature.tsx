/**
 * The barebones account feature (B2): "Konto".
 *
 * Semantic controls only — headings, forms, buttons, plain status text
 * (the UX/UI track owns visual design). The screen mounts its own Convex
 * auth provider (the same client factory the sign-in feature uses) and
 * walks three panels: linking state and pending proofs, the email change,
 * and the device-session registry with revocation. Every label renders
 * from ./state.ts (`accountCopy`); failures classify by machine markers,
 * never prose.
 */

import { useEffect, useMemo } from "react";
import { ConvexAuthProvider, useAuthActions, useConvexAuth } from "@convex-dev/auth/react";
import { useMutation } from "convex/react";
import { api } from "../../../../../convex/_generated/api";
import { createConvexClient } from "../sign-in/client";
import { accountCopy } from "./state";
import { LinkingPanel } from "./LinkingPanel";
import { EmailChangePanel } from "./EmailChangePanel";
import { AccountSessionsPanel } from "./AccountSessionsPanel";

/** The feature root: bring the provider, gate on authentication. */
export function AccountFeature(): React.ReactNode {
  const client = useMemo(() => createConvexClient(import.meta.env.VITE_CONVEX_URL), []);
  return (
    <ConvexAuthProvider client={client}>
      <AccountScreen />
    </ConvexAuthProvider>
  );
}

function AccountScreen(): React.ReactNode {
  const { isAuthenticated, isLoading } = useConvexAuth();
  return (
    <main lang="pl">
      <h1>{accountCopy.title}</h1>
      <p>{accountCopy.intro}</p>
      {isLoading ? (
        <p>{accountCopy.checkingSession}</p>
      ) : isAuthenticated ? (
        <AuthenticatedAccount />
      ) : (
        <p role="status">{accountCopy.signInFirst}</p>
      )}
    </main>
  );
}

/** Authenticated shell: ensure the session registry row, then the panels. */
function AuthenticatedAccount(): React.ReactNode {
  const ensureSession = useMutation(api.access.identity.functions.ensureSessionRegistry);
  const { signOut } = useAuthActions();

  useEffect(() => {
    // Idempotent bootstrap (B1): provisions the registry row on first call,
    // refreshes trusted activity time afterwards. A denied registry (signed
    // out upstream, revoked elsewhere) surfaces honestly through the
    // panels' own queries.
    void ensureSession({}).catch(() => undefined);
  }, [ensureSession]);

  return (
    <>
      <LinkingPanel />
      <EmailChangePanel />
      <AccountSessionsPanel />
      <button type="button" onClick={() => void signOut()}>
        {accountCopy.signOut}
      </button>
    </>
  );
}
