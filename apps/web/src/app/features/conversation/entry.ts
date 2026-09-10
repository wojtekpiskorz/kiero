/**
 * Company conversation feature entry (A4 host wiring point).
 *
 * "Rozmowa firmy" is the authenticated default route (execution charter:
 * the application starts in the company conversation; project context and
 * "Co teraz" are reachable without a mandatory dashboard).
 *
 * H1's mount: the full conversation UI — company and project projections of
 * the one history, unread badges (F1), honest processing states, correction-
 * as-new-source, and the canonical per-source deep link (`?zrodlo=<id>`;
 * ASCII param, Polish keying). J1's core-text controls
 * graduated into the conversation feature (the proved send loop and its
 * copy are preserved verbatim); the minimal J1 mount was replaced through
 * this declared entry without duplicating backend state or making a second
 * conversation store.
 *
 * Consumed operations are the commands the surface issues (the J1 pair plus
 * F1's read marking); reads ride the lane-owned public queries (D1
 * conversation views, F1 read-state projection, C2 memory reads), exactly
 * like the J1 mount declared them.
 */

import { createElement } from "react";
import { appFeatureEntry, type AppFeatureEntry } from "../../registry";
import { ConversationFeature } from "../../../features/conversation/ConversationFeature";

/** The registered host entry for the default company conversation surface. */
export const conversationFeatureEntry: AppFeatureEntry = appFeatureEntry({
  featureId: "conversation.company",
  routePath: "/",
  navLabel: "Rozmowa firmy",
  screenHeading: "Rozmowa firmy",
  consumedOperations: [
    "sources.prepareUpload",
    "sources.acceptSource",
    "attention.markSourceRead",
  ],
  implementation: "mounted",
  screen: () => createElement(ConversationFeature),
});
