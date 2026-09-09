/**
 * Honest pending-screen render tests (A4).
 *
 * Headless render proof for the shell content: the real entry screens are
 * server-rendered with the real providers and the unconfigured connection
 * state, asserting the disconnected state renders honestly (Polish copy,
 * "w przygotowaniu", no faked data). The entry/provider modules are
 * deliberately JSX-free (createElement) so this node program compiles
 * without a JSX flag.
 */

import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { appFeatures } from "../../apps/web/src/app/app-features";
import { AppServicesProvider } from "../../apps/web/src/app/providers";
import { loadAppConfig } from "../../apps/web/src/app/config";

function renderScreen(entryIndex: number, config = loadAppConfig({})): string {
  const entry = appFeatures[entryIndex];
  if (entry === undefined) {
    throw new Error("render: missing feature entry");
  }
  return renderToString(
    createElement(AppServicesProvider, {
      services: { config, connected: false },
      children: createElement(entry.screen),
    }),
  );
}

describe("pending feature screens render honestly", () => {
  it("renders the default company conversation screen with the disconnected state", () => {
    const html = renderScreen(0);
    expect(html).toContain("Rozmowa firmy");
    expect(html).toContain("W przygotowaniu.");
    expect(html).toContain("Nie pokazujemy przykładowych wpisów");
    // The honest disconnected explanation names the missing config seam.
    expect(html).toContain("VITE_CONVEX_URL");
    // Consumed contract operations are visible, not hidden behind fake UI.
    expect(html).toContain("sources.acceptSource");
  });

  it("renders Co teraz and projects context as visibly pending, never fake", () => {
    const coTeraz = renderScreen(1);
    expect(coTeraz).toContain("Co teraz");
    expect(coTeraz).toContain("W przygotowaniu.");
    const projects = renderScreen(2);
    expect(projects).toContain("Projekty");
    expect(projects).toContain("W przygotowaniu.");
    expect(projects).toContain("projects.identifyProject");
  });

  it("keeps the conversation screen honest when the URL is misconfigured", () => {
    const html = renderScreen(0, loadAppConfig({ VITE_CONVEX_URL: "not a url" }));
    expect(html).toContain("jest nieprawidłowy");
  });
});
