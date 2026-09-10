/**
 * Extensions feature entry (A4 host wiring point, H2's sanctioned
 * addition).
 *
 * "Dodatkowe informacje" is the typed-extension surface: C3's catalog
 * search with similarity candidates rendered by field kind and stable
 * field ids, definition/version commands through the checked memory
 * dispatch, evidence-backed value recording (the boss's statement becomes
 * a real source; one staged change set publishes the typed value), the
 * validate-value pre-flight, and audited corrections of existing
 * extension findings.
 */

import { createElement } from "react";
import { appFeatureEntry } from "../../registry";
import { ExtensionsFeature } from "../../../features/extensions/ExtensionsFeature";

/** The registered host entry for the typed-extension surface. */
export const extensionsFeatureEntry = appFeatureEntry({
  featureId: "memory.extensions",
  routePath: "/dodatkowe",
  navLabel: "Dodatkowe informacje",
  screenHeading: "Dodatkowe informacje",
  consumedOperations: [
    // The value-recording section's statement becomes a real source through
    // the shared statement-to-source send (the same commands the
    // conversation rides), so the surface consumes D1's send pair too.
    "sources.prepareUpload",
    "sources.acceptSource",
    "memory.searchExtensionCatalog",
    "memory.defineExtension",
    "memory.versionExtensionDefinition",
    "memory.validateExtensionValue",
    "memory.prepareChangeSet",
    "memory.publishChangeSet",
    "memory.correctFinding",
  ],
  implementation: "mounted",
  screen: () => createElement(ExtensionsFeature),
});
