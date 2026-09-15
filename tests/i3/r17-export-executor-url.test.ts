/**
 * R17 regression: the two export executor consumers must derive their
 * full URLs from ONE bare-origin KIERO_EXPORT_EXECUTOR_URL.
 *
 * The defect (found by the #206 advisory review): the build drive
 * fetched the env value verbatim while the cleanup drive appended
 * /exports/cleanup, so no single value could serve both. The repair
 * appends the route in code at both sites through the shared
 * exportExecutorUrl helper. These tests pin:
 *
 * - one bare origin (with and without a trailing slash) yields exactly
 *   .../exports/build for the build drive (captured from the real
 *   callExportExecutor fetch, env path) and .../exports/cleanup for the
 *   helper the cleanup site consumes;
 * - urlOverride stays a verbatim full URL (the guarded proofs point at
 *   exact endpoints, dead or alive);
 * - a missing env value still fails closed as
 *   export_executor_not_configured.
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  callExportExecutor,
  EXPORT_BUILD_ROUTE,
  EXPORT_CLEANUP_ROUTE,
  exportExecutorUrl,
} from "../../convex/operations/exports/executor";

const ENV_NAME = "KIERO_EXPORT_EXECUTOR_URL";

afterEach(() => {
  delete process.env[ENV_NAME];
  delete process.env.KIERO_SERVICE_TOKEN;
  vi.unstubAllGlobals();
});

/** A 200 envelope shaped like the Worker's build answer. */
function stubFetchCapture(): string[] {
  const urls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      urls.push(String(input));
      return new Response(JSON.stringify({ _tag: "ok", value: {} }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }),
  );
  return urls;
}

describe("exportExecutorUrl (R17 shared derivation)", () => {
  it("derives both consumer routes from one bare origin", () => {
    const base = "https://export-worker.example";
    expect(exportExecutorUrl(base, EXPORT_BUILD_ROUTE)).toBe(
      "https://export-worker.example/exports/build",
    );
    expect(exportExecutorUrl(base, EXPORT_CLEANUP_ROUTE)).toBe(
      "https://export-worker.example/exports/cleanup",
    );
  });

  it("tolerates a trailing slash on the origin for both routes", () => {
    const base = "https://export-worker.example/";
    expect(exportExecutorUrl(base, EXPORT_BUILD_ROUTE)).toBe(
      "https://export-worker.example/exports/build",
    );
    expect(exportExecutorUrl(base, EXPORT_CLEANUP_ROUTE)).toBe(
      "https://export-worker.example/exports/cleanup",
    );
  });
});

describe("callExportExecutor (R17 build drive)", () => {
  it("POSTs the appended build route for a bare-origin env value", async () => {
    process.env[ENV_NAME] = "https://export-worker.example";
    process.env.KIERO_SERVICE_TOKEN = "service-token";
    const urls = stubFetchCapture();

    const outcome = await callExportExecutor("job-1", "export-1", "build-token");

    expect(outcome).toEqual({ kind: "succeeded" });
    expect(urls).toEqual(["https://export-worker.example/exports/build"]);
  });

  it("keeps urlOverride verbatim (the guarded proofs pin exact endpoints)", async () => {
    process.env[ENV_NAME] = "https://export-worker.example";
    process.env.KIERO_SERVICE_TOKEN = "service-token";
    const urls = stubFetchCapture();

    await callExportExecutor("job-1", "export-1", "build-token", "https://proof-sink.example/dead-endpoint");

    expect(urls).toEqual(["https://proof-sink.example/dead-endpoint"]);
  });

  it("fails closed as export_executor_not_configured without the env", async () => {
    delete process.env[ENV_NAME];
    process.env.KIERO_SERVICE_TOKEN = "service-token";

    const outcome = await callExportExecutor("job-1", "export-1", "build-token");

    expect(outcome).toEqual({
      kind: "failed",
      retryable: false,
      errorKind: "export_executor_not_configured",
    });
  });
});
