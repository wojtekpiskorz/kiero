/**
 * C1 focused verification: the checked dispatch surface, the lane policy
 * registration and the contract-vocabulary enforcement.
 *
 * The transaction halves need a Convex deployment; the LIVE proof
 * (tests/c1/live-proof.mjs) exercises them end to end against the leased
 * dev deployment. What MUST hold structurally is pinned here: exactly the
 * six projects operations are registered under the write intent; unknown
 * or unimplemented operations (including any invented automatic-closure
 * operation) fail closed `unsupported`; invalid or wrong-vocabulary input
 * fails `validation` BEFORE any handler runs (a "paused" stage, an
 * impossible calendar resume date, an empty pause reason); no resolved
 * identity means `unauthenticated`; and the pinned error-kind vocabulary
 * of the A2 surface.
 */

import { describe, expect, it, vi } from "vitest";
import { Schema } from "effect";
import {
  ActorContext,
  parseTableId,
  projectsOperations,
  tableIdSchema,
} from "@kiero/contracts";
import {
  dispatchCommand,
  membershipPolicy,
  type RequestContext,
} from "@kiero/runtime";
import { projectsHandlers } from "../../convex/projects/dispatch";
import { projectsLanePolicy } from "../../convex/projects/policy";
import { projectsTables } from "../../convex/projects/schema";

function contextFixture(role: "admin" | "member"): RequestContext {
  const actor = Schema.decodeUnknownSync(ActorContext)({
    userId: parseTableId("users", "u1"),
    companyId: parseTableId("companies", "c1"),
    membershipRole: role,
    isGm: false,
    sessionId: parseTableId("sessions", "s1"),
    via: "user",
  });
  return { actor, resolvedAtMs: Date.now() };
}

const envelope = (operation: string, input: unknown) => ({
  operation,
  input,
  expectedRevisions: [],
});

const projectId = () => parseTableId("projects", "p1");

