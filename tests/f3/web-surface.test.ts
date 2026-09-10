/**
 * F3 web-surface tests: the shipped service worker keeps the PWA seam's
 * two hard rules (no fetch/cache handler; clicks stay inside the worker's
 * own scope), the host feature entry mounts the Polish screen, and the
 * push module fills the prepared composition slot.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { appFeatures } from "../../apps/web/src/app/app-features";
import { composePwaEntries } from "../../apps/web/src/app/pwa/composition";
import { webPushEntry } from "../../apps/web/src/pwa/push";
import { notificationsCopy } from "../../apps/web/src/features/notifications/state";

const webRoot = path.resolve(fileURLToPath(import.meta.url), "../../..", "apps/web");
const workerSource = readFileSync(path.join(webRoot, "public", "sw.js"), "utf8");

describe("the shipped service worker", () => {
  it("handles push presentation and click-through only", () => {
    expect(workerSource).toMatch(/addEventListener\(\s*["']push["']/);
    expect(workerSource).toMatch(/addEventListener\(\s*["']notificationclick["']/);
  });

  it("installs NO fetch handler and NO cache (protected data stays behind live authorized queries)", () => {
    expect(workerSource).not.toMatch(/addEventListener\(\s*["']fetch["']/);
    expect(workerSource).not.toMatch(/caches\./);
  });

  it("opens only its OWN scope on click, never a payload URL", () => {
    // openWindow's argument is the registration scope, not payload data.
    expect(workerSource).toMatch(/openWindow\(self\.registration\.scope\)/);
    expect(workerSource).not.toMatch(/openWindow\(.*data/);
  });

  it("never marks anything read on click (no server call in the click path)", () => {
    const clickBlock = workerSource.slice(
      workerSource.indexOf("notificationclick"),
      workerSource.indexOf("notificationclick") + 900,
    );
    expect(clickBlock).not.toMatch(/fetch\(|mutation|runMutation/);
  });
});

describe("the host feature entry", () => {
  it("mounts the Polish notifications settings screen at /powiadomienia", () => {
    const entry = appFeatures.find((candidate) => candidate.featureId === "attention.push");
    expect(entry).toBeDefined();
    expect(entry?.routePath).toBe("/powiadomienia");
    expect(entry?.navLabel).toBe("Powiadomienia");
    expect(entry?.implementation).toBe("mounted");
    expect(entry?.consumedOperations).toEqual([
      "attention.registerPushSubscription",
      "attention.revokePushSubscription",
    ]);
  });

  it("the screen copy is Polish and explains recovery without blocking use", () => {
    expect(notificationsCopy.title).toBe("Powiadomienia");
    expect(notificationsCopy.permissionDeniedRecovery).toContain("ustawieniach przeglądarki");
    expect(notificationsCopy.permissionDeniedRecovery).toContain("Aplikacja działa normalnie");
  });
});

describe("the PWA composition slot", () => {
  it("attaches the push module together with the worker script", () => {
    const composition = composePwaEntries({
      serviceWorkerScript: "/sw.js",
      push: webPushEntry,
    });
    expect(composition.serviceWorkerScript).toBe("/sw.js");
    expect(composition.push?.moduleId).toBe("attention.push");
  });

  it("refuses a push module without the owning worker (the prepared rule)", () => {
    expect(() => composePwaEntries({ push: webPushEntry })).toThrow(
      /require a service worker script/,
    );
  });
});
