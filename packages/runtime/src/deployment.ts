/**
 * The single definition of the deployment environment label (R13).
 *
 * `KIERO_ENVIRONMENT` is the deployment's closed self-description: exactly
 * one of three labels (dev, staging, alpha-production) read from
 * server-side configuration only. Before R13 the closed-label read existed
 * in five runtime copies (the telemetry cron, the backups HTTP boundary,
 * the redaction format set, the Calendar return resolver and the gateway
 * telemetry tag, which classified the Worker's `ENVIRONMENT` binding); a
 * label added in one copy but not another silently classified that
 * deployment as dev, and dev is exactly what re-allows a plain-http
 * return link. Every runtime classifier now routes through THIS
 * definition (the repo's mirror-is-a-hazard ruling); release tooling that
 * only NAMES the label (`infra/release`) reads it as a deployment
 * descriptor, not a classification.
 *
 * Pure like the rest of this package: no Convex, no Node, so the Convex
 * functions and the gateway Worker share it freely.
 */

/**
 * The closed label set. This is the accepted vocabulary: no label may be
 * added or removed here without re-accepting the deployment contract, and
 * every consumer (classification and validation alike) derives from it.
 */
export const DEPLOYMENT_ENVIRONMENT_LABELS = [
  "dev",
  "staging",
  "alpha-production",
] as const;

/** One accepted deployment environment label. */
export type DeploymentEnvironmentLabel = (typeof DEPLOYMENT_ENVIRONMENT_LABELS)[number];

/**
 * The closed-label pattern, derived from the label set so the validation
 * side (the redaction `environment` metadata format) can never drift from
 * the classification side. ONE shared RegExp instance: no user passes the
 * `g` flag, so `.test` carries no state between calls.
 */
export const DEPLOYMENT_ENVIRONMENT_PATTERN = new RegExp(
  `^(${DEPLOYMENT_ENVIRONMENT_LABELS.join("|")})$`,
);

/**
 * Classifies a deployment's environment self-description (R13's one
 * canonical read).
 *
 * The accepted rule, unchanged from the five copies this replaces: an
 * absent (or null) value reads as dev; an unknown, empty or malformed
 * label honestly reads as dev rather than guessing; only the exact closed
 * labels survive. A non-string value (unreachable through the typed
 * seams) also reads as dev; classification never throws.
 */
export function deploymentEnvironment(
  env: string | null | undefined,
): DeploymentEnvironmentLabel {
  if (typeof env !== "string") {
    return "dev";
  }
  return DEPLOYMENT_ENVIRONMENT_PATTERN.test(env)
    ? (env as DeploymentEnvironmentLabel)
    : "dev";
}
