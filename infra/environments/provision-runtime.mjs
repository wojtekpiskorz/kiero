#!/usr/bin/env node
// Provisions the self-generated runtime configuration of one Convex
// deployment (and, for staging, the GitHub secrets the release consumes).
//
//   node infra/environments/provision-runtime.mjs --target dev|staging [--apply] [--rotate] [--github]
//
// Without --apply it prints the plan (names only). Values are generated in
// process memory and leave it only through stdin (and a 0600 temp file for
// the deploy keys the CLI writes); they are never printed. Existing
// variables are kept unless --rotate is given, so a re-run is safe. Provider credentials (DeepSeek, OpenRouter, Resend,
// Google, Axiom) are NOT generated: the script lists which are missing.

import { execFileSync } from "node:child_process";
import { generateKeyPairSync, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CONVEX = ["--yes", "convex@1.45.0"];
const STAGING_WEB = "https://kiero-staging-web.wojtek-524.workers.dev";
const STAGING_GATEWAY = "https://kiero-staging-gateway.wojtek-524.workers.dev";

/** Per-target deployment, public configuration and GitHub mirror. */
export const TARGETS = {
  dev: {
    deployment: "glorious-hawk-339",
    site: "https://glorious-hawk-339.eu-west-1.convex.site",
    fixed: {
      SITE_URL: "http://localhost:5173",
      KIERO_CALENDAR_APP_BASE_URL: "http://localhost:5173",
      KIERO_ENVIRONMENT: "dev",
      KIERO_DEPLOYMENT_LABEL: "dev",
      WEB_PUSH_VAPID_SUBJECT: "http://localhost:5173",
    },
    github: null,
  },
  staging: {
    deployment: "wojtek-piskorz-jr:kiero-dev-core:staging",
    site: "https://outgoing-marlin-429.eu-west-1.convex.site",
    fixed: {
      SITE_URL: STAGING_WEB,
      KIERO_CALENDAR_APP_BASE_URL: STAGING_WEB,
      KIERO_ENVIRONMENT: "staging",
      KIERO_DEPLOYMENT_LABEL: "staging",
      WEB_PUSH_VAPID_SUBJECT: STAGING_WEB,
      AXIOM_DATASET: "kiero-staging",
      // Executor URLs: bare origins where the consumer appends its route,
      // the full URL where it fetches verbatim (docs/evidence/staging/candidate.json).
      KIERO_MEDIA_WORKER_URL: "https://kiero-staging-media-worker.wojtek-524.workers.dev",
      KIERO_IMAGES_EXECUTOR_URL: `${STAGING_GATEWAY}/images/normalize`,
      KIERO_EXPORT_EXECUTOR_URL: "https://kiero-staging-export-worker.wojtek-524.workers.dev",
      KIERO_BACKUP_WORKER_URL: "https://kiero-staging-backup-worker.wojtek-524.workers.dev",
      KIERO_PURGE_EXECUTOR_URL: STAGING_GATEWAY,
    },
    // Generated values the release injects into the Workers must match Convex.
    github: { environment: "staging", mirrored: ["KIERO_SERVICE_TOKEN", "KIERO_MEDIA_WORKER_TOKEN"] },
  },
};

/** Owner-held credentials this script never invents. */
export const OWNER_PROVIDED = [
  "DEEPSEEK_API_KEY",
  "OPENROUTER_API_KEY",
  "RESEND_API_KEY",
  "RESEND_FROM",
  "AUTH_GOOGLE_ID",
  "AUTH_GOOGLE_SECRET",
  "AXIOM_API_TOKEN",
  "KIERO_GM_EMAILS",
];

const base64Url = (bytes) => Buffer.from(bytes).toString("base64url");

/** Convex Auth RS256 pair: PKCS#8 PEM on one line, public JWKS. */
export function convexAuthKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
  const jwk = publicKey.export({ format: "jwk" });
  return {
    JWT_PRIVATE_KEY: pem.trimEnd().replace(/\n/g, " "),
    JWKS: JSON.stringify({ keys: [{ use: "sig", ...jwk }] }),
  };
}

/** Web Push VAPID pair: raw uncompressed P-256 public point, PKCS#8 private key. */
export function vapidKeys() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const spki = publicKey.export({ type: "spki", format: "der" });
  return {
    WEB_PUSH_VAPID_PUBLIC_KEY: base64Url(spki.subarray(spki.length - 65)),
    WEB_PUSH_VAPID_PRIVATE_KEY: base64Url(privateKey.export({ type: "pkcs8", format: "der" })),
  };
}

