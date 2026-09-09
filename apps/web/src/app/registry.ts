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
 * A pending entry renders an honest "w przygotowaniu" screen. It never
 * fakes data: until its owning lane mounts a real implementation, the
 * placeholder states exactly what is missing.
 */

import { Schema } from "effect";
import {
  FeatureId,
  features as contractFeatures,
  operations as contractOperations,
  type FeatureEntry,
} from "@kiero/contracts";
import type { ReactNode } from "react";

/**
 * Root-level route path: "/" for the default route, otherwise a lowercase
 * ASCII segment ("/co-teraz"). Diacritics are excluded on purpose so
 * Polish labels never leak into encodable-path problems.
 */
const ROUTE_PATH_PATTERN = /^\/$|^\/[a-z0-9-]+$/;

/** Input an owning lane writes; `featureId` is validated and branded here. */
export interface AppFeatureEntryInput {
  readonly kind: "app_feature";
  readonly featureId: string;
  readonly routePath: string;
  readonly navLabel: string;
  readonly screenHeading: string;
  /** Honest Polish note shown while the feature is pending. */
  readonly pendingNote: string;
  /** Contract operation names this feature consumes once implemented. */
  readonly consumedOperations: readonly string[];
  /**
   * "pending" mounts the honest placeholder screen; an owning lane flips
   * this to "mounted" only together with a real screen implementation.
   */
  readonly implementation: AppFeatureImplementation;
  /** The screen component mounted at `routePath` (plain zero-prop component). */
  readonly screen: () => ReactNode;
}

/** Implementation state of a host feature entry. */
export type AppFeatureImplementation = "pending" | "mounted";

/** The validated entry the host composes routes and navigation from. */
export interface AppFeatureEntry {
  readonly kind: "app_feature";
  readonly featureId: FeatureId;
  readonly routePath: string;
  readonly navLabel: string;
  readonly screenHeading: string;
  readonly pendingNote: string;
  readonly consumedOperations: readonly string[];
  readonly implementation: AppFeatureImplementation;
  /** The screen component mounted at `routePath` (plain zero-prop component). */
  readonly screen: () => ReactNode;
}

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
  if (entry.pendingNote.trim() === "") {
    throw new Error(
      `app feature registry: feature ${entry.featureId} is pending and needs an honest pending note`,
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
  return {
    kind: "app_feature",
    featureId,
    routePath: entry.routePath,
    navLabel: entry.navLabel,
    screenHeading: entry.screenHeading,
    pendingNote: entry.pendingNote,
    consumedOperations: entry.consumedOperations,
    implementation: entry.implementation,
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

/**
 * The backend registration for the same feature id, when one exists in the
 * contracts registry. Null is honest: no executor/event registration claims
 * this feature yet. Kept as the typed alignment seam for lanes that need
 * both halves (e.g. to show which durable jobs their feature executes).
 */
export function contractFeatureRegistration(featureId: FeatureId): FeatureEntry | null {
  return contractFeatures.find((feature) => feature.featureId === featureId) ?? null;
}
