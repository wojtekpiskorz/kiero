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
 *
 * R3 (issue #128) additions: the runtime-decoded summary union
 * (`decodeDeliverySummary`: F2's entry summaries and F4's taskIds-only
 * reminder summaries, never a cast after JSON.parse), the bounded
 * Polish task-reminder copy ("Przypomnienie o zadaniu"), the validated
 * RELATIVE same-origin click targets (source dossier, task record, Co
 * teraz) and the non-content payload a terminal suppression stores.
 */

import type { PushLegReport } from "./protocol";

/** One collapsed delivery summary as F2's evaluator records it (deliveryJson). */
export interface DeliveredSummary {
  readonly semanticKind: "source_entry" | "clarification" | "task_reminder" | "confirmation";
  readonly bucket: string;
  /** Absent on task-reminder summaries (F4's shape has no scope). */
  readonly scope?: { readonly kind: "company" | "project"; readonly projectIds: readonly string[] };
  readonly sourceIds?: readonly string[];
  readonly clarificationIds?: readonly string[];
  /** F4's collapsed reminder batch: the tasks this one summary covers. */
  readonly taskIds?: readonly string[];
  readonly reminderKinds?: readonly string[];
  readonly deliveredAtMs: number;
}

/** The F2-shaped summary of one source-entry or clarification batch. */
export interface EntrySummary {
  readonly semanticKind: "source_entry" | "clarification";
  readonly bucket: string;
  readonly scope: {
    readonly kind: "company" | "project";
    readonly projectIds: readonly string[];
  };
  readonly sourceIds: readonly string[];
  readonly clarificationIds: readonly string[];
  readonly deliveredAtMs: number;
}

/** The F4-shaped summary of one collapsed task-reminder batch (no scope). */
export interface TaskSummary {
  readonly semanticKind: "task_reminder";
  readonly bucket: string;
  readonly taskIds: readonly string[];
  readonly deliveredAtMs: number;
}

/** The runtime-decoded union of every summary the transport accepts (R3). */
export type DecodedSummary = EntrySummary | TaskSummary;

/** What decoding one stored deliveryJson concluded (R3: no cast after parse). */
export type SummaryDecode =
  | { readonly kind: "decoded"; readonly summary: DecodedSummary }
  | { readonly kind: "confirmation" }
  | { readonly kind: "invalid" };

const SUMMARY_KINDS = [
  "source_entry",
  "clarification",
  "task_reminder",
  "confirmation",
] as const;

type SummaryKind = (typeof SUMMARY_KINDS)[number];

function isSummaryKind(value: unknown): value is SummaryKind {
  return (
    typeof value === "string" && SUMMARY_KINDS.includes(value as SummaryKind)
  );
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((entry) => typeof entry === "string")
  );
}

/**
 * Decodes one stored deliveryJson into the typed union, or refuses. The
 * push prepare runs this BEFORE any delivery row exists, so a malformed or
 * unsupported summary can never reach the transport (issue 128: the cast
 * after JSON.parse hid F4's taskIds-and-no-scope shape). Id VALUES are
 * shape-checked only: ownership stays the adapter's live read, because a
 * foreign id is a routing hint, never access.
 */
