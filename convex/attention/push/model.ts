/**
 * Web Push delivery decision core (F3): the PURE model the push
 * transactions and the delivery action run (the F2 `model.ts` precedent
 * - deterministic over its inputs, no Convex, no clock, no environment,
 * so every rule is unit-testable without a deployment while
 * ./operations.ts re-runs the SAME functions inside transactions).
 *
 * Semantics pinned by issue 43's bounded solution and the accepted
 * notification decision (issue 7 resolution):
 *
 * - The unit of delivery is F2's COLLAPSED summary on one delivered
 *   intent: ONE notification per recipient, bucket and fire instant -
 *   never one per underlying entry. The idempotency key is the semantic
 *   intent PLUS the subscription ("Do urządzenia" once), so a retried
 *   job or a concurrent sweep can never double-deliver.
 * - The preview carries project or Firma, the author and a short
 *   fragment, or the nagranie/photo count; hide-preview replaces all
 *   content with a neutral notice while keeping the semantic routing
 *   ids (ids are not content).
 * - Payloads are composed from data re-read at delivery time; a
 *   notification is never evidence of current access (the click lands in
 *   the app, which resolves current data through live authentication).
 * - Terminal provider responses (404/410) disable the subscription;
 *   uncertain outcomes (timeout/unknown) block blind re-sends - the
 *   echo/G3 uncertainty discipline.
 */

import type { PushLegReport } from "./protocol";

/** One collapsed delivery summary as F2's evaluator records it (deliveryJson). */
export interface DeliveredSummary {
  readonly semanticKind: "source_entry" | "clarification" | "task_reminder" | "confirmation";
  readonly bucket: string;
  readonly scope: { readonly kind: "company" | "project"; readonly projectIds: readonly string[] };
  readonly sourceIds?: readonly string[];
  readonly clarificationIds?: readonly string[];
  readonly deliveredAtMs: number;
}

/** The current project names of one summary's scope (re-read at delivery). */
export interface ScopeView {
  /** Current display names, sorted; empty for the company scope. */
  readonly projectNames: readonly string[];
  readonly kind: "company" | "project";
}

/** One source's preview material as the delivery re-read reads it. */
export interface SourcePreview {
  readonly sourceId: string;
  readonly authorName: string;
  /** The author's own text, when the entry has any. */
  readonly authorText: string | null;
  readonly audioCount: number;
  readonly photoCount: number;
  readonly stillActive: boolean;
}

/** One open clarification's preview material. */
export interface ClarificationPreview {
  readonly clarificationId: string;
  readonly question: string;
  readonly stillOpen: boolean;
}

/** The inputs the payload composer needs, re-read at delivery time. */
export interface PayloadInputs {
  readonly summary: DeliveredSummary;
  readonly scope: ScopeView;
  readonly sources: readonly SourcePreview[];
  readonly clarifications: readonly ClarificationPreview[];
  readonly hidePreview: boolean;
}

/** The notification the service worker shows (JSON on the wire). */
export interface PushNotificationPayload {
  readonly v: 1;
  readonly kind: "source_entry" | "clarification" | "task_reminder";
  readonly title: string;
  readonly body: string;
  /**
   * Semantic routing ids only - RELATIVE identity, never an absolute URL:
   * the service worker resolves the click inside its own scope, so an old
   * notification can never steer a user to a foreign origin. The app
   * resolves current data and live access after the click.
   */
  readonly data: {
    readonly companyId?: string;
    readonly sourceIds?: readonly string[];
    readonly clarificationIds?: readonly string[];
  };
}

/** Longest fragment/body slice kept (bounded, single record payload). */
const FRAGMENT_LIMIT = 120;

/** Collapse whitespace and bound a preview fragment. */
export function fragmentOf(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return collapsed.length <= FRAGMENT_LIMIT
    ? collapsed
    : `${collapsed.slice(0, FRAGMENT_LIMIT - 1).trimEnd()}…`;
}

/** The scope name a title shows: project names, or Firma for the company. */
export function scopeNameOf(scope: ScopeView): string {
  if (scope.kind === "company" || scope.projectNames.length === 0) {
    return "Firma";
  }
  return scope.projectNames.slice(0, 2).join(", ");
}

/** One source's preview line: author plus fragment or media counts. */
export function sourcePreviewLine(source: SourcePreview): string {
  const media: string[] = [];
  if (source.audioCount > 0) {
    // The glossary names the medium of a Wiadomość źródłowa "nagranie"
    // (może łączyć tekst, nagranie i zdjęcia); the photo line below uses
    // the same glossary vocabulary.
    media.push(source.audioCount === 1 ? "Nagranie" : `Nagrania: ${source.audioCount}`);
  }
  if (source.photoCount > 0) {
    media.push(source.photoCount === 1 ? "Zdjęcie" : `Zdjęcia: ${source.photoCount}`);
  }
  const material =
    source.authorText !== null && source.authorText.trim() !== ""
      ? fragmentOf(source.authorText)
      : media.join(" i ");
  return material === "" ? `${source.authorName}: (pusty wpis)` : `${source.authorName}: ${material}`;
}

/**
 * Composes ONE notification for one collapsed summary. Deterministic:
 * sources are ordered by their ids. The hide-preview preference replaces
 * ALL content (title included) while the routing ids stay, because ids
 * are not content and the click resolves current data anyway.
 */
