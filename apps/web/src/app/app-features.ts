/**
 * The composed host feature list (A4).
 *
 * This is the ONLY file a feature lane needs to touch (one import + one
 * array line): the router, navigation and default route are all derived
 * from this list, so independent lanes do not rewrite one App/router file.
 * `composeAppFeatures` validates the composition loudly at startup.
 */

import { composeAppFeatures, type AppFeatureEntry } from "./registry";
import { conversationFeatureEntry } from "./features/conversation/entry";
import { coTerazFeatureEntry } from "./features/co-teraz/entry";
import { projectsFeatureEntry } from "./features/projects/entry";
import { membershipFeatureEntry } from "./features/membership/entry";

/** Every registered host feature, in navigation order. The first entry ("/") is the default route. */
export const appFeatures: readonly AppFeatureEntry[] = composeAppFeatures([
  conversationFeatureEntry,
  coTerazFeatureEntry,
  projectsFeatureEntry,
  // B3's sanctioned host mount: the first mounted feature (sign-in gate +
  // membership surface); the entry file owns the shape, this line the wiring.
  membershipFeatureEntry,
]);
