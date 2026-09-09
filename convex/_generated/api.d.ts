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
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as integrations_email_copy from "../integrations/email/copy.js";
import type * as integrations_email_resend from "../integrations/email/resend.js";
import type * as integrations_email_send from "../integrations/email/send.js";
import type * as operations_telemetry_costs from "../operations/telemetry/costs.js";
import type * as operations_telemetry_cron from "../operations/telemetry/cron.js";
import type * as operations_telemetry_emit from "../operations/telemetry/emit.js";
import type * as operations_telemetry_functions from "../operations/telemetry/functions.js";
import type * as operations_telemetry_heartbeat from "../operations/telemetry/heartbeat.js";
import type * as operations_telemetry_http from "../operations/telemetry/http.js";
import type * as operations_telemetry_incidents from "../operations/telemetry/incidents.js";
import type * as operations_telemetry_observability from "../operations/telemetry/observability.js";
import type * as operations_telemetry_proof from "../operations/telemetry/proof.js";
import type * as operations_telemetry_redact from "../operations/telemetry/redact.js";
import type * as operations_telemetry_retention from "../operations/telemetry/retention.js";
import type * as operations_telemetry_serviceToken from "../operations/telemetry/serviceToken.js";
import type * as operations_telemetry_sink from "../operations/telemetry/sink.js";
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
import type * as sources_accept_acceptance from "../sources/accept/acceptance.js";
import type * as sources_accept_commands from "../sources/accept/commands.js";
import type * as sources_accept_dispatch from "../sources/accept/dispatch.js";
import type * as sources_accept_probe from "../sources/accept/probe.js";
import type * as sources_probe_shared from "../sources/probe_shared.js";
import type * as sources_read_probe from "../sources/read/probe.js";
import type * as sources_read_rows from "../sources/read/rows.js";
import type * as sources_read_views from "../sources/read/views.js";

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
  crons: typeof crons;
  http: typeof http;
  "integrations/email/copy": typeof integrations_email_copy;
  "integrations/email/resend": typeof integrations_email_resend;
  "integrations/email/send": typeof integrations_email_send;
  "operations/telemetry/costs": typeof operations_telemetry_costs;
  "operations/telemetry/cron": typeof operations_telemetry_cron;
  "operations/telemetry/emit": typeof operations_telemetry_emit;
  "operations/telemetry/functions": typeof operations_telemetry_functions;
  "operations/telemetry/heartbeat": typeof operations_telemetry_heartbeat;
  "operations/telemetry/http": typeof operations_telemetry_http;
  "operations/telemetry/incidents": typeof operations_telemetry_incidents;
  "operations/telemetry/observability": typeof operations_telemetry_observability;
  "operations/telemetry/proof": typeof operations_telemetry_proof;
  "operations/telemetry/redact": typeof operations_telemetry_redact;
  "operations/telemetry/retention": typeof operations_telemetry_retention;
  "operations/telemetry/serviceToken": typeof operations_telemetry_serviceToken;
  "operations/telemetry/sink": typeof operations_telemetry_sink;
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
  "sources/accept/acceptance": typeof sources_accept_acceptance;
  "sources/accept/commands": typeof sources_accept_commands;
  "sources/accept/dispatch": typeof sources_accept_dispatch;
  "sources/accept/probe": typeof sources_accept_probe;
  "sources/probe_shared": typeof sources_probe_shared;
  "sources/read/probe": typeof sources_read_probe;
  "sources/read/rows": typeof sources_read_rows;
  "sources/read/views": typeof sources_read_views;
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
