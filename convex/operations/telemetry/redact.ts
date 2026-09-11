/**
 * The single redaction definition for Kiero diagnostics (I2).
 *
 * PURE MODULE: no Convex, Effect or Node imports, so the gateway Worker and
 * the Convex functions share ONE sanitizer (the architecture's GW -> OBS flow
 * must not grow a second, drifting copy).
 *
 * Redaction is enforced BY CONSTRUCTION:
 *
 * - An event is `{ kind, metadata: {key,value}[] }` and nothing else. There
 *   is no free-form field anywhere in the shape.
 * - `kind` is a closed union; unknown kinds are REJECTED, not coerced.
 * - Every metadata key is closed AND allow-listed per kind; a key that is
 *   unknown, or known but not allowed for that kind, is dropped and counted.
 * - Every value must match its key's strict format (charset + length). A
 *   value that fails - including any value with whitespace, mixed-case prose,
 *   URL schemes, base64/JWT blobs or credential-shaped prefixes - is replaced
 *   with `<redacted>` and counted. Raw messages, filenames, prompt fragments,
 *   transcripts, auth headers, URLs and provider error strings all fail these
 *   formats structurally: no format admits a space, and none admits `//`.
 * - Malformed STRUCTURE (wrong types, duplicate keys, oversized metadata)
 *   rejects the whole event; adversarial STRING CONTENT redacts in place, so
 *   the signal survives while the content cannot.
 *
 * The output of `sanitizeDiagnosticEvent` is the ONLY shape `emit.ts` writes
 * to `diagnosticEvents`, and the only shape the sink forwards.
 */

/** Version of the redaction rules (recorded on every stored event). */
export const REDACTION_VERSION = "i2.redact.1";

/** Replacement for any value that fails its format guard. */
export const REDACTED = "<redacted>";

/** The closed diagnostic event vocabulary (mirrored in infra/observability/events.json). */
export const DIAGNOSTIC_EVENT_KINDS = [
  // Monitor group 1: processing/save incidents
  "ops.processing.completed",
  "ops.processing.failed",
  "ops.processing.stuck",
  "ops.save.failed",
  "ops.job.attempts_exhausted",
  "ops.outbox.delivery_failed",
  // Monitor group 2: recovery/health (incl. backend-silence detection)
  "ops.health.heartbeat",
  "ops.health.silence_detected",
  // I5 append (issue #57, flagged shared-file change - the sibling pattern):
  // complete-backup freshness. Emitted by the backups freshness check when
  // the newest VERIFIED manifest's SNAPSHOT age exceeds one hour (or runs
  // exist but none ever verified); deduped per staleness episode.
  "ops.backup.stale",
  // I4 append (issue #56, flagged shared-file change - the I5 precedent):
  // permanent-deletion 24-hour tracking. Emitted by the deletion purge tick
  // when a derivative family's stage is still un-purged past its deadline;
  // deduped per stage per hour (the tick's deadline slides hourly).
  "ops.deletion.overdue",
  // Monitor group 3: costs/limits
  "ops.cost.entry",
  "ops.cost.threshold_warning",
  "ops.cost.threshold_alert",
  // Gateway request surface (GW -> OBS flow)
  "ops.gateway.request",
  // Provider call accounting (metered compute + AI spend hooks)
  "ops.provider.call",
] as const;

export type DiagnosticEventKind = (typeof DIAGNOSTIC_EVENT_KINDS)[number];

/**
 * Metadata key formats. Every key's value must match its regex exactly.
 * Charsets are deliberately minimal: no whitespace, no `?`/`&` (query
 * strings), no `//` (URL schemes), no uppercase prose, no Polish diacritics.
 */
