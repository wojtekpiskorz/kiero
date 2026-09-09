/**
 * A3 proof 1: checked calls, sanitized errors and the live subscription
 * path through the Convex TanStack Query integration.
 *
 * Rows produced (see docs/evidence/platform/README.md):
 *   V1 valid bridge command          V2 bad credential
 *   V3 malformed body                V4 unknown operation
 *   V5 unimplemented operation       V6 invalid input reaches no effect
 *   V7 unauthenticated direct call   V8 subscription update (adapter)
 *   V9 malformed subscription args
 *
 * Usage: node docs/evidence/platform/scripts/proof1-validation-subscription.mjs
 */

// The Convex TanStack Query adapter's live subscription path is gated on
// `typeof window !== "undefined"`. This Node proof supplies the minimal
// browser globals BEFORE importing the adapter so the real subscription
// wiring (WebSocket watch -> TanStack cache) runs; no adapter code is
// replaced or mocked.
if (typeof globalThis.window === "undefined") {
  globalThis.window = globalThis;
}
if (typeof globalThis.document === "undefined") {
  globalThis.document = { hasFocus: () => true };
}

// Dynamic imports: the adapter evaluates `isServer` at module load, so the
// globals above must exist BEFORE it loads (static imports would hoist past
// the shim).
const [{ ConvexReactClient }, { ConvexQueryClient, convexQuery }, { QueryClient }, { anyApi }] =
  await Promise.all([
    import("convex/react"),
    import("@convex-dev/react-query"),
    import("@tanstack/react-query"),
    import("convex/server"),
  ]);
import {
  bridgeCall,
  CLIENT_URL,
  httpClient,
  loadEnv,
  pollUntil,
  record,
  SITE_URL,
  stamp,
  summarize,
} from "./lib.mjs";

const env = loadEnv();
const api = anyApi;

console.log(`# proof1 validation+subscription :: started ${stamp()}`);

// --- V1: valid bridge command through the checked path ------------------------

const seed = await httpClient().action("platform/probe:probeSeed", {});
if (seed._tag !== "ok") {
  throw new Error(`probeSeed failed: ${JSON.stringify(seed)}`);
}
console.log(`seeded fixtures: ${JSON.stringify(seed.value)}`);

const echo1 = await bridgeCall(env, {
  operation: "platform.probeEcho",
  input: { message: "wycena dachu Buniewice" },
});
record(
  "V1 valid bridge command dispatches through the checked path",
  echo1.status === 200 && echo1.body._tag === "ok" && echo1.body.value.echo.includes("wycena")
    ? "PASS"
    : "FAIL",
  `status=${echo1.status} echo=${echo1.body?.value?.echo ?? JSON.stringify(echo1.body)}`,
);

// --- V2: bad credential ---------------------------------------------------------

const badToken = await bridgeCall(env, { operation: "platform.health" }, { token: "wrong" });
record(
  "V2 invalid service credential is rejected sanitized",
  badToken.status === 401 && badToken.body.error?._tag === "unauthenticated" ? "PASS" : "FAIL",
  `status=${badToken.status} tag=${badToken.body?.error?._tag}`,
);

// --- V3: malformed body ---------------------------------------------------------

