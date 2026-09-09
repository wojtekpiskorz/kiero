/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as access_identity_authEntry from "../access/identity/authEntry.js";
import type * as access_identity_functions from "../access/identity/functions.js";
import type * as access_identity_issuanceLimit from "../access/identity/issuanceLimit.js";
import type * as access_identity_operations from "../access/identity/operations.js";
import type * as access_identity_policy from "../access/identity/policy.js";
import type * as access_identity_probe from "../access/identity/probe.js";
import type * as access_identity_proofDomain from "../access/identity/proofDomain.js";
import type * as access_identity_providerAvailability from "../access/identity/providerAvailability.js";
import type * as access_identity_resolution from "../access/identity/resolution.js";
import type * as access_identity_userPolicy from "../access/identity/userPolicy.js";
import type * as auth from "../auth.js";
import type * as http from "../http.js";
import type * as integrations_email_copy from "../integrations/email/copy.js";
import type * as integrations_email_resend from "../integrations/email/resend.js";
import type * as integrations_email_send from "../integrations/email/send.js";
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
  "access/identity/authEntry": typeof access_identity_authEntry;
  "access/identity/functions": typeof access_identity_functions;
  "access/identity/issuanceLimit": typeof access_identity_issuanceLimit;
  "access/identity/operations": typeof access_identity_operations;
  "access/identity/policy": typeof access_identity_policy;
  "access/identity/probe": typeof access_identity_probe;
  "access/identity/proofDomain": typeof access_identity_proofDomain;
  "access/identity/providerAvailability": typeof access_identity_providerAvailability;
  "access/identity/resolution": typeof access_identity_resolution;
  "access/identity/userPolicy": typeof access_identity_userPolicy;
  auth: typeof auth;
  http: typeof http;
  "integrations/email/copy": typeof integrations_email_copy;
  "integrations/email/resend": typeof integrations_email_resend;
  "integrations/email/send": typeof integrations_email_send;
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
