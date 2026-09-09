/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as http from "../http.js";
import type * as platform_context from "../platform/context.js";
import type * as platform_dispatch from "../platform/dispatch.js";
import type * as platform_echo from "../platform/echo.js";
import type * as platform_executors from "../platform/executors.js";
import type * as platform_health from "../platform/health.js";
import type * as platform_http from "../platform/http.js";
import type * as platform_jobs from "../platform/jobs.js";
import type * as platform_outbox from "../platform/outbox.js";
import type * as platform_pipeline from "../platform/pipeline.js";
import type * as platform_probe from "../platform/probe.js";
import type * as platform_publish from "../platform/publish.js";
import type * as schema_shared from "../schema/shared.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  http: typeof http;
  "platform/context": typeof platform_context;
  "platform/dispatch": typeof platform_dispatch;
  "platform/echo": typeof platform_echo;
  "platform/executors": typeof platform_executors;
  "platform/health": typeof platform_health;
  "platform/http": typeof platform_http;
  "platform/jobs": typeof platform_jobs;
  "platform/outbox": typeof platform_outbox;
  "platform/pipeline": typeof platform_pipeline;
  "platform/probe": typeof platform_probe;
  "platform/publish": typeof platform_publish;
  "schema/shared": typeof schema_shared;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
};