const malformed = await fetch(`${SITE_URL}/platform/bridge`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${env.KIERO_SERVICE_TOKEN}`,
    "content-type": "application/json",
  },
  body: "{not json",
});
const malformedBody = await malformed.json();
record(
  "V3 malformed bridge body fails closed with a validation error",
  malformed.status === 400 && malformedBody.error?._tag === "validation" ? "PASS" : "FAIL",
  `status=${malformed.status} tag=${malformedBody?.error?._tag}`,
);

// --- V4/V5: unknown and unimplemented operations --------------------------------

const unknown = await bridgeCall(env, { operation: "drifted.nonexistent", input: {} });
record(
  "V4 unknown operation denied with unsupported/unknown_operation",
  unknown.status === 501 && unknown.body.error?.code === "unknown_operation" ? "PASS" : "FAIL",
  `status=${unknown.status} code=${unknown.body?.error?.code}`,
);

const unimplemented = await bridgeCall(env, {
  operation: "sources.acceptSource",
  input: { uploadId: "x" },
});
record(
  "V5 registered-but-unimplemented business operation fails closed (notImplemented)",
  unimplemented.status === 501 && unimplemented.body.error?.code === "not_implemented"
    ? "PASS"
    : "FAIL",
  `status=${unimplemented.status} code=${unimplemented.body?.error?.code}`,
);

// --- V6: invalid input reaches no domain effect ---------------------------------

const outboxBefore = await bridgeCall(env, { operation: "platform.outboxState", input: {} });
const eventsBefore = outboxBefore.body.value.events.length;
const invalid = await bridgeCall(env, {
  operation: "platform.probeEcho",
  input: { message: "" },
});
const outboxAfterInvalid = await bridgeCall(env, { operation: "platform.outboxState", input: {} });
record(
  "V6 invalid input reaches NO domain effect (no event published)",
  invalid.status === 400 &&
    invalid.body.error?._tag === "validation" &&
    outboxAfterInvalid.body.value.events.length === eventsBefore
    ? "PASS"
    : "FAIL",
  `status=${invalid.status} tag=${invalid.body?.error?._tag} events=${eventsBefore}->${
    outboxAfterInvalid.body.value.events.length
  }`,
);

// --- V7: unauthenticated direct client call -------------------------------------

const direct = await httpClient().mutation("platform/probe:probeEcho", {
  envelope: { operation: "platform.probeEcho", input: { message: "x" }, expectedRevisions: [] },
});
record(
  "V7 direct client command without identity fails unauthenticated",
  direct._tag === "error" && direct.error._tag === "unauthenticated" ? "PASS" : "FAIL",
  JSON.stringify(direct).slice(0, 160),
);

// --- V8/V9: the subscription path through the Convex React-Query integration ----

const convexClient = new ConvexReactClient(CLIENT_URL);
const convexQueryClient = new ConvexQueryClient(convexClient);
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryKeyHashFn: convexQueryClient.hashFn(),
      queryFn: convexQueryClient.queryFn(),
    },
  },
});
convexQueryClient.connect(queryClient);

// V8: subscribe to the health query through the adapter, then trigger a
// real mutation and observe the REACTIVE push (no invalidateQueries).
const healthOptions = convexQuery(api["platform/health"].health, {});
await queryClient.prefetchQuery(healthOptions);
const initial = queryClient.getQueryData(healthOptions.queryKey);
const update = await pollUntil(
  "reactive health revision change",
  () => {
    const current = queryClient.getQueryData(healthOptions.queryKey);
    return current && initial && current.revision > initial.revision ? current : null;
  },
  {
    timeoutMs: 25_000,
    intervalMs: 500,
    onTick: async () => {
      const bump = await bridgeCall(env, {
        operation: "platform.probeEcho",
        input: { message: `subscription bump ${Date.now()}` },
      });
      if (bump.status !== 200) {
        throw new Error(`bump failed: ${JSON.stringify(bump)}`);
      }
    },
  },
);
record(
  "V8 subscription updates push through the Convex React-Query adapter",
  update && initial && update.revision > initial.revision ? "PASS" : "FAIL",
  `revision ${initial?.revision} -> ${update?.revision} (reactive, no invalidation)`,
);

// V9: malformed subscription args are rejected by the Convex boundary and
// surface as the query's error state.
const badOptions = convexQuery(api["platform/health"].health, { unexpected: true });
try {
  await queryClient.fetchQuery({ ...badOptions, retry: false, staleTime: 0, gcTime: 0 });
  record("V9 malformed subscription args surface as errors", "FAIL", "no error raised");
} catch (error) {
  record(
    "V9 malformed subscription args surface as errors",
    String(error?.message ?? error).length > 0 ? "PASS" : "FAIL",
    String(error?.message ?? error).slice(0, 120),
  );
}

queryClient.clear();
await convexClient.close();

process.exit(summarize() ? 0 : 1);
