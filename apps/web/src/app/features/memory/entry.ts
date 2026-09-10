/**
 * Memory feature entry (A4 host wiring point, H1's sanctioned addition).
 *
 * "Pamięć" is the boss-facing memory route: current findings with their
 * honest knowledge states, per-finding revision history and provenance
 * (links back to the canonical source deep link), E3's sourced
 * clarifications with the answering flow, and C2's audited direct
 * correction command. The project scope is selectable (?projekt=<id>, the
 * same deep-link key the conversation route uses).
 *
 * Consumed operations are the commands the surface issues: C2's separate
 * audited correction command and the clarification resolution. Reads (C2
 * current findings, the H1-flagged history/clarifications reads) ride the
 * lane-owned public queries.
 */

import { createElement } from "react";
import { appFeatureEntry, type AppFeatureEntry } from "../../registry";
import { MemoryFeature } from "../../../features/memory/MemoryFeature";

/** The registered host entry for the memory surface. */
export const memoryFeatureEntry: AppFeatureEntry = appFeatureEntry({
  featureId: "memory.project",
  routePath: "/pamiec",
  navLabel: "Pamięć",
  screenHeading: "Pamięć",
  consumedOperations: ["memory.correctFinding", "memory.resolveClarification"],
  implementation: "mounted",
  screen: () => createElement(MemoryFeature),
});