export function composePushPayload(inputs: PayloadInputs): PushNotificationPayload {
  const summary = inputs.summary;
  if (inputs.hidePreview) {
    return {
      v: 1,
      kind: kindOf(summary),
      title: "Nowe powiadomienie",
      body: "Otwórz Kiero, żeby zobaczyć.",
      data: routingDataOf(summary),
    };
  }
  if (summary.semanticKind === "clarification") {
    const open = inputs.clarifications.filter((entry) => entry.stillOpen);
    const first = open[0];
    if (first === undefined) {
      return {
        v: 1,
        kind: "clarification",
        title: "Nowe powiadomienie",
        body: "Otwórz Kiero, żeby zobaczyć.",
        data: routingDataOf(summary),
      };
    }
    const more = open.length > 1 ? ` (i ${open.length - 1} więcej)` : "";
    return {
      v: 1,
      kind: "clarification",
      // The glossary and H1's surface name this concept "Sprawa do
      // wyjaśnienia"; the notification voice uses the same name.
      title: `Sprawa do wyjaśnienia: ${scopeNameOf(inputs.scope)}`,
      body: `${fragmentOf(first.question)}${more}`,
      data: routingDataOf(summary),
    };
  }
  // source_entry (and, when F4 creates them, task_reminder): the collapsed
  // current batch of entries. The payload kind mirrors the summary's
  // semantic kind on every path (kindOf), so hide-preview and normal
  // previews never disagree about what the notification is.
  const live = inputs.sources.filter((source) => source.stillActive);
  if (live.length === 0) {
    return {
      v: 1,
      kind: kindOf(summary),
      title: "Nowe powiadomienie",
      body: "Otwórz Kiero, żeby zobaczyć.",
      data: routingDataOf(summary),
    };
  }
  const ordered = [...live].sort((left, right) => left.sourceId.localeCompare(right.sourceId));
  if (ordered.length === 1) {
    return {
      v: 1,
      kind: kindOf(summary),
      title: `Nowy wpis: ${scopeNameOf(inputs.scope)}`,
      body: sourcePreviewLine(ordered[0]!),
      data: routingDataOf(summary),
    };
  }
  const authors = [...new Set(ordered.map((source) => source.authorName))];
  const authorsLabel = fragmentOf(authors.join(", "));
  return {
    v: 1,
    kind: kindOf(summary),
    title: `Nowe wpisy (${ordered.length}): ${scopeNameOf(inputs.scope)}`,
    body:
      authors.length === 1
        ? `${authorsLabel}: pierwszy z ${ordered.length} nowych wpisów`
        : `${ordered.length} nowych wpisów: ${authorsLabel}`,
    data: routingDataOf(summary),
  };
}

function kindOf(
  summary: DeliveredSummary,
): PushNotificationPayload["kind"] {
  return summary.semanticKind === "clarification" ? "clarification" : summary.semanticKind === "task_reminder" ? "task_reminder" : "source_entry";
}

function routingDataOf(summary: DeliveredSummary): PushNotificationPayload["data"] {
  return {
    ...(summary.sourceIds !== undefined && summary.sourceIds.length > 0
      ? { sourceIds: [...summary.sourceIds] }
      : {}),
    ...(summary.clarificationIds !== undefined && summary.clarificationIds.length > 0
      ? { clarificationIds: [...summary.clarificationIds] }
      : {}),
  };
}

/** Delivery TTL: every notification kind stays meaningful for a working day. */
export function ttlSecondsOf(): number {
  return 24 * 60 * 60;
}

// ---------------------------------------------------------------------------
// Leg outcome settlement (the pure half of ./operations.ts; the
// transaction carriers PreparedLeg/LegResult live there, where the Id
// types are).
// ---------------------------------------------------------------------------

/** How many transport attempts one per-device delivery may take. */
export const MAX_LEG_ATTEMPTS = 3;

/**
 * The settled row state one leg outcome implies, given the attempts count
 * AFTER this attempt (one decision, one place). A `retry_later` answer
 * with attempts left keeps the row `pending` for the next bounded sweep;
 * the same answer with none left settles `failed` as
 * `push_attempts_exhausted`. Uncertain answers are never retried.
 */
export function settleLegOutcome(
  report: PushLegReport,
  attemptsAfter: number,
): {
  readonly state: "delivered" | "failed" | "unknown" | "pending";
  readonly errorKind: string | null;
  /** The subscription is terminally gone and must be disabled. */
  readonly revokeSubscription: boolean;
  /** The notificationAttempts vocabulary for this leg (terminal-only). */
  readonly attemptOutcome: "delivered" | "failed" | "suppressed" | "unknown";
} {
  switch (report.kind) {
    case "delivered":
      return { state: "delivered", errorKind: null, revokeSubscription: false, attemptOutcome: "delivered" };
    case "gone":
      // Terminal provider response: the device unsubscribed upstream.
      return {
        state: "failed",
        errorKind: "push_subscription_gone",
        revokeSubscription: true,
        attemptOutcome: "failed",
      };
    case "rejected":
      return {
        state: "failed",
        errorKind: "push_payload_rejected",
        revokeSubscription: false,
        attemptOutcome: "failed",
      };
    case "unauthorized":
      return {
        state: "failed",
        errorKind: "push_unauthorized",
        revokeSubscription: false,
        attemptOutcome: "failed",
      };
    case "retry_later":
      return attemptsAfter < MAX_LEG_ATTEMPTS
        ? {
            state: "pending",
            errorKind: "push_retry_later",
            revokeSubscription: false,
            attemptOutcome: "failed",
          }
        : {
            state: "failed",
            errorKind: "push_attempts_exhausted",
            revokeSubscription: false,
            attemptOutcome: "failed",
          };
    case "unknown":
      return {
        state: "unknown",
        errorKind: report.cause === "timeout" ? "push_timeout_after_send" : "push_outcome_unknown",
        revokeSubscription: false,
        attemptOutcome: "unknown",
      };
  }
}
