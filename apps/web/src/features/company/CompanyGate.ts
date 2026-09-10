/**
 * The shared company-feature gate (H1 review round 1): the connection
 * gate, the Convex auth wiring, B1's sign-in walk and the B3 membership
 * gate every member-facing surface rides, extracted from the two
 * hand-copies this PR had added (conversation and memory). Older features
 * that hand-roll the same stack (membership, calendar, work-list, project
 * catalog) can migrate lane by lane.
 *
 * JSX-free on purpose (createElement only), like the surfaces it gates:
 * the host feature registry chain stays importable by the node programs.
 *
 * This module also owns the dispatch micro-helpers both features
 * re-declared (the command envelope, the submit-event surface and the
 * result notice), so a change to the checked dispatch input shape has one
 * home.
 */

import { createElement, useMemo, type ReactNode } from "react";
import { ConvexAuthProvider, useAuthActions } from "@convex-dev/auth/react";
import { useQuery_experimental as useQueryState } from "convex/react";
import { Link } from "@tanstack/react-router";
import { api } from "../../../../../convex/_generated/api";
import { useAppServices } from "../../app/providers";
import { createConvexClient } from "../sign-in/client";
import { AuthenticatedGate } from "../sign-in/SignInGate";
import { signInCopy } from "../sign-in/state";
import type { MembershipOverview } from "../../../../../convex/access/membership/functions";

/** The member-carrying membership overview (what gated surfaces consume). */
export type MemberOverview = Extract<MembershipOverview, { state: "member" }>;

// ---------------------------------------------------------------------------
// Dispatch micro-helpers (the checked dispatch input shape, shared)
// ---------------------------------------------------------------------------

/** One command envelope (the checked dispatch input shape). */
export function envelopeOf(operation: string, input: unknown) {
  return { operation, input, expectedRevisions: [] };
}

/** The submit-event surface the handlers consume (preventDefault only). */
export interface SubmitEvent {
  preventDefault(): void;
}

/** The result notice every surface shows (server Polish copy or a hint). */
export interface Notice {
  readonly kind: "ok" | "error";
  readonly text: string;
}

// ---------------------------------------------------------------------------
// The gate stack: connection gate -> auth -> membership gate
// ---------------------------------------------------------------------------

/** Gate copy for the screens the stack itself renders (stable product text). */
const gateCopy = {
  connectionUnconfigured:
    "Aplikacja nie jest połączona z backendem (VITE_CONVEX_URL nie jest ustawiony).",
  connectionMisconfigured:
    "Adres backendu jest nieprawidłowy — aplikacja działa bez połączenia.",
  checkingSession: "Sprawdzamy Twoją sesję…",
  noCompanyHeading: "Nie należysz jeszcze do żadnej firmy",
  noCompanyIntro:
    "Aby wysyłać wiadomości, najpierw załóż firmę lub przyjmij zaproszenie na ekranie Firma.",
  noCompanyLink: "Przejdź do ekranu Firma",
} as const;

/**
 * The company-feature root: connection gate, auth wiring and membership
 * gate around one member continuation. Unauthenticated visitors reach
 * B1's sign-in walk; members without a company reach the admission
 * pointer; members continue into the feature's own surface.
 */
export function CompanyFeatureGate({
  title,
  member,
}: {
  /** The feature's screen title (rendered on the stack's own screens). */
  readonly title: string;
  /** The member surface: receives the member overview. */
  readonly member: (overview: MemberOverview) => ReactNode;
}): ReactNode {
  const { config } = useAppServices();
  if (config.connection.state === "unconfigured") {
    return createElement("section", null, createElement("h1", null, title), createElement("p", null, gateCopy.connectionUnconfigured));
  }
  if (config.connection.state === "misconfigured") {
    return createElement("section", null, createElement("h1", null, title), createElement("p", null, gateCopy.connectionMisconfigured));
  }
  return createElement(CompanyConnectedRoot, { convexUrl: config.connection.convexUrl, title, member });
}

function CompanyConnectedRoot({
  convexUrl,
  title,
  member,
}: {
  readonly convexUrl: string;
  readonly title: string;
  readonly member: (overview: MemberOverview) => ReactNode;
}): ReactNode {
  const client = useMemo(() => createConvexClient(convexUrl), [convexUrl]);
  return createElement(ConvexAuthProvider, {
    client,
    children: createElement(CompanyAuthGate, { title, member }),
  });
}

/** Authentication gate: B1's shared sign-in walk; members continue here. */
function CompanyAuthGate({
  title,
  member,
}: {
  readonly title: string;
  readonly member: (overview: MemberOverview) => ReactNode;
}): ReactNode {
  return createElement(AuthenticatedGate, {
    continuation: () => createElement(CompanySurface, { title, member }),
  });
}

/** The membership gate: session errors end the session; members continue. */
function CompanySurface({
  title,
  member,
}: {
  readonly title: string;
  readonly member: (overview: MemberOverview) => ReactNode;
}): ReactNode {
  const overview = useQueryState({
    query: api.access.membership.functions.membershipOverview,
    args: {},
  });

  if (overview.status === "error") {
    return createElement(SessionEnded);
  }
  if (overview.status !== "success") {
    return createElement("p", { role: "status" }, gateCopy.checkingSession);
  }
  if (overview.data.state === "no_company") {
    return createElement(
      "section",
      null,
      createElement("h1", null, title),
      createElement("h2", null, gateCopy.noCompanyHeading),
      createElement("p", null, gateCopy.noCompanyIntro),
      createElement("p", null, createElement(Link, { to: "/firma" }, gateCopy.noCompanyLink)),
    );
  }
  return member(overview.data);
}

/**
 * The session-ended fallback every gated query renders on error: the
 * honest way back to sign-in, never a spinner over an erroring query.
 */
export function SessionEnded(): ReactNode {
  const { signOut } = useAuthActions();
  return createElement(
    "div",
    { role: "alert" },
    createElement("p", null, signInCopy.sessionEndedNotice),
    createElement(
      "button",
      { type: "button", onClick: () => void signOut() },
      signInCopy.signInAgain,
    ),
  );
}
