/**
 * The shared release-target descriptor (R6): the ONE format the guard
 * (verify-target.mjs), the deploy adapter (deploy-component.mjs), the
 * Checks gate (verify-checks.mjs) and the evidence recorder
 * (record-release-evidence.mjs) all consume.
 *
 * A descriptor is a committed JSON file under infra/release/targets/ that
 * names, for one deployment target:
 *
 * - the GitHub environment the deploy job must run in (`githubEnvironment`);
 * - the secret-name prefix every GitHub secret reference must carry
 *   (`secretPrefix`): NAMES only, values never appear here;
 * - the identity of the deterministic Checks job that must have succeeded
 *   for the exact release revision (`checksName`, pinned against
 *   .github/workflows/checks.yml by the guard);
 * - the deployable components, each with its build command, artifact path,
 *   transport kind and the runtime configuration NAMES it requires. A
 *   convex-deploy transport may additionally pin `expectedIdentity`: the
 *   provider-observed identity (team, project, reference, type, slug, URL,
 *   default-ness) the credential must resolve to before any mutating
 *   command runs (R9).
 *
 * Authorization is intrinsic and re-checked at every layer: the descriptor
 * target must match the requested target, the runtime environment label
 * (`KIERO_ENVIRONMENT`) must match the descriptor target, and every
 * required configuration NAME must be present (non-empty) before any
 * transport is invoked. Nothing in this module reads configuration values
 * beyond presence.
 */

import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";

/** Where the committed (workflow-referenced) target descriptors live. */
export const COMMITTED_TARGETS_DIRECTORY = join("infra", "release", "targets");

/**
 * True when the descriptor path points inside the committed targets
 * directory. BOTH halves resolve against the same base (`cwd`, which the
 * release workflow leaves at the repository root), so the classification
 * cannot be split by the adapter's --cwd flag: a relative descriptor
 * argument and the targets root always pair. Committed descriptors are
 * the deploy contract; temporary fixtures elsewhere may use the stub
 * transport, committed ones may not.
 */
export function isCommittedDescriptorPath(path, cwd = process.cwd()) {
  const absolute = resolve(cwd, path);
  const targetsRoot = resolve(cwd, COMMITTED_TARGETS_DIRECTORY);
  return absolute.startsWith(`${targetsRoot}${sep}`);
}

/**
 * Committed-descriptor rule (R6 hardening): files under
 * infra/release/targets must never use the stub transport, so an edit to
 * a committed descriptor cannot mint synthetic "deployed" records from
 * the test transport. Returns violations (empty when clean).
 */
export function committedDescriptorViolations(descriptor) {
  const stubbed = descriptor.components
    .filter((component) => component?.transport?.kind === "stub")
    .map((component) => component.id);
  if (stubbed.length === 0) {
    return [];
  }
  return [
    `committed target descriptors must not use the stub transport (found on: ${stubbed.join(", ")})`,
  ];
}

/** The canonical inventory of allowed deployment targets and their secret-name prefixes. */
export const RELEASE_TARGETS = {
  staging: { secretPrefix: "STAGING_", environmentName: "staging" },
  production: { secretPrefix: "PRODUCTION_", environmentName: "alpha-production" },
};

/** The transport kinds deploy-component.mjs can resolve to a module. */
export const TRANSPORT_KINDS = [
  "wrangler-pages",
  "wrangler-deploy",
  "convex-deploy",
  "stub",
];

