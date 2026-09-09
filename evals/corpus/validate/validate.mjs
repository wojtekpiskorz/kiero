#!/usr/bin/env node
/**
 * Kiero evaluation corpus validator.
 *
 * Enforces, with plain `node` and zero dependencies:
 *  - exact modality counts (14 text / 16 voice / 12 image / 8 mixed = 50) and unique IDs,
 *  - case fixtures and expected outcome files conform to the JSON Schemas,
 *  - required fields per case type (voice transcript + provenance, image asset + provenance, ...),
 *  - asset availability (present file with matching sha256, OR explicit pending provenance),
 *  - per-case tenant isolation and referential integrity (no case references another case's state),
 *  - anchor validity (text quotes verbatim, audio intervals inside duration, image regions inside bounds),
 *  - corpus revision presence and consistency across manifest, fixtures and answer keys,
 *  - full coverage of the declared coverage vocabulary.
 *
 * Usage: node evals/corpus/validate/validate.mjs   (exit 0 = valid, exit 1 = invalid)
 */

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), ".."); // evals/corpus
const CASES_DIR = join(ROOT, "cases");
const EXPECTED_DIR = resolve(ROOT, "..", "expected");
const MANIFEST_PATH = join(ROOT, "manifest.json");

const errors = [];
const fail = (msg) => errors.push(msg);

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

// ---------------------------------------------------------------------------
// Minimal JSON Schema validator (subset used by the corpus schemas).
// Supported: $ref (local #/definitions/...), type, enum, const, pattern,
// minLength, maxLength, minimum, maximum, exclusiveMinimum, exclusiveMaximum,
// items, minItems, maxItems, uniqueItems, required, properties,
// additionalProperties, anyOf, oneOf.
// ---------------------------------------------------------------------------

function resolveRef(schema, root) {
  let node = schema;
  while (typeof node === "object" && node !== null && "$ref" in node) {
    const ref = node.$ref;
    if (!ref.startsWith("#/")) throw new Error(`unsupported $ref: ${ref}`);
    node = ref
      .slice(2)
      .split("/")
      .reduce((acc, seg) => acc[seg.replace(/~1/g, "/").replace(/~0/g, "~")], root);
  }
  return node;
}

