/**
 * Error-kind survival tests (R28, issue #236): the actionable half of every
 * failed-job diagnostic must survive redaction.
 *
 * I11's live qualification found every `ops.job.attempts_exhausted`
 * diagnostic carrying `errorKind: <redacted>`: the producers emit closed
 * `kind:detail` composites (`unavailable:images_executor_unavailable`) while
 * the redaction format admitted no colon. The format now admits ONE optional
 * colon with both segments closed-format snake_case. These tests pin BOTH
 * directions so the vocabularies cannot drift apart again:
 *
 * - producer direction: every real producer kind - the closed-error tags
 *   composed with their codes, the lane-prefixed refusals, the colon-free
 *   platform kinds - survives `valuePasses("errorKind", ...)` and the whole
 *   incident emission leg (`classifyIncidents` -> `sanitizeDiagnosticEvent`);
 * - redactor direction: the bounded grammar admits no free text - multi
 *   colon, empty segments, non-charset content, oversized kind segments and
 *   overlong values all redact, and the format source itself is pinned.
 *
 * The same discipline R27 applied to the forward-status vocabulary
 * (forward-outcome.test.ts: closed list -> every member sanitizer-safe).
 */

import { describe, expect, it } from "vitest";
import {
  MAX_VALUE_LENGTH,
  METADATA_KEY_FORMATS,
  valuePasses,
  sanitizeDiagnosticEvent,
} from "../../convex/operations/telemetry/redact";
import { classifyIncidents } from "../../convex/operations/telemetry/incidents";

/** The closed-error `_tag` union (@kiero/contracts ClosedErrorKind). */
const CLOSED_ERROR_TAGS = [
  "validation",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "idempotency_conflict",
  "unsupported",
  "unavailable",
] as const;

/**
 * Representative real composites, each with its producer:
 * - the closed-error executors (`${error._tag}:${error.code}`: the images,
 *   deletion and exports lanes);
 * - the provider-failure mapping (`@kiero/providers` CLOSED_CODE via
 *   failureToClosedError);
 * - the memory-recompute marking refusals and the vision-routes failure
 *   (detail = the closed ProviderFailureKind set).
 */
const PRODUCER_COMPOSITE_KINDS = [
  "unavailable:images_executor_unavailable", // gateway images normalizer (I11's live finding)
  "unavailable:provider_deadline_exceeded",
  "unavailable:provider_connection_failed",
  "unavailable:provider_rate_limited",
  "unauthenticated:provider_key_rejected",
  "unavailable:provider_credits_exhausted",
  "validation:provider_output_rejected",
  "validation:provider_unknown_tool",
  "conflict:state_mismatch", // runtime conflictError default code
  "not_found:record_not_found", // runtime notFoundError default code
  "unsupported:not_implemented", // contracts notImplemented
  "unavailable:internal_failure", // sanitizeUnknownError fallback code
  "withdrawal_marking_refused:revision_mismatch",
  "scope_marking_refused:record_not_found",
  "vision_routes_failed:rate_limited",
  "vision_routes_failed:provider_unavailable",
  // The longest grammar-legal composite the redactor must admit WHOLE:
  // 26-char prefix + colon + 37-char code = 64 = MAX_VALUE_LENGTH exactly
  // (the memory-recompute prefix, the images-ledger code).
  "withdrawal_marking_refused:representation_retained_event_missing",
] as const;

/** Colon-free kinds the platform job runner and executors already emit. */
const PRODUCER_FLAT_KINDS = [
  "max_attempts_exceeded", // platform/jobs.ts
  "unsupported_job_kind",
  "job_input_not_json",
  "executor_not_registered", // every lane executor
  "job_input_rejected",
  "images_executor_deadline_exceeded", // processing/images/executor.ts
  "consumer_projection_missing", // platform/outbox.ts
  "push_delivery_failed", // attention/push
  "external_uncertain", // calendar sync
] as const;

