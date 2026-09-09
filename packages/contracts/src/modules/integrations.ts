/**
 * Integrations module surface (architecture "Deep modules": Integrations).
 * Implements lanes: E2 (providers), D6 (STT), B1 (email), G1–G3 (Calendar
 * OAuth flow owned by gateway routes).
 *
 * Provider-specific decoding, capability-aware fallback, external outcome
 * uncertainty, bounded retries. Model configuration is server-owned and
 * application-approved; there is no user-editable model selector, and no
 * provider call is made by these candidate contracts.
 */

import { Schema } from "effect";
import { operationEntry, eventEntry } from "./registration";

export const integrationsOperations = {
  "integrations.executeModelCall": operationEntry({
    kind: "operation",
    name: "integrations.executeModelCall",
    input: Schema.Struct({
      /** Server-approved route id; the concrete model order lives server-side. */
      routeId: Schema.Literals([
        "chat_analysis",
        "vision_extraction",
        "speech_to_text",
        "embedding",
      ]),
      /** Payload validated by the provider adapter for the chosen route. */
      payload: Schema.Unknown,
    }),
    result: Schema.Struct({
      actualModel: Schema.NonEmptyString,
      usageTokens: Schema.Number,
      durationMs: Schema.Number,
    }),
    errorKinds: ["forbidden", "validation", "unavailable"],
  }),
  "integrations.sendEmail": operationEntry({
    kind: "operation",
    name: "integrations.sendEmail",
    input: Schema.Struct({
      toAddress: Schema.String.pipe(
        Schema.check(Schema.isPattern(/^[^@\s]+@[^@\s]+\.[^@\s]+$/)),
      ),
      template: Schema.Literals(["invitation_code", "sign_in_code"]),
      locale: Schema.Literal("pl"),
    }),
    result: Schema.Struct({
      outcome: Schema.Literals(["sent", "failed", "unknown"]),
    }),
    errorKinds: ["forbidden", "validation", "unavailable"],
  }),
} as const;

export const integrationsEvents = {
  "integrations.providerCallCompleted": eventEntry({
    kind: "event",
    name: "integrations.providerCallCompleted",
    payload: Schema.Struct({
      routeId: Schema.NonEmptyString,
      actualModel: Schema.NonEmptyString,
      outcome: Schema.Literals(["succeeded", "failed", "timeout_unknown"]),
    }),
  }),
} as const;