function typeMatches(value, type) {
  switch (type) {
    case "object": return typeof value === "object" && value !== null && !Array.isArray(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": return typeof value === "number" && Number.isFinite(value);
    case "integer": return typeof value === "number" && Number.isInteger(value);
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: throw new Error(`unsupported type: ${type}`);
  }
}

function validateSchema(value, schema, root, path, errs) {
  schema = resolveRef(schema, root);

  if (schema === undefined) {
    errs.push(`${path}: schema reference resolved to undefined`);
    return;
  }

  if (typeof schema !== "object" || schema === null) {
    // Boolean schemas: true accepts, false rejects.
    if (schema === false) errs.push(`${path}: value not allowed here`);
    return;
  }

  if ("enum" in schema) {
    if (!schema.enum.some((option) => JSON.stringify(option) === JSON.stringify(value))) {
      errs.push(`${path}: must be one of ${JSON.stringify(schema.enum)}, got ${JSON.stringify(value)}`);
    }
  }

  if ("const" in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) {
    errs.push(`${path}: must equal ${JSON.stringify(schema.const)}, got ${JSON.stringify(value)}`);
  }

  if ("type" in schema) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => typeMatches(value, t))) {
      errs.push(`${path}: expected type ${types.join("|")}, got ${typeof value}`);
      return; // further checks meaningless on wrong type
    }
  }

  if (typeof value === "string") {
    if ("pattern" in schema && !new RegExp(schema.pattern).test(value)) {
      errs.push(`${path}: does not match pattern ${schema.pattern} (got ${JSON.stringify(value)})`);
    }
    if ("minLength" in schema && value.length < schema.minLength) {
      errs.push(`${path}: shorter than minLength ${schema.minLength}`);
    }
    if ("maxLength" in schema && value.length > schema.maxLength) {
      errs.push(`${path}: longer than maxLength ${schema.maxLength}`);
    }
  }

  if (typeof value === "number") {
    if ("minimum" in schema && value < schema.minimum) errs.push(`${path}: below minimum ${schema.minimum}`);
    if ("maximum" in schema && value > schema.maximum) errs.push(`${path}: above maximum ${schema.maximum}`);
    if ("exclusiveMinimum" in schema && value <= schema.exclusiveMinimum) {
      errs.push(`${path}: not above exclusiveMinimum ${schema.exclusiveMinimum}`);
    }
    if ("exclusiveMaximum" in schema && value >= schema.exclusiveMaximum) {
      errs.push(`${path}: not below exclusiveMaximum ${schema.exclusiveMaximum}`);
    }
  }

  if (Array.isArray(value)) {
    if ("minItems" in schema && value.length < schema.minItems) {
      errs.push(`${path}: needs at least ${schema.minItems} items, has ${value.length}`);
    }
    if ("maxItems" in schema && value.length > schema.maxItems) {
      errs.push(`${path}: allows at most ${schema.maxItems} items, has ${value.length}`);
    }
    if (schema.uniqueItems === true) {
      const seen = new Set();
      for (const item of value) {
        const key = JSON.stringify(item);
        if (seen.has(key)) errs.push(`${path}: items must be unique, duplicate ${key}`);
        seen.add(key);
      }
    }
    if ("items" in schema) {
      value.forEach((item, index) => validateSchema(item, schema.items, root, `${path}[${index}]`, errs));
    }
  }

  if (typeof value === "object" && value !== null && !Array.isArray(value)) {
    if ("required" in schema) {
      for (const key of schema.required) {
        if (!(key in value)) errs.push(`${path}: missing required field "${key}"`);
      }
    }
    if ("properties" in schema) {
      for (const [key, childSchema] of Object.entries(schema.properties)) {
        if (key in value) validateSchema(value[key], childSchema, root, `${path}.${key}`, errs);
      }
    }
    if (schema.additionalProperties === false && "properties" in schema) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) {
          errs.push(`${path}: unexpected additional property "${key}"`);
        }
      }
    } else if (schema.additionalProperties && typeof schema.additionalProperties === "object" && "properties" in schema) {
      for (const key of Object.keys(value)) {
        if (!(key in schema.properties)) {
          validateSchema(value[key], schema.additionalProperties, root, `${path}.${key}`, errs);
        }
      }
    }
  }

  if ("anyOf" in schema) {
    const passes = schema.anyOf.some((sub) => {
      const probe = [];
      validateSchema(value, sub, root, path, probe);
      return probe.length === 0;
    });
    if (!passes) {
      errs.push(`${path}: does not satisfy any allowed variant (anyOf)`);
    }
  }

  if ("oneOf" in schema) {
    const variantErrors = schema.oneOf.map((sub) => {
      const probe = [];
      validateSchema(value, sub, root, path, probe);
      return probe;
    });
    const satisfied = variantErrors.filter((probe) => probe.length === 0).length;
    if (satisfied !== 1) {
      const hints = variantErrors
        .map((probe) => probe[0])
        .filter(Boolean)
        .slice(0, 2)
        .join("; ");
      errs.push(`${path}: must satisfy exactly one allowed variant (oneOf), satisfied ${satisfied}${hints ? `; first issues per variant: ${hints}` : ""}`);
    }
  }
}

function validateAgainstSchema(value, schemaPath, label) {
  const schema = readJson(schemaPath);
  const errs = [];
  validateSchema(value, schema, schema, label, errs);
  for (const e of errs) fail(`[schema] ${e}`);
  return errs.length === 0;
}

// ---------------------------------------------------------------------------
// Corpus-level validation
// ---------------------------------------------------------------------------

const manifest = readJson(MANIFEST_PATH);
const caseSchemaPath = join(ROOT, "schema", "case.schema.json");
const expectedSchemaPath = join(ROOT, "schema", "expected.schema.json");

