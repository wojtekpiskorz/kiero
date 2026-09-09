/**
 * Company conversation feature entry (A4 placeholder; the capture lanes D
 * own the real implementation).
 *
 * "Rozmowa firmy" is the authenticated default route (execution charter:
 * the application starts in the company conversation; project context and
 * "Co teraz" are reachable without a mandatory dashboard). Until log-in
 * (B1) and the backend exist, this screen states exactly what is missing
 * and shows no example entries.
 */

import { createElement, type ReactNode } from "react";
import { appFeatureEntry } from "../../registry";
import { useAppServices } from "../../providers";
import { FeatureOperationsList, featureHeadingId } from "../../feature-pending";

const CONVERSATION_PENDING_NOTE =
  "Rozmowa firmy to jedna ciągła, wspólna historia wypowiedzi szefów i agenta na poziomie firmy. Tu pojawi się po zaimplementowaniu funkcji.";

function connectionLine(state: "configured" | "unconfigured" | "misconfigured"): string {
  switch (state) {
    case "configured":
      return "Adres backendu jest ustawiony; rozmowa pojawi się po zaimplementowaniu funkcji.";
    case "misconfigured":
      return "Adres backendu (VITE_CONVEX_URL) jest nieprawidłowy — aplikacja działa bez połączenia.";
    case "unconfigured":
      return "Adres backendu (VITE_CONVEX_URL) nie jest ustawiony — aplikacja działa bez połączenia.";
  }
}

/** Richer placeholder: spells out what this default surface is waiting for. */
function ConversationPendingScreen(): ReactNode {
  const { config } = useAppServices();
  return createElement(
    "section",
    { "aria-labelledby": featureHeadingId(conversationFeatureEntry) },
    createElement("h1", { id: featureHeadingId(conversationFeatureEntry) }, "Rozmowa firmy"),
    createElement("p", { role: "status" }, "W przygotowaniu."),
    createElement("p", null, CONVERSATION_PENDING_NOTE),
    createElement("h2", null, "Co jest potrzebne"),
    createElement(
      "ul",
      null,
      createElement(
        "li",
        { key: "auth" },
        "Zalogowanie i członkostwo w firmie — logowanie jest w przygotowaniu.",
      ),
      createElement("li", { key: "backend" }, connectionLine(config.connection.state)),
      createElement(
        "li",
        { key: "no-examples" },
        "Nie pokazujemy przykładowych wpisów: historia rozmowy pojawi się, gdy funkcja będzie gotowa.",
      ),
    ),
    createElement(FeatureOperationsList, { entry: conversationFeatureEntry }),
  );
}

/** The registered host entry for the default company conversation surface. */
export const conversationFeatureEntry = appFeatureEntry({
  featureId: "conversation.company",
  routePath: "/",
  navLabel: "Rozmowa firmy",
  screenHeading: "Rozmowa firmy",
  consumedOperations: [
    "sources.acceptSource",
    "sources.withdrawSource",
    "attention.markSourceRead",
  ],
  implementation: "pending",
  pendingNote: CONVERSATION_PENDING_NOTE,
  pendingScreen: ConversationPendingScreen,
});
