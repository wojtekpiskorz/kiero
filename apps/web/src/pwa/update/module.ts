/**
 * The PWA update module (I7): fills A4's prepared UpdateEntryModule slot
 * and composes the whole safe-update flow.
 *
 * The order is the issue's bounded solution, verbatim: DETECT a new
 * version, PERSIST/MIGRATE the local draft first, and SHOW a Polish
 * update prompt only at a safe point. Concretely, per evaluation tick:
 *
 * 1. DETECT: a waiting service worker (a new client version installed)
 *    and/or the backend handshake answering "unsupported" for this build;
 *    "unsupported" is the stronger kind and wins.
 * 2. GATE: the prompt appears only when the safe-point gate agrees (no
 *    work holds, input settled, page visible). This module NEVER
 *    auto-reloads: the reload happens solely on the prompt's button.
 * 3. PREPARE (once, before the first prompt shows): the client draft
 *    store migrates to the current record schema (D4's store is read
 *    through IndexedDB, never edited); the prompt's Polish copy can then
 *    honestly say the szkic stays recoverable.
 * 4. RELOAD (user click only): dispatch the pagehide flush contract so
 *    any lagging debounced text persists (D4's composer listens on the
 *    window), re-run prepare, give the IndexedDB commit its settle
 *    window, then reload. The real pagehide of the reload fires D4's
 *    flush again natively; the waiting worker activates as the old
 *    client goes away (no skipWaiting exists or is needed).
 *
 * Urgent signals (session revocation and friends) register on the gate
 * and are readable immediately regardless of holds; they are surfaced to
 * the flow state, never deferred, and never rendered by this module
 * (they belong to the auth surfaces).
 *
 * Structural DOM types throughout (the A4 pattern) so node-side test
 * programs import this chain without a DOM lib.
 */

import type {
  ServiceWorkerRegistrationHandle,
  UpdateEntryModule,
} from "../../app/pwa/composition";
import { createPwaUpdateGate, type PwaUpdateGate } from "./gate";
import {
  resolveRegistration,
  watchServiceWorkerUpdates,
  type RegistrationLike,
  type UpdateDetector,
} from "./detector";
import {
  CLIENT_EXPECTED_RUNTIME_VERSION,
  decideRuntimeHandshake,
  fetchHealthVersionSource,
  convexSiteUrlFromCloudUrl,
  type VersionInfoSource,
} from "./handshake";
import { migrateBrowserDraftStore, type DraftMigrationReport } from "./draft-migration";
import { updateCopy, type UpdateFlowState, type UpdatePromptKind } from "./state";
import type { AppConfig } from "../../app/config";

// ---------------------------------------------------------------------------
// Structural DOM surfaces
// ---------------------------------------------------------------------------

interface ElementLike {
  setAttribute(name: string, value: string): void;
  textContent: string;
  appendChild(child: ElementLike): ElementLike;
  addEventListener(type: string, listener: () => void): void;
  remove(): void;
}

interface DocumentLike {
  createElement(tagName: string): ElementLike;
  body: ElementLike | null;
  addEventListener(type: string, listener: () => void): void;
  readonly visibilityState: string;
}

interface WindowLike {
  addEventListener(type: string, listener: () => void): void;
  dispatchEvent(event: unknown): boolean;
}

function documentSurface(): DocumentLike | undefined {
  // Normalized: absent surfaces answer undefined, never null or missing.
  return (globalThis as { document?: DocumentLike }).document ?? undefined;
}

function windowSurface(): WindowLike | undefined {
  return (globalThis as { window?: WindowLike }).window ?? undefined;
}

// ---------------------------------------------------------------------------
// The prompt presenter (barebones DOM; no styling, semantic elements)
// ---------------------------------------------------------------------------

/** What a presenter must do (tests inject a recording fake). */
export interface UpdatePromptPresenter {
  showPrompt(kind: UpdatePromptKind, actions: { reload(): void }): void;
  hide(): void;
  readonly visible: false | UpdatePromptKind;
}

