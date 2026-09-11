/**
 * I7 focused tests: the safe PWA update flow over a structural
 * service-worker surface (a fake registration the tests drive through
 * the real lifecycle: updatefound -> installing -> installed-with-
 * controller). The physical legs (a real served build, a real Chromium,
 * a real waiting worker, a real reload) run in the live proof and the
 * browser test row; these rows pin the state machine and the deferral
 * rules deterministically.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPwaUpdateGate } from "../../apps/web/src/pwa/update/gate";
import {
  resolveRegistration,
  watchServiceWorkerUpdates,
  type RegistrationLike,
  type ServiceWorkerLike,
} from "../../apps/web/src/pwa/update/detector";
import { startUpdateFlow } from "../../apps/web/src/pwa/update/module";
import type { UpdatePromptKind } from "../../apps/web/src/pwa/update/state";
import type { DraftMigrationReport } from "../../apps/web/src/pwa/update/draft-migration";
import type { VersionInfoSource } from "../../apps/web/src/pwa/update/handshake";

/** A worker whose state the test flips. */
function fakeWorker(initial: string): ServiceWorkerLike & { setState(state: string): void } {
  const listeners = new Set<() => void>();
  let state = initial;
  return {
    get state() {
      return state;
    },
    setState(next) {
      state = next;
      for (const listener of listeners) {
        listener();
      }
    },
    addEventListener(_type, listener) {
      listeners.add(listener);
    },
    removeEventListener(_type, listener) {
      listeners.delete(listener);
    },
  };
}

/** A registration the test drives through the real update lifecycle. */
function fakeRegistration(): RegistrationLike & {
  deliverUpdate(): void;
  setWaiting(): void;
  updateCalls(): number;
} {
  const listeners = new Set<() => void>();
  let installing: ServiceWorkerLike | null = null;
  let waiting: ServiceWorkerLike | null = null;
  let updateCalls = 0;
  return {
    scope: "/",
    get installing() {
      return installing;
    },
    get waiting() {
      return waiting;
    },
    addEventListener(_type: string, listener: () => void) {
      listeners.add(listener);
    },
    removeEventListener(_type: string, listener: () => void) {
      listeners.delete(listener);
    },
    update: async () => {
      updateCalls += 1;
    },
    deliverUpdate() {
      installing = fakeWorker("installing");
      for (const listener of listeners) {
        listener();
      }
      (installing as ReturnType<typeof fakeWorker>).setState("installed");
    },
    setWaiting() {
      waiting = fakeWorker("installed");
    },
    updateCalls: () => updateCalls,
  };
}

const emptyReport: DraftMigrationReport = {
  status: "already-current",
  draftRecords: 0,
  migrated: 0,
  alreadyCurrent: 0,
  leftIntact: 0,
  problems: [],
};

/** A recording presenter standing in for the DOM one. */
function recordingPresenter() {
  const shown: UpdatePromptKind[] = [];
  let visible: false | UpdatePromptKind = false;
  let reloadAction: (() => void) | null = null;
  const presenter = {
    shown,
    get visible(): false | UpdatePromptKind {
      return visible;
    },
    lastReloadAction: (): (() => void) | null => reloadAction,
    showPrompt(kind: UpdatePromptKind, actions: { reload(): void }): void {
      visible = kind;
      shown.push(kind);
      reloadAction = actions.reload;
    },
    hide(): void {
      visible = false;
    },
  };
  return presenter;
}

const staticVersionSource = (version: string | null): VersionInfoSource => ({
  readRuntimeVersion: async () => version,
});

