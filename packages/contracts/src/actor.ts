/**
 * Actor context and command/result envelopes.
 *
 * The server resolves the actor from the authenticated session, never from
 * client input. An agent plan is untrusted input: when the agent acts, the
 * context records the boss on whose behalf it acts (`via: "agent"`), and the
 * same checked domain operations run. Commands carry the revisions they
 * expect to build on and an optional idempotency key; results are an
 * explicit ok/error envelope. Candidate contract until A3 certifies it.
 */

import { Schema } from "effect";
import { tableIdSchema, IdempotencyKeySchema } from "./tableIds";
import { ClosedError } from "./errors";

/** Membership role inside a company ("Członkostwo w firmie", CONTEXT.md). */
export const MembershipRole = Schema.Literals(["admin", "member"]);
export type MembershipRole = Schema.Schema.Type<typeof MembershipRole>;

/**
 * Trusted, server-resolved actor context. Constructed by access resolution;
 * decoding it from client input would be a security defect, so this schema
 * exists for internal transport and tests, not for API boundaries.
 */
export const ActorContext = Schema.Struct({
  userId: tableIdSchema("users"),
  companyId: tableIdSchema("companies"),
  membershipRole: MembershipRole,
  /** GM is separate from company membership ("GM", CONTEXT.md). */
  isGm: Schema.Boolean,
  sessionId: tableIdSchema("sessions"),
  /** Whether the command comes directly from the boss or through the agent acting for them. */
  via: Schema.Literals(["user", "agent"]),
});
export type ActorContext = Schema.Schema.Type<typeof ActorContext>;

/** Monotonic per-record revision counter; 1 is the first recorded revision. */
export const RevisionCounter = Schema.Number.pipe(
  Schema.check(Schema.isInt()),
  Schema.check(Schema.isGreaterThanOrEqualTo(1)),
);
export type RevisionCounter = Schema.Schema.Type<typeof RevisionCounter>;

/** The closed table inventory ids may reference in an expectation. */
export const ExpectedRecordTable = Schema.Literals([
  "findings",
  "tasks",
  "checklistItems",
  "events",
  "projects",
  "sources",
  "extensionDefinitions",
  "clarifications",
]);
export type ExpectedRecordTable = Schema.Schema.Type<typeof ExpectedRecordTable>;

/**
 * One optimistic-concurrency expectation: the command believes this record is
 * at this revision. A mismatch fails with `conflict`, it never merges.
 */
export const RevisionExpectation = Schema.Struct({
  recordTable: ExpectedRecordTable,
  recordId: Schema.String,
  revision: RevisionCounter,
});
export type RevisionExpectation = Schema.Schema.Type<typeof RevisionExpectation>;

/** Envelope for every checked domain command (UI and agent use the same one). */
export const CommandEnvelope = Schema.Struct({
  operation: Schema.NonEmptyString,
  input: Schema.Unknown,
  expectedRevisions: Schema.Array(RevisionExpectation),
  idempotencyKey: Schema.optionalKey(IdempotencyKeySchema),
});
export type CommandEnvelope = Schema.Schema.Type<typeof CommandEnvelope>;

/** Result envelope: an explicit outcome pair, never a bare throw across the seam. */
export const ResultEnvelope = Schema.TaggedUnion({
  ok: { value: Schema.Unknown },
  error: { error: ClosedError },
});
export type ResultEnvelope = Schema.Schema.Type<typeof ResultEnvelope>;

/** Construct an ok envelope (decode-checked, no casts). */
export function okResult(value: unknown): ResultEnvelope {
  return Schema.decodeUnknownSync(ResultEnvelope)({ _tag: "ok", value });
}

/** Construct an error envelope (decode-checked, no casts). */
export function errorResult(error: ClosedError): ResultEnvelope {
  return Schema.decodeUnknownSync(ResultEnvelope)({ _tag: "error", error });
}
