/**
 * The host feature-entry registry (A4).
 *
 * This is the UI-side half of the registration contract from A2/A3: lanes
 * B/D/F/G/H each fill one feature entry (their own module entry file under
 * `./features/<name>/`) instead of rewriting a shared App/router file, and
 * `./app-features` composes the list. The shape stays aligned with
 * `@kiero/contracts`:
 *
 * - `featureId` uses the SAME branded `FeatureId` schema the contracts
 *   registry validates against;
 * - `consumedOperations` must name operations that exist in the composed
 *   contracts registry (`@kiero/contracts` `operations`), so a UI entry can
 *   never claim an operation no module surface declared — the same
 *   loud-drift rule the backend registry applies at construction time.
 *
 * The entry is discriminated on `implementation`: a pending entry carries
 * a Polish note (and may carry a richer placeholder screen) and renders
 * "w przygotowaniu" without faking data; a mounted entry carries its real
 * screen. The router dispatches on that tag, so a lane that flips an entry
 * to "mounted" supplies its screen through the type, not through a
 * render-time surprise.
 */

import { Schema } from "effect";
import { FeatureId, operations as contractOperations } from "@kiero/contracts";
import type { ReactNode } from "react";

/**
 * Root-level route path: "/" for the default route, otherwise a lowercase
 * ASCII segment ("/co-teraz"). Diacritics are excluded on purpose so
 * Polish labels never leak into encodable-path problems.
 */
const ROUTE_PATH_PATTERN = /^\/$|^\/[a-z0-9-]+$/;

/** Fields every entry declares, whatever its implementation state. */
export interface AppFeatureCommonInput {
  readonly featureId: string;
  readonly routePath: string;
  readonly navLabel: string;
  readonly screenHeading: string;
  /** Contract operation names this feature consumes once implemented. */
  readonly consumedOperations: readonly string[];
}

/**
 * What an owning lane writes. A pending entry states what is missing; a
 * mounted entry brings the screen that renders it.
 */
export type AppFeatureEntryInput =
  | (AppFeatureCommonInput & {
      readonly implementation: "pending";
      /** Polish note shown while the feature is pending. */
      readonly pendingNote: string;
      /** Richer placeholder screen; defaults to the shared one when omitted. */
      readonly pendingScreen?: (() => ReactNode) | undefined;
    })
  | (AppFeatureCommonInput & {
      readonly implementation: "mounted";
      readonly screen: () => ReactNode;
    });

/** Says the entry shape once: the output is the input with a branded id. */
type WithBrandedFeatureId<T> = T extends unknown
  ? Omit<T, "featureId"> & { readonly featureId: FeatureId }
  : never;

/** The validated entry the host composes routes and navigation from. */
export type AppFeatureEntry = WithBrandedFeatureId<AppFeatureEntryInput>;

/** The pending variant of an entry (carries the pending note/screen). */
export type PendingAppFeatureEntry = Extract<AppFeatureEntry, { implementation: "pending" }>;

/** Declares one host feature entry (validates loudly, brands the id). */
export function appFeatureEntry(entry: AppFeatureEntryInput): AppFeatureEntry {
  let featureId: FeatureId;
  try {
    featureId = Schema.decodeUnknownSync(FeatureId)(entry.featureId);
  } catch {
    throw new Error(
      `app feature registry: featureId "${entry.featureId}" does not match the contracts FeatureId pattern`,
    );
  }
  if (!ROUTE_PATH_PATTERN.test(entry.routePath)) {
    throw new Error(
      `app feature registry: feature ${entry.featureId} has an invalid routePath "${entry.routePath}" (expected "/" or "/lowercase-ascii")`,
    );
  }
  if (entry.navLabel.trim() === "" || entry.screenHeading.trim() === "") {
    throw new Error(
      `app feature registry: feature ${entry.featureId} is missing a Polish nav label or screen heading`,
    );
  }
  if (entry.consumedOperations.length === 0) {
    throw new Error(
      `app feature registry: feature ${entry.featureId} declares no consumed operations; a UI feature must name the contract operations it will use`,
    );
  }
  for (const operation of entry.consumedOperations) {
    if (!(operation in contractOperations)) {
      throw new Error(
        `app feature registry: feature ${entry.featureId} consumes unknown operation ${operation}`,
      );
    }
  }
  if (entry.implementation === "pending") {
    if (entry.pendingNote.trim() === "") {
      throw new Error(
        `app feature registry: feature ${entry.featureId} is pending and needs a pending note`,
      );
    }
    return {
      featureId,
      routePath: entry.routePath,
      navLabel: entry.navLabel,
      screenHeading: entry.screenHeading,
      consumedOperations: entry.consumedOperations,
      implementation: "pending",
      pendingNote: entry.pendingNote,
      ...(entry.pendingScreen === undefined ? {} : { pendingScreen: entry.pendingScreen }),
    };
  }
  return {
    featureId,
    routePath: entry.routePath,
    navLabel: entry.navLabel,
    screenHeading: entry.screenHeading,
    consumedOperations: entry.consumedOperations,
    implementation: "mounted",
    screen: entry.screen,
  };
}

/**
 * Validates the composed list the router and navigation are built from:
 * unique ids and paths, exactly one default route ("/") and it first, so
 * the company conversation stays the authenticated default entry point.
 * Throws loudly so drift fails at startup, not in production silently.
 */
export function composeAppFeatures(entries: readonly AppFeatureEntry[]): readonly AppFeatureEntry[] {
  const seenIds = new Set<string>();
  const seenPaths = new Set<string>();
  let defaults = 0;
  entries.forEach((entry, index) => {
    if (seenIds.has(entry.featureId)) {
      throw new Error(`app feature registry: duplicate featureId ${entry.featureId}`);
    }
    if (seenPaths.has(entry.routePath)) {
      throw new Error(`app feature registry: duplicate routePath ${entry.routePath}`);
    }
    if (entry.routePath === "/") {
      defaults += 1;
      if (index !== 0) {
        throw new Error(
          "app feature registry: the default route (/) must be the first entry (company conversation)",
        );
      }
    }
    seenIds.add(entry.featureId);
    seenPaths.add(entry.routePath);
  });
  if (defaults !== 1) {
    throw new Error(
      `app feature registry: expected exactly one default route (/), found ${defaults}`,
    );
  }
  return entries;
}
