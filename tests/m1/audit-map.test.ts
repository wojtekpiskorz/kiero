import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * M1 #141: fixture-driven wrapper around docs/implementation/audit-map.mjs.
 *
 * Every case runs the real audit script offline (never --remote) through the
 * KIERO_MAP_MANIFEST override against mutated copies of the manifest and the
 * derived tables. The manifest is the authority; the checks below prove that
 * each drift class and each prior invariant fails with its own message.
 */

const implementationDir = fileURLToPath(new URL("../../docs/implementation/", import.meta.url));
const auditScript = join(implementationDir, "audit-map.mjs");
const tableFiles = ["dependency-graph.md", "inventory.md", "proof-ownership.md", "ux-coverage.md"] as const;

interface AuditReport {
  result: "PASS" | "FAIL";
  entries: number;
  coreEdges: number;
  uxRows: number;
  errors: string[];
}

interface AuditRun {
  status: number | null;
  report: AuditReport;
}

type FixtureManifest = Record<string, unknown> & { entries: Array<Record<string, unknown>> };

interface FixtureOptions {
  manifest?: (manifest: FixtureManifest) => void;
  tables?: Array<{ file: (typeof tableFiles)[number]; mutate: (content: string) => string }>;
}

function runAudit(scriptPath: string, workingDirectory: string, manifestPath?: string): AuditRun {
  const spawned = spawnSync(process.execPath, [scriptPath], {
    cwd: workingDirectory,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: manifestPath === undefined ? process.env : { ...process.env, KIERO_MAP_MANIFEST: manifestPath },
  });
  expect(spawned.stderr).toBe("");
  const report = JSON.parse(spawned.stdout) as AuditReport;
  return { status: spawned.status, report };
}

