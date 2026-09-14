/**
 * R16 focused tests (issue #198): the Calendar entry is withheld from the
 * v1 PWA composition (the owner deferred the Google Calendar integration
 * beyond v1; ADR docs/adr/calendar-deferral-2026-09.md).
 *
 * Two proofs, both through the real modules:
 *
 * - the entry half pins the registry state: the real calendar entry file
 *   validates as PENDING through the real registry (`appFeatureEntry`
 *   runs at module load, so a bad shape would fail the import itself),
 *   keeps its /kalendarz identity and its five G-series consumed
 *   operations, and states the deferral honestly in Polish. No screen
 *   import remains, so nothing in the host mounts CalendarFeature; the
 *   CalendarFeature module itself stays intact for the lane that
 *   remounts it.
 *
 * - the composition half imports the REAL composed list (app-features,
 *   the module the router and the navigation derive from) and pins the
 *   withholding: no /kalendarz route path and no "Kalendarz" navigation
 *   label reach the v1 host, and the loud composition validation still
 *   passes (the company conversation stays the default route). The
 *   composition import is dynamic so the entry-half proofs stay runnable
 *   even while the composition reports drift; the withholding assertions
 *   then name the exact gap instead of a whole-file module-load crash.
 */

import { describe, expect, it } from "vitest";
import { calendarFeatureEntry } from "../../apps/web/src/app/features/calendar/entry";

describe("the withheld calendar entry (R16, issue #198)", () => {
  it("validates through the real registry as pending, keeping its identity", () => {
    expect(calendarFeatureEntry.featureId).toBe("calendar.connection");
    expect(calendarFeatureEntry.implementation).toBe("pending");
    expect(calendarFeatureEntry.routePath).toBe("/kalendarz");
    expect(calendarFeatureEntry.navLabel).toBe("Kalendarz");
    expect(calendarFeatureEntry.screenHeading).toBe("Kalendarz Kiero w Google");
  });

  it("keeps the five certified G-series operations the future lane remounts", () => {
    expect(calendarFeatureEntry.consumedOperations).toEqual([
      "calendar.connectCalendar",
      "calendar.disconnectCalendar",
      "calendar.setCopyHidden",
      "calendar.reconcileCopy",
      "calendar.setSelection",
    ]);
  });

  it("states the deferral honestly in Polish, without a placeholder screen", () => {
    if (calendarFeatureEntry.implementation === "pending") {
      expect(calendarFeatureEntry.pendingNote).toContain("odroczon");
      expect(calendarFeatureEntry.pendingNote).toContain("Kalendarz Kiero w Google");
      expect(calendarFeatureEntry.pendingScreen).toBeUndefined();
    }
  });
});

describe("the v1 composition withholds the calendar surface", () => {
  it("composes no /kalendarz route and no Kalendarz navigation entry", async () => {
    const { appFeatures } = await import("../../apps/web/src/app/app-features");
    expect(appFeatures.some((entry) => entry.routePath === "/kalendarz")).toBe(false);
    expect(appFeatures.some((entry) => entry.navLabel === "Kalendarz")).toBe(false);
  });

  it("still passes the loud composition validation (conversation default first)", async () => {
    const { appFeatures } = await import("../../apps/web/src/app/app-features");
    expect(appFeatures[0]?.featureId).toBe("conversation.company");
    expect(appFeatures[0]?.routePath).toBe("/");
  });
});

describe("the composition drift check names the deferral states (R16)", () => {
  // The validator runs over the PRE-withhold composed list; rebuild it from
  // the filtered output plus the pending entry exactly as fullCoreAppFeatures
  // composes it, then break each invariant in the style of tests/j2.
  const composedWithDeferred = async () => {
    const { appFeatures } = await import("../../apps/web/src/app/app-features");
    return [...appFeatures, calendarFeatureEntry];
  };

  it("accepts the recorded deferral: pending calendar present in the composed list", async () => {
    const { validateFullCoreComposition } = await import("../../apps/web/src/composition/full");
    const problems = validateFullCoreComposition(await composedWithDeferred()).problems;
    expect(problems).toEqual([]);
  });

  it("bites when a listed deferral silently disappears from the composition", async () => {
    const { appFeatures } = await import("../../apps/web/src/app/app-features");
    const { validateFullCoreComposition } = await import("../../apps/web/src/composition/full");
    const problems = validateFullCoreComposition(appFeatures).problems;
    expect(
      problems.some(
        (problem) => problem.kind === "feature_missing" && problem.name === "calendar.connection",
      ),
    ).toBe(true);
  });

  it("bites when a deferred id remounts under a stale deferral record (deferred_not_pending)", async () => {
    const list = await composedWithDeferred();
    const { validateFullCoreComposition } = await import("../../apps/web/src/composition/full");
    const remounted = list.map((entry) =>
      entry.featureId === "calendar.connection"
        ? { ...entry, implementation: "mounted" as const }
        : entry,
    ) as typeof list;
    const problems = validateFullCoreComposition(remounted).problems;
    expect(
      problems.some(
        (problem) => problem.kind === "deferred_not_pending" && problem.name === "calendar.connection",
      ),
    ).toBe(true);
  });

  it("bites when a core surface flips to pending without a recorded deferral (feature_not_mounted)", async () => {
    const list = await composedWithDeferred();
    const { validateFullCoreComposition } = await import("../../apps/web/src/composition/full");
    // Deliberate shape violation (a mounted entry flipped pending without a
    // pendingNote): the cast exists because the drift fixture breaks the
    // union on purpose, exactly what the validator must name.
    const quietlyUnshipped = list.map((entry) =>
      entry.featureId === "memory.project"
        ? { ...entry, implementation: "pending" as const }
        : entry,
    ) as typeof list;
    const problems = validateFullCoreComposition(quietlyUnshipped).problems;
    expect(
      problems.some(
        (problem) => problem.kind === "feature_not_mounted" && problem.name === "memory.project",
      ),
    ).toBe(true);
  });
});
