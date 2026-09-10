/**
 * Capture feature entry (D4 host wiring point, the sibling pattern).
 *
 * "Nowy wpis" is the mobile composer of one wiadomość źródłowa: text,
 * ONE tap-to-record voice note and several photos, with the stable
 * recoverable local draft (apps/web/src/storage/drafts) and the real D2
 * upload paths (gateway resumable parts + D1 acceptance; the draft id is
 * both the prepare draftId and the acceptance idempotency key).
 *
 * J2's join replaces this separate mount by folding the capture modes
 * into the conversation surface; until then the composer is reachable
 * through its own route so the capture semantics stay provable in
 * isolation (the UX/UI track owns final placement).
 *
 * Consumed operations are the commands the surface issues: the certified
 * prepare semantics (through the gateway Worker's fused prepare/begin
 * route, which drives the SAME ledger step) and D1's atomic acceptance.
 * Reads ride the lane-owned public queries (projects overview, source
 * detail for the honest post-send processing states), exactly like the
 * conversation entry declares its own.
 */

import { createElement } from "react";
import { appFeatureEntry, type AppFeatureEntry } from "../../registry";
import { CaptureFeature } from "../../../features/capture/CaptureFeature";

/** The registered host entry for the capture composer surface. */
export const captureFeatureEntry: AppFeatureEntry = appFeatureEntry({
  featureId: "capture.composer",
  routePath: "/wpis",
  navLabel: "Nowy wpis",
  screenHeading: "Nowy wpis",
  consumedOperations: ["sources.prepareUpload", "sources.acceptSource"],
  implementation: "mounted",
  screen: () => createElement(CaptureFeature),
});
