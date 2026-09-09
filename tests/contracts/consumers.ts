/**
 * Compile-time placeholder consumers (A2 focused verification).
 *
 * This file is NOT a vitest suite (root config runs only `*.test.ts`); the
 * root `tsc -p tsconfig.json` includes it and must keep it compiling. It
 * exercises the candidate interfaces the way later lanes will, with precise
 * inferred types and NO unchecked type assertions — a placeholder that can
 * only compile via `as` would itself be a contract defect.
 */

import { Schema } from "effect";
import {
  ActorContext,
  CommandEnvelope,
  DomainEventEnvelope,
  MembershipRole,
  ResultEnvelope,
  RevisionExpectation,
  errorResult,
  events,
  isClosedError,
  newCorrelationId,
  newEventId,
  newIdempotencyKey,
  notImplemented,
  okResult,
  operations,
  parseTableId,
  tableIdSchema,
  type CompanyId,
  type EventEntry,
  type OperationEntry,
  type TaskId,
} from "@kiero/contracts";

// 1. Actor context: constructed by decoding (server-resolved semantics).
const actor: ActorContext = Schema.decodeUnknownSync(ActorContext)({
  userId: parseTableId("users", "u1"),
  companyId: parseTableId("companies", "c1"),
  membershipRole: "admin",
  isGm: false,
  sessionId: parseTableId("sessions", "s1"),
  via: "user",
});

// 2. Branded table ids keep table identity at compile time.
const parsedCompanyId = parseTableId("companies", "c1");
if (parsedCompanyId === null) {
  throw new Error("fixture id failed to normalize");
}
const companyId: CompanyId = parsedCompanyId;
// @ts-expect-error - a companies id is not a tasks id
const wrongTable: TaskId = parseTableId("companies", "c1");

// 3. Command envelope with expected revisions and idempotency.
const expectation: RevisionExpectation = Schema.decodeUnknownSync(RevisionExpectation)({
  recordTable: "tasks",
  recordId: "t1",
  revision: 2,
});
const command: CommandEnvelope = Schema.decodeUnknownSync(CommandEnvelope)({
  operation: "work.changeTaskState",
  input: { taskId: "t1", expectedRevision: 2, state: "done" },
  expectedRevisions: [expectation],
  idempotencyKey: newIdempotencyKey(),
});

// 4. Result envelope: ok and error branches without casts.
const ok: ResultEnvelope = okResult({ taskId: "t1" });
const failed: ResultEnvelope = errorResult(notImplemented(command.operation));

// 5. Module surface entries keep precise input/result types.
const resolveCurrentAccess = operations["access.resolveCurrentAccess"];
if (resolveCurrentAccess === undefined) {
  throw new Error("surface entry missing");
}
const accessInput = Schema.decodeUnknownSync(resolveCurrentAccess.input)({
  sessionId: parseTableId("sessions", "s1"),
});
const membershipAdmin: MembershipRole = "admin";

// Generic entry consumption: an executor placeholder accepts the widened
// entry shape and fails closed without pretending business work.
function placeholderOperationExecutor(entry: OperationEntry): () => ResultEnvelope {
  return () => errorResult(notImplemented(entry.name));
}
const failClosedAccess = placeholderOperationExecutor(resolveCurrentAccess);
const publishChangeSet = operations["memory.publishChangeSet"];
if (publishChangeSet === undefined) {
  throw new Error("surface entry missing: memory.publishChangeSet");
}
const failClosedPublish = placeholderOperationExecutor(publishChangeSet);
const unusedResultPair: [ResultEnvelope, ResultEnvelope] = [
  failClosedAccess(),
  failClosedPublish(),
];

// 6. Event publication through the generic envelope, payload schema attached.
const findingRevised = events["memory.findingRevised"];
if (findingRevised === undefined) {
  throw new Error("surface entry missing: memory.findingRevised");
}
function placeholderEventPublisher(entry: EventEntry, company: CompanyId): DomainEventEnvelope {
  return Schema.decodeUnknownSync(DomainEventEnvelope)({
    eventId: newEventId(),
    name: entry.name,
    companyId: company,
    occurredAt: "2026-09-09T08:00:00.000Z",
    correlationId: newCorrelationId(),
    payload: {},
  });
}
const published = placeholderEventPublisher(findingRevised, companyId);

// 7. Table id schema family: every table in the inventory has one.
const taskIdSchema = tableIdSchema("tasks");
const taskId: TaskId = Schema.decodeUnknownSync(taskIdSchema)("t1");

// 8. The closed error type guard works on the fail-closed error.
const guardWorks: boolean = isClosedError(notImplemented("work.changeTaskState"));

export const COMPILE_TIME_CONSUMERS = [
  actor,
  wrongTable,
  command,
  ok,
  failed,
  accessInput,
  membershipAdmin,
  taskId,
  unusedResultPair,
  published,
  guardWorks,
] as const;
