/**
 * The honest placeholder screen for pending host feature entries (A4).
 *
 * A pending entry never fakes data: it states "W przygotowaniu.", explains
 * what is missing in Polish, and lists the contract operations the feature
 * will consume once its owning lane mounts it. Written with `createElement`
 * (no JSX) to keep the composed registry importable from the root node
 * test program.
 */

import { createElement, type ReactNode } from "react";
import type { AppFeatureEntry } from "./registry";

/** Stable heading id for aria-labelling the feature screen. */
export function featureHeadingId(entry: AppFeatureEntry): string {
  return `app-feature-heading-${entry.featureId}`;
}

/** The plain controls surface: which checked operations this feature uses. */
export function FeatureOperationsList({ entry }: { entry: AppFeatureEntry }): ReactNode {
  return createElement(
    "section",
    null,
    createElement("h2", null, "Operacje tej funkcji w rejestrze kontraktów"),
    createElement(
      "p",
      null,
      "Po zaimplementowaniu funkcja korzysta z tych sprawdzonych operacji, a nie z prywatnych kształtów bazy:",
    ),
    createElement(
      "ul",
      null,
      ...entry.consumedOperations.map((operation) => createElement("li", { key: operation }, operation)),
    ),
  );
}

/**
 * The screen a pending feature mounts. The status is explicit, never a
 * fake success: nothing renders until the owning lane replaces it.
 */
export function FeaturePendingScreen({ entry }: { entry: AppFeatureEntry }): ReactNode {
  if (entry.implementation !== "pending") {
    throw new Error(
      `app: FeaturePendingScreen mounted for ${entry.featureId}, which is not pending`,
    );
  }
  return createElement(
    "section",
    { "aria-labelledby": featureHeadingId(entry) },
    createElement("h1", { id: featureHeadingId(entry) }, entry.screenHeading),
    createElement("p", { role: "status" }, "W przygotowaniu."),
    createElement("p", null, entry.pendingNote),
    createElement(FeatureOperationsList, { entry }),
  );
}
