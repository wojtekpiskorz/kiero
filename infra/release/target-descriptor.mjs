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
 *   transport kind and the runtime configuration NAMES it requires.
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
