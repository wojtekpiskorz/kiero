/**
 * Convex platform surface tests (A3): these imports also pull the whole
 * convex/platform tree into the root TypeScript program, so the repo
 * typecheck covers it, and they pin the executor composition facts.
 */

import { describe, expect, it } from "vitest";
import { Schema } from "effect";
import { DateRange, executors } from "@kiero/contracts";
import { jobExecutors } from "../../convex/platform/executors";
import { echoExecutor } from "../../convex/platform/echo";
import { analyzeChangePlanExecutor } from "../../convex/platform/pipeline";

describe("convex executor composition", () => {
  it("registers exactly the platform-owned mechanical executors", () => {
    expect(Object.keys(jobExecutors).sort()).toEqual(
      ["platform.echo_delivery", "processing.analyze_change_plan"].sort(),
    );
    expect(echoExecutor.jobKind).toBe("platform.echo_delivery");
    expect(analyzeChangePlanExecutor.jobKind).toBe("processing.analyze_change_plan");
  });

  it("every registered kind exists in the A2/A3 registry executor table", () => {
    for (const kind of Object.keys(jobExecutors)) {
      expect(executors.some((entry) => entry.jobKind === kind), kind).toBe(true);
    }
  });

  it("unimplemented kinds (the fail-closed placeholders) stay unimplemented", () => {
    expect(jobExecutors["deletion.purge_source"]).toBeUndefined();
    expect(jobExecutors["memory.recompute_dependents"]).toBeUndefined();
  });
});

describe("temporal cross-precision bound ordering (A2 deferral resolved by A3)", () => {
  const decode = Schema.decodeUnknownSync(DateRange);

  it("accepts in-order mixed precisions (month start before a day in it)", () => {
    const range = decode({
      _tag: "range",
      start: { _tag: "month", month: "2026-05" },
      end: { _tag: "day", day: "2026-05-10" },
    });
    expect(range._tag).toBe("range");
  });

  it("accepts equal period starts (a bound and the period containing it)", () => {
    expect(() =>
      decode({ _tag: "range", start: { _tag: "month", month: "2026-05" }, end: { _tag: "month", month: "2026-05" } }),
    ).not.toThrow();
  });

  it("rejects a start that begins after the end's period start", () => {
    expect(() =>
      decode({
        _tag: "range",
        start: { _tag: "day", day: "2026-05-10" },
        end: { _tag: "month", month: "2026-05" },
      }),
    ).toThrow();
    expect(() =>
      decode({
        _tag: "range",
        start: { _tag: "month", month: "2026-06" },
        end: { _tag: "year", year: "2026" },
      }),
    ).toThrow();
  });
});
