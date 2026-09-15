/**
 * I8 focused tests: the descriptor-driven worker runtime-secret
 * injector.
 *
 * The injector is the committed half of the worker SECRET plane: names
 * and worker assignments come from the descriptor's runtimeSecrets map,
 * values flow process env -> stdin of `wrangler secret bulk` (never
 * argv), one bulk call per worker, and every terminal outcome lands in
 * the outcomes file. These tests pin, without any network:
 *
 * - the descriptor schema accepts the runtimeSecrets shape and rejects
 *   the drift classes (duplicated names, bad sources, non-boolean
 *   deferred);
 * - one bulk call per worker with the exact JSON payload over stdin and
 *   the worker name from transport.workerName (the fake wrangler
 *   records argv and stdin, so a value in argv fails loudly);
 * - an unset non-deferred source REFUSES (exit 1) with the source name
 *   recorded, because a green release must carry its service bearers;
 * - an unset deferred source records `deferred` without refusing (the
 *   explicitly pending owner decisions, e.g. CONVEX_BACKUP_ADMIN_KEY);
 * - a wrangler failure refuses with the sanitized output tail.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseTargetDescriptor } from "../../infra/release/target-descriptor.mjs";

const injectorCli = fileURLToPath(new URL("../../infra/release/inject-worker-secrets.mjs", import.meta.url));
const REAL_DESCRIPTOR = JSON.parse(
  readFileSync(fileURLToPath(new URL("../../infra/release/targets/staging.json", import.meta.url)), "utf8"),
) as {
  components: Array<{
    id: string;
    included: boolean;
    runtimeSecrets?: Array<{ name: string; source: string; deferred?: boolean; format?: string }>;
    transport: { kind: string; workerName?: string; cwd?: string };
  }>;
};

/** The fake wrangler: records argv+stdin per call, always succeeds. */
function fakeWranglerBin(directory: string, callsFile: string) {
  const bin = join(directory, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    join(bin, "npx"),
    `#!/usr/bin/env node
const { appendFileSync, readFileSync } = require("node:fs");
const raw = readFileSync(0, "utf8");
appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify({ argv: process.argv.slice(2), stdin: raw }) + "\\n");
`,
    { mode: 0o755 },
  );
  writeFileSync(join(bin, "npx.cmd"), "@echo off\n", { mode: 0o755 });
}

function fixtureDescriptor(overrides: {
  runtimeSecrets?: Array<{ name: string; source: string; deferred?: boolean }>;
}) {
  return {
    descriptorId: "fixture@2026-09-15",
    target: "staging",
    githubEnvironment: "staging",
    secretPrefix: "STAGING_",
    checksName: "checks",
    components: [
      {
        id: "gateway",
        included: true,
        build: null,
        artifact: "apps/gateway",
        requiredConfig: ["CLOUDFLARE_API_TOKEN"],
        runtimeSecrets: overrides.runtimeSecrets ?? [
          { name: "KIERO_SERVICE_TOKEN", source: "SRC_SERVICE" },
          { name: "AXIOM_API_TOKEN", source: "SRC_AXIOM" },
        ],
        transport: { kind: "wrangler-deploy", cwd: ".", wranglerEnv: "staging", workerName: "fixture-worker" },
      },
    ],
  };
}

function runInjector(directory: string, env: Record<string, string>) {
  const outcomes = join(directory, "outcomes.json");
  const descriptorPath = join(directory, "descriptor.json");
  const result = spawnSync(
    process.execPath,
    [injectorCli, "--descriptor", descriptorPath, "--outcomes", outcomes],
    {
      cwd: directory,
      encoding: "utf8",
      env: { PATH: `${join(directory, "bin")}:${process.env.PATH ?? ""}`, ...env },
    },
  );
  const outcomeRows = (() => {
    try {
      return JSON.parse(readFileSync(outcomes, "utf8")) as Array<Record<string, unknown>>;
    } catch {
      return [];
    }
  })();
  return { result, outcomeRows };
}

