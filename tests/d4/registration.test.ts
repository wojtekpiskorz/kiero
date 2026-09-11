/**
 * D4 focused tests: the host registration seam and the configuration
 * append the capture surface consumes.
 *
 * The issue owned both halves of the original mount: the feature entry
 * (capture.composer at /wpis, the sibling pattern H1 established) and the
 * one-line composition in app-features; plus the minimal VITE_GATEWAY_URL
 * append to the A4-owned config seam (an optional URL — unset disables
 * media sending honestly, it never breaks the rest of the host).
 *
 * J2 amendment (issue #61, flagged): the /wpis route retired when the
 * composer joined the conversation surface; the registration assertions
 * now pin the RETIRED state (no capture.composer entry composes, the
 * conversation carries the composer's commands) while the configuration
 * seam keeps its original guarantees.
 *
 * The live halves (the composer against the real Convex deployment, the
 * real gateway Worker and a killed-mid-upload browser tab) run in
 * ./live-proof.mjs against the leased dev deployment and are transcribed
 * into the session report.
 */

import { describe, expect, it } from "vitest";
import { appFeatures } from "../../apps/web/src/app/app-features";
import { loadAppConfig } from "../../apps/web/src/app/config";

describe("the capture feature registration after J2's join", () => {
  it("retires the separate /wpis route: no capture.composer entry composes", () => {
    expect(appFeatures.map((entry) => entry.featureId)).not.toContain("capture.composer");
    expect(appFeatures.some((entry) => entry.routePath === "/wpis")).toBe(false);
  });

  it("keeps the conversation the default route that carries the composer", () => {
    expect(appFeatures[0]?.routePath).toBe("/");
    expect(appFeatures[0]?.featureId).toBe("conversation.company");
    // The composer's commands ride the conversation entry now.
    expect([...(appFeatures[0]?.consumedOperations ?? [])]).toEqual(
      expect.arrayContaining(["sources.prepareUpload", "sources.acceptSource"]),
    );
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
