/**
 * The Cloudflare Worker transport (R6): deploys one apps/* worker through
 * its named wrangler environment (`wrangler deploy --env staging` /
 * `--env alpha-production`). The named environment blocks point only at
 * kiero-staging-* / kiero-alpha-* resource names, so a bare deploy can
 * never touch them. The remote identity is the worker name declared by
 * the descriptor AND reported by wrangler; a mismatch or absence refuses.
 */

import { spawnSync } from "node:child_process";
import { join } from "node:path";

const VERSION_ID_PATTERN = /Version ID:\s*([0-9a-f]{8,})/;

export function run({ transport, env, cwd }) {
  const deploy = spawnSync("npx", ["wrangler", "deploy", "--env", transport.wranglerEnv], {
    cwd: join(cwd, transport.cwd),
    env,
    encoding: "utf8",
    timeout: 15 * 60_000,
  });
  const output = `${deploy.stdout ?? ""}${deploy.stderr ?? ""}`;
  if (deploy.status !== 0) {
    throw new Error(
      `wrangler deploy exited ${String(deploy.status)} for --env ${transport.wranglerEnv}: ${output.trim().slice(-500)}`,
    );
  }
  if (!output.includes(transport.workerName)) {
    throw new Error(
      `wrangler deploy output does not mention the declared worker ${transport.workerName}; refusing to claim identity`,
    );
  }
  const versionId = VERSION_ID_PATTERN.exec(output)?.[1];
  return {
    remoteIdentity: {
      kind: "cloudflare-worker",
      id: transport.workerName,
      ...(versionId === undefined ? {} : { versionId }),
    },
  };
}