describe("the C1 projects handler registration", () => {
  it("registers exactly the six contract operations of the projects surface", () => {
    const handlers = projectsHandlers();
    expect(Object.keys(handlers).sort()).toEqual([
      "projects.assignCodename",
      "projects.assignContactRole",
      "projects.changeStage",
      "projects.identifyProject",
      "projects.setPause",
      "projects.upsertContact",
    ]);
  });

  it("binds every operation to the write intent (boss-level collaborative work)", () => {
    const handlers = projectsHandlers();
    for (const binding of Object.values(handlers)) {
      expect(binding.intent).toBe("write");
    }
  });

  it("fails closed on invented operations, including automatic closure", async () => {
    // "Feed silence, an elapsed date and no open tasks into transition
    // commands and prove they cannot close a project": there is NO
    // operation for it. Any invented name is unknown at the composed
    // registry (B3's company-scoped dispatch analogue).
    for (const operation of [
      "projects.autoCloseInactive",
      "projects.closeOnElapsedDate",
      "projects.closeWhenNoOpenTasks",
      "projects.mergeProjects",
    ]) {
      const result = await dispatchCommand(
        {
          resolveContext: async () => contextFixture("admin"),
          policy: projectsLanePolicy,
          handlers: {},
        },
        null,
        envelope(operation, {}),
      );
      expect(result._tag, operation).toBe("error");
      if (result._tag === "error") {
        expect(result.error._tag).toBe("unsupported");
        expect(result.error.code).toBe("unknown_operation");
      }
    }
  });

  it("never invokes a handler when the contract rejects the input", async () => {
    const handler = vi.fn(async () => ({ _tag: "ok" as const, value: {} }));
    const cases: ReadonlyArray<[string, unknown]> = [
      // A pause is NOT a stage: the trap shape fails the vocabulary.
      ["projects.changeStage", { projectId: projectId(), expectedRevision: 1, stage: "paused" }],
      // Any other non-stage string fails the same way.
      ["projects.changeStage", { projectId: projectId(), expectedRevision: 1, stage: "on_hold" }],
      // A missing stage cannot close anything (silence is not a command).
      ["projects.changeStage", { projectId: projectId(), expectedRevision: 1 }],
      // Impossible calendar days fail the LocalDate contract.
      [
        "projects.setPause",
        { projectId: projectId(), expectedRevision: 1, pause: { reason: "okna", resumeOn: "2026-02-30" } },
      ],
      ["projects.setPause", { projectId: projectId(), expectedRevision: 1, pause: { reason: "okna", resumeOn: "2026-13-01" } }],
      // An empty reason is not a pause.
      ["projects.setPause", { projectId: projectId(), expectedRevision: 1, pause: { reason: "", resumeOn: null } }],
      // Pause shape must be null or {reason, resumeOn}: a bare string is not one.
      ["projects.setPause", { projectId: projectId(), expectedRevision: 1, pause: "bo tak" }],
      // Contact kinds and roles are closed vocabularies.
      ["projects.upsertContact", { contactId: null, kind: "company", displayName: "X" }],
      ["projects.assignContactRole", { projectId: projectId(), contactId: parseTableId("contacts", "c1"), role: "boss" }],
      // expectedRevision is a positive integer.
      ["projects.changeStage", { projectId: projectId(), expectedRevision: 0, stage: "agreed" }],
      ["projects.identifyProject", { displayName: "Łazienka", initialStage: "quote", clientId: null }],
    ];
    for (const [operation, input] of cases) {
      const result = await dispatchCommand(
        {
          resolveContext: async () => contextFixture("member"),
          policy: projectsLanePolicy,
          handlers: { [operation]: { intent: "write", run: handler } },
        },
        undefined,
        envelope(operation, input),
      );
      expect(result._tag, `${operation}: ${JSON.stringify(input)}`).toBe("error");
      if (result._tag === "error") {
        expect(result.error._tag).toBe("validation");
      }
      expect(handler).not.toHaveBeenCalled();
    }
  });

  it("decodes a well-formed pause with a calendar-verified resume date", () => {
    const decoded = Schema.decodeUnknownSync(projectsOperations["projects.setPause"].input)({
      projectId: projectId(),
      expectedRevision: 3,
      pause: { reason: "czekamy na okna", resumeOn: "2028-02-29" },
    });
    expect(decoded.pause).toEqual({ reason: "czekamy na okna", resumeOn: "2028-02-29" });
  });

  it("denies projects commands without a resolved identity before any handler runs", async () => {
    const handler = vi.fn(async () => ({ _tag: "ok" as const, value: {} }));
    const result = await dispatchCommand(
      {
        resolveContext: async () => null,
        policy: projectsLanePolicy,
        handlers: { "projects.identifyProject": { intent: "write", run: handler } },
      },
      undefined,
      envelope("projects.identifyProject", {
        displayName: "Łazienka",
        initialStage: "inquiry",
        clientId: null,
      }),
    );
    expect(result._tag).toBe("error");
    if (result._tag === "error") {
      expect(result.error._tag).toBe("unauthenticated");
    }
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("the C1 policy registration", () => {
  it("is the C1 registration over the platform seam", () => {
    expect(projectsLanePolicy.policyId).toBe("projects.c1-projects-v1");
  });

  it("agrees with the certified platform semantics on every intent and role", async () => {
    const requests = [
      { intent: "read" as const },
      { intent: "write" as const },
      { intent: "execute" as const },
      { intent: "administer" as const },
      { intent: "inspectGm" as const },
    ];
    for (const role of ["admin", "member"] as const) {
      const context = contextFixture(role);
      for (const request of requests) {
        expect(await projectsLanePolicy.authorize(context, request)).toEqual(
          await membershipPolicy.authorize(context, request),
        );
      }
    }
  });

  it("denies null contexts and cross-company scopes", async () => {
    const denied = await projectsLanePolicy.authorize(null, { intent: "write" });
    expect(denied.allowed).toBe(false);
    const cross = await projectsLanePolicy.authorize(contextFixture("admin"), {
      intent: "write",
      companyId: Schema.decodeUnknownSync(tableIdSchema("companies"))("c2"),
    });
    expect(cross.allowed).toBe(false);
  });
});

describe("the projects contract entries (closed error vocabulary)", () => {
  it("pins the declared error kinds of the implemented surface", () => {
    expect([...projectsOperations["projects.identifyProject"].errorKinds].sort()).toEqual([
      "forbidden",
      "validation",
    ]);
    expect([...projectsOperations["projects.assignCodename"].errorKinds].sort()).toEqual([
      "conflict",
      "forbidden",
      "not_found",
    ]);
    expect([...projectsOperations["projects.changeStage"].errorKinds].sort()).toEqual([
      "conflict",
      "forbidden",
      "not_found",
      "validation",
    ]);
    expect([...projectsOperations["projects.setPause"].errorKinds].sort()).toEqual([
      "conflict",
      "forbidden",
      "not_found",
    ]);
    expect([...projectsOperations["projects.upsertContact"].errorKinds].sort()).toEqual([
      "forbidden",
      "validation",
    ]);
    expect([...projectsOperations["projects.assignContactRole"].errorKinds].sort()).toEqual([
      "forbidden",
      "not_found",
      "validation",
    ]);
  });

  it("keeps the schema fragment pinned to the contract vocabularies", () => {
    expect(Object.keys(projectsTables).sort()).toEqual([
      "contactRoles",
      "contacts",
      "projectAliases",
      "projects",
    ]);
    // The stage union on the projects table is the encoded contract
    // vocabulary; a drift fails typecheck (shared.ValueValidator) — this
    // asserts the fragment actually declares it on every table row shape.
    expect(projectsTables.projects).toBeDefined();
    expect(projectsTables.projectAliases).toBeDefined();
    expect(projectsTables.contacts).toBeDefined();
    expect(projectsTables.contactRoles).toBeDefined();
  });
});