/** Every generated value for one target (fresh on each call). */
export function generatedValues(target) {
  const config = TARGETS[target];
  return {
    ...config.fixed,
    KIERO_CALENDAR_REDIRECT_URI: `${config.site}/calendar/oauth/callback`,
    ...convexAuthKeys(),
    ...vapidKeys(),
    KIERO_SERVICE_TOKEN: base64Url(randomBytes(32)),
    KIERO_MEDIA_WORKER_TOKEN: base64Url(randomBytes(32)),
    KIERO_CALENDAR_TOKEN_KEY: randomBytes(32).toString("base64"),
  };
}

function convex(args, options = {}) {
  return execFileSync("npx", [...CONVEX, ...args], { encoding: "utf8", ...options });
}

/** Variable names only: values never enter this process (preflight.mjs does the same). */
function existingNames(deployment) {
  const out = convex(["env", "list", "--names-only", "--deployment", deployment], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  const lines = out.split("\n").map((line) => line.trim()).filter(Boolean);
  const names = lines.filter((line) => /^[A-Z0-9_]+$/.test(line));
  // Anything else means the CLI output changed shape; refusing beats silently
  // treating every variable as missing and overwriting live keys.
  if (names.length !== lines.length && !/no environment variables/i.test(out)) {
    throw new Error("unexpected `convex env list --names-only` output; refusing to continue");
  }
  return new Set(names);
}

function withSecretFile(content, run) {
  const dir = mkdtempSync(join(tmpdir(), "kiero-provision-"));
  const file = join(dir, "values");
  try {
    writeFileSync(file, content, { mode: 0o600 });
    return run(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  const target = args[args.indexOf("--target") + 1];
  if (!(target in TARGETS)) {
    throw new Error("usage: --target dev|staging [--apply] [--rotate] [--github]");
  }
  const apply = args.includes("--apply");
  const rotate = args.includes("--rotate");
  const github = args.includes("--github");
  const config = TARGETS[target];

  const present = existingNames(config.deployment);
  const values = generatedValues(target);
  const toSet = Object.entries(values).filter(([name]) => rotate || !present.has(name));

  console.log(`target ${target} (${config.deployment})`);
  console.log(`set: ${toSet.map(([name]) => name).join(", ") || "(nothing)"}`);
  console.log(`kept: ${Object.keys(values).filter((name) => present.has(name) && !rotate).join(", ") || "(none)"}`);
  console.log(`owner-provided, missing: ${OWNER_PROVIDED.filter((name) => !present.has(name)).join(", ") || "(none)"}`);
  if (!apply) {
    console.log("dry run: pass --apply to write");
    return;
  }

  // One variable at a time over stdin: the CLI's dotenv parser would not
  // unescape the quotes inside JWKS.
  for (const [name, value] of toSet) {
    convex(["env", "set", name, "--deployment", config.deployment], {
      input: value,
      stdio: ["pipe", "ignore", "inherit"],
    });
  }

  if (github && config.github !== null) {
    const setNames = new Set(toSet.map(([name]) => name));
    for (const name of config.github.mirrored.filter((n) => setNames.has(n))) {
      execFileSync("gh", ["secret", "set", `STAGING_${name}`, "--env", config.github.environment], {
        input: values[name],
        stdio: ["pipe", "ignore", "inherit"],
      });
    }
    // A fresh deploy key for the release and one for the backup export.
    for (const [secret, keyName] of [
      ["STAGING_CONVEX_DEPLOY_KEY", "staging-release"],
      ["STAGING_CONVEX_BACKUP_ADMIN_KEY", "staging-backup-export"],
    ]) {
      withSecretFile("", (file) => {
        convex(["deployment", "token", "create", keyName, "--deployment", config.deployment, "--save-env", file], {
          stdio: ["ignore", "ignore", "inherit"],
        });
        const key = /^CONVEX_DEPLOY_KEY=(.+)$/m.exec(readFileSync(file, "utf8"))?.[1]?.replace(/^"|"$/g, "");
        if (key === undefined) {
          throw new Error(`deploy key for ${secret} was not written`);
        }
        execFileSync("gh", ["secret", "set", secret, "--env", config.github.environment], {
          input: key,
          stdio: ["pipe", "ignore", "inherit"],
        });
      });
    }
    execFileSync("gh", ["secret", "set", "STAGING_CONVEX_DEPLOYMENT", "--env", config.github.environment], {
      input: config.deployment,
      stdio: ["pipe", "ignore", "inherit"],
    });
    execFileSync("gh", ["variable", "set", "STAGING_CONVEX_URL", "--body", config.site.replace(".convex.site", ".convex.cloud")], {
      stdio: ["ignore", "ignore", "inherit"],
    });
  }
  console.log("applied (values not shown)");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