const EXPECTED_COUNTS = { text: 14, voice: 16, image: 12, mixed: 8 };

// The two schemas intentionally duplicate the typed value-contract definitions.
// Divergence would silently fork the meaning of values between fixtures and
// answer keys, so any difference fails validation. Comparison is key-order
// insensitive; descriptions must still match verbatim.
const SHARED_VALUE_DEFS = [
  "value",
  "temporalValue",
  "financialValue",
  "quantityValue",
  "textValue",
  "enumValue",
  "entityRefValue",
  "knowledgeState",
];
{
  const canon = (v) =>
    JSON.stringify(v, (k, val) => {
      if (val && typeof val === "object" && !Array.isArray(val)) {
        return Object.keys(val)
          .sort()
          .reduce((acc, key) => ({ ...acc, [key]: val[key] }), {});
      }
      return val;
    });
  const caseDefs = readJson(caseSchemaPath).definitions ?? {};
  const expectedDefs = readJson(expectedSchemaPath).definitions ?? {};
  for (const name of SHARED_VALUE_DEFS) {
    if (!caseDefs[name] || !expectedDefs[name]) {
      fail(`schema divergence: shared definition "${name}" missing from one of the schema files`);
    } else if (canon(caseDefs[name]) !== canon(expectedDefs[name])) {
      fail(`schema divergence: shared definition "${name}" differs between case.schema.json and expected.schema.json; keep the copies identical`);
    }
  }
}

const caseDirs = readdirSync(CASES_DIR)
  .filter((name) => statSync(join(CASES_DIR, name)).isDirectory())
  .sort();

const seenIds = new Map();
const counts = { text: 0, voice: 0, image: 0, mixed: 0 };
const coverageUsed = new Map();

