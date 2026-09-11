/**
 * J2 focused tests, composition half: the three final core composition
 * entries the join owns (convex/composition/core.ts,
 * apps/web/src/composition/full.ts, apps/gateway/src/composition/full.ts)
 * validate the complete core loudly: every core durable job kind has an
 * executor, every core surface composes mounted in order, the retired
 * /wpis route stays retired, and the gateway's core HTTP surface resolves.
 *
 * Drift injections prove the validators actually bite: a dropped provider,
 * a resurrected route and a missing executor each fail loudly instead of
 * shipping a silently incomplete core.
 */

import { describe, expect, it } from "vitest";
import { operations, events } from "@kiero/contracts";
import {
  CORE_EVENT_SEAMS,
  CORE_JOB_KINDS,
  CORE_OPERATION_SEAMS,
  coreCompositionOrThrow,
  validateCoreComposition,
  type CoreRegistryView,
} from "../../convex/composition/core";
import {
  FULL_CORE_FEATURE_IDS,
  RETIRED_CORE_ROUTE_PATHS,
  fullCoreAppFeatures,
  validateFullCoreComposition,
} from "../../apps/web/src/composition/full";
import {
  FULL_CORE_PROVIDER_IDS,
  FULL_CORE_ROUTE_PATHS,
  fullCoreGatewayOrThrow,
  validateFullCoreGateway,
  type GatewayRegistryView,
} from "../../apps/gateway/src/composition/full";
import { jobExecutors } from "../../convex/platform/executors";
import { appFeatures } from "../../apps/web/src/app/app-features";
import { appFeatureEntry, type AppFeatureEntry } from "../../apps/web/src/app/registry";

describe("the Convex core composition entry", () => {
  it("validates cleanly: every core job kind has a registered executor", () => {
    const composition = coreCompositionOrThrow();
    expect(composition.problems).toEqual([]);
    expect(composition.executorCount).toBeGreaterThanOrEqual(CORE_JOB_KINDS.length);
    for (const kind of CORE_JOB_KINDS) {
      expect(jobExecutors[kind]).toBeDefined();
    }
  });

  it("names operation and event seams that exist in the contracts registries", async () => {
    const { operations, events } = await import("@kiero/contracts");
    for (const operation of CORE_OPERATION_SEAMS) {
      expect(operation in operations).toBe(true);
    }
    for (const eventName of CORE_EVENT_SEAMS) {
      expect(eventName in events).toBe(true);
    }
  });

  it("bites: a job kind without an executor is reported, not shipped", () => {
    // REAL drift through the validator's registry view (the gateway
    // validator's pattern): drop one live executor from the composed view
    // and the validator must name exactly that kind, and the loud gate
    // must throw on it. The I-lane kinds (exports, backups, purge) are
    // honestly OUTSIDE the core set, so the injected drift removes a CORE
    // kind instead.
    const drifted: CoreRegistryView = {
      jobExecutors: Object.fromEntries(
        Object.entries(jobExecutors).filter(([kind]) => kind !== "search.index_generation"),
      ),
      operations,
      events,
    };
    const composition = validateCoreComposition(drifted);
    expect(composition.problems).toEqual([
      { kind: "executor_missing", name: "search.index_generation" },
    ]);
    expect(() => coreCompositionOrThrow(drifted)).toThrow(
      /Core composition drift: executor_missing: search\.index_generation/,
    );
  });

  it("bites: a seam missing from the contracts registries is reported", () => {
    const drifted: CoreRegistryView = {
      jobExecutors,
      operations: {}, // every operation seam is now missing
      events,
    };
    const composition = validateCoreComposition(drifted);
    expect(
      composition.problems.filter((problem) => problem.kind === "operation_missing"),
    ).toHaveLength(CORE_OPERATION_SEAMS.length);
  });
});

