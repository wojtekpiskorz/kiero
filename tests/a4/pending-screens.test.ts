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
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { appFeatures } from "../../apps/web/src/app/app-features";
import { resolveFeatureScreen } from "../../apps/web/src/app/feature-pending";
import { AppServicesProvider } from "../../apps/web/src/app/providers";
import { loadAppConfig } from "../../apps/web/src/app/config";

/** The real dispatch, imported from the app: the test exercises the rule
 * the router actually uses. */
const screenFor = resolveFeatureScreen;

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
    // J1's mount graduated into H1's conversation feature: the entry stays
    // mounted and its own connection gate is the honest disconnected state
    // (no fake entries either way).
    expect(html).toContain("Aplikacja nie jest połączona z backendem");
    // The disconnected explanation names the missing config seam.
    expect(html).toContain("VITE_CONVEX_URL");
  });

  it("renders the H1 memory screen with the same honest disconnected gate", () => {
    const html = renderScreen(1);
    expect(html).toContain("Pamięć");
    expect(html).toContain("Aplikacja nie jest połączona z backendem");
    expect(html).not.toContain("<li>");
  });

  it("renders Co teraz (H2's mount), the work/extensions records and the projects placeholder honestly", () => {
    // H2 (issue #50) flipped /co-teraz to the real per-user screen: like
    // every mounted lane, its connection gate is the honest disconnected
    // state (no fake entries either way).
    const coTeraz = renderScreen(2);
    expect(coTeraz).toContain("Co teraz");
    expect(coTeraz).toContain("Aplikacja nie jest połączona z backendem");
    const work = renderScreen(3);
    expect(work).toContain("Praca");
    expect(work).toContain("Aplikacja nie jest połączona z backendem");
    const extensions = renderScreen(4);
    expect(extensions).toContain("Dodatkowe informacje");
    expect(extensions).toContain("Aplikacja nie jest połączona z backendem");
    const projects = renderScreen(5);
    expect(projects).toContain("Projekty");
    expect(projects).toContain("W przygotowaniu.");
    expect(projects).toContain("projects.identifyProject");
  });

  it("states the misconfigured URL on the conversation screen", () => {
    const html = renderScreen(0, loadAppConfig({ VITE_CONVEX_URL: "not a url" }));
    expect(html).toContain("jest nieprawidłowy");
  });
});
