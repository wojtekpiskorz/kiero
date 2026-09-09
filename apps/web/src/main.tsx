import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { loadAppConfig } from "./app/config";
import { createAppConnections } from "./app/connections";
import { AppServicesProvider } from "./app/providers";
import { createAppRouter } from "./app/router";
import { composePwaEntries, registerPwa } from "./app/pwa/composition";

/**
 * Bootstrap entry for the Kiero PWA host (A4).
 *
 * Wires React 19 + TanStack Router + TanStack Query with the Convex
 * React-Query adapter exactly as A3 proved it, reads the typed config seam
 * once, mounts the application host and prepares the PWA entry
 * composition (a no-op until F3/I7 ship their modules). Without a
 * configured backend the app still runs and renders the disconnected
 * state without faking a connection.
 */

const config = loadAppConfig(import.meta.env);
const connections = createAppConnections(config);
const router = createAppRouter();

const container = document.getElementById("root");
if (!(container instanceof HTMLDivElement)) {
  throw new Error("bootstrap: #root container not found");
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={connections.queryClient}>
      <AppServicesProvider services={{ config }}>
        <RouterProvider router={router} />
      </AppServicesProvider>
    </QueryClientProvider>
  </StrictMode>,
);

// Prepared seam only: registers nothing while no service worker is shipped.
void registerPwa(composePwaEntries());
