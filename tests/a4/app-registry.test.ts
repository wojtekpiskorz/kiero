/**
 * Host feature-entry registry tests (A4).
 *
 * Proves the registry enforces the registration contract loudly (aligned
 * with @kiero/contracts: FeatureId discipline, operations that exist) and
 * that the SHIPPED composition is valid, honest and starts at the company
 * conversation. The composed list and entry modules are intentionally
 * JSX-free so this node program can import the real thing.
 */

import { describe, expect, it } from "vitest";
import { features as contractFeatures, operations } from "@kiero/contracts";
import { appFeatures } from "../../apps/web/src/app/app-features";
import {
  appFeatureEntry,
  composeAppFeatures,
  contractFeatureRegistration,
  type AppFeatureEntryInput,
} from "../../apps/web/src/app/registry";

const dummyScreen = () => null;

function entryInput(overrides: Partial<AppFeatureEntryInput> = {}): AppFeatureEntryInput {
  return {
    kind: "app_feature",
    featureId: "test.feature",
    routePath: "/test",
    navLabel: "Test",
    screenHeading: "Test",
    pendingNote: "Funkcja testowa jest w przygotowaniu.",
    consumedOperations: ["platform.probeEcho"],
    implementation: "pending",
    screen: dummyScreen,
    ...overrides,
  };
}

describe("app feature entry validation", () => {
  it("accepts a valid entry and brands the feature id", () => {
    const entry = appFeatureEntry(entryInput());
    expect(entry.featureId).toBe("test.feature");
    expect(entry.routePath).toBe("/test");
  });

  it("rejects a featureId outside the contracts FeatureId pattern", () => {
    expect(() => appFeatureEntry(entryInput({ featureId: "drifted" }))).toThrow(/FeatureId/);
    expect(() => appFeatureEntry(entryInput({ featureId: "Has.Upper" }))).toThrow(/FeatureId/);
  });

  it("rejects route paths that are not '/' or a lowercase ascii segment", () => {
    for (const routePath of ["/test/", "/Test", "/projekty-ł", "test", ""]) {
      expect(() => appFeatureEntry(entryInput({ routePath }))).toThrow(/routePath/);
    }
  });

  it("rejects a consumed operation no contract module surface declared", () => {
    expect(() =>
      appFeatureEntry(entryInput({ consumedOperations: ["drifted.nonexistent"] })),
    ).toThrow(/unknown operation drifted\.nonexistent/);
  });

  it("rejects entries with no operations, no labels or no honest pending note", () => {
    expect(() => appFeatureEntry(entryInput({ consumedOperations: [] }))).toThrow(
      /no consumed operations/,
    );
    expect(() => appFeatureEntry(entryInput({ navLabel: " " }))).toThrow(/nav label/);
    expect(() => appFeatureEntry(entryInput({ pendingNote: "" }))).toThrow(/pending note/);
  });
});

describe("composed feature list invariants", () => {
  it("rejects duplicate feature ids or route paths", () => {
    const a = appFeatureEntry(entryInput());
    const b = appFeatureEntry(entryInput({ featureId: "test.other" }));
    expect(() => composeAppFeatures([a, b])).toThrow(/duplicate routePath/);
    const c = appFeatureEntry(entryInput({ routePath: "/other" }));
    expect(() => composeAppFeatures([a, c])).toThrow(/duplicate featureId/);
  });

  it("requires exactly one default route, and it must be first", () => {
    const a = appFeatureEntry(entryInput({ routePath: "/one" }));
    const b = appFeatureEntry(entryInput({ featureId: "test.other", routePath: "/two" }));
    expect(() => composeAppFeatures([a, b])).toThrow(/exactly one default route/);
    const d = appFeatureEntry(entryInput({ featureId: "test.default", routePath: "/" }));
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

  it("registers every feature as pending with a mounted screen (no fake successes)", () => {
    for (const entry of appFeatures) {
      expect(entry.implementation).toBe("pending");
      expect(typeof entry.screen).toBe("function");
      expect(entry.pendingNote.length).toBeGreaterThan(0);
    }
  });
});

describe("backend registration alignment seam", () => {
  it("resolves a contracts feature registration when one exists", () => {
    const registered = contractFeatureRegistration(
      appFeatureEntry(entryInput({ featureId: "platform.echo" })).featureId,
    );
    expect(registered?.kind).toBe("feature");
    expect(contractFeatures.map((feature) => feature.featureId)).toContain("platform.echo");
  });

  it("is honestly null for a host feature no backend lane registered yet", () => {
    expect(
      contractFeatureRegistration(appFeatures[0]!.featureId),
    ).toBeNull();
  });
});
