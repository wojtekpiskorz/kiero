#!/usr/bin/env node
// Non-secret shape check for I1's environment descriptors (issue #53).
//
//   node infra/environments/shape-check.mjs
//
// Validates, without contacting any provider and without reading any secret:
//  1. convex.json is strict JSON (JSONC is not allowed there) with the
//     team/project/functions fields and the dev naming convention.
//  2. Every apps/*/wrangler.jsonc parses as JSONC (comments stripped, strict
//     JSON afterwards), keeps kiero-dev-* top-level names, staging/alpha
//     names in their env blocks, eu jurisdiction on R2 bindings, required
//     container fields, and no account_id.
//  3. Descriptor/binding markdown files exist and cover the required sections.
//  4. No file under the owned paths contains token-like literals (long
//     high-entropy strings) or obvious secret assignments.
//
// Exit code 0 = all checks pass.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const fail = (msg) => {
  console.error(`FAIL: ${msg}`);
  process.exitCode = 1;
};
const ok = (msg) => console.log(`ok: ${msg}`);

// --- JSONC: strip // and /* */ comments, then require strict JSON ---------
function parseJsonc(text, file) {
  const stripped = text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|[^:"'\\])\/\/.*$/gm, "$1");
  try {
    return JSON.parse(stripped);
  } catch (e) {
    fail(`${file} is not valid JSONC/JSON after comment stripping: ${e.message}`);
    return null;
  }
}

// --- 1. convex.json --------------------------------------------------------
const convexPath = path.join(ROOT, "convex.json");
try {
  const convex = JSON.parse(fs.readFileSync(convexPath, "utf8")); // strict JSON, no comments
  const keys = Object.keys(convex);
  if (!["team", "project", "functions"].every((k) => keys.includes(k)))
    fail("convex.json must contain team, project, functions");
  if (convex.project !== "kiero-dev-core")
    fail(`convex.json project must stay kiero-dev-core (dev-only guardrail), got ${convex.project}`);
  if (convex.functions !== "convex/") fail("convex.json functions must be convex/");
  ok(`convex.json strict JSON, dev project pinned (${convex.team}/${convex.project})`);
} catch (e) {
  fail(`convex.json: ${e.message}`);
}

// --- 2. wrangler.jsonc skeletons ------------------------------------------
const expectedApps = {
  gateway: ["kiero-dev-gateway", "kiero-staging-gateway", "kiero-alpha-gateway"],
  "media-worker": ["kiero-dev-media-worker", "kiero-staging-media-worker", "kiero-alpha-media-worker"],
  "export-worker": ["kiero-dev-export-worker", "kiero-staging-export-worker", "kiero-alpha-export-worker"],
  "backup-worker": ["kiero-dev-backup-worker", "kiero-staging-backup-worker", "kiero-alpha-backup-worker"],
};
for (const [app, names] of Object.entries(expectedApps)) {
  const file = path.join(ROOT, "apps", app, "wrangler.jsonc");
  if (!fs.existsSync(file)) {
    fail(`missing ${file}`);
    continue;
  }
  const cfg = parseJsonc(fs.readFileSync(file, "utf8"), file);
  if (!cfg) continue;
  if (cfg.name !== names[0]) fail(`${file}: top-level name must be ${names[0]} (dev default), got ${cfg.name}`);
  if (cfg.account_id) fail(`${file}: account_id must not be committed`);
  const envs = cfg.env ?? {};
  for (const [envName, expected] of [
    ["staging", names[1]],
    ["alpha-production", names[2]],
  ]) {
    const env = envs[envName];
    if (!env) {
      fail(`${file}: missing env.${envName}`);
      continue;
    }
    if (env.name !== expected) fail(`${file}: env.${envName}.name must be ${expected}, got ${env.name}`);
    if (env.account_id) fail(`${file}: env.${envName} commits account_id`);
  }
  // R2 expectations derive from the file's own declared scope: every
  // environment (top-level plus each named env block) that declares R2
  // bindings must declare all of them eu-jurisdiction, and the gateway must
  // declare at least one binding somewhere so the rule cannot pass vacuously.
  const r2Scopes = [
    ["top-level", cfg.r2_buckets ?? []],
    ...Object.entries(envs).map(([envName, e]) => [`env.${envName}`, e.r2_buckets ?? []]),
  ];
  const declaredR2 = r2Scopes.filter(([, blocks]) => blocks.length > 0);
  for (const [scope, blocks] of r2Scopes)
    for (const b of blocks)
      if (b.jurisdiction !== "eu")
        fail(`${file}: ${scope} R2 binding ${b.binding} must carry jurisdiction "eu"`);
  if (app === "gateway" && declaredR2.length === 0)
    fail(`${file}: gateway declares no R2 bindings; at least one eu binding per environment is required`);
  if (app !== "gateway")
    for (const [scope, blocks] of declaredR2)
      fail(`${file}: ${scope} must not bind R2 directly (S3 credentials instead)`);
  const containerBlocks = [
    ...(cfg.containers ?? []),
    ...Object.values(envs).flatMap((e) => e.containers ?? []),
  ];
  if (app !== "gateway") {
    if (!(cfg.containers?.length)) fail(`${file}: missing top-level containers block`);
    for (const c of containerBlocks) {
      if (!c.image || !c.class_name) fail(`${file}: container ${c.name} needs image and class_name`);
      // Durable invariant: once constraints exist (wrangler >= 4.130 schema),
      // EU jurisdiction is mandatory, never optional.
      if (c.constraints && c.constraints.jurisdiction !== "eu")
        fail(`${file}: container ${c.name} constraints.jurisdiction must be "eu"`);
    }
  } else if (containerBlocks.length) {
    fail(`${file}: gateway must not run containers`);
  }
  ok(`${file}: names, EU jurisdiction and container shape valid`);
}

// --- 3. descriptor / binding markdown coverage -----------------------------
const requiredDocs = [
  "infra/environments/local.md",
  "infra/environments/synthetic-staging.md",
  "infra/environments/alpha-production.md",
  "infra/environments/README.md",
  "infra/bindings/README.md",
  "infra/bindings/convex-functions.md",
  "infra/bindings/gateway-worker.md",
  "infra/bindings/media-export-workers.md",
  "infra/bindings/backup-worker.md",
  "docs/evidence/environment/preflight-2026-09.md",
];
for (const doc of requiredDocs) {
  const p = path.join(ROOT, doc);
  if (!fs.existsSync(p)) {
    fail(`missing ${p}`);
    continue;
  }
  ok(`${doc} present`);
}
for (const env of ["local", "synthetic-staging", "alpha-production"]) {
  const p = path.join(ROOT, "infra/environments", `${env}.md`);
  if (!fs.existsSync(p)) continue;
  const text = fs.readFileSync(p, "utf8");
  for (const section of [
    "## Identity",
    "## Secret-name inventory",
    "## Resource naming convention",
    "## EU requirements",
    "Command aliases",
  ])
    if (!text.includes(section)) fail(`${p}: missing section "${section}"`);
}

// --- 4. secret-leak heuristic over owned paths ------------------------------
const ownedDirs = [
  path.join(ROOT, "infra"),
  path.join(ROOT, "docs/evidence/environment"),
  path.join(ROOT, "apps"),
  path.join(ROOT, "convex.json"),
];
// Long runs that contain both letters and digits (rulers like ---- are excluded).
const suspicious = /(sk-[A-Za-z0-9]{16,}|(?=[A-Za-z0-9_-]{40,})(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{40,}|Bearer\s+[A-Za-z0-9._-]{20,}|api[_-]?key["'\s:=]+[A-Za-z0-9]{16,})/i;
function walk(p) {
  const st = fs.statSync(p);
  if (st.isDirectory()) {
    if (path.basename(p) === "node_modules") return;
    return fs.readdirSync(p).forEach((c) => walk(path.join(p, c)));
  }
  if (!/\.(md|jsonc|json|mjs)$/.test(p)) return;
  const text = fs.readFileSync(p, "utf8");
  // Account ids are 32 hex chars and allowed only in the evidence doc.
  const hex32 = text.match(/\b[0-9a-f]{32}\b/);
  if (hex32 && !p.includes(path.join("docs", "evidence")))
    fail(`${p}: 32-hex account-id-like literal outside evidence (${hex32[0]})`);
  const m = text.match(suspicious);
  if (m && !/^[0-9a-f]{32}$/.test(m[1])) fail(`${p}: token-like literal (${m[1].slice(0, 12)}...)`);
}
for (const d of ownedDirs) if (fs.existsSync(d)) walk(d);
ok("secret-leak heuristic clean over owned paths");

console.log(process.exitCode ? "shape check FAILED" : "shape check passed");
