/**
 * The Cloudflare Pages transport for the built web bundle (R6). Deploys
 * the artifact directory produced by the component's build command to
 * the Pages project named by the target descriptor.
 *
 * Authorization happens BEFORE this module runs (the adapter validated
 * the descriptor, the Checks gate, the environment label and the
 * configuration names; CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID are
 * wrangler's own credential names and are only ever read by wrangler).
 * The remote identity is the Pages project name plus the deployment URL
 * wrangler reports; without both, no "deployed" outcome is recorded.
 */

import { spawnSync } from "node:child_process";

const OUTPUT_URL_PATTERN = /https:\/\/[A-Za-z0-9.-]+\.pages\.dev/;

export function run({ transport, artifactPath, revision, env, cwd = process.cwd() }) {
  const deploy = spawnSync(
    "npx",
    [
      "wrangler",
      "pages",
      "deploy",
      artifactPath,
      "--project-name",
      transport.projectName,
      "--branch",
      "main",
      "--commit-hash",
      revision,
    ],
    { cwd, env, encoding: "utf8", timeout: 15 * 60_000 },
  );
  const output = `${deploy.stdout ?? ""}${deploy.stderr ?? ""}`;
  if (deploy.status !== 0) {
    throw new Error(
      `wrangler pages deploy exited ${String(deploy.status)} for project ${transport.projectName}: ${output.trim().slice(-500)}`,
    );
  }
  const url = OUTPUT_URL_PATTERN.exec(output)?.[0];
  if (url === undefined) {
    throw new Error(`wrangler pages deploy reported no deployment URL for ${transport.projectName}`);
  }
  return { remoteIdentity: { kind: "cloudflare-pages", id: transport.projectName, url } };
}