for (const dir of caseDirs) {
  const casePath = join(CASES_DIR, dir, "case.json");
  if (!existsSync(casePath)) {
    fail(`cases/${dir}: missing case.json`);
    continue;
  }
  let kase;
  try {
    kase = readJson(casePath);
  } catch (e) {
    fail(`cases/${dir}: case.json is not valid JSON (${e.message})`);
    continue;
  }

  const label = `cases/${dir}/case.json`;

  // Structural schema validation.
  validateAgainstSchema(kase, caseSchemaPath, label);

  if (typeof kase.caseId !== "string") continue; // schema already flagged it

  // ID / directory / modality consistency.
  if (kase.caseId !== dir) fail(`${label}: caseId "${kase.caseId}" does not match directory "${dir}"`);
  if (seenIds.has(kase.caseId)) {
    fail(`${label}: duplicate caseId "${kase.caseId}" (also in ${seenIds.get(kase.caseId)})`);
  }
  seenIds.set(kase.caseId, label);

  const prefixModality = { T: "text", V: "voice", I: "image", M: "mixed" }[kase.caseId[0]];
  if (kase.modality !== prefixModality) {
    fail(`${label}: modality "${kase.modality}" does not match ID prefix (${prefixModality})`);
  }
  counts[kase.modality] = (counts[kase.modality] ?? 0) + 1;

  // Corpus revision presence and consistency.
  if (kase.corpusRevision !== manifest.corpusRevision) {
    fail(`${label}: corpusRevision "${kase.corpusRevision}" != manifest "${manifest.corpusRevision}"`);
  }

  // Coverage bookkeeping.
  for (const tag of kase.coverage ?? []) {
    if (!coverageUsed.has(tag)) coverageUsed.set(tag, []);
    coverageUsed.get(tag).push(kase.caseId);
  }

  // ---- Modality-specific required structure ----
  const sources = Array.isArray(kase.sources) ? kase.sources : [];
  const parts = sources.flatMap((s) => Array.isArray(s.parts) ? s.parts : []);
  const partTypes = new Set(parts.map((p) => p.type));
  const voiceParts = parts.filter((p) => p.type === "voice");
  const imageParts = parts.filter((p) => p.type === "image");

  if (kase.modality === "text") {
    const hasTimeline = (kase.timeline ?? []).length > 0;
    if (sources.length !== 1 && !hasTimeline) {
      fail(`${label}: text case must have exactly 1 source unless a timeline declares follow-up beats (has ${sources.length})`);
    }
    if (partTypes.size !== 1 || !partTypes.has("text")) {
      fail(`${label}: text case must contain text parts only (found ${[...partTypes].join(",")})`);
    }
  }
  if (kase.modality === "voice" && voiceParts.length === 0) {
    fail(`${label}: voice case must contain at least one voice part`);
  }
  if (kase.modality === "image" && imageParts.length === 0) {
    fail(`${label}: image case must contain at least one image part`);
  }
  if (kase.modality === "mixed" && sources.length < 2) {
    fail(`${label}: mixed follow-up case must have at least 2 sources (has ${sources.length})`);
  }

  // Fixture clock anchors the first source.
  if (sources.length > 0 && kase.fixtureClock !== sources[0].sentAt) {
    fail(`${label}: fixtureClock must equal sources[0].sentAt`);
  }

  // ---- Tenant isolation and referential integrity (within this case only) ----
  const tenant = kase.tenant ?? { bosses: [], contacts: [], projects: [] };
  const definedRefs = new Set([
    ...(tenant.bosses ?? []).map((b) => b.ref),
    ...(tenant.contacts ?? []).map((c) => c.ref),
    ...(tenant.projects ?? []).map((p) => p.ref),
  ]);
  const projectRefs = new Set((tenant.projects ?? []).map((p) => p.ref));

  const scopeRefs = (obj, path) => {
    if (Array.isArray(obj)) return obj.forEach((v, i) => scopeRefs(v, `${path}[${i}]`));
    if (obj && typeof obj === "object") {
      // create_project expectations intentionally reference a project NOT yet in the tenant:
      // creating it from the inquiry is exactly what the runner must do. Tenant isolation still
      // forbids referencing another CASE's refs.
      if (obj.scope && obj.scope.level === "project" && obj.operation !== "create_project" && !projectRefs.has(obj.scope.ref)) {
        fail(`${label}: ${path} references project "${obj.scope.ref}" not defined in this case's tenant`);
      }
      for (const [k, v] of Object.entries(obj)) scopeRefs(v, `${path}.${k}`);
    }
  };
  scopeRefs(tenant.existingFindings ?? [], "existingFindings");
  scopeRefs(kase.sources ?? [], "sources");

  const checkRef = (ref, path) => {
    if (!definedRefs.has(ref)) fail(`${label}: ${path} references "${ref}" not defined in this case's tenant`);
  };
  for (const s of sources) {
    checkRef(s.author, `sources[${s.sourceId}].author`);
    if (s.projectPill && !projectRefs.has(s.projectPill)) {
      fail(`${label}: sources[${s.sourceId}].projectPill "${s.projectPill}" not defined in tenant projects`);
    }
  }
  for (const entry of kase.timeline ?? []) {
    if (entry.by) checkRef(entry.by, `timeline(${entry.type}).by`);
  }

  // ---- Assets: availability + provenance ----
  const caseDir = join(CASES_DIR, dir);
  for (const part of voiceParts) {
    const prov = part.assetProvenance ?? {};
    if (prov.status === "generated") {
      const assetPath = join(caseDir, part.asset ?? "audio.wav");
      if (!existsSync(assetPath)) fail(`${label}: ${part.partId} provenance "generated" but asset file missing`);
    } else if (prov.status === "pending_generation") {
      if (!prov.statement || !/transcript/i.test(prov.statement)) {
        fail(`${label}: ${part.partId} pending audio must carry a statement that the transcript is the source of truth for expected STT`);
      }
    } else {
      fail(`${label}: ${part.partId} missing valid assetProvenance`);
    }
  }
  for (const part of imageParts) {
    const prov = part.assetProvenance ?? {};
    if (!part.asset) { fail(`${label}: ${part.partId} image part without asset reference`); continue; }
    const assetPath = join(caseDir, part.asset);
    if (!existsSync(assetPath)) {
      if (prov.status === "generated") fail(`${label}: ${part.partId} asset file missing: ${part.asset}`);
      else if (prov.status !== "pending_generation") fail(`${label}: ${part.partId} asset missing and provenance not pending_generation`);
      continue;
    }
    const bytes = readFileSync(assetPath);
    const sha = createHash("sha256").update(bytes).digest("hex");
    if (typeof prov.sha256 === "string") {
      if (prov.sha256 !== sha) {
        fail(`${label}: ${part.partId} asset sha256 mismatch (recorded ${prov.sha256.slice(0, 12)}..., actual ${sha.slice(0, 12)}...); regenerate or fix provenance`);
      }
    } else {
      fail(`${label}: ${part.partId} present asset must record sha256 provenance`);
    }
    if (prov.status !== "generated" || !prov.generator) {
      fail(`${label}: ${part.partId} present asset must record status "generated" and its generator`);
    }
  }

  // ---- Timeline chronology and source references ----
  const sourceIds = new Set(sources.map((s) => s.sourceId));
  const sendTimes = new Map(sources.map((s) => [s.sourceId, Date.parse(s.sentAt)]));
  let lastAt = sources.length ? Math.min(...[...sendTimes.values()]) : 0;
  for (const entry of kase.timeline ?? []) {
    if (!sourceIds.has(entry.sourceId)) fail(`${label}: timeline ${entry.type} references unknown source "${entry.sourceId}"`);
    const t = Date.parse(entry.completesAt ?? entry.at);
    if (Number.isNaN(t)) continue;
    if (t < lastAt) fail(`${label}: timeline not chronological at source "${entry.sourceId}" (${entry.type})`);
    lastAt = Math.max(lastAt, t);
    const sent = sendTimes.get(entry.sourceId);
    if (sent !== undefined && t < sent) {
      fail(`${label}: timeline ${entry.type} for ${entry.sourceId} happens before the source was sent`);
    }
  }
}