/** Creates the DOM presenter: a polite status region appended to the body. */
export function createDomPromptPresenter(): UpdatePromptPresenter {
  const document = documentSurface();
  let root: ElementLike | null = null;
  let kind: false | UpdatePromptKind = false;
  return {
    get visible() {
      return kind;
    },
    showPrompt(nextKind, actions) {
      this.hide();
      const doc = document ?? documentSurface();
      if (doc === undefined) {
        return;
      }
      kind = nextKind;
      root = doc.createElement("div");
      root.setAttribute("role", "status");
      root.setAttribute("aria-live", "polite");
      root.setAttribute("aria-label", updateCopy.regionLabel);
      const heading = doc.createElement("p");
      heading.textContent =
        nextKind === "required" ? updateCopy.requiredHeading : updateCopy.availableHeading;
      const body = doc.createElement("p");
      body.textContent =
        nextKind === "required" ? updateCopy.requiredBody : updateCopy.availableBody;
      const button = doc.createElement("button");
      button.textContent =
        nextKind === "required" ? updateCopy.requiredButton : updateCopy.availableButton;
      button.addEventListener("click", () => actions.reload());
      root.appendChild(heading);
      root.appendChild(body);
      root.appendChild(button);
      if (doc.body !== null && doc.body !== undefined) {
        doc.body.appendChild(root);
      }
    },
    hide() {
      if (root !== null) {
        root.remove();
        root = null;
      }
      kind = false;
    },
  };
}

// ---------------------------------------------------------------------------
// The flow
// ---------------------------------------------------------------------------