describe("the safe-point gate", () => {
  it("holds defer work and release restores safety (idempotent both ways)", () => {
    const gate = createPwaUpdateGate();
    expect(gate.isSafePoint(1_000)).toBe(true);
    const releaseRecording = gate.hold("capture.recording");
    const releaseUpload = gate.hold("capture.uploading");
    gate.hold("capture.recording");
    expect(gate.holders()).toEqual(["capture.recording", "capture.uploading"]);
    expect(gate.isSafePoint(1_000)).toBe(false);
    expect(gate.deferralReason(1_000)).toBe("held-by-work");
    releaseRecording();
    releaseRecording();
    expect(gate.deferralReason(1_000)).toBe("held-by-work");
    releaseUpload();
    expect(gate.isSafePoint(1_000)).toBe(true);
  });

  it("recent editing input defers the prompt inside the settle window", () => {
    const gate = createPwaUpdateGate({ inputSettleMs: 1_500 });
    gate.noteEditingInput(10_000);
    expect(gate.deferralReason(11_000)).toBe("recent-input");
    expect(gate.deferralReason(11_499)).toBe("recent-input");
    expect(gate.deferralReason(11_501)).toBe("");
  });

  it("urgent signals are readable while work holds are open (never gated)", () => {
    const gate = createPwaUpdateGate();
    gate.hold("capture.uploading");
    gate.registerUrgentSignal("session-revoked");
    expect(gate.urgentSignals()).toEqual(["session-revoked"]);
    expect(gate.deferralReason(0)).toBe("held-by-work");
  });
});

describe("update detection", () => {
  beforeEach(() => {
    vi.stubGlobal("navigator", { serviceWorker: { controller: {}, getRegistration: async () => undefined } });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves nothing outside a browser service-worker container", async () => {
    vi.stubGlobal("navigator", {});
    expect(await resolveRegistration("/")).toBeNull();
  });

  it("a first install (no controller) is NOT an update", () => {
    vi.stubGlobal("navigator", { serviceWorker: { controller: null } });
    const registration = fakeRegistration();
    const detections: string[] = [];
    const detector = watchServiceWorkerUpdates(registration, (detection) => {
      detections.push(detection.status);
    });
    registration.deliverUpdate();
    expect(detections).toContain("installing");
    expect(detector.detection.status).toBe("installing");
    detector.stop();
  });

  it("installed-with-controller is a waiting update", () => {
    vi.stubGlobal("navigator", { serviceWorker: { controller: {} } });
    const registration = fakeRegistration();
    const detector = watchServiceWorkerUpdates(registration, () => undefined);
    registration.deliverUpdate();
    expect(detector.detection.status).toBe("waiting");
    detector.stop();
  });

  it("poll re-derives a waiting worker AND still checks for chained updates", async () => {
    vi.stubGlobal("navigator", { serviceWorker: { controller: {} } });
    const registration = fakeRegistration();
    const detector = watchServiceWorkerUpdates(registration, () => undefined);
    registration.setWaiting();
    await detector.poll();
    expect(detector.detection.status).toBe("waiting");
    // A waiting worker from an earlier episode must not stop the check.
    expect(registration.updateCalls()).toBe(1);
    detector.stop();
  });
});