describe("the web full-core composition entry", () => {
  it("composes the complete core with the conversation first and /wpis retired", () => {
    const composed = fullCoreAppFeatures();
    expect(composed[0]?.featureId).toBe("conversation.company");
    expect(composed[0]?.routePath).toBe("/");
    const mountedIds = composed
      .filter((entry) => entry.implementation === "mounted")
      .map((entry) => entry.featureId);
    expect(mountedIds.join("|")).toBe(FULL_CORE_FEATURE_IDS.join("|"));
    expect(composed.some((entry) => RETIRED_CORE_ROUTE_PATHS.includes(entry.routePath))).toBe(
      false,
    );
  });

  it("is the list the shipped host composes (app-features delegates to the join)", () => {
    expect(appFeatures.map((entry) => entry.featureId)).toEqual(
      fullCoreAppFeatures().map((entry) => entry.featureId),
    );
  });

  it("bites: a resurrected /wpis entry or a dropped surface fails validation", () => {
    const resurrected = appFeatureEntry({
      featureId: "capture.composer",
      routePath: "/wpis",
      navLabel: "Nowy wpis",
      screenHeading: "Nowy wpis",
      consumedOperations: ["sources.prepareUpload", "sources.acceptSource"],
      implementation: "mounted",
      screen: () => null,
    });
    const withRetired: readonly AppFeatureEntry[] = [...appFeatures, resurrected];
    const problems = validateFullCoreComposition(withRetired).problems;
    expect(problems.some((problem) => problem.kind === "retired_route_present")).toBe(true);

    const dropped: readonly AppFeatureEntry[] = appFeatures.filter(
      (entry) => entry.featureId !== "attention.now",
    );
    const droppedProblems = validateFullCoreComposition(dropped).problems;
    expect(droppedProblems.some((problem) => problem.kind === "feature_missing")).toBe(true);
  });

  it("bites: the conversation's send operations cannot drift silently", () => {
    const drifted: readonly AppFeatureEntry[] = appFeatures.map((entry) =>
      entry.featureId === "conversation.company"
        ? appFeatureEntry({
            featureId: "conversation.company",
            routePath: "/",
            navLabel: entry.navLabel,
            screenHeading: entry.screenHeading,
            consumedOperations: ["sources.acceptSource"],
            implementation: "mounted",
            screen: () => null,
          })
        : entry,
    );
    const problems = validateFullCoreComposition(drifted).problems;
    expect(problems.some((problem) => problem.kind === "conversation_operations_drift")).toBe(
      true,
    );
  });
});

describe("the gateway full-core composition entry", () => {
  /** The registry view matching the join's declared expectation. */
  const completeRegistry: GatewayRegistryView = {
    providers: FULL_CORE_PROVIDER_IDS.map((providerId) => ({ providerId })),
    match: (method, path) =>
      FULL_CORE_ROUTE_PATHS.some(
        (route) => route.method === method && route.path === path,
      )
        ? { method, path }
        : undefined,
  };

  it("validates cleanly when the five core providers compose with their routes", () => {
    const composition = fullCoreGatewayOrThrow(completeRegistry);
    expect(composition.problems).toEqual([]);
    expect(composition.providerIds).toEqual(FULL_CORE_PROVIDER_IDS);
  });

  it("bites: a dropped provider and a missing route are reported as drift", () => {
    const dropped: GatewayRegistryView = {
      providers: completeRegistry.providers.filter(
        (provider) => provider.providerId !== "uploads",
      ),
      match: completeRegistry.match,
    };
    const droppedProblems = validateFullCoreGateway(dropped).problems;
    expect(droppedProblems.some((problem) => problem.kind === "provider_missing")).toBe(true);

    const routeless: GatewayRegistryView = {
      providers: completeRegistry.providers,
      match: () => undefined,
    };
    const routeProblems = validateFullCoreGateway(routeless).problems;
    expect(routeProblems.some((problem) => problem.kind === "route_missing")).toBe(true);
    expect(() => fullCoreGatewayOrThrow(routeless)).toThrow(/Full core gateway composition drift/);
  });
});