export function decodeDeliverySummary(json: string): SummaryDecode {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { kind: "invalid" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid" };
  }
  const candidate = parsed as Record<string, unknown>;
  const semanticKind = candidate.semanticKind;
  if (
    !isSummaryKind(semanticKind) ||
    typeof candidate.bucket !== "string" ||
    typeof candidate.deliveredAtMs !== "number"
  ) {
    return { kind: "invalid" };
  }
  if (semanticKind === "confirmation") {
    // The kind exists in the union but F2 never creates it.
    return { kind: "confirmation" };
  }
  const sourceIds =
    candidate.sourceIds === undefined ? [] : candidate.sourceIds;
  const clarificationIds =
    candidate.clarificationIds === undefined ? [] : candidate.clarificationIds;
  if (!isStringArray(sourceIds) || !isStringArray(clarificationIds)) {
    return { kind: "invalid" };
  }
  if (semanticKind === "task_reminder") {
    if (!isStringArray(candidate.taskIds) || candidate.taskIds.length === 0) {
      return { kind: "invalid" };
    }
    return {
      kind: "decoded",
      summary: {
        semanticKind: "task_reminder",
        bucket: candidate.bucket,
        taskIds: candidate.taskIds,
        deliveredAtMs: candidate.deliveredAtMs,
      },
    };
  }
  // Entry summaries (source_entry, clarification) need the scope shape.
  const scope: unknown = candidate.scope;
  if (scope === null || typeof scope !== "object" || Array.isArray(scope)) {
    return { kind: "invalid" };
  }
  const scopeRecord = scope as Record<string, unknown>;
  if (
    (scopeRecord.kind !== "company" && scopeRecord.kind !== "project") ||
    !isStringArray(scopeRecord.projectIds)
  ) {
    return { kind: "invalid" };
  }
  return {
    kind: "decoded",
    summary: {
      semanticKind,
      bucket: candidate.bucket,
      scope: {
        kind: scopeRecord.kind,
        projectIds: scopeRecord.projectIds,
      },
      sourceIds,
      clarificationIds,
      deliveredAtMs: candidate.deliveredAtMs,
    },
  };
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

/** One open task's preview material as the F4 adapter re-reads it (R3). */
export interface TaskPreview {
  readonly taskId: string;
  readonly title: string;
  /** False when completed, cancelled, deleted or inaccessible. */
  readonly stillOpen: boolean;
}

/** The inputs the payload composer needs, re-read at delivery time. */
export interface PayloadInputs {
  readonly summary: DeliveredSummary;
  readonly scope: ScopeView;
  readonly sources: readonly SourcePreview[];
  readonly clarifications: readonly ClarificationPreview[];
  /** The F4 adapter's re-read task rows (absent for entry summaries). */
  readonly tasks?: readonly TaskPreview[];
  readonly hidePreview: boolean;
}

/** The notification the service worker shows (JSON on the wire). */
export interface PushNotificationPayload {
  readonly v: 1;
  readonly kind: "source_entry" | "clarification" | "task_reminder";
  readonly title: string;
  readonly body: string;
  /**
   * Semantic routing ids plus the validated RELATIVE same-origin target -
   * never an absolute URL: the service worker resolves and allowlists the
   * click inside its own scope, so an old notification can never steer a
   * user to a foreign origin. The app resolves current data and live
   * access after the click.
   */
  readonly data: {
    readonly companyId?: string;
    readonly sourceIds?: readonly string[];
    readonly clarificationIds?: readonly string[];
    readonly taskIds?: readonly string[];
    readonly target: string;
  };
}

/** Longest fragment/body slice kept (bounded, single record payload). */
const FRAGMENT_LIMIT = 120;

// ---------------------------------------------------------------------------
// The validated relative targets (R3). The SAME literal wire forms the app
// registers: the source dossier route (R5's serializer contract, kept as a
// runtime-neutral twin like convex/operations/exports/snapshot.ts), the
// task record screen's param key (apps/web/src/features/now/state.ts) and
// the Co teraz route whose live read reloads current clarification state.
// RELATIVE only: no host ever enters the payload, and the service worker
// re-validates against its own scope before navigating.
// ---------------------------------------------------------------------------

/** The dossier route of one "Wiadomość źródłowa" (the R5 wire contract). */
export const SOURCE_ROUTE_PATH = "/zrodlo";
/** The task record screen's deep-link key (the accepted record route). */
export const TASK_ROUTE_PATH = "/praca";
export const TASK_ROUTE_PARAM = "zadanie";
/** The authenticated route whose live read reloads current open cases. */
export const CLARIFICATION_ROUTE_PATH = "/co-teraz";

/** The canonical relative target of one source record. */
export function sourceTargetOf(sourceId: string): string {
  return `${SOURCE_ROUTE_PATH}?zrodlo=${encodeURIComponent(sourceId)}`;
}

/** The canonical relative target of one task record. */
export function taskTargetOf(taskId: string): string {
  return `${TASK_ROUTE_PATH}?${TASK_ROUTE_PARAM}=${encodeURIComponent(taskId)}`;
}

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

/** The live open tasks of the batch, ordered by id (one order, one place). */
function orderedOpenTasksOf(inputs: PayloadInputs): readonly TaskPreview[] {
  return [...(inputs.tasks ?? [])]
    .filter((task) => task.stillOpen)
    .sort((left, right) => left.taskId.localeCompare(right.taskId));
}

/** The live sources of the batch, ordered by id (one order, one place). */
function orderedLiveSourcesOf(inputs: PayloadInputs): readonly SourcePreview[] {
  return [...inputs.sources]
    .filter((source) => source.stillActive)
    .sort((left, right) => left.sourceId.localeCompare(right.sourceId));
}

/**
 * The routing target of the FIRST live record of the summary's own kind,
 * ordered by id: the click lands on current content even when other
 * members of the batch died. Empty when nothing is live (the pure neutral
 * paths; the transaction denies before composing when that happens).
 */
function liveTargetOf(inputs: PayloadInputs): string {
  const summary = inputs.summary;
  if (summary.semanticKind === "task_reminder") {
    const open = orderedOpenTasksOf(inputs);
    return open.length > 0 ? taskTargetOf(open[0]!.taskId) : "";
  }
  if (summary.semanticKind === "clarification") {
    return inputs.clarifications.some((entry) => entry.stillOpen)
      ? CLARIFICATION_ROUTE_PATH
      : "";
  }
  const live = orderedLiveSourcesOf(inputs);
  return live.length > 0 ? sourceTargetOf(live[0]!.sourceId) : "";
}

/**
 * Composes ONE notification for one collapsed summary. Deterministic:
 * sources and tasks are ordered by their ids. The hide-preview preference
 * replaces ALL content (title included) while the routing ids and target
 * stay, because ids are not content and the click resolves current data
 * anyway.
 */
export function composePushPayload(
  inputs: PayloadInputs,
): PushNotificationPayload {
  const summary = inputs.summary;
  if (inputs.hidePreview) {
    return {
      v: 1,
      kind: kindOf(summary),
      title: "Nowe powiadomienie",
      body: "Otwórz Kiero, żeby zobaczyć.",
      data: routingDataOf(inputs, liveTargetOf(inputs)),
    };
  }
  if (summary.semanticKind === "task_reminder") {
    // The F4 adapter's rendering (R3): the CURRENT open tasks of the
    // collapsed batch. The reminder kinds are delivery metadata; the copy
    // carries the task titles only, bounded by the shared fragment limit.
    const ordered = orderedOpenTasksOf(inputs);
    if (ordered.length === 0) {
      return {
        v: 1,
        kind: "task_reminder",
        title: "Nowe powiadomienie",
        body: "Otwórz Kiero, żeby zobaczyć.",
        data: routingDataOf(inputs, ""),
      };
    }
    const first = ordered[0]!;
    return {
      v: 1,
      kind: "task_reminder",
      title:
        ordered.length === 1
          ? // The glossary names this concept "Przypomnienie o zadaniu".
            "Przypomnienie o zadaniu"
          : `Przypomnienia o zadaniach (${ordered.length})`,
      body:
        ordered.length === 1
          ? fragmentOf(first.title)
          : `${fragmentOf(first.title)} (i ${ordered.length - 1} więcej)`,
      data: routingDataOf(inputs, taskTargetOf(first.taskId)),
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
        data: routingDataOf(inputs, ""),
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
      // The authenticated route whose live read reloads the current open
      // cases (the app resolves access after the click).
      data: routingDataOf(inputs, CLARIFICATION_ROUTE_PATH),
    };
  }
  // source_entry: the collapsed current batch of entries. The payload kind
  // mirrors the summary's semantic kind on every path (kindOf), so
  // hide-preview and normal previews never disagree about what the
  // notification is.
  const ordered = orderedLiveSourcesOf(inputs);
  if (ordered.length === 0) {
    return {
      v: 1,
      kind: kindOf(summary),
      title: "Nowe powiadomienie",
      body: "Otwórz Kiero, żeby zobaczyć.",
      data: routingDataOf(inputs, ""),
    };
  }
  const target = sourceTargetOf(ordered[0]!.sourceId);
  if (ordered.length === 1) {
    return {
      v: 1,
      kind: kindOf(summary),
      title: `Nowy wpis: ${scopeNameOf(inputs.scope)}`,
      body: sourcePreviewLine(ordered[0]!),
      data: routingDataOf(inputs, target),
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
    data: routingDataOf(inputs, target),
  };
}

function kindOf(summary: DeliveredSummary): PushNotificationPayload["kind"] {
  return payloadKindOf(summary.semanticKind);
}

/** Maps a summary's semantic kind onto the payload's kind vocabulary. */
export function payloadKindOf(
  semanticKind: string,
): PushNotificationPayload["kind"] {
  return semanticKind === "clarification"
    ? "clarification"
    : semanticKind === "task_reminder"
      ? "task_reminder"
      : "source_entry";
}

/**
 * The routing data of one payload: the ids of the LIVE records only (a
 * purged member of the batch leaves no routing id behind) plus the
 * validated relative target. An empty target means "no specific record"
 * (the transaction denies before composing when nothing is live); the
 * service worker treats it like any absent target and opens its own scope.
 */
function routingDataOf(
  inputs: PayloadInputs,
  target: string,
): PushNotificationPayload["data"] {
  const summary = inputs.summary;
  if (summary.semanticKind === "task_reminder") {
    const open = orderedOpenTasksOf(inputs);
    return {
      ...(open.length > 0 ? { taskIds: open.map((task) => task.taskId) } : {}),
      target,
    };
  }
  if (summary.semanticKind === "clarification") {
    const open = inputs.clarifications.filter((entry) => entry.stillOpen);
    return {
      ...(open.length > 0
        ? { clarificationIds: open.map((entry) => entry.clarificationId) }
        : {}),
      target,
    };
  }
  const live = orderedLiveSourcesOf(inputs);
  return {
    ...(live.length > 0
      ? { sourceIds: live.map((source) => source.sourceId) }
      : {}),
    target,
  };
}

/** Delivery TTL: every notification kind stays meaningful for a working day. */
export function ttlSecondsOf(): number {
  return 24 * 60 * 60;
}

/**
 * The stored payload a terminal suppression leaves behind (R3): non-content
 * data only, no preview text and no routing ids, because the work will
 * never transport. Deleted content must not survive even as evidence of
 * what COULD have been sent.
 */
export function suppressedPayloadJson(
  kind: PushNotificationPayload["kind"],
): string {
  return JSON.stringify({
    v: 1,
    kind,
    title: "Nowe powiadomienie",
    body: "Otwórz Kiero, żeby zobaczyć.",
    data: { target: "" },
  } satisfies PushNotificationPayload);
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