describe("the update flow", () => {
  beforeEach(() => {
    const registration = fakeRegistration();
    vi.stubGlobal("navigator", {
      serviceWorker: {
        controller: {},
        getRegistration: async () => registration,
      },
    });
    // No document/window in node: the flow must tolerate their absence.
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("stays silent without an update, then prompts at a safe point and migrates the draft first", async () => {
    const presenter = recordingPresenter();
    const gate = createPwaUpdateGate();
    const flow = await startUpdateFlow(
      { scope: "/" },
      {
        gate,
        presenter,
        versionSource: staticVersionSource("a3.0"),
        prepare: async () => emptyReport,
        reload: () => undefined,
        pollIntervalMs: 0,
        now: () => 5_000,
        sleep: async () => undefined,
      },
    );
    expect(flow.state().detected).toBe("none");
    expect(presenter.visible).toBe(false);

    await flow.pollNow();
    // The fake container reports a waiting worker only after deliverUpdate;
    // poll ran update() (no-op fake). Drive the lifecycle directly:
    const registration = (await resolveRegistration("/")) as unknown as ReturnType<typeof fakeRegistration> | null;
    expect(registration).not.toBeNull();
    registration?.deliverUpdate();

    expect(flow.state().detected).toBe("waiting-worker");
    await flow.evaluateNow();
    expect(presenter.visible).toBe("available");
    // The draft migration ran BEFORE the prompt appeared (bounded order).
    expect(flow.state().draftMigration).toContain("already-current");
    flow.stop();
  });

  it("defers while work holds are open and prompts when they release", async () => {
    const presenter = recordingPresenter();
    const gate = createPwaUpdateGate();
    const releaseRecording = gate.hold("capture.recording");
    const flow = await startUpdateFlow(
      { scope: "/" },
      {
        gate,
        presenter,
        versionSource: null,
        prepare: async () => emptyReport,
        reload: () => undefined,
        pollIntervalMs: 0,
        now: () => 5_000,
        sleep: async () => undefined,
      },
    );
    const registration = (await resolveRegistration("/")) as unknown as ReturnType<typeof fakeRegistration> | null;
    registration?.deliverUpdate();
    await flow.evaluateNow();
    expect(presenter.visible).toBe(false);
    expect(flow.state().deferredReason).toBe("held-by-work");

    releaseRecording();
    await flow.evaluateNow();
    expect(presenter.visible).toBe("available");
    expect(flow.state().deferredReason).toBe("");
    flow.stop();
  });

  it("recent editing input defers the prompt (the settle heuristic)", async () => {
    const presenter = recordingPresenter();
    const gate = createPwaUpdateGate({ inputSettleMs: 2_000 });
    const flow = await startUpdateFlow(
      { scope: "/" },
      {
        gate,
        presenter,
        versionSource: null,
        prepare: async () => emptyReport,
        reload: () => undefined,
        pollIntervalMs: 0,
        now: () => 10_000,
        sleep: async () => undefined,
      },
    );
    gate.noteEditingInput(9_500);
    const registration = (await resolveRegistration("/")) as unknown as ReturnType<typeof fakeRegistration> | null;
    registration?.deliverUpdate();
    await flow.evaluateNow();
    expect(flow.state().deferredReason).toBe("recent-input");
    expect(presenter.visible).toBe(false);
    flow.stop();
  });

  it("an unsupported client (handshake) shows the REQUIRED prompt and wins over a waiting worker", async () => {
    const presenter = recordingPresenter();
    const flow = await startUpdateFlow(
      { scope: "/" },
      {
        presenter,
        versionSource: staticVersionSource("a4.0"),
        prepare: async () => emptyReport,
        reload: () => undefined,
        pollIntervalMs: 0,
        now: () => 5_000,
        sleep: async () => undefined,
      },
    );
    await flow.pollNow();
    expect(flow.state().detected).toBe("unsupported-client");
    expect(presenter.visible).toBe("required");
    flow.stop();
  });

  it("never reloads on its own: only the prompt's action reloads, after flush and prepare", async () => {
    const presenter = recordingPresenter();
    const reloads: number[] = [];
    const prepared: string[] = [];
    const events: string[] = [];
    vi.stubGlobal("window", {
      addEventListener: () => undefined,
      dispatchEvent: (event: unknown) => {
        events.push(String((event as { type?: string }).type ?? "unknown"));
        return true;
      },
    });
    const flow = await startUpdateFlow(
      { scope: "/" },
      {
        presenter,
        versionSource: null,
        prepare: async () => {
          prepared.push("prepare");
          return emptyReport;
        },
        reload: () => reloads.push(Date.now()),
        pollIntervalMs: 0,
        settleMs: 5,
        now: () => 5_000,
        sleep: async () => {
          prepared.push("settled");
        },
      },
    );
    const registration = (await resolveRegistration("/")) as unknown as ReturnType<typeof fakeRegistration> | null;
    registration?.deliverUpdate();
    await flow.evaluateNow();
    expect(reloads).toHaveLength(0);

    presenter.lastReloadAction()?.();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(reloads).toHaveLength(1);
    expect(flow.state().reloads).toBe(1);
    // The bounded order: pagehide flush FIRST, then prepare, then reload.
    expect(events).toEqual(["pagehide"]);
    expect(prepared).toEqual(["prepare", "settled"]);
    flow.stop();
    vi.stubGlobal("window", undefined);
  });

  it("stop() hides the prompt and ends the flow", async () => {
    const presenter = recordingPresenter();
    const flow = await startUpdateFlow(
      { scope: "/" },
      {
        presenter,
        versionSource: null,
        prepare: async () => emptyReport,
        reload: () => undefined,
        pollIntervalMs: 0,
        now: () => 5_000,
        sleep: async () => undefined,
      },
    );
    const registration = (await resolveRegistration("/")) as unknown as ReturnType<typeof fakeRegistration> | null;
    registration?.deliverUpdate();
    await flow.evaluateNow();
    expect(presenter.visible).toBe("available");
    flow.stop();
    expect(presenter.visible).toBe(false);
    await flow.evaluateNow();
    expect(flow.state().promptShown).toBe("available");
  });
});