export const METADATA_KEY_FORMATS = {
  /** Trace/run correlation id (uuid or convex id shape; lowercase only - mixed-case base64 content fails). */
  traceId: /^[a-z0-9_-]{8,64}$/,
  /** Convex document id (lowercase alphanumeric, no separators). */
  runId: /^[a-z0-9]{20,64}$/,
  sourceId: /^[a-z0-9]{20,64}$/,
  /** Outbox event id (uuid). */
  eventId: /^[a-f0-9-]{10,64}$/,
  /** Durable job key (`job_` + uuid). */
  jobKey: /^job_[a-f0-9-]{10,64}$/,
  /** Closed snake_case error/state/outcome kinds (sanitized, no payloads). */
  errorKind: /^[a-z][a-z0-9_]{1,63}$/,
  state: /^[a-z][a-z0-9_]{1,31}$/,
  outcome: /^[a-z][a-z0-9_]{1,31}$/,
  status: /^[a-z][a-z0-9_]{1,31}$/,
  jobKind: /^[a-z][a-z0-9_.]{2,63}$/,
  /** I4 append (flagged): the deletion purge stage vocabulary (dotless). */
  stageKind: /^[a-z][a-z0-9_]{1,31}$/,
  eventName: /^[a-z][a-z0-9_.]{2,63}$/,
  /** Non-negative integer counters/latencies in milliseconds. */
  latencyMs: /^\d{1,10}$/,
  ageMs: /^\d{1,12}$/,
  attempts: /^\d{1,3}$/,
  maxAttempts: /^\d{1,3}$/,
  count: /^\d{1,9}$/,
  usageIn: /^\d{1,12}$/,
  usageOut: /^\d{1,12}$/,
  usageTotal: /^\d{1,12}$/,
  /** PLN minor units (grosze). */
  costMinor: /^\d{1,10}$/,
  totalMinor: /^\d{1,10}$/,
  thresholdMinor: /^\d{1,10}$/,
  /** UTC month. */
  period: /^\d{4}-(0[1-9]|1[0-2])$/,
  /** Pipeline/provider vocabularies (lowercase, dot/slash/colon/dash only). */
  pipelineVersion: /^[a-z0-9][a-z0-9.-]{0,31}$/,
  provider: /^[a-z][a-z0-9_]{1,31}$/,
  providerRoute: /^[a-z0-9][a-z0-9./:-]{0,63}$/,
  model: /^[a-z0-9][a-z0-9./-]{0,63}$/,
  category: /^[a-z][a-z0-9_]{1,31}$/,
  basis: /^(observed|estimate)$/,
  level: /^(warning_400|alert_500)$/,
  serviceName: /^[a-z][a-z0-9_.-]{2,63}$/,
  environment: /^(dev|staging|alpha-production)$/,
  /** Gateway route path (starts with `/`, no query strings possible). */
  route: /^\/[a-z0-9/_-]{1,120}$/,
  /** HTTP status code. */
  httpStatus: /^\d{3}$/,
} as const;

export type MetadataKey = keyof typeof METADATA_KEY_FORMATS;

/** Per-kind allow-list: an event kind admits ONLY these metadata keys. */
export const KIND_METADATA_ALLOWLIST: Record<DiagnosticEventKind, readonly MetadataKey[]> = {
  "ops.processing.completed": ["runId", "traceId", "pipelineVersion", "latencyMs", "providerRoute", "state"],
  "ops.processing.failed": ["runId", "traceId", "errorKind", "attempts", "state"],
  "ops.processing.stuck": ["runId", "traceId", "ageMs", "state"],
  "ops.save.failed": ["sourceId", "traceId", "errorKind", "count"],
  "ops.job.attempts_exhausted": ["jobKey", "jobKind", "errorKind", "attempts", "maxAttempts"],
  "ops.outbox.delivery_failed": ["eventId", "eventName", "errorKind", "attempts"],
  "ops.health.heartbeat": ["serviceName", "status"],
  "ops.health.silence_detected": ["serviceName", "ageMs", "count"],
  "ops.backup.stale": ["serviceName", "ageMs", "state", "count"],
  "ops.deletion.overdue": ["sourceId", "stageKind", "state", "attempts", "ageMs"],
  "ops.cost.entry": ["provider", "category", "costMinor", "period", "basis"],
  "ops.cost.threshold_warning": ["period", "totalMinor", "thresholdMinor", "level"],
  "ops.cost.threshold_alert": ["period", "totalMinor", "thresholdMinor", "level"],
  "ops.gateway.request": ["route", "httpStatus", "latencyMs", "environment"],
  "ops.provider.call": ["providerRoute", "model", "latencyMs", "usageIn", "usageOut", "usageTotal", "costMinor", "outcome"],
};

export const MAX_METADATA_ENTRIES = 16;
export const MAX_VALUE_LENGTH = 64;

/**
 * Credential-shaped prefixes that are redacted even when a value would
 * otherwise survive charset checks (defense in depth; the per-key formats
 * already reject most of these).
 */
const SECRET_PREFIXES = ["sk-", "ghp_", "gho_", "ghs_", "xox", "akia", "bearer"] as const;

