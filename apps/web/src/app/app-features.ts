/**
 * The composed host feature list (A4).
 *
 * This is the ONLY file a feature lane needs to touch (one import + one
 * array line): the router, navigation and default route are all derived
 * from this list, so independent lanes do not rewrite one App/router file.
 * `composeAppFeatures` validates the composition loudly at startup.
 *
 * J2's join (issue #61, flagged amendment): the full-flow join owns the
 * FINAL core composition, so this file now delegates to
 * `apps/web/src/composition/full.ts` (the join's owned path) instead of
 * composing the entry list itself. The capture composer's separate /wpis
 * route retired with that join: all capture modes mount INSIDE the
 * company conversation.
 */

import type { AppFeatureEntry } from "./registry";
import { fullCoreAppFeatures } from "../composition/full";

/** Every registered host feature, in navigation order. The first entry ("/") is the default route. */
export const appFeatures: readonly AppFeatureEntry[] = fullCoreAppFeatures();
