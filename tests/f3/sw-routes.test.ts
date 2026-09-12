/**
 * F3/R3 focused verification (issue #128): the shipped service worker's
 * click-through routing, executed for real. tests/f3/web-surface.test.ts
 * pins the structural rules as text; these tests EVALUATE the worker
 * source in a VM with a fake worker self and drive the registered
 * notificationclick handler, so the route matrix runs the actual code:
 *
 * - source, task and clarification targets navigate to the validated
 *   relative same-origin route;
 * - an existing app window is focused and navigated (no new window);
 * - absolute, protocol-relative, cross-origin and unknown routes reject,
 *   and the click opens the worker's OWN scope instead;
 * - the click path performs no fetch and no mutation (never marks read).
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

const webRoot = path.resolve(
  fileURLToPath(import.meta.url),
  "../../..",
  "apps/web",
);
const workerSource = readFileSync(
  path.join(webRoot, "public", "sw.js"),
  "utf8",
);

const SCOPE = "https://app.kiero.example/";

interface FakeWindowClient {
  url: string;
  focused: boolean;
  navigatedTo: string | null;
  focus(): Promise<FakeWindowClient>;
  navigate(url: string): Promise<FakeWindowClient | null>;
}

interface WorkerHarness {
  readonly click: (data: unknown) => Promise<void>;
  readonly openedWindows: readonly string[];
  readonly matchAllCalls: () => number;
  readonly existingClients: FakeWindowClient[];
}

/** Evaluates the worker with a fake self whose clients the test controls. */
function loadWorker(withExistingWindow: boolean): WorkerHarness {
  const listeners = new Map<string, (event: unknown) => void>();
  const openedWindows: string[] = [];
  const existingClients: FakeWindowClient[] = withExistingWindow
    ? [
        {
          url: `${SCOPE}co-teraz`,
          focused: false,
          navigatedTo: null,
          async focus() {
            this.focused = true;
            return this;
          },
          async navigate(url: string) {
            this.navigatedTo = url;
            return this;
          },
        },
      ]
    : [];
  let matchAllCalls = 0;
  const clientsApi = {
    matchAll: async () => {
      matchAllCalls += 1;
      return [...existingClients];
    },
    openWindow: async (url: string) => {
      openedWindows.push(url);
      return null;
    },
  };
  const selfObject = {
    addEventListener: (name: string, handler: (event: unknown) => void) => {
      listeners.set(name, handler);
    },
    registration: { scope: SCOPE },
    clients: clientsApi,
  };
  const context = vm.createContext({
    self: selfObject,
    URL,
    console,
  });
  vm.runInContext(workerSource, context);

  const harness: WorkerHarness = {
    openedWindows,
    matchAllCalls: () => matchAllCalls,
    existingClients,
    click: async (data: unknown) => {
      const handler = listeners.get("notificationclick");
      if (handler === undefined) {
        throw new Error("notificationclick handler not registered");
      }
      let settled: Promise<unknown> | null = null;
      handler({
        notification: { close: () => {}, data },
        waitUntil: (promise: Promise<unknown>) => {
          settled = promise;
        },
      });
      await settled;
    },
  };
  return harness;
}

describe("the shipped service worker click routes", () => {
  it("opens the SOURCE dossier route from its validated relative target", async () => {
    const worker = loadWorker(false);
    await worker.click({ target: "/zrodlo?zrodlo=k1234567890123456789zz" });
    expect(worker.openedWindows).toEqual([
      "/zrodlo?zrodlo=k1234567890123456789zz",
    ]);
  });

  it("opens the TASK record route from its validated relative target", async () => {
    const worker = loadWorker(false);
    await worker.click({ target: "/praca?zadanie=k1234567890123456789zz" });
    expect(worker.openedWindows).toEqual([
      "/praca?zadanie=k1234567890123456789zz",
    ]);
  });

  it("opens the CLARIFICATION route (Co teraz) from its validated target", async () => {
    const worker = loadWorker(false);
    await worker.click({ target: "/co-teraz" });
    expect(worker.openedWindows).toEqual(["/co-teraz"]);
  });

  it("focuses and NAVIGATES an existing app window instead of opening one", async () => {
    const worker = loadWorker(true);
    await worker.click({ target: "/praca?zadanie=k1234567890123456789zz" });
    const client = worker.existingClients[0]!;
    expect(client.focused).toBe(true);
    expect(client.navigatedTo).toBe("/praca?zadanie=k1234567890123456789zz");
    expect(worker.openedWindows).toEqual([]);
  });

  it("focuses an existing window without navigating when the target is invalid", async () => {
    const worker = loadWorker(true);
    await worker.click({ target: "https://evil.example.net/praca" });
    const client = worker.existingClients[0]!;
    expect(client.focused).toBe(true);
    expect(client.navigatedTo).toBeNull();
    expect(worker.openedWindows).toEqual([]);
  });
});

describe("the shipped service worker rejects hostile targets", () => {
  const REJECTED = [
    "https://evil.example.net/zrodlo?zrodlo=k1",
    "http://app.kiero.example/praca",
    "//evil.example.net/co-teraz",
    "/\\evil.example.net/praca",
    "/admin",
    "/zrodlo/..%2fevil",
    "javascript:alert(1)",
    "",
    42,
    null,
  ];

  it("every rejected target opens only the worker's OWN scope", async () => {
    for (const target of REJECTED) {
      const worker = loadWorker(false);
      await worker.click({ target });
      expect(worker.openedWindows, `target ${JSON.stringify(target)}`).toEqual([
        SCOPE,
      ]);
    }
  });

  it("a missing or non-object routing payload opens the scope", async () => {
    const noData = loadWorker(false);
    await noData.click(undefined);
    expect(noData.openedWindows).toEqual([SCOPE]);
    const nullData = loadWorker(false);
    await nullData.click(null);
    expect(nullData.openedWindows).toEqual([SCOPE]);
  });

  it("query extras cannot smuggle a route past the pathname allowlist", async () => {
    const worker = loadWorker(false);
    await worker.click({ target: "/co-teraz?next=/evil" });
    expect(worker.openedWindows).toEqual(["/co-teraz?next=/evil"]);
  });
});

describe("the click path never mutates read state", () => {
  it("contains no fetch and no mutation call anywhere in the worker source", () => {
    expect(workerSource).not.toMatch(/fetch\(/);
    expect(workerSource).not.toMatch(/\bmutation\b/i);
  });

  it("makes no client calls besides matchAll/openWindow/focus/navigate", async () => {
    // The fake self throws loudly if the worker calls anything else on it.
    const worker = loadWorker(true);
    await worker.click({ target: "/zrodlo?zrodlo=k1234567890123456789zz" });
    expect(worker.matchAllCalls()).toBe(1);
    expect(worker.openedWindows).toEqual([]);
  });
});