/** Everything the flow accepts from its host (tests inject fakes). */
export interface UpdateFlowOptions {
  readonly gate?: PwaUpdateGate;
  /** null disables the handshake leg (no backend configured). */
  readonly versionSource?: VersionInfoSource | null;
  readonly presenter?: UpdatePromptPresenter;
  /** Pre-update draft migration (the default runs the real IndexedDB one). */
  readonly prepare?: () => Promise<DraftMigrationReport>;
  readonly reload?: () => void;
  readonly pollIntervalMs?: number;
  /** Settle window for the unload-time IndexedDB commit before reload. */
  readonly settleMs?: number;
  readonly now?: () => number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The running flow's control surface. */
export interface UpdateFlowHandle {
  readonly gate: PwaUpdateGate;
  /** One evaluation tick (timers call it; tests call it directly). */
  evaluateNow(): Promise<void>;
  /** One detection poll (worker update check + handshake read). */
  pollNow(): Promise<void>;
  state(): UpdateFlowState;
  stop(): void;
}

function defaultNow(): number {
  return Date.now();
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultReload(): void {
  const location = (globalThis as { location?: { reload(): void } }).location;
  location?.reload();
}

function reportSummary(report: DraftMigrationReport): string {
  return `${report.status} records=${report.draftRecords} migrated=${report.migrated} intact=${report.leftIntact}`;
}

/** Builds a synthetic pagehide event when this runtime has an Event. */
function syntheticPageHide(): unknown {
  const eventConstructor = (globalThis as { Event?: new (type: string) => unknown }).Event;
  return eventConstructor === undefined ? null : new eventConstructor("pagehide");
}

/**
 * The per-tab "this update episode was already accepted" mark. Chromium
 * keeps the controlling worker across reloads (no skipWaiting exists by
 * design), so after an accepted reload the waiting worker can still be
 * the SAME episode; the app content is already new (the worker installs
 * no fetch handler, every asset comes fresh from the network), and the
 * prompt must not nag about the stale episode. The mark lives in
 * sessionStorage: it survives the reload and dies with the tab, which is
 * exactly the episode boundary; a genuinely NEW waiting worker in the
 * same tab prompts again.
 */
const UPDATE_ACCEPTED_KEY = "kieroUpdateAccepted";

interface SessionStorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function sessionStorageSurface(): SessionStorageLike | undefined {
  return (globalThis as { sessionStorage?: SessionStorageLike }).sessionStorage ?? undefined;
}

/**
 * Starts the safe-update flow for one service-worker scope. Resolves once
 * the flow is wired; the ticking continues in the background until stop().
 */
export async function startUpdateFlow(
  registrationHandle: ServiceWorkerRegistrationHandle,
  options: UpdateFlowOptions = {},
): Promise<UpdateFlowHandle> {
  const now = options.now ?? defaultNow;
  const sleep = options.sleep ?? defaultSleep;
  const pollIntervalMs = options.pollIntervalMs ?? 60_000;
  const settleMs = options.settleMs ?? 250;
  const gate = options.gate ?? createPwaUpdateGate();
  const presenter = options.presenter ?? createDomPromptPresenter();
  const prepare = options.prepare ?? (async () => migrateBrowserDraftStore());
  const reload = options.reload ?? defaultReload;
  const versionSource = options.versionSource ?? null;

  let detector: UpdateDetector | null = null;
  let detected: UpdateFlowState["detected"] = "none";
  let unsupportedClient = false;
  let promptShown: false | UpdatePromptKind = false;
  let deferredReason: UpdateFlowState["deferredReason"] = "";
  let draftMigrationSummary: string | null = null;
  let reloads = 0;
  let prepareRun: Promise<void> | null = null;
  let stopped = false;
  // An update episode this tab already accepted (see UPDATE_ACCEPTED_KEY):
  // consumes the storage mark once and stays until the detection clears.
  let acceptedEpisode = false;
  const storage = sessionStorageSurface();
  if (storage !== undefined && storage.getItem(UPDATE_ACCEPTED_KEY) === "1") {
    storage.removeItem(UPDATE_ACCEPTED_KEY);
    acceptedEpisode = true;
  }

  const resolveDetector = async (): Promise<void> => {
    if (detector !== null || stopped) {
      return;
    }
    const registration: RegistrationLike | null = await resolveRegistration(
      registrationHandle.scope,
    );
    if (registration === null || stopped) {
      return;
    }
    detector = watchServiceWorkerUpdates(registration, (detection) => {
      const next = detection.status === "waiting" ? "waiting-worker" : "none";
      if (next !== detected && next === "none") {
        // The episode ended (worker activated or was replaced by nothing):
        // a future waiting worker is a new episode and may prompt again.
        acceptedEpisode = false;
      }
      detected = next;
    });
  };

  const runPrepareOnce = (): Promise<void> => {
    prepareRun ??= prepare().then((report) => {
      draftMigrationSummary = reportSummary(report);
    });
    return prepareRun;
  };

  const performUpdate = async (): Promise<void> => {
    reloads += 1;
    // The flush contract: D4's composer flushes lagging debounced text on
    // pagehide; dispatching it now (same task as the click, before the
    // reload begins) gives that write its head start. The reload's own
    // pagehide fires the same listener natively.
    const window = windowSurface();
    const pageHide = syntheticPageHide();
    if (window !== undefined && pageHide !== null) {
      window.dispatchEvent(pageHide);
    }
    await runPrepareOnce();
    storage?.setItem(UPDATE_ACCEPTED_KEY, "1");
    if (settleMs > 0) {
      await sleep(settleMs);
    }
    reload();
  };

  const evaluateNow = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    await resolveDetector();
    const kind: UpdatePromptKind | null = unsupportedClient
      ? "required"
      : detected === "waiting-worker"
        ? "available"
        : null;
    // Every "not now" path: hide any shown prompt and record why, so the
    // state stays honest about the moment the prompt went away.
    const defer = (reason: UpdateFlowState["deferredReason"]): void => {
      presenter.hide();
      promptShown = false;
      deferredReason = reason;
    };
    if (kind === null) {
      defer("");
      return;
    }
    const document = documentSurface();
    if (document !== undefined && document.visibilityState === "hidden") {
      defer("not-visible");
      return;
    }
    const reason = gate.deferralReason(now());
    if (reason !== "") {
      defer(reason);
      return;
    }
    deferredReason = "";
    if (kind === "available" && acceptedEpisode) {
      // This tab already accepted this worker episode (the reload handed
      // over the new app; the worker swap completes when the tab closes).
      presenter.hide();
      promptShown = false;
      return;
    }
    await runPrepareOnce();
    if (promptShown !== kind) {
      presenter.showPrompt(kind, { reload: () => void performUpdate() });
      promptShown = kind;
    }
  };

  const pollNow = async (): Promise<void> => {
    if (stopped) {
      return;
    }
    await resolveDetector();
    await detector?.poll();
    if (versionSource !== null) {
      const serverRuntime = await versionSource.readRuntimeVersion();
      const handshake = decideRuntimeHandshake(CLIENT_EXPECTED_RUNTIME_VERSION, serverRuntime);
      unsupportedClient = handshake.status === "unsupported";
    }
    await evaluateNow();
  };

  // Host wiring: input tracking (the editing settle heuristic) and the
  // visibility hook both ride real DOM events when they exist.
  const document = documentSurface();
  const inputListener = (): void => gate.noteEditingInput(now());
  document?.addEventListener("input", inputListener);
  document?.addEventListener("keydown", inputListener);
  const window = windowSurface();
  const visibilityListener = (): void => {
    if (documentSurface()?.visibilityState === "visible") {
      void pollNow();
    }
  };
  window?.addEventListener("visibilitychange", visibilityListener);

  const timer: ReturnType<typeof setInterval> | null =
    pollIntervalMs > 0 ? setInterval(() => void pollNow(), pollIntervalMs) : null;

  await pollNow();

  return {
    gate,
    evaluateNow,
    pollNow,
    state: (): UpdateFlowState => ({
      detected: unsupportedClient ? "unsupported-client" : detected,
      deferredReason,
      promptShown,
      urgentSignals: gate.urgentSignals(),
      draftMigration: draftMigrationSummary,
      reloads,
    }),
    stop() {
      stopped = true;
      detector?.stop();
      if (timer !== null) {
        clearInterval(timer);
      }
      presenter.hide();
    },
  };
}

/**
 * Builds the composition entry (A4's prepared slot) around its version
 * source: attaching it together with the service worker script starts
 * the safe-update flow for that worker's scope. This module never
 * registers a worker itself and never modifies the shipped worker
 * script (F3 owns /sw.js). The source arrives here, at attach time
 * (main.tsx passes the typed config seam's answer); a null source means
 * no handshake leg, which is honest for a backend-less host.
 */
export function createWebUpdateEntry(
  versionSource: VersionInfoSource | null,
): UpdateEntryModule {
  return {
    moduleId: "update.pwa",
    promptAtSafePoint: async (registration) => {
      await startUpdateFlow(registration, { versionSource });
    },
  };
}

/**
 * Builds the production version source from the app's Convex websocket
 * URL (the site origin is derived; failures answer "unavailable").
 * Exported for the host wiring and the live proofs.
 */
export function versionSourceFromConvexUrl(convexUrl: string): VersionInfoSource | null {
  const siteUrl = convexSiteUrlFromCloudUrl(convexUrl);
  return siteUrl === null ? null : fetchHealthVersionSource(siteUrl);
}

/**
 * Derives the update version source from the typed app config: a
 * configured Convex URL yields the health-endpoint source; anything else
 * yields null (the handshake leg stays honestly off).
 */
export function versionSourceFromAppConfig(config: AppConfig): VersionInfoSource | null {
  return config.connection.state === "configured"
    ? versionSourceFromConvexUrl(config.connection.convexUrl)
    : null;
}