function looksLikeCredential(value: string): boolean {
  const lower = value.toLowerCase();
  if (lower.includes("eyl") || lower.includes("eyj")) {
    return true; // base64 JWT headers
  }
  return SECRET_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** True when a value is acceptable for its key (format + credential guard). */
export function valuePasses(key: MetadataKey, value: string): boolean {
  if (value.length === 0 || value.length > MAX_VALUE_LENGTH) {
    return false;
  }
  if (value.includes("//")) {
    return false; // URL schemes never legitimately appear
  }
  if (looksLikeCredential(value)) {
    return false;
  }
  return METADATA_KEY_FORMATS[key].test(value);
}

/** One metadata entry after redaction. */
export interface SanitizedMetadataEntry {
  readonly key: MetadataKey;
  readonly value: string;
}

/** The only event shape that can reach storage or the sink. */
export interface SanitizedDiagnosticEvent {
  readonly kind: DiagnosticEventKind;
  readonly metadata: readonly SanitizedMetadataEntry[];
  readonly redactionsApplied: number;
  readonly redactionVersion: string;
  readonly serviceName?: string;
  readonly environment?: string;
}

export type SanitizeResult =
  | { readonly status: "ok"; readonly event: SanitizedDiagnosticEvent }
  | { readonly status: "rejected"; readonly reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Sanitizes one raw diagnostic event. Structural malformation REJECTS;
 * adversarial string content REDACTS in place. The result carries how many
 * redactions were applied so drops are visible, never silent.
 */
export function sanitizeDiagnosticEvent(input: unknown): SanitizeResult {
  if (!isRecord(input)) {
    return { status: "rejected", reason: "event_not_object" };
  }
  const { kind } = input;
  if (typeof kind !== "string" || !DIAGNOSTIC_EVENT_KINDS.includes(kind as DiagnosticEventKind)) {
    return { status: "rejected", reason: "kind_unknown" };
  }
  const allowed = KIND_METADATA_ALLOWLIST[kind as DiagnosticEventKind];
  const rawMetadata = input.metadata;
  if (!Array.isArray(rawMetadata)) {
    return { status: "rejected", reason: "metadata_not_array" };
  }
  if (rawMetadata.length > MAX_METADATA_ENTRIES) {
    return { status: "rejected", reason: "metadata_too_large" };
  }

  let redactionsApplied = 0;
  const seen = new Set<MetadataKey>();
  const metadata: SanitizedMetadataEntry[] = [];
  for (const entry of rawMetadata) {
    if (!isRecord(entry) || typeof entry.key !== "string" || typeof entry.value !== "string") {
      return { status: "rejected", reason: "metadata_entry_malformed" };
    }
    const { key, value } = entry;
    if (!(key in METADATA_KEY_FORMATS)) {
      redactionsApplied += 1; // unknown key: dropped, never stored
      continue;
    }
    const typedKey = key as MetadataKey;
    if (!allowed.includes(typedKey)) {
      redactionsApplied += 1; // known key, wrong kind: dropped
      continue;
    }
    if (seen.has(typedKey)) {
      return { status: "rejected", reason: "metadata_duplicate_key" };
    }
    seen.add(typedKey);
    const passes = valuePasses(typedKey, value);
    if (!passes && value !== REDACTED) {
      redactionsApplied += 1;
    }
    metadata.push({ key: typedKey, value: passes ? value : REDACTED });
  }

  let serviceName: string | undefined;
  if (input.serviceName !== undefined) {
    if (
      typeof input.serviceName === "string" &&
      valuePasses("serviceName", input.serviceName)
    ) {
      serviceName = input.serviceName;
    } else {
      redactionsApplied += 1;
    }
  }
  let environment: string | undefined;
  if (input.environment !== undefined) {
    if (
      typeof input.environment === "string" &&
      valuePasses("environment", input.environment)
    ) {
      environment = input.environment;
    } else {
      redactionsApplied += 1;
    }
  }

  return {
    status: "ok",
    event: {
      kind: kind as DiagnosticEventKind,
      metadata,
      redactionsApplied,
      redactionVersion: REDACTION_VERSION,
      ...(serviceName === undefined ? {} : { serviceName }),
      ...(environment === undefined ? {} : { environment }),
    },
  };
}

/**
 * Serializable form of the whole redaction spec. `infra/observability/
 * events.json` mirrors this exactly, and tests/i2 asserts the two cannot
 * drift.
 */
export function diagnosticEventSpec(): {
  redactionVersion: string;
  redactedPlaceholder: string;
  limits: { maxMetadataEntries: number; maxValueLength: number };
  kinds: readonly string[];
  keys: Record<MetadataKey, string>;
  allowlist: Record<DiagnosticEventKind, readonly string[]>;
} {
  const keys = {} as Record<MetadataKey, string>;
  for (const key of Object.keys(METADATA_KEY_FORMATS) as MetadataKey[]) {
    keys[key] = METADATA_KEY_FORMATS[key].source;
  }
  const allowlist = {} as Record<DiagnosticEventKind, readonly string[]>;
  for (const kind of DIAGNOSTIC_EVENT_KINDS) {
    allowlist[kind] = [...KIND_METADATA_ALLOWLIST[kind]];
  }
  return {
    redactionVersion: REDACTION_VERSION,
    redactedPlaceholder: REDACTED,
    limits: {
      maxMetadataEntries: MAX_METADATA_ENTRIES,
      maxValueLength: MAX_VALUE_LENGTH,
    },
    kinds: [...DIAGNOSTIC_EVENT_KINDS],
    keys,
    allowlist,
  };
}
