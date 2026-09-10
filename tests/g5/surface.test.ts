/**
 * G5 focused verification, part 4: the scope section's mounted editor
 * (criterion 3, the follow-up in G4's owned files) with honest Polish copy.
 *
 * Server-side renders of the REAL ScopeSection (createElement only, the
 * A4/G4 pattern) under a dummy Convex provider: the two mode radios seeded
 * from the effective selection, the save control (disabled while the
 * projects catalog has not loaded in explicit mode), the honest next-sync
 * note, and the empty-selection note for the explicit opt-out. The
 * checkbox list itself needs the live catalog read; the live proof in
 * ./live-proof.mjs exercises the full editor seam end to end.
 */

import { describe, expect, it } from "vitest";
import { createElement, type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { operations } from "@kiero/contracts";
import { ScopeSection } from "../../apps/web/src/features/calendar/CalendarSettings";
import { settingsCopy, type SelectionView } from "../../apps/web/src/features/calendar/state";
import { appFeatures } from "../../apps/web/src/app/app-features";

const calendarEntry = appFeatures.find((entry) => entry.featureId === "calendar.connection");

// A dummy client: mutation hooks only close over it during render; the
// catalog query stays pending under renderToString, which is exactly the
// loading state asserted below.
const dummyClient = new ConvexReactClient("https://proof.invalid.convex.cloud");

function renderPanel(node: ReactNode): string {
  return renderToString(createElement(ConvexProvider, { client: dummyClient, children: node }));
}

const allProjects: SelectionView = { mode: "all_projects", projectIds: null };

describe("the scope editor is mounted on the certified write (criterion 3)", () => {
  it("the registration pin carries the selection write", () => {
    expect(calendarEntry?.consumedOperations).toContain("calendar.setSelection");
    expect("calendar.setSelection" in operations).toBe(true);
  });

  it("renders both mode radios and the save control seeded from all projects", () => {
    const html = renderPanel(createElement(ScopeSection, { selection: allProjects }));
    expect(html).toContain(settingsCopy.scopeHeading);
    expect(html).toContain(settingsCopy.scopeIntro);
    expect(html).toContain(settingsCopy.scopeEditMode);
    expect(html).toContain(settingsCopy.scopeModeAll);
    expect(html).toContain(settingsCopy.scopeModeExplicit);
    expect(html).toContain(settingsCopy.scopeSave);
    expect(html).toContain(settingsCopy.scopeNextSyncNote);
    expect(html).toContain(settingsCopy.personalFieldsNote);
    // The all-projects radio is the checked one.
    expect(html).toMatch(/type="radio"[^>]*checked[^>]*>/);
  });

  it("shows the honest count line and the empty-selection note for an explicit opt-out", () => {
    const html = renderPanel(
      createElement(ScopeSection, { selection: { mode: "explicit", projectIds: [] } }),
    );
    expect(html).toContain(settingsCopy.scopeCount(0));
    expect(html).toContain(settingsCopy.scopeExplicitEmpty);
  });

  it("counts a stored explicit selection and never fakes a loaded catalog", () => {
    const html = renderPanel(
      createElement(ScopeSection, {
        selection: { mode: "explicit", projectIds: ["k0001ttttttttttttttttttttt"] },
      }),
    );
    expect(html).toContain(settingsCopy.scopeCount(1));
    // While the catalog read is pending the save control stays disabled in
    // explicit mode: an editor that cannot see the projects must not save
    // a selection over them.
    expect(html).toMatch(/<button[^>]*disabled[^>]*>/);
    expect(html).not.toContain(settingsCopy.scopeSaved);
  });

  it("keeps the personal character of the choice in the copy", () => {
    expect(settingsCopy.scopeIntro).toContain("osobisty");
    expect(settingsCopy.scopeIntro).toContain("nie zmienia faktów firmy");
    expect(settingsCopy.scopeSaved).toContain("najbliższej synchronizacji");
    expect(settingsCopy.scopeNextSyncNote).toContain("najbliższej synchronizacji");
  });
});
