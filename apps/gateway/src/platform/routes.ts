/**
 * Gateway platform routes (A3).
 *
 * The fixed route table the Worker serves for the platform lane:
 *
 * - `GET /platform/health`: local gateway health/version plus the backend
 *   health through the verified bridge (later diagnostics build on this).
 * - `POST /platform/command`: forwards one command envelope through the
 *   verified bridge (service identity -> canonical access check).
 * - anything else under `/platform/`: denied with the sanitized
 *   `unsupported` closed error (no route accidentally "works").
 *
 * Route providers register in `../composition/registry.ts`; later lanes add
 * their own provider files there without touching this one.
 */

import { errorResult, okResult } from "@kiero/contracts";
import { RUNTIME_VERSION, unsupportedError } from "@kiero/runtime";
import { callPlatform, platformHealth, type BridgeEnv } from "./bridge";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface GatewayRoute {
  readonly method: "GET" | "POST";
  readonly path: string;
  handle(request: Request, env: BridgeEnv): Promise<Response>;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export const platformRoutes: readonly GatewayRoute[] = [
  {
    method: "GET",
    path: "/platform/health",
    handle: async (_request, env) => {
      const backend = await platformHealth(env);
      return jsonResponse(200, {
        gateway: okResult({
          status: "ok",
          runtimeVersion: RUNTIME_VERSION,
          backendReachable: backend._tag === "ok",
        }),
        backend,
      });
    },
  },
  {
    method: "POST",
    path: "/platform/command",
    handle: async (request, env) => {
      let body: unknown;
      try {
        body = await request.json();
      } catch {
        return jsonResponse(400, errorResult(unsupportedError("gateway.command", "body_not_json")));
      }
      if (!isRecord(body)) {
        return jsonResponse(400, errorResult(unsupportedError("gateway.command", "body_not_object")));
      }
      const { operation, input, idempotencyKey } = body;
      if (typeof operation !== "string" || operation.length === 0) {
        return jsonResponse(
          400,
          errorResult(unsupportedError("gateway.command", "operation_missing")),
        );
      }
      const result = await callPlatform(env, {
        operation,
        input,
        ...(typeof idempotencyKey === "string" ? { idempotencyKey } : {}),
      });
      return jsonResponse(result._tag === "ok" ? 200 : 400, result);
    },
  },
];

/** Answers an unmatched /platform/ path with the honest closed error. */
export function unsupportedPlatformRoute(path: string): Response {
  return jsonResponse(400, errorResult(unsupportedError(`gateway${path}`, "no_such_route")));
}
