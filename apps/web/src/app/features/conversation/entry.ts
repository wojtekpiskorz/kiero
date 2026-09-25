/**
 * Company conversation feature entry.
 *
 * "Rozmowa firmy" is the authenticated default route (execution charter:
 * the application starts in the company conversation; project context and
 * "Co teraz" are reachable without a mandatory dashboard).
 *
 * the mount: the full conversation UI — company and project projections of
 * the one history, unread badges, honest processing states, correction-
 * as-new-source, and the canonical per-source deep link (`?zrodlo=<id>`;
 * ASCII param, Polish keying). The core-text controls
 * graduated into the conversation feature (the proved send loop and its
 * copy are preserved verbatim); the first minimal mount was replaced through
 * this declared entry without duplicating backend state or making a second
 * conversation store.
 *
 * ALL capture modes mount here — the composer
 * (text + one recording + photos over the recoverable-draft engine, with
 * the voice-only ruling) embeds as the one send form, and the answer
 * loop runs per question message ("Zapytaj agenta"). The separate /wpis
 * capture route is retired.
 *
 * Consumed operations are the commands the surface issues (the send pair —
 * now through the composer's upload engine — plus the read marking); the
 * answer action is the public `agent/loop:askAgent` entry. Reads ride the
 * lane-owned public queries (conversation views, read-state
 * projection, memory reads).
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