function auditFixture(options: FixtureOptions = {}): AuditRun {
  const root = mkdtempSync(join(tmpdir(), "kiero-m1-audit-"));
  try {
    mkdirSync(join(root, "impl"), { recursive: true });
    mkdirSync(join(root, "handoffs", "ux-ui"), { recursive: true });
    cpSync(auditScript, join(root, "impl", "audit-map.mjs"));
    cpSync(
      join(implementationDir, "..", "handoffs", "ux-ui", "feature-and-flow-inventory.md"),
      join(root, "handoffs", "ux-ui", "feature-and-flow-inventory.md"),
    );
    for (const file of tableFiles) {
      const mutation = options.tables?.find(table => table.file === file)?.mutate;
      const content = readFileSync(join(implementationDir, file), "utf8");
      writeFileSync(join(root, "impl", file), mutation === undefined ? content : mutation(content));
    }
    const manifest = JSON.parse(readFileSync(join(implementationDir, "issues.json"), "utf8")) as FixtureManifest;
    options.manifest?.(manifest);
    const manifestPath = join(root, "impl", "issues.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    return runAudit(join(root, "impl", "audit-map.mjs"), join(root, "impl"), manifestPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function expectFail(run: AuditRun, message: string): void {
  expect(run.status).toBe(1);
  expect(run.report.result).toBe("FAIL");
  expect(run.report.errors).toContain(message);
}

describe("M1 audit: derived map table content", () => {
  it("passes offline against the real manifest and tables (M1-P2)", () => {
    const run = runAudit(auditScript, implementationDir);
    expect(run.status).toBe(0);
    expect(run.report.result).toBe("PASS");
    expect(run.report.errors).toEqual([]);
    expect(run.report.entries).toBe(68);
    expect(run.report.coreEdges).toBe(160);
    expect(run.report.uxRows).toBe(61);
  });

  it("passes offline against an unmutated fixture copy", () => {
    const run = auditFixture();
    expect(run.status).toBe(0);
    expect(run.report.result).toBe("PASS");
  });

  it("fails when one graph-table blocker is swapped (M1-P1)", () => {
    const run = auditFixture({
      tables: [
        {
          file: "dependency-graph.md",
          mutate: content =>
            content.replace(
              "| [M0 #125](https://github.com/wojtekpiskorz/kiero/issues/125), [I7 #59](https://github.com/wojtekpiskorz/kiero/issues/59) |",
              "| [M0 #125](https://github.com/wojtekpiskorz/kiero/issues/125), [I5 #57](https://github.com/wojtekpiskorz/kiero/issues/57) |",
            ),
        },
      ],
    });
    expectFail(run, "R6: graph table blockers differ from manifest blockedBy");
  });

  it("fails when one graph-table state cell is flipped (M1-P1)", () => {
    const run = auditFixture({
      tables: [
        {
          file: "dependency-graph.md",
          mutate: content =>
            content.replace(
              "| [M1 #141](https://github.com/wojtekpiskorz/kiero/issues/141) | OPEN |",
              "| [M1 #141](https://github.com/wojtekpiskorz/kiero/issues/141) | CLOSED |",
            ),
        },
      ],
    });
    expectFail(run, "M1: graph table state CLOSED differs from cached OPEN");
  });

  it("fails on a stale integrated-table remaining owner (M1-P1)", () => {
    const run = auditFixture({
      tables: [
        {
          file: "inventory.md",
          mutate: content =>
            content.replace(
              /(\| \[C2 #25\]\([^)]*\)[^\n]*?)\[R1 #126\]\(https:\/\/github\.com\/wojtekpiskorz\/kiero\/issues\/126\)/,
              "$1[E7 #115](https://github.com/wojtekpiskorz/kiero/issues/115)",
            ),
        },
      ],
    });
    expectFail(run, "C2: inventory remaining owner E7 is not an open manifest entry");
  });

  it("fails on a stale mermaid remaining-work node (M1-P1)", () => {
    const run = auditFixture({
      tables: [
        {
          file: "dependency-graph.md",
          mutate: content => content.replace('  M1["M1 #141"]\n', '  M1["M1 #141"]\n  M0["M0 #125"]\n'),
        },
      ],
    });
    expectFail(run, "mermaid remaining-work nodes differ from manifest open entries");
  });

  it("fails when a derived-cell reference carries a wrong issue number (M1-P1)", () => {
    const run = auditFixture({
      tables: [
        {
          file: "dependency-graph.md",
          mutate: content =>
            content.replace(
              "| [M0 #125](https://github.com/wojtekpiskorz/kiero/issues/125), [I7 #59](https://github.com/wojtekpiskorz/kiero/issues/59) |",
              "| [M0 #124](https://github.com/wojtekpiskorz/kiero/issues/125), [I7 #59](https://github.com/wojtekpiskorz/kiero/issues/59) |",
            ),
        },
      ],
    });
    expectFail(run, "R6: graph table reference [M0 #124] does not match cached issue number 125");
  });

  it("fails on a stale closed owner inside a ux-coverage scope note (M1-P1)", () => {
    const run = auditFixture({
      tables: [
        {
          file: "ux-coverage.md",
          mutate: content =>
            content.replace(
              /(^\| UX-PRJ-01 \|.*Remaining repair\/proof owners: \[J5 #64\]\(https:\/\/github\.com\/wojtekpiskorz\/kiero\/issues\/64\))\./m,
              "$1, [G5 #107](https://github.com/wojtekpiskorz/kiero/issues/107).",
            ),
        },
      ],
    });
    expectFail(run, "UX-PRJ-01: remaining owner G5 is not an open manifest entry");
  });

  it("fails when an open product-path owner is stripped from ux-coverage references (M1-P1)", () => {
    const run = auditFixture({
      tables: [
        {
          file: "ux-coverage.md",
          mutate: content =>
            content
              .split("[R5 #130](https://github.com/wojtekpiskorz/kiero/issues/130)")
              .join(""),
        },
      ],
    });
    expectFail(run, "UX coverage never references open product-path owner R5");
  });

  it("fails on the observed P06 owner drift replayed as a fixture (M1-P1)", () => {
    const run = auditFixture({
      tables: [
        {
          file: "proof-ownership.md",
          mutate: content =>
            content.replace(
              /(\| P06 [^\n]*?)\[R5 #130\]\(https:\/\/github\.com\/wojtekpiskorz\/kiero\/issues\/130\)/,
              "$1[J3 #62](https://github.com/wojtekpiskorz/kiero/issues/62)",
            ),
        },
      ],
    });
    expectFail(run, "P06: required owners differ from manifest open proof owners");
  });

  it("fails when the cached map body restates the native-children count (mapBody check)", () => {
    const run = auditFixture({
      manifest: manifest => {
        manifest.mapBody = (manifest.mapBody as string).replace(
          "The map's native children and dependency edges are exactly those recorded",
          "The complete map contains 68 native children and its edges are recorded",
        );
      },
    });
    expectFail(run, "mapBody restates the native-children count");
  });

  it("fails when the cached map body restates the core-edge count (mapBody check)", () => {
    const run = auditFixture({
      manifest: manifest => {
        manifest.mapBody = (manifest.mapBody as string).replace(
          "plus A0's external planning prerequisite #13.",
          "across 160 core dependency edges plus A0's external planning prerequisite #13.",
        );
      },
    });
    expectFail(run, "mapBody restates the core-edge count");
  });

  it("fails when the cached map body restates a remaining-work count (mapBody check)", () => {
    const run = auditFixture({
      manifest: manifest => {
        manifest.mapBody = (manifest.mapBody as string).replace(
          "Remaining execution and administration work is listed",
          "After M0 closed, 19 execution issues remain and are listed",
        );
      },
    });
    expectFail(run, "mapBody restates a remaining-work count");
  });

  it("fails when the cached map body restates a spelled-out remaining-work count (mapBody check)", () => {
    const run = auditFixture({
      manifest: manifest => {
        manifest.mapBody = (manifest.mapBody as string).replace(
          "Remaining execution and administration work is listed",
          "Four original qualifiers remain open and are listed",
        );
      },
    });
    expectFail(run, "mapBody restates a remaining-work count");
  });

  it("fails when the cached map body J5 execution-order row omits M1 (mapBody check)", () => {
    const run = auditFixture({
      manifest: manifest => {
        manifest.mapBody = (manifest.mapBody as string).replace(
          ", [M1 #141](https://github.com/wojtekpiskorz/kiero/issues/141) |\n| [R1 #126]",
          " |\n| [R1 #126]",
        );
      },
    });
    expectFail(run, "mapBody J5 execution-order blockers differ from manifest blockedBy");
  });

  it("still enforces the 61-row UX inventory (M1-P3)", () => {
    const run = auditFixture({
      tables: [
        {
          file: "ux-coverage.md",
          mutate: content => content.replace(/^\| UX-OPS-04 \|.*\n/m, ""),
        },
      ],
    });
    expectFail(run, "UX inventory must retain all 61 unique rows");
  });

  it("still enforces the P01-P12 proof register row set (M1-P3)", () => {
    const run = auditFixture({
      tables: [
        {
          file: "proof-ownership.md",
          mutate: content => content.replace(/^\| P07 [^\n]*\n/m, ""),
        },
      ],
    });
    expectFail(run, "proof register must contain P01-P12 exactly once");
  });

  it("still enforces the core edge total (M1-P3)", () => {
    const run = auditFixture({
      manifest: manifest => {
        manifest.nativeCoreEdges = 161;
      },
    });
    expectFail(run, "core edge count mismatch");
  });

  it("still detects dependency cycles (M1-P3)", () => {
    const run = auditFixture({
      manifest: manifest => {
        const r2 = manifest.entries.find(entry => entry.key === "R2");
        if (r2 === undefined) throw new Error("fixture manifest lost R2");
        r2.blockedBy = [...(r2.blockedBy as string[]), "I9"];
      },
    });
    expect(run.status).toBe(1);
    expect(run.report.result).toBe("FAIL");
    expect(run.report.errors.some(error => error.startsWith("cycle at"))).toBe(true);
  });

  it("still detects unordered owned-path overlap between open entries (M1-P3)", () => {
    const run = auditFixture({
      manifest: manifest => {
        const r6 = manifest.entries.find(entry => entry.key === "R6");
        if (r6 === undefined) throw new Error("fixture manifest lost R6");
        r6.ownedPaths = [...(r6.ownedPaths as string[]), "docs/implementation/issues.json"];
      },
    });
    expect(run.status).toBe(1);
    expect(run.report.result).toBe("FAIL");
    expect(run.report.errors.some(error => error.includes("unordered exact owned-path overlap"))).toBe(true);
  });
});
