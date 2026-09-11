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

describe("convex executor composition", () => {
  it("registers exactly the implemented executors (platform + B3 + C5 + D5 + D6 + E3/E4 + F2 + G3 + E5 lanes)", () => {
    expect(Object.keys(jobExecutors).sort()).toEqual(
      [
        "platform.echo_delivery",
        "processing.analyze_change_plan",
        // B3's sanctioned append (issue #22 owns the declared consumer
        // proof for the access-revocation edges).
        "access.cleanup_revocation",
        // D6's sanctioned append (issue #34 owns per-segment STT; the
        // contracts amendment registering the kind is flagged there).
        "processing.transcribe_segment",

        // D5's sanctioned append (issue #33 owns the declared consumer
        // proof for the accepted-photo normalization edge).
        "processing.normalize_photo",

        // F2's sanctioned append (issue #42 owns the notification-intent
        // lane: the durable reaction to the three consumed events).
        "attention.evaluate_due_intents",
        // F4's sanctioned append (issue #44 owns the task-reminder lane:
        // the durable schedule recompute for the work task events and
        // bound-deadline revisions).
        "attention.schedule_task_reminders",
        // E3's sanctioned append (issue #37 owns the text-analysis lane:
        // the mechanical A3 analyze executor is replaced behind the same
        // seam by the real workflow, and the extract edge is implemented).
        // I3's sanctioned append (issue #55 owns the firm-export archive
        // build executor).
        "exports.build_archive",
        "processing.extract_fragments",

        // C5's sanctioned append (issue #28 owns the recomputation lane).
        "memory.recompute_dependents",
        // G3's sanctioned append (issue #47 owns the declared consumer
        // proof for the calendar.copyOutcomeRecorded edge).
        "calendar.reconcile_outcome",

        // E5's sanctioned append (issue #39 owns the derived-search lane:
        // versioned index generations plus the scoped lifecycle refreshes of
        // the disposable search rows).
        "search.index_generation",
        // E4's sanctioned append (issue #38 owns the multimodal join; the
        // contracts amendment registering the kind is flagged there).
        "processing.join_multimodal",
        // F3's sanctioned append (issue #43 owns the web push transport:
        // the declared consumer proof for the attention.intentDelivered
        // edge).
        "attention.deliver_push",
      ].sort(),
    );
    expect(echoExecutor.jobKind).toBe("platform.echo_delivery");
  });

  it("every registered kind exists in the A2/A3 registry executor table", () => {
    for (const kind of Object.keys(jobExecutors)) {
      expect(
        executors.some((entry) => entry.jobKind === kind),
        kind,
      ).toBe(true);
    }
  });

  it("unimplemented kinds (the fail-closed placeholders) stay unimplemented", () => {
    expect(jobExecutors["deletion.purge_source"]).toBeUndefined();
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
      decode({
        _tag: "range",
        start: { _tag: "month", month: "2026-05" },
        end: { _tag: "month", month: "2026-05" },
      }),
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
