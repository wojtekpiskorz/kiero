/**
 * R13 focused verification, part 1: the ONE shared deployment environment
 * label rule (`packages/runtime/src/deployment.ts`).
 *
 * The closed read previously lived in five runtime copies (the telemetry
 * cron, the backups HTTP boundary, the redaction label set, the Calendar
 * return resolver and the gateway telemetry tag). These tests pin the
 * consolidated helper's classification matrix EXACTLY as accepted, so no
 * later copy can drift:
 *
 * - the closed label set is exactly dev, staging, alpha-production;
 * - absent (undefined), null and empty all honestly mean dev;
 * - every other string (unknown, wrong case, padded, embedded) means dev;
 * - a non-string value (unreachable through the typed seams, reachable
 *   through a broken one) also means dev; classification never throws;
 * - the validation pattern is DERIVED from the label list, and its source
 *   is byte-identical to the accepted regex `^(dev|staging|alpha-production)$`
 *   (the exact string `infra/observability/events.json` mirrors through
 *   `diagnosticEventSpec()`; tests/i2/schema.test.ts pins that mirror).
 *
 * Part 2 (`./environment-call-sites.test.ts`) proves each migrated call
 * site routes through this helper.
 */

import { describe, expect, it } from "vitest";
import {
  DEPLOYMENT_ENVIRONMENT_LABELS,
  DEPLOYMENT_ENVIRONMENT_PATTERN,
  deploymentEnvironment,
} from "@kiero/runtime";

/**
 * The accepted classification matrix: the value a deployment variable may
 * hold, and the label the rule must answer. Unknown-means-dev is the
 * honest fallback, never a guess.
 */
const CLASSIFICATION_MATRIX = [
  { value: "dev", expected: "dev" },
  { value: "staging", expected: "staging" },
  { value: "alpha-production", expected: "alpha-production" },
  { value: undefined, expected: "dev" },
  { value: "", expected: "dev" },
  { value: "production", expected: "dev" },
  { value: "prod", expected: "dev" },
  { value: "qa", expected: "dev" },
  { value: "alpha", expected: "dev" },
  { value: "internal", expected: "dev" },
  { value: "dev-eu", expected: "dev" },
  { value: "Dev", expected: "dev" },
  { value: "DEV", expected: "dev" },
  { value: "Staging", expected: "dev" },
  { value: " dev", expected: "dev" },
  { value: "dev ", expected: "dev" },
  { value: "staging;dev", expected: "dev" },
  { value: "alpha-production1", expected: "dev" },
  { value: "alpha_prod", expected: "dev" },
  { value: "https://dev", expected: "dev" },
] as const;

const show = (value: string | undefined): string =>
  value === undefined ? "absent" : JSON.stringify(value);

describe("deploymentEnvironment (the classification matrix, exactly as accepted)", () => {
  for (const row of CLASSIFICATION_MATRIX) {
    it(`classifies ${show(row.value)} as ${row.expected}`, () => {
      expect(deploymentEnvironment(row.value)).toBe(row.expected);
    });
  }

  it("classifies an explicit null as dev", () => {
    expect(deploymentEnvironment(null)).toBe("dev");
  });

  it("classifies non-string values as dev without throwing (a broken seam stays honest)", () => {
    for (const broken of [42, true, {}, [], Symbol("x")] as const) {
      expect(deploymentEnvironment(broken as unknown as string)).toBe("dev");
    }
  });

  it("answers membership for every string: an exact label passes, anything else is dev", () => {
    for (const row of CLASSIFICATION_MATRIX) {
      if (typeof row.value !== "string") {
        continue;
      }
      const admitted = (DEPLOYMENT_ENVIRONMENT_LABELS as readonly string[]).includes(row.value);
      expect(deploymentEnvironment(row.value)).toBe(admitted ? row.value : "dev");
    }
  });
});

describe("the closed label set and its derived validation pattern", () => {
  it("is exactly the three accepted labels in the accepted order", () => {
    expect([...DEPLOYMENT_ENVIRONMENT_LABELS]).toEqual(["dev", "staging", "alpha-production"]);
  });

  it("derives a pattern whose source is byte-identical to the accepted regex", () => {
    expect(DEPLOYMENT_ENVIRONMENT_PATTERN.source).toBe("^(dev|staging|alpha-production)$");
    expect(DEPLOYMENT_ENVIRONMENT_PATTERN.flags).toBe("");
  });

  it("matches whole labels only (anchored at both ends)", () => {
    for (const label of DEPLOYMENT_ENVIRONMENT_LABELS) {
      expect(DEPLOYMENT_ENVIRONMENT_PATTERN.test(label)).toBe(true);
      expect(DEPLOYMENT_ENVIRONMENT_PATTERN.test(`x${label}`)).toBe(false);
      expect(DEPLOYMENT_ENVIRONMENT_PATTERN.test(`${label}x`)).toBe(false);
    }
  });
});