const DESCRIPTOR_ID_PATTERN = /^[a-z0-9/._-]+@[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const COMPONENT_ID_PATTERN = /^[a-z0-9-]+$/;
const CONFIG_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const RELATIVE_PATH_PATTERN = /^[^/].*$/;

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function checkTransportFields(kind, transport, violations) {
  if (kind === "wrangler-pages") {
    if (typeof transport.projectName !== "string" || transport.projectName === "") {
      violations.push(`transport wrangler-pages requires a non-empty projectName`);
    }
  }
  if (kind === "wrangler-deploy") {
    for (const field of ["cwd", "wranglerEnv", "workerName"]) {
      if (typeof transport[field] !== "string" || transport[field] === "") {
        violations.push(`transport wrangler-deploy requires a non-empty ${field}`);
      }
    }
  }
  if (kind === "stub") {
    if (
      transport.recordPath !== undefined &&
      (typeof transport.recordPath !== "string" || transport.recordPath === "")
    ) {
      violations.push("transport stub recordPath must be a non-empty string when present");
    }
  }
  if (kind === "convex-deploy") {
    // R9: the pinned provider-observed identity a Convex transport may
    // deploy to. Optional at the format level (alpha production stays
    // unpinned until its deployment exists); the deploy adapter's
    // credential-target gate refuses any unpinned Convex component, so an
    // unpinned descriptor can never reach a mutating command.
    if (transport.expectedIdentity !== undefined) {
      const identity = transport.expectedIdentity;
      const identityWhere = "transport convex-deploy expectedIdentity";
      if (!isPlainObject(identity)) {
        violations.push(`${identityWhere} must be an object when present`);
      } else {
        for (const fieldName of ["teamSlug", "projectSlug", "reference", "type", "slug", "url"]) {
          if (typeof identity[fieldName] !== "string" || identity[fieldName] === "") {
            violations.push(`${identityWhere} requires a non-empty ${fieldName}`);
          }
        }
        if (typeof identity.type === "string" && !["prod", "dev"].includes(identity.type)) {
          violations.push(`${identityWhere} type must be "prod" or "dev" (a preview target cannot be pinned by reference)`);
        }
        if (typeof identity.url === "string") {
          const urlMatch = /^https:\/\/([a-z0-9-]+)\.([a-z0-9-]+)\.convex\.cloud$/.exec(identity.url);
          if (urlMatch === null) {
            violations.push(`${identityWhere} url must be https://<slug>.<region>.convex.cloud`);
          } else if (typeof identity.slug === "string" && urlMatch[1] !== identity.slug) {
            violations.push(`${identityWhere} url host must match the pinned slug`);
          }
        }
        if (identity.isDefault !== undefined && typeof identity.isDefault !== "boolean") {
          violations.push(`${identityWhere} isDefault must be a boolean when present`);
        }
        const allowedIdentityFields = new Set([
          "teamSlug",
          "projectSlug",
          "reference",
          "type",
          "slug",
          "url",
          "isDefault",
        ]);
        for (const fieldName of Object.keys(identity)) {
          if (!allowedIdentityFields.has(fieldName)) {
            violations.push(`${identityWhere} carries unknown field "${fieldName}"`);
          }
        }
      }
    }
  }
}

/**
 * Validates a parsed descriptor value. Returns a list of violations
 * (strings of NAMES only); empty means the descriptor is valid.
 */
export function validateTargetDescriptor(value) {
  const violations = [];
  if (!isPlainObject(value)) {
    return ["descriptor must be a JSON object"];
  }
  if (typeof value.descriptorId !== "string" || !DESCRIPTOR_ID_PATTERN.test(value.descriptorId)) {
    violations.push("descriptorId must match <path>@<yyyy-mm-dd>");
  }
  const spec = RELEASE_TARGETS[value.target];
  if (spec === undefined) {
    violations.push(
      `target must be one of ${Object.keys(RELEASE_TARGETS).join(", ")} (found ${String(value.target)})`,
    );
  }
  if (spec !== undefined) {
    if (value.githubEnvironment !== spec.environmentName) {
      violations.push(
        `githubEnvironment must be ${spec.environmentName} for target ${value.target}`,
      );
    }
    if (value.secretPrefix !== spec.secretPrefix) {
      violations.push(`secretPrefix must be ${spec.secretPrefix} for target ${value.target}`);
    }
  }
  if (typeof value.checksName !== "string" || value.checksName === "") {
    violations.push("checksName must be a non-empty string");
  }
  if (!Array.isArray(value.components) || value.components.length === 0) {
    return [...violations, "components must be a non-empty array"];
  }
  const seenIds = new Set();
  for (const [index, component] of value.components.entries()) {
    const where = `components[${index}]`;
    if (!isPlainObject(component)) {
      violations.push(`${where} must be an object`);
      continue;
    }
    if (typeof component.id !== "string" || !COMPONENT_ID_PATTERN.test(component.id)) {
      violations.push(`${where} id must match ${COMPONENT_ID_PATTERN.source}`);
    } else if (seenIds.has(component.id)) {
      violations.push(`${where} id "${component.id}" is duplicated`);
    }
    seenIds.add(component.id);
    if (typeof component.included !== "boolean") {
      violations.push(`${where} included must be a boolean`);
    }
    if (component.build !== null && typeof component.build !== "string") {
      violations.push(`${where} build must be a shell command string or null`);
    }
    if (typeof component.artifact !== "string" || !RELATIVE_PATH_PATTERN.test(component.artifact)) {
      violations.push(`${where} artifact must be a non-empty repo-relative path`);
    } else if (component.artifact.includes("..")) {
      violations.push(`${where} artifact must not escape the repository`);
    }
    if (!isPlainObject(component.transport)) {
      violations.push(`${where} transport must be an object`);
    } else {
      const kind = component.transport.kind;
      if (!TRANSPORT_KINDS.includes(kind)) {
        violations.push(
          `${where} transport.kind must be one of ${TRANSPORT_KINDS.join(", ")} (found ${String(kind)})`,
        );
      } else {
        checkTransportFields(kind, component.transport, violations);
      }
    }
    if (
      !Array.isArray(component.requiredConfig) ||
      component.requiredConfig.some((name) => typeof name !== "string" || !CONFIG_NAME_PATTERN.test(name))
    ) {
      violations.push(
        `${where} requiredConfig must be an array of configuration NAMES (${CONFIG_NAME_PATTERN.source})`,
      );
    } else if (new Set(component.requiredConfig).size !== component.requiredConfig.length) {
      violations.push(`${where} requiredConfig contains duplicated names`);
    }
    if (
      component.runtimeSecrets !== undefined &&
      component.transport.kind !== "wrangler-deploy"
    ) {
      violations.push(
        `${where} runtimeSecrets is only implemented for wrangler-deploy transports`,
      );
    }
    if (component.runtimeSecrets !== undefined) {
      // I8: the worker RUNTIME secret plane. Names follow the binding
      // docs; sources are the deployment-scoped store names (GitHub
      // environment secrets). `deferred` marks names whose value is an
      // explicitly recorded owner decision still pending (e.g.
      // CONVEX_BACKUP_ADMIN_KEY until I10): the injector records them
      // instead of refusing.
      if (!Array.isArray(component.runtimeSecrets) || component.runtimeSecrets.length === 0) {
        violations.push(`${where} runtimeSecrets must be a non-empty array when present`);
      } else {
        const seenSecretNames = new Set();
        for (const entry of component.runtimeSecrets) {
          if (!isPlainObject(entry)) {
            violations.push(`${where} runtimeSecrets entries must be objects`);
            continue;
          }
          if (typeof entry.name !== "string" || !CONFIG_NAME_PATTERN.test(entry.name)) {
            violations.push(
              `${where} runtimeSecrets name must match ${CONFIG_NAME_PATTERN.source}`,
            );
          } else if (seenSecretNames.has(entry.name)) {
            violations.push(`${where} runtimeSecrets contains duplicated name ${entry.name}`);
          }
          seenSecretNames.add(entry.name);
          if (typeof entry.source !== "string" || !CONFIG_NAME_PATTERN.test(entry.source)) {
            violations.push(
              `${where} runtimeSecrets source must match ${CONFIG_NAME_PATTERN.source}`,
            );
          }
          if (entry.deferred !== undefined && typeof entry.deferred !== "boolean") {
            violations.push(`${where} runtimeSecrets deferred must be a boolean when present`);
          }
        }
      }
    }
  }
  return violations;
}

/** Parses descriptor JSON text; returns { descriptor } or { violations }. */
export function parseTargetDescriptor(text) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { violations: [`descriptor is not valid JSON: ${error.message}`] };
  }
  const violations = validateTargetDescriptor(parsed);
  if (violations.length > 0) {
    return { violations };
  }
  return { descriptor: parsed };
}

/** Reads and validates a descriptor file; returns { descriptor } or { violations }. */
export function loadTargetDescriptor(path) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { violations: [`descriptor file cannot be read: ${error.message}`] };
  }
  return parseTargetDescriptor(text);
}
