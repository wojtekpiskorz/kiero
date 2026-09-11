/**
 * Service-worker update detection (I7): watches one registration for a
 * NEW WAITING worker, the only honest signal a new client version exists
 * in this architecture (F3's worker installs no fetch handler and no
 * cache, so documents always come fresh from the network; the worker's
 * own bytes changing is what an update means).
 *
 * Deliberately NO skipWaiting: the shipped worker (apps/web/public/sw.js,
 * F3-owned) has no message handler and this module never replaces that
 * file. Activation therefore happens the standard way: the waiting
 * worker takes over when the old clients are gone, which is exactly what
 * the user-approved reload provides.
 *
 * Structural DOM-free types (the A4 pattern): node-side test programs can
 * import this chain without a DOM lib.
 */

/** The structural worker surface the detector watches. */
export interface ServiceWorkerLike {
  readonly state: string;
  addEventListener(type: "statechange", listener: () => void): void;
  removeEventListener(type: "statechange", listener: () => void): void;
}

/** The structural registration surface the detector needs. */
export interface RegistrationLike {
  readonly scope: string;
  readonly installing: ServiceWorkerLike | null;
  readonly waiting: ServiceWorkerLike | null;
  addEventListener(type: "updatefound", listener: () => void): void;
  removeEventListener(type: "updatefound", listener: () => void): void;
  /** Asks the browser to re-fetch the worker script now. */
  update(): Promise<void>;
}

/** The structural service-worker container surface (globalThis probing). */
interface ContainerLike {
  getRegistration(scope?: string): Promise<RegistrationLike | undefined>;
  readonly controller: unknown;
}

/** What detection knows at one moment. */
export type UpdateDetection =
  | { readonly status: "idle" }
  | { readonly status: "installing" }
  | { readonly status: "waiting" };

/** Resolves the live container, when this runtime has one. */
function serviceWorkerContainer(): ContainerLike | undefined {
  const navigator = (globalThis as { navigator?: { serviceWorker?: ContainerLike } }).navigator;
  return navigator?.serviceWorker;
}

/** Resolves the real registration for one scope (reading, not registering). */
export async function resolveRegistration(
  scope: string,
): Promise<RegistrationLike | null> {
  const container = serviceWorkerContainer();
  if (container === undefined) {
    return null;
  }
  const registration = await container.getRegistration(scope).catch(() => undefined);
  return registration ?? null;
}

/** Whether a controller already owns this page (a real UPDATE, not a first install). */
export function pageIsControlled(): boolean {
  return serviceWorkerContainer()?.controller !== undefined &&
    serviceWorkerContainer()?.controller !== null;
}

export interface UpdateDetector {
  /** The current detection. */
  readonly detection: UpdateDetection;
  /** Polls the worker script for changes (interval and visibility hooks call this). */
  poll(): Promise<void>;
  /** Stops listening (test teardown). */
  stop(): void;
}

/**
 * Watches one registration: updatefound -> the installing worker's
 * statechange -> "installed" while a controller exists means a WAITING
 * update. A first-ever install (no controller) stays "idle"/"installing".
 */
export function watchServiceWorkerUpdates(
  registration: RegistrationLike,
  sink: (detection: UpdateDetection) => void,
): UpdateDetector {
  let detection: UpdateDetection = registration.waiting !== null && pageIsControlled()
    ? { status: "waiting" }
    : { status: "idle" };
  let stopped = false;
  const stateListener = (): void => {
    if (stopped) {
      return;
    }
    const worker = registration.installing;
    if (worker === null) {
      return;
    }
    if (worker.state === "installed" && pageIsControlled()) {
      detection = { status: "waiting" };
    } else if (worker.state === "installing" || worker.state === "installed") {
      detection = { status: "installing" };
    }
    sink(detection);
  };
  const updateFoundListener = (): void => {
    if (stopped) {
      return;
    }
    const worker = registration.installing;
    if (worker !== null) {
      worker.addEventListener("statechange", stateListener);
    }
    stateListener();
  };
  registration.addEventListener("updatefound", updateFoundListener);
  return {
    get detection() {
      return detection;
    },
    async poll() {
      if (stopped) {
        return;
      }
      // Always ask: a waiting worker from an earlier episode must not stop
      // the check (a chained release installs a NEW worker behind it).
      await registration.update().catch(() => undefined);
      // A waiting worker that appeared while nobody watched (a background
      // browser check or an earlier episode) is still the truth.
      if (registration.waiting !== null && pageIsControlled()) {
        detection = { status: "waiting" };
        sink(detection);
      }
    },
    stop() {
      stopped = true;
      registration.removeEventListener("updatefound", updateFoundListener);
      const worker = registration.installing;
      if (worker !== null) {
        worker.removeEventListener("statechange", stateListener);
      }
    },
  };
}
