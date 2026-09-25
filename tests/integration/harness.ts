/// <reference types="vite/client" />
/**
 * In-process Convex backend for integration tests (convex-test).
 *
 * Runs the real schema, validators, indexes, transactions and scheduler of
 * convex/ without a deployment. Unlike the node-side fakes elsewhere in
 * tests/, this catches what only the Convex runtime enforces: a `fetch`
 * inside a mutation, a document that fails its table validator, a strict
 * `v.object` argument receiving an extra field.
 *
 * The guarded probe actions double as fixtures here: they are the same
 * entries the live proofs drive against a real deployment.
 */

import { convexTest, type TestConvex } from "convex-test";
import schema from "../../convex/schema";
import workflowSchema from "../../node_modules/@convex-dev/workflow/dist/component/schema.js";
import workpoolSchema from "../../node_modules/@convex-dev/workpool/dist/component/schema.js";
import batchWorkerSchema from "../../node_modules/@convex-dev/batch-worker/dist/component/schema.js";
import { api } from "../../convex/_generated/api";

// Vite resolves these globs at transform time; the component modules come
// from the packages' built output, like a real deployment's bundle.
const modules = import.meta.glob("../../convex/**/*.*s");
const workflowModules = import.meta.glob("../../node_modules/@convex-dev/workflow/dist/component/**/*.js");
const workpoolModules = import.meta.glob("../../node_modules/@convex-dev/workpool/dist/component/**/*.js");
const batchWorkerModules = import.meta.glob("../../node_modules/@convex-dev/batch-worker/dist/component/**/*.js");

export type Backend = TestConvex<typeof schema>;

/** A fresh backend with the workflow component and probe fixtures enabled. */
export function backend(): Backend {
  process.env.KIERO_PROBE_ENABLED = "1";
  const t = convexTest(schema, modules);
  // Same names as convex/convex.config.ts; workflow runs on workpool, which
  // runs its main loop on batch-worker.
  t.registerComponent("workflow", workflowSchema, workflowModules);
  t.registerComponent("workflow/workpool", workpoolSchema, workpoolModules);
  t.registerComponent("workflow/workpool/batchWorker", batchWorkerSchema, batchWorkerModules);
  return t;
}

/** Envelope result as returned by every checked Convex entry. */
export type Envelope<T = Record<string, unknown>> =
  | { readonly _tag: "ok"; readonly value: T }
  | { readonly _tag: "error"; readonly error: { readonly code: string; readonly reason?: string } };

/** Narrows an envelope to its ok value or fails the test with the error. */
export function ok<T>(result: unknown): T {
  const envelope = result as Envelope<T>;
  if (envelope._tag !== "ok") {
    throw new Error(`expected ok, got ${JSON.stringify(envelope)}`);
  }
  return envelope.value;
}

/** Seeds the service company, admin user and live session. */
export async function seedServiceCompany(t: Backend) {
  return ok<{ companyId: string; userId: string; sessionId: string }>(
    await t.action(api.platform.probe.probeSeed, {}),
  );
}