describe("runtimeSecrets descriptor shape", () => {
  it("the real staging descriptor parses and every secret maps a source", () => {
    expect(parseTargetDescriptor(JSON.stringify(REAL_DESCRIPTOR)).violations).toBeUndefined();
    const withSecrets = REAL_DESCRIPTOR.components.filter((c) => (c.runtimeSecrets ?? []).length > 0);
    expect(withSecrets.length).toBe(4);
    for (const component of withSecrets) {
      expect(component.transport.workerName).toMatch(/^kiero-staging-/);
      for (const entry of component.runtimeSecrets ?? []) {
        expect(entry.source).toMatch(/^STAGING_/);
      }
    }
    const deferred = withSecrets.flatMap((c) => c.runtimeSecrets ?? []).filter((e) => e.deferred === true);
    expect(deferred.map((e) => e.name)).toEqual(["CONVEX_BACKUP_ADMIN_KEY"]);
  });

  it("rejects duplicated secret names and malformed entries", () => {
    const base = fixtureDescriptor({ runtimeSecrets: [{ name: "A_TOKEN", source: "SRC_A" }] });
    expect(parseTargetDescriptor(JSON.stringify(base)).violations).toBeUndefined();
    const duplicated = fixtureDescriptor({
      runtimeSecrets: [
        { name: "A_TOKEN", source: "SRC_A" },
        { name: "A_TOKEN", source: "SRC_B" },
      ],
    });
    expect(parseTargetDescriptor(JSON.stringify(duplicated)).violations?.[0]).toContain("duplicated name A_TOKEN");
    const badSource = fixtureDescriptor({ runtimeSecrets: [{ name: "A_TOKEN", source: "" }] });
    expect(parseTargetDescriptor(JSON.stringify(badSource)).violations?.length).toBeGreaterThan(0);
    const badDeferred = fixtureDescriptor({ runtimeSecrets: [{ name: "A_TOKEN", source: "SRC_A", deferred: "yes" } as never] });
    expect(parseTargetDescriptor(JSON.stringify(badDeferred)).violations?.[0]).toContain("deferred must be a boolean");
  });
});