describe("producer direction: every producer error kind survives redaction", () => {
  it("every real composite kind passes the errorKind format", () => {
    for (const kind of PRODUCER_COMPOSITE_KINDS) {
      expect(valuePasses("errorKind", kind), kind).toBe(true);
    }
  });

  it("every closed-error tag composed with a representative code passes", () => {
    for (const tag of CLOSED_ERROR_TAGS) {
      for (const code of ["internal_failure", "provider_unavailable"] as const) {
        const kind = `${tag}:${code}`;
        expect(valuePasses("errorKind", kind), kind).toBe(true);
      }
    }
  });

  it("the colon-free producer kinds keep passing", () => {
    for (const kind of PRODUCER_FLAT_KINDS) {
      expect(valuePasses("errorKind", kind), kind).toBe(true);
    }
  });

  it("an attempts-exhausted job keeps its actionable kind through the whole emission leg", () => {
    const incidents = classifyIncidents(
      {
        jobs: [
          {
            jobKey: "job_abc123-def456",
            kind: "processing.normalize_photo",
            state: "failed",
            attempts: 3,
            maxAttempts: 3,
            lastErrorKind: "unavailable:images_executor_unavailable",
          },
        ],
        outbox: [],
        runs: [],
      },
      0,
    );
    expect(incidents).toHaveLength(1);
    const sanitized = sanitizeDiagnosticEvent({
      kind: incidents[0]?.kind,
      metadata: incidents[0]?.metadata,
    });
    expect(sanitized.status).toBe("ok");
    if (sanitized.status !== "ok") {
      return;
    }
    expect(sanitized.event.redactionsApplied).toBe(0);
    const entry = sanitized.event.metadata.find((item) => item.key === "errorKind");
    expect(entry?.value).toBe("unavailable:images_executor_unavailable");
  });

  it("a failed outbox row keeps its kind through the same leg", () => {
    const incidents = classifyIncidents(
      {
        jobs: [],
        outbox: [
          {
            eventId: "c4d62f5c-0000-4000-8000-000000000abc",
            // The REAL producer shape: outbox event names are camelCase and
            // the eventName entry redacts under today's format — exactly the
            // R33 #251 gap. This test pins the production event as it occurs:
            // one redaction (eventName), the errorKind entry verbatim. When
            // R33 aligns the eventName format, redactionsApplied flips to 0
            // and this pin must be updated with it.
            eventName: "sources.sourceAccepted",
            deliveryState: "failed",
            attempts: 2,
            lastErrorKind: "withdrawal_marking_refused:representation_retained_event_missing",
          },
        ],
        runs: [],
      },
      0,
    );
    const sanitized = sanitizeDiagnosticEvent({
      kind: incidents[0]?.kind,
      metadata: incidents[0]?.metadata,
    });
    expect(sanitized.status).toBe("ok");
    if (sanitized.status !== "ok") {
      return;
    }
    // The production event as it occurs today: exactly one redaction — the
    // eventName entry (the R33 #251 gap) — while the errorKind entry rides
    // through verbatim. R33's alignment flips redactionsApplied to 0.
    expect(sanitized.event.redactionsApplied).toBe(1);
    const nameEntry = sanitized.event.metadata.find((item) => item.key === "eventName");
    expect(nameEntry?.value).toBe("<redacted>");
    const entry = sanitized.event.metadata.find((item) => item.key === "errorKind");
    expect(entry?.value).toBe(
      "withdrawal_marking_refused:representation_retained_event_missing",
    );
  });
});

describe("redactor direction: the bounded grammar admits no free text", () => {
  const REJECTED_KINDS = [
    "unavailable:code:extra", // more than one colon
    ":images_executor_unavailable", // empty kind segment
    "unavailable:", // empty detail segment
    "Unavailable:code", // uppercase kind segment
    "unavailable:Code", // uppercase detail segment
    "unavailable:images executor", // whitespace in the detail
    "unavailable:przekroczony limit", // Polish prose
    "1unavailable:code", // leading digit
    "unavailable://api", // URL scheme
    "unavailable:429 too many requests", // provider error string
    "sk-proj-unavailable:code", // credential-shaped prefix
    `unavailable:${"a".repeat(MAX_VALUE_LENGTH - "unavailable:".length + 1)}`, // overlong total (65)
    `${"a".repeat(33)}:code`, // kind segment beyond the 32-char bound
  ] as const;

  it("every adversarial or malformed kind redacts", () => {
    for (const kind of REJECTED_KINDS) {
      expect(valuePasses("errorKind", kind), kind).toBe(false);
    }
  });

  it("a colon-bearing provider error redacts inside a real event, not just at the format", () => {
    const result = sanitizeDiagnosticEvent({
      kind: "ops.job.attempts_exhausted",
      metadata: [
        { key: "jobKey", value: "job_abc123-def456" },
        { key: "jobKind", value: "processing.transcribe_segment" },
        { key: "errorKind", value: "unavailable:429 too many requests" },
        { key: "attempts", value: "3" },
        { key: "maxAttempts", value: "3" },
      ],
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") {
      return;
    }
    const entry = result.event.metadata.find((item) => item.key === "errorKind");
    expect(entry?.value).toBe("<redacted>");
    expect(result.event.redactionsApplied).toBe(1);
  });

  it("the format source is the pinned single-colon grammar (loosening is deliberate)", () => {
    expect(METADATA_KEY_FORMATS.errorKind.source).toBe(
      "^(?:[a-z][a-z0-9_]{1,63}|[a-z][a-z0-9_]{0,31}:[a-z][a-z0-9_]{0,63})$",
    );
  });
});
