#!/usr/bin/env node
// Read-only audit of the cached map and GitHub's native issue relationships.
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const exec = promisify(execFile);
const directory = fileURLToPath(new URL('.', import.meta.url));
const manifestPath = process.env.KIERO_MAP_MANIFEST ?? `${directory}issues.json`;
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const entries = manifest.entries;
const errors = [];
const require = (condition, message) => { if (!condition) errors.push(message); };
const hash = value => createHash('sha256').update(value).digest('hex');
const sameSet = (a, b) => a.length === b.length && [...a].sort().join('|') === [...b].sort().join('|');
const byKey = new Map(entries.map(entry => [entry.key, entry]));
const byNumber = new Map(entries.map(entry => [entry.issueNumber, entry]));
require(manifest.version === 2, 'unsupported manifest version');
require(byKey.size === entries.length, 'duplicate issue key');
require(byNumber.size === entries.length, 'duplicate issue number');
require(byKey.has('J5'), 'missing final qualification J5');
require(manifest.administrationIssue === byKey.get('M0')?.issueNumber, 'administration issue mismatch');
require(sameSet(manifest.roots, entries.filter(entry => entry.blockedBy.length === 0).map(entry => entry.key)), 'root keys mismatch');
for (const entry of entries) {
  require(Number.isSafeInteger(entry.issueNumber) && entry.issueNumber > 0, `${entry.key}: unresolved issue number`);
  require(entry.bodySha256 === hash(entry.body), `${entry.key}: cached body hash mismatch`);
  require(new Set(entry.blockedBy).size === entry.blockedBy.length, `${entry.key}: duplicate blocker`);
  for (const key of entry.blockedBy) require(byKey.has(key), `${entry.key}: unknown blocker ${key}`);
  require(entry.ownedPaths.length > 0, `${entry.key}: missing ownership`);
  require(['OPEN', 'CLOSED'].includes(entry.state), `${entry.key}: invalid cached state`);
  require(entry.issueUrl === `https://github.com/wojtekpiskorz/kiero/issues/${entry.issueNumber}`, `${entry.key}: issue URL mismatch`);
  const external = entry.externalBlockedBy ?? [];
  require(new Set(external).size === external.length, `${entry.key}: duplicate external blocker`);
  for (const number of external) require(Number.isSafeInteger(number) && number > 0 && !byNumber.has(number), `${entry.key}: invalid external blocker ${number}`);
}
const visited = new Set();
const active = new Set();
function visit(key) {
  if (active.has(key)) { errors.push(`cycle at ${key}`); return; }
  if (visited.has(key) || !byKey.has(key)) return;
  active.add(key);
  for (const dependency of byKey.get(key).blockedBy) visit(dependency);
  active.delete(key); visited.add(key);
}
for (const key of byKey.keys()) visit(key);
function ancestors(key, result = new Set()) {
  for (const dependency of byKey.get(key)?.blockedBy ?? []) {
    if (!result.has(dependency)) { result.add(dependency); ancestors(dependency, result); }
  }
  return result;
}
const finalAncestors = ancestors('J5');
for (const entry of entries) {
  const declared = entry.declaredPrerequisites ?? [];
  for (const key of entry.blockedBy) require(declared.includes(key), `${entry.key}: direct blocker ${key} missing from declared prerequisites`);
  const reachable = ancestors(entry.key);
  for (const key of declared) require(reachable.has(key), `${entry.key}: declared prerequisite ${key} absent from native ancestry`);
}
const remaining = entries.filter(entry => entry.state === 'OPEN');
for (let a = 0; a < remaining.length; a++) {
  for (let b = a + 1; b < remaining.length; b++) {
    const left = remaining[a]; const right = remaining[b];
    const shared = left.ownedPaths.filter(path => right.ownedPaths.includes(path));
    require(shared.length === 0 || ancestors(left.key).has(right.key) || ancestors(right.key).has(left.key), `${left.key}/${right.key}: unordered exact owned-path overlap ${shared.join(', ')}`);
  }
}
for (const entry of entries.filter(entry => entry.state === 'OPEN' && entry.key !== 'J5')) {
  require(finalAncestors.has(entry.key), `${entry.key}: remaining task does not block J5`);
}
const edges = entries.reduce((sum, entry) => sum + entry.blockedBy.length, 0);
require(edges === manifest.nativeCoreEdges, 'core edge count mismatch');
require(entries.reduce((sum, entry) => sum + (entry.externalBlockedBy ?? []).length, 0) === manifest.externalEdges, 'external edge count mismatch');
const ux = await readFile(`${directory}ux-coverage.md`, 'utf8');
const uxKeys = [...ux.matchAll(/^\| (UX-[A-Z]+-\d+) \|/gm)].map(match => match[1]);
require(uxKeys.length === 61 && new Set(uxKeys).size === 61, 'UX inventory must retain all 61 unique rows');
const canonicalUx = await readFile(`${directory}../handoffs/ux-ui/feature-and-flow-inventory.md`, 'utf8');
const canonicalKeys = [...new Set(canonicalUx.match(/UX-[A-Z]+-\d+/g))];
require(sameSet(uxKeys, canonicalKeys), 'UX keys differ from the accepted design inventory');
const proofDoc = await readFile(`${directory}proof-ownership.md`, 'utf8');
const proofKeys = [...proofDoc.matchAll(/^\| (P\d\d) /gm)].map(match => match[1]);
const expectedProofs = Array.from({ length: 12 }, (_, index) => `P${String(index + 1).padStart(2, '0')}`);
require(sameSet(proofKeys, expectedProofs), 'proof register must contain P01-P12 exactly once');
require(sameSet([...new Set(entries.flatMap(entry => entry.proofs))], expectedProofs), 'manifest proof union differs from P01-P12');
const inventory = await readFile(`${directory}inventory.md`, 'utf8');
const graph = await readFile(`${directory}dependency-graph.md`, 'utf8');
for (const entry of entries) {
  const reference = `[${entry.key} #${entry.issueNumber}]`;
  require(graph.includes(reference), `${entry.key}: missing from graph table`);
  if (entry.key !== 'M0') require(inventory.includes(reference), `${entry.key}: missing from inventory`);
}
require(graph.includes(`There are ${edges} core edges`), 'graph edge count differs from manifest');
for (const [name, content] of [['graph', graph], ['inventory', inventory], ['proofs', proofDoc], ['UX', ux]]) {
  require(!/#pending|number assigned during reconciliation|#None/.test(content), `${name}: unresolved generated reference`);
}

async function api(path) {
  const { stdout } = await exec('gh', ['api', path, '--paginate', '--slurp'], { maxBuffer: 16 * 1024 * 1024 });
  return JSON.parse(stdout).flat();
}
let live = null;
if (process.argv.includes('--remote') && errors.length === 0) {
  const prefix = 'repos/wojtekpiskorz/kiero/issues';
  const children = await api(`${prefix}/15/sub_issues?per_page=100`);
  require(sameSet(children.map(child => child.number), entries.map(entry => entry.issueNumber)), 'native map children differ from manifest');
  const [map] = await api(`${prefix}/15`);
  require(map.body === manifest.mapBody, 'map #15 body differs from cached manifest');
  const remoteByNumber = new Map(children.map(child => [child.number, child]));
  const allBlockers = new Map();
  let next = 0;
  await Promise.all(Array.from({ length: 4 }, async () => {
    while (next < entries.length) {
      const entry = entries[next++];
      const remote = remoteByNumber.get(entry.issueNumber);
      if (!remote) continue;
      require(hash(remote.body ?? '') === entry.bodySha256, `${entry.key}: GitHub body differs from cache`);
      require(remote.title === entry.title, `${entry.key}: GitHub title differs from cache`);
      // M0's PR closes its own administrative issue after publishing this snapshot.
      const administrationCompleted = entry.key === 'M0' && entry.state === 'OPEN' && remote.state === 'closed';
      require(remote.state.toUpperCase() === entry.state || administrationCompleted, `${entry.key}: GitHub state differs from cached state`);
      const blockers = await api(`${prefix}/${entry.issueNumber}/dependencies/blocked_by?per_page=100`);
      const expected = entry.blockedBy.map(key => byKey.get(key).issueNumber).concat(entry.externalBlockedBy ?? []);
      require(sameSet(blockers.map(blocker => blocker.number), expected), `${entry.key}: native blockers differ from cache`);
      allBlockers.set(entry.key, blockers);
    }
  }));
  const open = children.filter(child => child.state === 'open');
  const ready = open.filter(child => child.assignees.length === 0 &&
    (allBlockers.get(byNumber.get(child.number)?.key) ?? []).every(blocker => blocker.state === 'closed'));
  live = {
    closed: children.length - open.length, open: open.length,
    unassignedWithNoOpenNativeBlockers: ready.map(child => `${byNumber.get(child.number)?.key} #${child.number}`),
    note: 'Native readiness still requires resource and active path ownership checks. Only M0 OPEN-to-CLOSED is allowed after its own documentation PR; update every other cached state when it changes.'
  };
}
console.log(JSON.stringify({ result: errors.length ? 'FAIL' : 'PASS', entries: entries.length, coreEdges: edges, uxRows: uxKeys.length, live, errors }, null, 2));
if (errors.length) process.exitCode = 1;
