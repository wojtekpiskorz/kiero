/**
 * The Convex functions transport (R6): deploys the checked-out convex/
 * functions root to the deployment named by CONVEX_DEPLOYMENT. The root
 * convex.json pins the DEV project (kiero-dev-core) and convex deploy
 * selects its target EXCLUSIVELY through CONVEX_DEPLOYMENT / --env-file
 * (verified flag surface, infra/environments/synthetic-staging.md), so
 * this transport can only reach the explicitly named deployment.
 *
 * CONVEX_DEPLOYMENT holds a deployment REFERENCE (team:project:name, a
 * resource name, not a credential); recording it as the remote identity
 * records a name, never a secret value.
 */

import { spawnSync } from "node:child_process";

export function run({ env, cwd }) {
  const deploymentReference = env.CONVEX_DEPLOYMENT ?? "";
  if (deploymentReference === "") {
    throw new Error("CONVEX_DEPLOYMENT names the target deployment; the adapter validated it, refusing here as well");
  }
  const deploy = spawnSync("npx", ["--yes", "convex@1.45.0", "deploy"], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 15 * 60_000,
  });
  const output = `${deploy.stdout ?? ""}${deploy.stderr ?? ""}`;
  if (deploy.status !== 0) {
    throw new Error(`convex deploy exited ${String(deploy.status)}: ${output.trim().slice(-500)}`);
  }
  return { remoteIdentity: { kind: "convex-deployment", id: deploymentReference } };
}
