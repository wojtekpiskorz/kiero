/**
 * D4 focused tests: the host registration seam and the configuration
 * append the capture surface consumes.
 *
 * The issue owns both halves of the mount: the feature entry
 * (capture.composer at /wpis, the sibling pattern H1 established) and the
 * one-line composition in app-features; plus the minimal VITE_GATEWAY_URL
 * append to the A4-owned config seam (an optional URL — unset disables
 * media sending honestly, it never breaks the rest of the host).
 *
 * The live halves (the composer against the real Convex deployment, the
 * real gateway Worker and a killed-mid-upload browser tab) run in
 * ./live-proof.mjs against the leased dev deployment and are transcribed
 * into the session report.
 */

import { describe, expect, it } from "vitest";
import { appFeatures } from "../../apps/web/src/app/app-features";
import { captureFeatureEntry } from "../../apps/web/src/app/features/capture/entry";
import { loadAppConfig } from "../../apps/web/src/app/config";

describe("the capture feature registration (D4's host mount)", () => {
  it("registers capture.composer at /wpis as a mounted screen", () => {
    expect(captureFeatureEntry.featureId).toBe("capture.composer");
    expect(captureFeatureEntry.routePath).toBe("/wpis");
    expect(captureFeatureEntry.implementation).toBe("mounted");
    expect(captureFeatureEntry.navLabel).toBe("Nowy wpis");
  });

  it("declares exactly the certified commands the surface issues", () => {
    expect(captureFeatureEntry.consumedOperations).toEqual([
      "sources.prepareUpload",
      "sources.acceptSource",
    ]);
  });

  it("composes into the validated host list without touching the default route", () => {
    const composed = appFeatures;
    expect(composed.map((entry) => entry.featureId)).toContain("capture.composer");
    expect(composed[0]?.routePath).toBe("/");
    expect(composed[0]?.featureId).toBe("conversation.company");
    // One route per feature: the composition validates uniqueness itself;
    // this asserts the capture route did not collide.
    expect(composed.filter((entry) => entry.routePath === "/wpis")).toHaveLength(1);
  });
});

describe("the gateway configuration append (optional, honest)", () => {
  it("stays unconfigured when VITE_GATEWAY_URL is unset or blank", () => {
    expect(loadAppConfig({ VITE_CONVEX_URL: "https://demo.convex.cloud" }).gateway).toEqual({
      state: "unconfigured",
    });
    expect(
      loadAppConfig({ VITE_CONVEX_URL: "https://demo.convex.cloud", VITE_GATEWAY_URL: "   " })
        .gateway,
    ).toEqual({ state: "unconfigured" });
  });

  it("normalizes a valid gateway URL", () => {
    expect(
      loadAppConfig({
        VITE_CONVEX_URL: "https://demo.convex.cloud",
        VITE_GATEWAY_URL: "https://kiero-dev-gateway-d4.workers.dev/",
      }).gateway,
    ).toEqual({ state: "configured", gatewayUrl: "https://kiero-dev-gateway-d4.workers.dev" });
  });

  it("treats an invalid gateway URL as null (degrades only the capture surface)", () => {
    const config = loadAppConfig({
      VITE_CONVEX_URL: "https://demo.convex.cloud",
      VITE_GATEWAY_URL: "not a url",
    });
    expect(config.gateway).toEqual({ state: "unconfigured" });
    expect(config.connection.state).toBe("configured");
  });

  it("never lets the gateway value affect the unconfigured Convex state", () => {
    const config = loadAppConfig({ VITE_GATEWAY_URL: "https://gw.example" });
    expect(config.connection.state).toBe("unconfigured");
    expect(config.gateway).toEqual({ state: "configured", gatewayUrl: "https://gw.example" });
  });
});
