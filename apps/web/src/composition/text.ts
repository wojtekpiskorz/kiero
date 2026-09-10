/**
 * The text composition entry (J1): the seam that composes the first real
 * text-to-memory loop into the barebones application host.
 *
 * A4's host registry keeps feature entries under `app/features/<name>/`;
 * the joins own explicit cross-module composition. This module is the
 * text join's UI half: it builds the MOUNTED conversation entry (the
 * authenticated default route "/") from the core-text feature, so the
 * host wiring file stays a one-line delegate and the mount decision —
 * which screen, which consumed operations — lives with the text
 * composition instead of being transcribed twice.
 *
 * The entry still declares itself through A4's `appFeatureEntry` (loud
 * validation: the featureId must match the contracts pattern, the default
 * route stays first, and every consumed operation must exist in the
 * composed contracts registry). H1 later replaces or enriches this mount
 * with the conversation UI, consuming the same commands.
 */

import { createElement } from "react";
import { appFeatureEntry, type AppFeatureEntry } from "../app/registry";
import { CoreTextFeature } from "../features/core-text/CoreTextFeature";

/**
 * The mounted company-conversation entry: J1's core-text controls on the
 * default route. The consumed operations are exactly what the surface
 * commands — the checked send path (`sources.prepareUpload` gives a
 * text-only source its durable upload row; `sources.acceptSource` accepts
 * it). Reads (conversation view, current memory) go through the lane-owned
 * public queries; later attention integration owns read-state marking.
 */
export function textConversationFeatureEntry(): AppFeatureEntry {
  return appFeatureEntry({
    featureId: "conversation.company",
    routePath: "/",
    navLabel: "Rozmowa firmy",
    screenHeading: "Rozmowa firmy",
    consumedOperations: ["sources.acceptSource", "sources.prepareUpload"],
    implementation: "mounted",
    screen: () => createElement(CoreTextFeature),
  });
}
