/**
 * Effect 4 RC execution inside Convex functions (A3): success, typed closed
 * errors, defect sanitization and the bounded deadline.
 */

import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { forbiddenError, runDomainEffect } from "@kiero/runtime";

describe("runDomainEffect", () => {
  it("returns an ok envelope for a successful program", async () => {
    const result = await runDomainEffect(Effect.succeed(42));
    expect(result).toEqual({ _tag: "ok", value: 42 });
  });

  it("passes a typed closed error through as-is", async () => {
    const error = forbiddenError("test_denied");
    const result = await runDomainEffect(Effect.fail(error));
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error).toEqual(error);
    }
  });

  it("sanitizes defects: nothing internal crosses the seam", async () => {
    const result = await runDomainEffect(
      Effect.die(new Error("internal token sk-live-1234567890abcdef")),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unavailable");
      expect(JSON.stringify(result.error)).not.toContain("sk-live");
    }
  });

  it("fails unavailable when the deadline is exceeded", async () => {
    const result = await runDomainEffect(
      Effect.delay(Effect.succeed("late"), { seconds: 2 }),
      { deadlineMs: 50 },
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unavailable");
      expect(result.error.code).toBe("domain_deadline_exceeded");
    }
  }, 10_000);
});
