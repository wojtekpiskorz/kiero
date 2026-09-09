import { createElement } from "react";
import { createRoot } from "react-dom/client";
import {
  createRootRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";

/**
 * Bootstrap entry for the Kiero PWA shell.
 *
 * This module mounts a minimal TanStack Router around a Polish placeholder
 * screen so the pinned React/Vite/TanStack toolchain is provably executable.
 * Real features, routes and generated route types are owned by later
 * tickets; nothing here is product UI.
 */

const rootRoute = createRootRoute({
  component: () =>
    createElement(
      "main",
      { lang: "pl" },
      createElement("h1", null, "Kiero: rdzeń w przygotowaniu"),
      createElement(
        "p",
        null,
        "Szkielet aplikacji działa. Funkcje pojawią się wraz z implementacją.",
      ),
    ),
});

const router = createRouter({ routeTree: rootRoute });

const container = document.getElementById("root");
if (!(container instanceof HTMLDivElement)) {
  throw new Error("bootstrap-placeholder: #root container not found");
}

createRoot(container).render(createElement(RouterProvider, { router }));
