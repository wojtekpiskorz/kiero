/**
 * Company conversation feature entry (A4 host wiring point).
 *
 * "Rozmowa firmy" is the authenticated default route (execution charter:
 * the application starts in the company conversation; project context and
 * "Co teraz" are reachable without a mandatory dashboard).
 *
 * J1's sanctioned mount: the first real text-to-memory loop lives here.
 * The mount decision (screen and consumed operations) is owned by the
 * text composition seam (../../composition/text.ts) so the join's choices
 * are not transcribed twice; this file stays the host wiring point A4
 * documented. H1 later replaces or enriches this mount with the
 * conversation UI, consuming the same commands.
 */

import type { AppFeatureEntry } from "../../registry";
import { textConversationFeatureEntry } from "../../../composition/text";

/** The registered host entry for the default company conversation surface. */
export const conversationFeatureEntry: AppFeatureEntry = textConversationFeatureEntry();