// Expected outcome files: 1:1 with cases, schema-valid, anchor-consistent.
const expectedFiles = existsSync(EXPECTED_DIR)
  ? readdirSync(EXPECTED_DIR).filter((f) => f.endsWith(".json") && !f.includes(".schema.")).sort()
  : [];

const expectedIds = new Set();
for (const file of expectedFiles) {
  const label = `expected/${file}`;
  let exp;
  try {
    exp = readJson(join(EXPECTED_DIR, file));
  } catch (e) {
    fail(`${label}: not valid JSON (${e.message})`);
    continue;
  }
  validateAgainstSchema(exp, expectedSchemaPath, label);
  if (typeof exp.caseId !== "string") continue;

  const id = exp.caseId;
  if (expectedIds.has(id)) fail(`${label}: duplicate expected caseId "${id}"`);
  expectedIds.add(id);

  const casePath = join(CASES_DIR, id, "case.json");
  if (!existsSync(casePath)) {
    fail(`${label}: no corpus case "${id}" for this expected file`);
    continue;
  }
  if (file !== `${id}.json`) fail(`${label}: file name must be ${id}.json`);

  const kase = readJson(casePath);

  // Tenant isolation for answer keys: every scope ref must resolve inside THIS
  // case's tenant (create_project expectations excepted, they create the ref).
  // A ref from another case's fixture (e.g. a borrowed P-BANAN) must fail.
  {
    const tenantProjects = new Set((kase.tenant?.projects ?? []).map((p) => p.ref));
    (exp.stages ?? []).forEach((stage) => {
      (stage.memoryChanges ?? []).forEach((change, i) => {
        const where = `stages[${stage.stageId}].memoryChanges[${i}]`;
        const scope = change.scope;
        if (!scope) return;
        if (scope.level === "company") {
          if (scope.ref !== "COMPANY") {
            fail(`${label}: ${where} company scope must use ref "COMPANY", got "${scope.ref}"`);
          }
        } else if (scope.level === "project") {
          if (change.operation !== "create_project" && !tenantProjects.has(scope.ref)) {
            fail(`${label}: ${where} references project "${scope.ref}" not defined in case ${id}'s tenant (cross-case leak or typo)`);
          }
        }
      });
    });
  }
  if (exp.corpusRevision !== kase.corpusRevision) {
    fail(`${label}: corpusRevision "${exp.corpusRevision}" != case "${kase.corpusRevision}"`);
  }

  // Build lookup structures for anchor checks.
  const textParts = new Map();
  const voiceParts = new Map();
  const imageParts = new Map();
  for (const s of kase.sources ?? []) {
    for (const p of s.parts ?? []) {
      if (p.type === "text") textParts.set(p.partId, p);
      if (p.type === "voice") voiceParts.set(p.partId, p);
      if (p.type === "image") imageParts.set(p.partId, p);
    }
  }
  const sourceIds = new Set((kase.sources ?? []).map((s) => s.sourceId));

  // Strict part resolution: a typo'd partId must FAIL, never silently degrade
  // to a haystack of all parts. An omitted partId is allowed only when exactly
  // one part of the anchor's type exists.
  const resolvePart = (partId, map, typeLabel, path) => {
    if (partId !== undefined) {
      const part = map.get(partId);
      if (!part) {
        fail(`${label}: ${path} references unknown ${typeLabel} part "${partId}"`);
        return null;
      }
      return part;
    }
    const all = [...map.values()];
    if (all.length === 1) return all[0];
    if (all.length === 0) {
      fail(`${label}: ${path} uses a ${typeLabel} anchor but the case has no ${typeLabel} part`);
      return null;
    }
    fail(`${label}: ${path} omits partId while the case has ${all.length} ${typeLabel} parts; the anchor is ambiguous`);
    return null;
  };

  const checkEvidence = (e, path) => {
    if (!sourceIds.has(e.sourceId)) fail(`${label}: ${path} references unknown sourceId "${e.sourceId}"`);
    if (e.anchor?.kind === "text_quote") {
      const part = resolvePart(e.partId, textParts, "text", path);
      if (part && !part.text.includes(e.anchor.quote)) {
        fail(`${label}: ${path} text_quote not found verbatim in source text: "${e.anchor.quote}"`);
      }
    }
    if (e.anchor?.kind === "audio_interval") {
      const part = resolvePart(e.partId, voiceParts, "voice", path);
      if (part && (e.anchor.to > part.durationSeconds + 0.001 || e.anchor.from < 0)) {
        fail(`${label}: ${path} audio interval [${e.anchor.from}, ${e.anchor.to}] outside part duration ${part.durationSeconds}s`);
      }
    }
    if (e.anchor?.kind === "image_region") {
      const part = resolvePart(e.partId, imageParts, "image", path);
      if (part && (e.anchor.x + e.anchor.w > part.widthPx + 0.001 || e.anchor.y + e.anchor.h > part.heightPx + 0.001)) {
        fail(`${label}: ${path} image region outside ${part.widthPx}x${part.heightPx} bounds`);
      }
    }
  };

  for (const change of exp.stages ?? []) {
    (change.memoryChanges ?? []).forEach((mc, i) =>
      (mc.evidence ?? []).forEach((e, j) => checkEvidence(e, `stages[${change.stageId}].memoryChanges[${i}].evidence[${j}]`))
    );
  }

  // STT fidelity points: text must come from the fixture transcript; intervals in range.
  for (const stt of exp.expectedStt ?? []) {
    if (!sourceIds.has(stt.sourceId)) fail(`${label}: expectedStt references unknown sourceId "${stt.sourceId}"`);
    const part = voiceParts.get(stt.partId);
    if (!part) { fail(`${label}: expectedStt references unknown voice part "${stt.partId}"`); continue; }
    // Schema failures above already flagged missing transcript/duration; skip semantics safely.
    if (typeof part.transcript !== "string" || typeof part.durationSeconds !== "number") continue;
    for (const [i, fp] of (stt.fidelityPoints ?? []).entries()) {
      if (typeof fp.expectedText !== "string") continue;
      if (!part.transcript.includes(fp.expectedText)) {
        fail(`${label}: expectedStt[${i}] expectedText not present in fixture transcript: "${fp.expectedText}"`);
      }
      if (fp.to > part.durationSeconds + 0.001 || fp.from < 0 || fp.to <= fp.from) {
        fail(`${label}: expectedStt[${i}] interval [${fp.from}, ${fp.to}] invalid for duration ${part.durationSeconds}s`);
      }
    }
  }
  if ((kase.modality === "voice" || kase.modality === "mixed") && voiceParts.size > 0 && !(exp.expectedStt ?? []).length) {
    fail(`${label}: voice-containing case must declare expectedStt fidelity points`);
  }

  // Vision extraction points: string content must appear in the SVG text content; regions in bounds.
  for (const vis of exp.expectedVision ?? []) {
    if (!sourceIds.has(vis.sourceId)) fail(`${label}: expectedVision references unknown sourceId "${vis.sourceId}"`);
    const part = imageParts.get(vis.partId);
    if (!part) { fail(`${label}: expectedVision references unknown image part "${vis.partId}"`); continue; }
    const svgText = readFileSync(join(CASES_DIR, id, part.asset), "utf8");
    const svgStrings = [...svgText.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
    const descMatch = svgText.match(/<desc>([^<]*)<\/desc>/);
    // Authoritative haystack: rendered text + embedded <desc> + the human ground-truth
    // contentDescription from the fixture. Space is ignored to survive "9 800" vs "9800".
    const haystack = [...svgStrings, descMatch?.[1] ?? "", part.contentDescription ?? ""].join("\n").replace(/\s+/g, "");
    for (const [i, ep] of (vis.extractionPoints ?? []).entries()) {
      if (!ep.region || typeof ep.region.x !== "number") continue; // schema failure already flagged
      if (ep.region.x + ep.region.w > part.widthPx + 0.001 || ep.region.y + ep.region.h > part.heightPx + 0.001) {
        fail(`${label}: expectedVision[${i}] region outside ${part.widthPx}x${part.heightPx} bounds`);
      }
      const val = ep.expectedValue;
      // Explicit override for values whose rendering is split across elements
      // (e.g. a calendar day cell plus a separate month header).
      if (typeof ep.assetTextEvidence === "string") {
        if (!haystack.includes(ep.assetTextEvidence.replace(/\s+/g, ""))) {
          fail(`${label}: expectedVision[${i}] assetTextEvidence "${ep.assetTextEvidence}" not found in asset`);
        }
        continue;
      }
      const needles = [];
      if (val?.kind === "financial") needles.push(val.amount, val.minAmount, val.maxAmount);
      if (val?.kind === "quantity") needles.push(val.value, val.secondValue);
      if (val?.kind === "temporal") {
        needles.push(val.date, val.fromDate, val.toDate, val.originalExpression);
        // Polish dd.mm / dd.mm.yyyy renderings derived from ISO dates.
        for (const iso of [val.date, val.fromDate, val.toDate].filter(Boolean)) {
          const [, y, m, d] = iso.match(/^(\d{4})-(\d{2})-(\d{2})$/);
          needles.push(`${d}.${m}`, `${d}.${m}.${y}`);
        }
      }
      if (val?.kind === "text") needles.push(val.value);
      const candidates = needles
        .filter(Boolean)
        .flatMap((needle) => [
          needle,
          needle.replace(".", ","), // comma decimal
          needle.replace(/\.\d+$/, "").replace(/\D/g, ""), // integer-part digits ("9800.00" -> "9800")
        ])
        .map((c) => c.replace(/\s+/g, ""));
      const present = candidates.some((c) => c.length >= 1 && haystack.includes(c));
      if (!present) {
          fail(`${label}: expectedVision[${i}] value [${needles.filter(Boolean).join(", ")}] not found in asset text content; asset and answer key disagree`);
      }
    }
  }
  if ((kase.modality === "image" || kase.modality === "mixed") && imageParts.size > 0 && !(exp.expectedVision ?? []).length) {
    fail(`${label}: image-containing case must declare expectedVision extraction points`);
  }

  // Stage structure per modality. Stale-plan cases (timeline run_completion beats)
  // must express their per-beat expectations even when the modality is text or voice.
  const stageCount = (exp.stages ?? []).length;
  const hasRunCompletion = (kase.timeline ?? []).some((e) => e.type === "run_completion");
  if (kase.modality === "mixed" && stageCount < 2) {
    fail(`${label}: mixed follow-up case must have at least 2 expected stages (has ${stageCount})`);
  }
  if (kase.modality !== "mixed" && !hasRunCompletion && stageCount !== 1) {
    fail(`${label}: non-mixed case without timeline beats must have exactly 1 expected stage (has ${stageCount})`);
  }
  if (kase.modality !== "mixed" && hasRunCompletion && stageCount < 2) {
    fail(`${label}: stale-plan case (run_completion timeline) must have at least 2 expected stages, one per beat (has ${stageCount})`);
  }
  for (const stage of exp.stages ?? []) {
    if ((stage.memoryChanges ?? []).length === 0 && !stage.noChangeReason) {
      fail(`${label}: stage "${stage.stageId}" has no memoryChanges and no noChangeReason`);
    }
    if (stage.stageId === "final" && stage !== exp.stages[exp.stages.length - 1]) {
      fail(`${label}: stage "final" must be the last stage`);
    }
  }
}

for (const id of seenIds.keys()) {
  if (!expectedIds.has(id)) fail(`expected/${id}.json: missing expected outcome file for case "${id}"`);
}
for (const id of expectedIds) {
  if (!seenIds.has(id)) fail(`expected/${id}.json: expected file without corpus case`);
}

// ---- Counts ----
for (const [modality, expected] of Object.entries(EXPECTED_COUNTS)) {
  if (counts[modality] !== expected) {
    fail(`modality count mismatch: ${modality}=${counts[modality]}, expected ${expected}`);
  }
}
const total = Object.values(counts).reduce((a, b) => a + b, 0);
if (total !== 50) fail(`total case count ${total} != 50`);

// ---- Coverage vocabulary fully used ----
const vocabulary = manifest.coverageVocabulary ?? [];
if (vocabulary.length === 0) fail("manifest.json must declare coverageVocabulary");
for (const tag of vocabulary) {
  if (!coverageUsed.has(tag)) fail(`coverage tag "${tag}" declared in manifest but used by no case`);
}
for (const tag of coverageUsed.keys()) {
  if (!vocabulary.includes(tag)) fail(`coverage tag "${tag}" used in cases but absent from manifest vocabulary`);
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

console.log("Kiero evaluation corpus validator");
console.log(`  revision: ${manifest.corpusRevision}`);
console.log(`  cases: ${total} (text ${counts.text}, voice ${counts.voice}, image ${counts.image}, mixed ${counts.mixed})`);
console.log(`  expected outcome files: ${expectedFiles.length}`);
console.log("");
console.log("Coverage matrix (cases per dimension):");
for (const tag of vocabulary) {
  const ids = coverageUsed.get(tag) ?? [];
  console.log(`  ${tag.padEnd(22)} ${String(ids.length).padStart(2)}  ${ids.join(" ")}`);
}
console.log("");

if (errors.length > 0) {
  console.error(`INVALID: ${errors.length} error(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  process.exit(1);
}
console.log("VALID: corpus, answer keys, assets, anchors, isolation and coverage all check out.");
