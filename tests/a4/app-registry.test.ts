/**
 * Host feature-entry registry tests (A4).
 *
 * Proves the registry enforces the registration contract loudly (aligned
 * with @kiero/contracts: FeatureId discipline, operations that exist) and
 * that the SHIPPED composition is valid, pending and starts at the company
 * conversation. The composed list and entry modules are intentionally
 * JSX-free so this node program can import the real thing.
 */

import { describe, expect, it } from "vitest";
import { operations } from "@kiero/contracts";
import { appFeatures } from "../../apps/web/src/app/app-features";
import {
  appFeatureEntry,
  composeAppFeatures,
  type AppFeatureCommonInput,
} from "../../apps/web/src/app/registry";

const mountedScreen = () => null;

function commonInput(overrides: Partial<AppFeatureCommonInput> = {}): AppFeatureCommonInput {
  return {
    featureId: "test.feature",
    routePath: "/test",
    navLabel: "Test",
    screenHeading: "Test",
    consumedOperations: ["platform.probeEcho"],
    ...overrides,
  };
}

function pendingInput(overrides: Partial<AppFeatureCommonInput> = {}) {
  return appFeatureEntry({
    ...commonInput(overrides),
    implementation: "pending",
    pendingNote: "Funkcja testowa jest w przygotowaniu.",
  });
}

describe("app feature entry validation", () => {
  it("accepts a valid pending entry and brands the feature id", () => {
    const entry = pendingInput();
    expect(entry.implementation).toBe("pending");
    expect(entry.featureId).toBe("test.feature");
    expect(entry.routePath).toBe("/test");
  });

  it("accepts a valid mounted entry carrying its screen", () => {
    const entry = appFeatureEntry({
      ...commonInput(),
      implementation: "mounted",
      screen: mountedScreen,
    });
    expect(entry.implementation).toBe("mounted");
    if (entry.implementation === "mounted") {
      expect(entry.screen).toBe(mountedScreen);
    }
  });

  it("rejects a featureId outside the contracts FeatureId pattern", () => {
    expect(() => pendingInput({ featureId: "drifted" })).toThrow(/FeatureId/);
    expect(() => pendingInput({ featureId: "Has.Upper" })).toThrow(/FeatureId/);
  });

  it("rejects route paths that are not '/' or a lowercase ascii segment", () => {
    for (const routePath of ["/test/", "/Test", "/projekty-ł", "test", ""]) {
      expect(() => pendingInput({ routePath })).toThrow(/routePath/);
    }
  });

  it("rejects a consumed operation no contract module surface declared", () => {
    expect(() =>
      pendingInput({ consumedOperations: ["drifted.nonexistent"] }),
    ).toThrow(/unknown operation drifted\.nonexistent/);
  });

  it("rejects entries with no operations, no labels or no pending note", () => {
    expect(() => pendingInput({ consumedOperations: [] })).toThrow(/no consumed operations/);
    expect(() => pendingInput({ navLabel: " " })).toThrow(/nav label/);
    expect(() =>
      appFeatureEntry({
        ...commonInput(),
        implementation: "pending",
        pendingNote: " ",
      }),
    ).toThrow(/pending note/);
  });
});

describe("composed feature list invariants", () => {
  it("rejects duplicate feature ids or route paths", () => {
    const a = pendingInput();
    const b = pendingInput({ featureId: "test.other" });
    expect(() => composeAppFeatures([a, b])).toThrow(/duplicate routePath/);
    const c = pendingInput({ routePath: "/other" });
    expect(() => composeAppFeatures([a, c])).toThrow(/duplicate featureId/);
  });

  it("requires exactly one default route, and it must be first", () => {
    const a = pendingInput({ routePath: "/one" });
    const b = pendingInput({ featureId: "test.other", routePath: "/two" });
    expect(() => composeAppFeatures([a, b])).toThrow(/exactly one default route/);
    const d = pendingInput({ featureId: "test.default", routePath: "/" });
    expect(() => composeAppFeatures([a, d])).toThrow(/default route \(\/\) must be the first/);
    expect(composeAppFeatures([d, a])).toHaveLength(2);
  });
});

describe("the shipped host features", () => {
  it("starts at the company conversation default route", () => {
    expect(appFeatures[0]?.routePath).toBe("/");
    expect(appFeatures[0]?.featureId).toBe("conversation.company");
    expect(appFeatures[0]?.navLabel).toBe("Rozmowa firmy");
  });

  it("keeps project context and Co teraz reachable through module entries", () => {
    const paths = appFeatures.map((entry) => entry.routePath);
    expect(paths).toContain("/projekty");
    expect(paths).toContain("/co-teraz");
  });

  it("consumes only operations that exist in the contracts registry", () => {
    for (const entry of appFeatures) {
      expect(entry.consumedOperations.length).toBeGreaterThan(0);
      for (const operation of entry.consumedOperations) {
        expect(operation in operations).toBe(true);
      }
    }
  });

  it("registers every feature as pending with a note, except the mounted lanes (H1 conversation + memory, B3 membership, B4 GM, G1 calendar, F3 notifications, H4 GM processing, H2 work/extensions/co-teraz); only the conversation carries its own placeholder screen", () => {
    // B3 (issue #22) is the first lane to mount a real screen through this
    // registry: the sanctioned sign-in + membership host composition.
    // B4 (issue #23) mounts the audited GM operator surface the same way;
    // G1 (issue #45) mounts the Calendar connection screen; J1 (issue #60)
    // mounted the core-text conversation surface on the default route, and
    // H1 (issue #49) replaced that mount with the full conversation UI and
    // added the memory route; F3 (issue #43) mounts the web push settings
    // screen; H4 (issue #52) mounts the audited GM processing inspector;
    // H2 (issue #50) mounts the work records (/praca), the typed extensions
    // (/dodatkowe) and flips the /co-teraz placeholder to the real per-user
    // screen.
    const mounted = appFeatures.filter((entry) => entry.implementation === "mounted");
    expect(mounted.map((entry) => entry.featureId)).toEqual([
      "conversation.company",
      "memory.project",
      "attention.now",
      "work.records",
      "memory.extensions",
      "access.membership",
      "access.gm",
      "operations.processing",
      "calendar.connection",
      "attention.push",
    ]);
    for (const mountedEntry of mounted) {
      expect(mountedEntry.screen).toBeTypeOf("function");
    }
    for (const entry of appFeatures) {
      if (entry.implementation === "pending") {
        expect(entry.pendingNote.length).toBeGreaterThan(0);
      }
    }
    const conversation = appFeatures[0];
    if (conversation?.implementation === "pending") {
      expect(conversation.pendingScreen).toBeTypeOf("function");
    }
    for (const entry of appFeatures.slice(1)) {
      if (entry.implementation === "pending") {
        expect(entry.pendingScreen).toBeUndefined();
      }
    }
  });
});
