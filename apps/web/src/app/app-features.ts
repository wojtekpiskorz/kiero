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
import { memoryFeatureEntry } from "./features/memory/entry";
import { coTerazFeatureEntry } from "./features/co-teraz/entry";
// H2's sanctioned host mounts: the work record surface, the typed-extension
// surface, and the real /co-teraz screen (the entry flip from pending).
import { workFeatureEntry } from "./features/work/entry";
import { extensionsFeatureEntry } from "./features/extensions/entry";
import { projectsFeatureEntry } from "./features/projects/entry";
import { membershipFeatureEntry } from "./features/membership/entry";
import { calendarFeatureEntry } from "./features/calendar/entry";
import { gmAccessFeatureEntry } from "./features/gm/entry";
// F3's sanctioned host mount: the Polish web push settings screen.
import { notificationsFeatureEntry } from "./features/notifications/entry";
// H4's sanctioned host mount: the audited GM processing inspector.
import { gmProcessingFeatureEntry } from "./features/gm/processing-entry";
// D4's sanctioned host mount: the capture composer at /wpis.
import { captureFeatureEntry } from "./features/capture/entry";
// H3's sanctioned host mounts: the evidence-search route and the full
// source-history route (media anchors, corrections, withdrawal impact).
import { searchFeatureEntry } from "./features/search/entry";
import { sourceDetailFeatureEntry } from "./features/source-detail/entry";

/** Every registered host feature, in navigation order. The first entry ("/") is the default route. */
export const appFeatures: readonly AppFeatureEntry[] = composeAppFeatures([
  conversationFeatureEntry,
  // H1's sanctioned host mount: the boss-facing memory views (findings,
  // history/provenance, clarifications, direct correction).
  memoryFeatureEntry,
  // H3's sanctioned host mount: evidence search over E5 retrieval.
  searchFeatureEntry,
  // H3's sanctioned host mount: the full source-history surface.
  sourceDetailFeatureEntry,
  coTerazFeatureEntry,
  // H2's sanctioned host mounts (issue #50): project work records at
  // /praca and typed extensions at /dodatkowe.
  workFeatureEntry,
  extensionsFeatureEntry,
  projectsFeatureEntry,
  // B3's sanctioned host mount: the first mounted feature (sign-in gate +
  // membership surface); the entry file owns the shape, this line the wiring.
  membershipFeatureEntry,
  // B4's sanctioned host mount: the audited GM operator surface (entry/exit
  // GM mode, inspection, recovery, onboarding, activation, restoration).
  gmAccessFeatureEntry,
  // H4's sanctioned host mount: the audited processing inspection and GM
  // retry controls (B4's GM mode required; no boss-facing mutation).
  gmProcessingFeatureEntry,
  // G1's sanctioned host mount: the optional personal Calendar connection
  // (sign-in gate reused; connection lifecycle only, never identity).
  calendarFeatureEntry,
  // F3's sanctioned host mount: the web push settings screen (device
  // registration, permission/subscription state, recovery guidance).
  notificationsFeatureEntry,
  // D4's sanctioned host mount: the capture composer ("Nowy wpis").
  captureFeatureEntry,
]);
