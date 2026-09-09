/**
 * The standalone sign-in feature root (B1).
 *
 * Reduced to the wrapper plus the device-session panel: the walk itself
 * (card, registry bootstrap, denial views) lives in ONE shared, JSX-free
 * implementation (./SignInGate.ts) that this root and every host-mounted
 * feature compose — the two presentations cannot age separately. The
 * continuation receives the provisioned session id, which the panel needs.
 *
 * Not mounted by the host directly: the membership surface (B3) mounts the
 * same gate at `/firma`, where an unauthenticated visitor reaches the same
 * sign-in walk and an authenticated member continues to the membership
 * surface.
 */

import { useMemo } from "react";
import { ConvexAuthProvider } from "@convex-dev/auth/react";
import { createConvexClient } from "./client";
import { AuthenticatedGate } from "./SignInGate";
import { SessionPanel } from "./SessionPanel";

export function SignInFeature(): React.ReactNode {
  const client = useMemo(() => createConvexClient(import.meta.env.VITE_CONVEX_URL), []);
  return (
    <ConvexAuthProvider client={client}>
      <AuthenticatedGate continuation={(sessionId) => <SessionPanel sessionId={sessionId} />} />
    </ConvexAuthProvider>
  );
}