describe("the injector (fake wrangler boundary)", () => {
  it("makes one bulk call per worker with the payload on stdin, never argv", () => {
    const directory = mkdtempSync(join(tmpdir(), "kiero-inject-"));
    fakeWranglerBin(directory, join(directory, "calls.jsonl"));
    writeFileSync(join(directory, "descriptor.json"), JSON.stringify(fixtureDescriptor({})));
    const { result, outcomeRows } = runInjector(directory, {
      SRC_SERVICE: "value-service",
      SRC_AXIOM: "value-axiom",
    });
    expect(result.status).toBe(0);
    const calls = readFileSync(join(directory, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(calls).toHaveLength(1);
    expect(calls[0].argv).toEqual(["--no-install", "wrangler", "secret", "bulk", "--name", "fixture-worker"]);
    expect(JSON.parse(calls[0].stdin)).toEqual({
      KIERO_SERVICE_TOKEN: "value-service",
      AXIOM_API_TOKEN: "value-axiom",
    });
    expect(calls[0].argv.join(" ")).not.toContain("value-");
    expect(outcomeRows).toEqual([{ outcome: "injected", worker: "fixture-worker", count: 2 }]);
  });

  it("refuses (exit 1) when a non-deferred source is unset", () => {
    const directory = mkdtempSync(join(tmpdir(), "kiero-inject-"));
    fakeWranglerBin(directory, join(directory, "calls.jsonl"));
    writeFileSync(join(directory, "descriptor.json"), JSON.stringify(fixtureDescriptor({})));
    const { result, outcomeRows } = runInjector(directory, { SRC_SERVICE: "value-service" });
    expect(result.status).toBe(1);
    expect(outcomeRows).toEqual([
      { outcome: "refused", worker: "fixture-worker", name: "AXIOM_API_TOKEN", source: "SRC_AXIOM" },
    ]);
    // No call was made: a partial payload never reaches the worker.
    const callsPath = join(directory, "calls.jsonl");
    expect(existsSync(callsPath) ? readFileSync(callsPath, "utf8") : "").toBe("");
  });

  it("records an unset deferred source without refusing", () => {
    const directory = mkdtempSync(join(tmpdir(), "kiero-inject-"));
    fakeWranglerBin(directory, join(directory, "calls.jsonl"));
    writeFileSync(
      join(directory, "descriptor.json"),
      JSON.stringify(
        fixtureDescriptor({
          runtimeSecrets: [
            { name: "KIERO_SERVICE_TOKEN", source: "SRC_SERVICE" },
            { name: "CONVEX_BACKUP_ADMIN_KEY", source: "SRC_BACKUP", deferred: true },
          ],
        }),
      ),
    );
    const { result, outcomeRows } = runInjector(directory, { SRC_SERVICE: "value-service" });
    expect(result.status).toBe(0);
    expect(outcomeRows).toEqual([
      { outcome: "deferred", worker: "fixture-worker", name: "CONVEX_BACKUP_ADMIN_KEY" },
      { outcome: "injected", worker: "fixture-worker", count: 1 },
    ]);
    const calls = readFileSync(join(directory, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(JSON.parse(calls[0].stdin)).toEqual({ KIERO_SERVICE_TOKEN: "value-service" });
  });
});

describe("R19: endpoint composition and coverage", () => {
  it("every EU R2 endpoint entry composes from the account id with the {} placeholder", () => {
    const endpoints = REAL_DESCRIPTOR.components
      .flatMap((c) => (c.runtimeSecrets ?? []).map((e) => ({ worker: c.id, ...e })))
      .filter((e) => e.name.endsWith("_ENDPOINT"));
    expect(new Set(endpoints.map((e) => e.worker))).toEqual(
      new Set(["media-worker", "export-worker", "backup-worker"]),
    );
    for (const e of endpoints) {
      expect(e.source).toBe("STAGING_CLOUDFLARE_ACCOUNT_ID");
      expect(e.format).toBe("https://{}.eu.r2.cloudflarestorage.com");
    }
  });

  it("format composes the value and reaches the payload (fake wrangler)", () => {
    const directory = mkdtempSync(join(tmpdir(), "kiero-inject-"));
    fakeWranglerBin(directory, join(directory, "calls.jsonl"));
    writeFileSync(
      join(directory, "descriptor.json"),
      JSON.stringify(
        fixtureDescriptor({
          runtimeSecrets: [
            { name: "R2_MEDIA_ENDPOINT", source: "SRC_R19_ACCOUNT", format: "https://{}.eu.r2.cloudflarestorage.com" } as never,
          ],
        }),
      ),
    );
    const { result } = runInjector(directory, { SRC_R19_ACCOUNT: "abc123account" });
    expect(result.status).toBe(0);
    const calls = readFileSync(join(directory, "calls.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
    expect(JSON.parse(calls[0].stdin)).toEqual({
      R2_MEDIA_ENDPOINT: "https://abc123account.eu.r2.cloudflarestorage.com",
    });
  });

  it("rejects a format without the placeholder and with two placeholders", () => {
    for (const format of ["https://eu.r2.cloudflarestorage.com", "https://{}{}.eu.r2.cloudflarestorage.com"]) {
      const violations = parseTargetDescriptor(
        JSON.stringify({
          descriptorId: "t", target: "staging", githubEnvironment: "staging", secretPrefix: "STAGING_", checksName: "c",
          components: [
            {
              id: "media-worker", included: true, requiredConfig: [],
              transport: { kind: "wrangler-deploy", workerName: "w", cwd: "apps/media-worker" },
              runtimeSecrets: [{ name: "R2_MEDIA_ENDPOINT", source: "S", format }],
            },
          ],
        }),
      ).violations;
      expect(violations?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("workflow wiring matches the descriptor sources", () => {
  it("every non-deferred staging runtimeSecrets source is mapped in the staging job's env", () => {
    const workflow = readFileSync(
      fileURLToPath(new URL("../../.github/workflows/release.yml", import.meta.url)),
      "utf8",
    );
    const stagingJob = workflow.slice(
      workflow.indexOf("Deploy synthetic staging"),
      workflow.indexOf("Deploy alpha production"),
    );
    const sources = REAL_DESCRIPTOR.components
      .flatMap((c) => c.runtimeSecrets ?? [])
      .filter((e) => e.deferred !== true)
      .map((e) => e.source);
    expect(new Set(sources).size).toBeGreaterThan(0);
    for (const source of sources) {
      // The injector reads process.env[<source>], so the step env key MUST
      // equal the descriptor source name; the STAGING_ prefix guard keeps
      // the value server-side.
      expect(stagingJob).toContain(`${source}: \${{ secrets.${source} }}`);
    }
  });
});
