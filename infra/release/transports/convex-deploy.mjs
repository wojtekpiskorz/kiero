/**
 * The Convex functions transport (R6, re-verified by R9): deploys the
 * checked-out convex/ functions root through `convex deploy` of the pinned
 * CLI 1.45.0 and records the PROVIDER-OBSERVED identity of the deployment
 * that was actually targeted.
 *
 * R9 contract (issue #168): the target of `convex deploy` is selected by
 * the credential: a deployment-scoped CONVEX_DEPLOY_KEY resolves to its
 * own deployment and makes the CLI ignore CONVEX_DEPLOYMENT entirely, so
 * the caller-provided CONVEX_DEPLOYMENT label can never serve as remote
 * identity. The adapter runs the pre-mutation identity gate
 * (verify-convex-target.mjs) before this transport; as defense in depth
 * the transport itself re-parses the deployment announcement the CLI
 * prints before pushing and refuses to claim success unless it matches the
 * identity pinned in the descriptor's transport.expectedIdentity:
 *
 *   ▌ Deploying code to deployment:
 *   ▌ [Production] <team>:<project>:<reference> (dashboard: …/t/<team>/<project>/<slug>)
 *   ▌ └─ https://<slug>.<region>.convex.cloud
 *
 * CONVEX_DEPLOYMENT is checked for PRESENCE only (the adapter validates
 * configuration names first; the label documents intent). On success the
 * remote identity is the observed announcement identity, never the label.
 */

import { spawnSync } from "node:child_process";
import {
  compareConvexIdentity,
  parseConvexAnnouncement,
  sanitizeConvexOutput,
} from "../verify-convex-target.mjs";

export function run({ transport, env, cwd }) {
  const deploymentReference = env.CONVEX_DEPLOYMENT ?? "";
  if (deploymentReference === "") {
    throw new Error("CONVEX_DEPLOYMENT names the intended target deployment; the adapter validated it, refusing here as well");
  }
  const expectedIdentity = transport?.expectedIdentity;
  if (
    expectedIdentity === undefined ||
    expectedIdentity === null ||
    typeof expectedIdentity !== "object"
  ) {
    throw new Error(
      "convex-deploy transport requires a pinned transport.expectedIdentity; refusing to deploy to an unverifiable target",
    );
  }
  const deploy = spawnSync("npx", ["--yes", "convex@1.45.0", "deploy"], {
    cwd,
    env,
    encoding: "utf8",
    timeout: 15 * 60_000,
  });
  const output = `${deploy.stdout ?? ""}${deploy.stderr ?? ""}`;
  if (deploy.status !== 0) {
    throw new Error(
      `convex deploy exited ${String(deploy.status)}: ${sanitizeConvexOutput(env, output).slice(-500)}`,
    );
  }
  const observed = parseConvexAnnouncement(output);
  if (observed === null) {
    throw new Error(
      "convex deploy output carries no deployment announcement; refusing to claim an unobserved identity",
    );
  }
  const differences = compareConvexIdentity(observed, expectedIdentity);
  if (differences.length > 0) {
    // Bytes have landed on the wrong deployment at this point; the error is
    // honest about that and the adapter records transport-failed.
    throw new Error(
      `convex deploy targeted a deployment that is not the pinned target (bytes may have landed there): ${differences.join("; ")}`,
    );
  }
  const id =
    observed.teamSlug !== null &&
    observed.projectSlug !== null &&
    observed.reference !== null
      ? `${observed.teamSlug}:${observed.projectSlug}:${observed.reference}`
      : (observed.slug ?? observed.url ?? "convex-deployment");
  return {
    remoteIdentity: {
      kind: "convex-deployment",
      id,
      slug: observed.slug,
      url: observed.url,
      type: observed.type,
      region: observed.region,
      isDefault: observed.isDefault,
      identitySource: "provider-observed",
    },
  };
}
