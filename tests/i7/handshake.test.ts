/**
 * I7 focused tests: the backend version handshake and the drift guards
 * that keep the update module honest against its siblings (the runtime
 * version constant, D4's draft database name, F3's untouched worker, the
 * A4 composition wiring).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { RUNTIME_VERSION } from "@kiero/runtime";
import {
  CLIENT_EXPECTED_RUNTIME_VERSION,
  convexSiteUrlFromCloudUrl,
  decideRuntimeHandshake,
} from "../../apps/web/src/pwa/update/handshake";
import { webUpdateEntry } from "../../apps/web/src/pwa/update/module";
import {
  DRAFTS_DB_NAME,
  DRAFTS_STORE_NAME,
} from "../../apps/web/src/pwa/update/draft-migration";
import { composePwaEntries } from "../../apps/web/src/app/pwa/composition";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const webSrc = path.join(repoRoot, "apps/web", "src");

describe("the runtime handshake", () => {
  it("derives the site URL from the cloud URL only", () => {
    expect(convexSiteUrlFromCloudUrl("https://wandering-eel-569.eu-west-1.convex.cloud")).toBe(
      "https://wandering-eel-569.eu-west-1.convex.site",
    );
    expect(convexSiteUrlFromCloudUrl("https://wandering-eel-569.eu-west-1.convex.cloud/")).toBe(
      "https://wandering-eel-569.eu-west-1.convex.site",
    );
    expect(convexSiteUrlFromCloudUrl("http://localhost:5173")).toBeNull();
    expect(convexSiteUrlFromCloudUrl("not a url")).toBeNull();
  });

  it("decides support by major runtime; unparseable servers answer unavailable", () => {
    expect(decideRuntimeHandshake("a3.0", "a3.0")).toMatchObject({ status: "supported" });
    expect(decideRuntimeHandshake("a3.0", "a3.1")).toMatchObject({ status: "supported" });
    expect(decideRuntimeHandshake("a3.0", "a2.9")).toMatchObject({ status: "supported" });
    expect(decideRuntimeHandshake("a3.0", "3.0")).toMatchObject({ status: "supported" });
    expect(decideRuntimeHandshake("a3.0", "a4.0")).toMatchObject({ status: "unsupported" });
    expect(decideRuntimeHandshake("a3.0", null)).toMatchObject({ status: "unavailable" });
    expect(decideRuntimeHandshake("a3.0", "banana")).toMatchObject({ status: "unavailable" });
  });

  it("refuses a non-version CLIENT expectation loudly", () => {
    expect(() => decideRuntimeHandshake("banana", "a3.0")).toThrow(/is not a version/);
  });

  it("the bundled expectation never drifts from @kiero/runtime", () => {
    expect(CLIENT_EXPECTED_RUNTIME_VERSION).toBe(RUNTIME_VERSION);
  });
});

describe("drift guards against sibling-owned constants", () => {
  it("the draft migration mirrors D4's private DB and store names", () => {
    const storeSource = readFileSync(path.join(webSrc, "storage", "drafts", "store.ts"), "utf8");
    expect(storeSource).toMatch(/const DB_NAME = "kiero-drafts"/);
    expect(storeSource).toMatch(/const STORE = "entries"/);
    expect(DRAFTS_DB_NAME).toBe("kiero-drafts");
    expect(DRAFTS_STORE_NAME).toBe("entries");
    // The draft metadata key suffix D4 builds user keys with.
    expect(storeSource).toMatch(/`\$\{userId\}#draft`/);
  });

  it("the shipped service worker stays F3's (no fetch, no cache, no skipWaiting channel)", () => {
    const worker = readFileSync(
      path.join(repoRoot, "apps", "web", "public", "sw.js"),
      "utf8",
    );
    expect(worker).toMatch(/addEventListener\(\s*["']push["']/);
    expect(worker).toMatch(/addEventListener\(\s*["']notificationclick["']/);
    // I7 added nothing to the worker: no fetch handler, no cache, no
    // message/SKIP_WAITING channel (activation stays takeover-on-reload).
    expect(worker).not.toMatch(/addEventListener\(\s*["']fetch["']/);
    expect(worker).not.toMatch(/caches\./);
    expect(worker).not.toMatch(/addEventListener\(\s*["']message["']/);
    expect(worker).not.toMatch(/SKIP_WAITING/i);
    expect(worker).not.toMatch(/skipWaiting/i);
    expect(worker).not.toMatch(/clients\.claim/i);
  });

  it("the update module fills the composition slot and the host wiring attaches it", () => {
    expect(webUpdateEntry.moduleId).toBe("update.pwa");
    const composition = composePwaEntries({
      serviceWorkerScript: "/sw.js",
      update: webUpdateEntry,
    });
    expect(composition.update?.moduleId).toBe("update.pwa");
    // The prepared seam still refuses modules without their worker.
    expect(() => composePwaEntries({ update: webUpdateEntry })).toThrow(
      /service worker script/,
    );

    const mainSource = readFileSync(path.join(webSrc, "main.tsx"), "utf8");
    expect(mainSource).toMatch(/update:\s*webUpdateEntry/);
    expect(mainSource).toMatch(/configureUpdateVersionSource\(versionSourceFromAppConfig\(config\)\)/);
    // The composition's register path now hands the registration to the
    // module hooks (the flagged I7 append).
    const compositionSource = readFileSync(
      path.join(webSrc, "app", "pwa", "composition.ts"),
      "utf8",
    );
    expect(compositionSource).toMatch(/promptAtSafePoint\(registration\)/);
    expect(compositionSource).toMatch(/push\.register\(registration\)/);
  });
});
