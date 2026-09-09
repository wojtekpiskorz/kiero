/**
 * PWA manifest/service-worker entry composition (A4 preparation).
 *
 * This module only PREPARES the composition seams; it registers nothing
 * yet. F3 owns the push module, I7 owns the update behavior, and the
 * manifest/service-worker scripts arrive with them. Two hard rules are
 * encoded here for those lanes:
 *
 * - a service worker is registered only through this composition, never
 *   ad-hoc from a feature;
 * - no service-worker cache may serve protected data in a way that
 *   bypasses current access checks (execution charter / issue 19 AC):
 *   protected reads stay behind live authorized queries. Stated here for
 *   F3/I7; nothing in this module enforces it.
 *
 * The module deliberately avoids DOM global types (structural handle,
 * globalThis probing) so the node-side test program can import it without
 * a DOM lib.
 */

/** Structural stand-in for a service worker registration handle. */
export interface ServiceWorkerRegistrationHandle {
  /** The registration's scope URL. */
  readonly scope: string;
}

/** Push handling module slot (F3 owns the implementation). */
export interface PushEntryModule {
  /** FeatureId-pattern identifier of the owning module (e.g. `push.webPush`). */
  readonly moduleId: string;
  /** Registers push handling on an active service worker registration. */
  register(registration: ServiceWorkerRegistrationHandle): Promise<void>;
}

/** Update behavior module slot (I7 owns the implementation). */
export interface UpdateEntryModule {
  /** FeatureId-pattern identifier of the owning module (e.g. `update.pwa`). */
  readonly moduleId: string;
  /** Prompts a PWA update at a safe point (never during recording/upload). */
  promptAtSafePoint(registration: ServiceWorkerRegistrationHandle): Promise<void>;
}

/** The composed PWA entry plan the host acts on. */
export interface PwaComposition {
  /** Web app manifest path, or null while no manifest is shipped. */
  readonly manifestPath: string | null;
  /** Service worker script path, or null while no worker is shipped. */
  readonly serviceWorkerScript: string | null;
  readonly push: PushEntryModule | null;
  readonly update: UpdateEntryModule | null;
}

/**
 * Composes the PWA entries. Today every slot is null: no worker exists,
 * so nothing is registered and no cache can exist. F3/I7 attach their
 * modules together with the worker script that owns them.
 */
export function composePwaEntries(input: {
  readonly manifestPath?: string | null;
  readonly serviceWorkerScript?: string | null;
  readonly push?: PushEntryModule | null;
  readonly update?: UpdateEntryModule | null;
} = {}): PwaComposition {
  const serviceWorkerScript = input.serviceWorkerScript ?? null;
  const modulesWithoutWorker =
    (input.push !== null && input.push !== undefined) ||
    (input.update !== null && input.update !== undefined);
  if (serviceWorkerScript === null && modulesWithoutWorker) {
    throw new Error(
      "pwa composition: push/update modules require a service worker script; attach them together with the owning worker",
    );
  }
  return {
    manifestPath: input.manifestPath ?? null,
    serviceWorkerScript,
    push: input.push ?? null,
    update: input.update ?? null,
  };
}

/** Minimal service worker container surface this seam registers through. */
interface ServiceWorkerContainerLike {
  register(scriptUrl: string): Promise<ServiceWorkerRegistrationHandle>;
}

function serviceWorkerContainer(): ServiceWorkerContainerLike | undefined {
  const navigator = (globalThis as { navigator?: { serviceWorker?: ServiceWorkerContainerLike } })
    .navigator;
  return navigator?.serviceWorker;
}

/**
 * Registers the composed service worker plan. A no-op while no script is
 * composed (today); outside browsers it also stays a no-op.
 */
export async function registerPwa(composition: PwaComposition): Promise<void> {
  if (composition.serviceWorkerScript === null) {
    return;
  }
  const container = serviceWorkerContainer();
  if (container === undefined) {
    return;
  }
  await container.register(composition.serviceWorkerScript);
}
