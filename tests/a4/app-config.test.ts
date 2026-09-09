/**
 * Client config seam and PWA entry composition tests (A4).
 *
 * The config seam is the only reader of VITE_* values; these tests pin
 * its three-state behavior (configured / unconfigured /
 * misconfigured). The PWA composition tests pin that nothing registers
 * while no service worker is shipped, and that push/update modules cannot
 * attach without their owning worker script.
 */

import { describe, expect, it } from "vitest";
import { loadAppConfig } from "../../apps/web/src/app/config";
import { composePwaEntries } from "../../apps/web/src/app/pwa/composition";

describe("loadAppConfig", () => {
  it("is unconfigured when VITE_CONVEX_URL is absent, blank or not a string", () => {
    expect(loadAppConfig({}).connection.state).toBe("unconfigured");
    expect(loadAppConfig({ VITE_CONVEX_URL: "   " }).connection.state).toBe("unconfigured");
    expect(loadAppConfig({ VITE_CONVEX_URL: 42 }).connection.state).toBe("unconfigured");
  });

  it("configures and normalizes a valid http(s) URL", () => {
    const configured = loadAppConfig({ VITE_CONVEX_URL: "https://demo.convex.cloud" });
    expect(configured.connection).toEqual({
      state: "configured",
      convexUrl: "https://demo.convex.cloud",
    });
    const normalized = loadAppConfig({
      VITE_CONVEX_URL: "https://demo.convex.cloud/",
    });
    expect(normalized.connection).toEqual({
      state: "configured",
      convexUrl: "https://demo.convex.cloud",
    });
  });

  it("is misconfigured with safe-to-show copy for an invalid URL", () => {
    for (const bad of ["not a url", "ftp://backend.example", "https", ""]) {
      // ("" is blank -> unconfigured, excluded below)
      if (bad === "") continue;
      const config = loadAppConfig({ VITE_CONVEX_URL: bad });
      expect(config.connection.state).toBe("misconfigured");
      if (config.connection.state === "misconfigured") {
        expect(config.connection.problem).toContain("VITE_CONVEX_URL");
      }
    }
    expect(loadAppConfig({ VITE_CONVEX_URL: "" }).connection.state).toBe("unconfigured");
  });
});

describe("composePwaEntries", () => {
  const pushModule = {
    moduleId: "push.webPush",
    register: async () => {},
  };

  it("composes an all-null plan while no service worker is shipped", () => {
    const composition = composePwaEntries();
    expect(composition).toEqual({
      manifestPath: null,
      serviceWorkerScript: null,
      push: null,
      update: null,
    });
  });

  it("refuses push/update modules without their owning worker script", () => {
    expect(() => composePwaEntries({ push: pushModule })).toThrow(/service worker script/);
  });

  it("accepts modules together with the worker script that owns them", () => {
    const composition = composePwaEntries({
      serviceWorkerScript: "/sw.js",
      push: pushModule,
    });
    expect(composition.serviceWorkerScript).toBe("/sw.js");
    expect(composition.push?.moduleId).toBe("push.webPush");
    expect(composition.update).toBeNull();
  });
});
