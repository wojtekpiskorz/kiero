/**
 * Pending-screen render tests (A4).
 *
 * Headless render proof for the shell content: the real entry screens are
 * server-rendered with the real providers and the unconfigured connection
 * state, asserting the honest disconnected state (Polish copy, "w
 * przygotowaniu", no faked data). The entry/provider modules are
 * deliberately JSX-free (createElement) so this node program compiles
 * without a JSX flag.
 */

import { describe, expect, it } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { appFeatures } from "../../apps/web/src/app/app-features";
import { AppServicesProvider } from "../../apps/web/src/app/providers";
import { loadAppConfig } from "../../apps/web/src/app/config";
import { createPendingScreen } from "../../apps/web/src/app/feature-pending";
import type { AppFeatureEntry } from "../../apps/web/src/app/registry";

/** Resolves the screen the way the router does (one dispatch rule). */
function screenFor(entry: AppFeatureEntry): () => ReactNode {
  return entry.implementation === "mounted"
    ? entry.screen
    : entry.pendingScreen ?? createPendingScreen(entry);
}

function renderScreen(entryIndex: number, config = loadAppConfig({})): string {
  const entry = appFeatures[entryIndex];
  if (entry === undefined) {
    throw new Error("render: missing feature entry");
  }
  return renderToString(
    createElement(AppServicesProvider, {
      services: { config },
      children: createElement(screenFor(entry)),
    }),
  );
}

describe("pending feature screens render without fake data", () => {
  it("renders the default company conversation screen with the disconnected state", () => {
    const html = renderScreen(0);
    expect(html).toContain("Rozmowa firmy");
    expect(html).toContain("W przygotowaniu.");
    expect(html).toContain("Nie pokazujemy przykładowych wpisów");
    // The disconnected explanation names the missing config seam.
    expect(html).toContain("VITE_CONVEX_URL");
    // Consumed contract operations are visible, not hidden behind fake UI.
    expect(html).toContain("sources.acceptSource");
  });

  it("renders Co teraz and projects context through the shared placeholder screen", () => {
    const coTeraz = renderScreen(1);
    expect(coTeraz).toContain("Co teraz");
    expect(coTeraz).toContain("W przygotowaniu.");
    const projects = renderScreen(2);
    expect(projects).toContain("Projekty");
    expect(projects).toContain("W przygotowaniu.");
    expect(projects).toContain("projects.identifyProject");
  });

  it("states the misconfigured URL on the conversation screen", () => {
    const html = renderScreen(0, loadAppConfig({ VITE_CONVEX_URL: "not a url" }));
    expect(html).toContain("jest nieprawidłowy");
  });
});
