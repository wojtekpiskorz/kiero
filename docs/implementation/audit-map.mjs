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

// Derived table content: the manifest is the authority, table cells are derivatives.
// Every manifest-derivable cell below must match issues.json exactly.
const openKeys = new Set(remaining.map(entry => entry.key));
const cellTokens = (cell, context) => {
  const tokens = [...cell.matchAll(/\[([A-Za-z]\w+) #(\d+)\]\(/g)].map(match => ({ label: match[1], number: Number(match[2]) }));
  for (const token of tokens) {
    const referenced = byKey.get(token.label);
    if (referenced !== undefined) {
      require(token.number === referenced.issueNumber, `${context} reference [${token.label} #${token.number}] does not match cached issue number ${referenced.issueNumber}`);
    }
  }
  return tokens;
};

const graphRowMatches = [...graph.matchAll(/^\| \[([A-Z]\w+) #(\d+)\]\([^|)]*\) \| (OPEN|CLOSED) \| ([^|]*) \|/gm)];
const graphRows = new Map(graphRowMatches.map(match => [match[1], { state: match[3], blockers: match[4] }]));
require(graphRows.size === graphRowMatches.length, 'graph table contains duplicate entry rows');
require(graphRows.size === entries.length, 'graph table row count differs from manifest entries');
for (const entry of entries) {
  const row = graphRows.get(entry.key);
  require(row !== undefined, `${entry.key}: graph table row missing`);
  if (!row) continue;
  require(row.state === entry.state, `${entry.key}: graph table state ${row.state} differs from cached ${entry.state}`);
  const tokens = cellTokens(row.blockers, `${entry.key}: graph table`);
  const core = tokens.filter(token => byKey.has(token.label)).map(token => token.label);
  const external = tokens.filter(token => !byKey.has(token.label)).map(token => token.number);
  require(core.join(',') === entry.blockedBy.join(','), `${entry.key}: graph table blockers differ from manifest blockedBy`);
  require(external.join(',') === (entry.externalBlockedBy ?? []).join(','), `${entry.key}: graph table external blockers differ from manifest`);
  if (entry.blockedBy.length === 0 && (entry.externalBlockedBy ?? []).length === 0) {
    require(row.blockers.trim() === 'None', `${entry.key}: graph table blockers must read None`);
  }
}

const mermaidBlocks = [...graph.matchAll(/```mermaid\n([\s\S]*?)```/g)];
require(mermaidBlocks.length === 1, 'graph must contain exactly one mermaid remaining-work block');
const mermaid = mermaidBlocks[0];
if (mermaid) {
  const mermaidNodes = [...mermaid[1].matchAll(/^\s*([A-Z]\w+)\["/gm)].map(match => match[1]);
  const mermaidEdges = [...mermaid[1].matchAll(/^\s*([A-Z]\w+) --> ([A-Z]\w+)\s*$/gm)].map(match => `${match[1]}-->${match[2]}`);
  const derivedEdges = [];
  for (const entry of remaining) {
    for (const blocker of entry.blockedBy) if (openKeys.has(blocker)) derivedEdges.push(`${blocker}-->${entry.key}`);
  }
  require(mermaidNodes.join(',') === remaining.map(entry => entry.key).join(','), 'mermaid remaining-work nodes differ from manifest open entries');
  require(mermaidEdges.join(',') === derivedEdges.join(','), 'mermaid remaining-work edges differ from manifest-derived remaining subgraph');
}

const remainingTable = inventory.split('## Remaining execution')[1]?.split('## Integrated implementation')[0] ?? '';
const remainingRowMatches = [...remainingTable.matchAll(/^\| \[([A-Z]\w+) #(\d+)\]\([^|)]*\) \| [^|]* \| ([^|]*) \|/gm)];
const remainingRows = new Map(remainingRowMatches.map(match => [match[1], match[3]]));
require(remainingRows.size === remainingRowMatches.length, 'inventory remaining-execution table contains duplicate rows');
require([...remainingRows.keys()].join(',') === remaining.map(entry => entry.key).join(','), 'inventory remaining-execution rows differ from manifest open entries');
for (const entry of remaining) {
  const cell = remainingRows.get(entry.key);
  if (cell === undefined) continue;
  const tokens = cellTokens(cell, `${entry.key}: inventory remaining`);
  for (const token of tokens) require(byKey.has(token.label), `${entry.key}: inventory remaining reference [${token.label}] is not a manifest key`);
  const core = tokens.filter(token => byKey.has(token.label)).map(token => token.label);
  require(core.join(',') === entry.blockedBy.join(','), `${entry.key}: inventory remaining blockers differ from manifest blockedBy`);
}

const integratedTable = inventory.split('## Integrated implementation')[1]?.split('## Evidence qualifications')[0] ?? '';
const integratedRowMatches = [...integratedTable.matchAll(/^\| \[([A-Z]\w+) #(\d+)\]\([^|)]*\) \| [^|]* \| [^|]* \| ([^|]*) \|/gm)];
const integratedRows = new Map(integratedRowMatches.map(match => [match[1], match[3]]));
require(integratedRows.size === integratedRowMatches.length, 'inventory integrated table contains duplicate rows');
const expectedIntegrated = entries.filter(entry => entry.state === 'CLOSED' && entry.key !== 'M0').map(entry => entry.key);
require(sameSet([...integratedRows.keys()], expectedIntegrated), 'inventory integrated rows differ from manifest closed entries');
for (const [key, cell] of integratedRows) {
  for (const token of cellTokens(cell, `${key}: inventory remaining owners`)) {
    require(byKey.has(token.label) && openKeys.has(token.label), `${key}: inventory remaining owner ${token.label} is not an open manifest entry`);
  }
}

const proofRowCells = new Map();
for (const match of proofDoc.matchAll(/^\| (P\d\d) [^|]* \| [^|]* \| [^|]* \| ([^|]*) \|/gm)) {
  proofRowCells.set(match[1], match[2]);
}
for (const proof of expectedProofs) {
  const cell = proofRowCells.get(proof);
  require(cell !== undefined, `${proof}: proof register row missing`);
  if (cell === undefined) continue;
  const owners = cellTokens(cell, `${proof}: proof owners`).map(token => token.label);
  const expected = remaining.filter(entry => entry.proofs.includes(proof)).map(entry => entry.key);
  require(sameSet(owners, expected), `${proof}: required owners differ from manifest open proof owners`);
}

const uxRemainingReferences = new Set();
for (const match of ux.matchAll(/^\| (UX-[A-Z]+-\d+) \| [^|]* \| ([^|]*) \|/gm)) {
  const identifier = match[1];
  const note = match[2];
  const marker = 'Remaining repair/proof owners: ';
  const at = note.indexOf(marker);
  require(at >= 0, `${identifier}: missing remaining-owner references`);
  if (at < 0) continue;
  for (const token of cellTokens(note.slice(at), `${identifier}: remaining owners`)) {
    require(byKey.has(token.label) && openKeys.has(token.label), `${identifier}: remaining owner ${token.label} is not an open manifest entry`);
    uxRemainingReferences.add(token.label);
  }
}
for (const entry of remaining) {
  const productFacing = entry.ownedPaths.some(path => path.startsWith('apps/web/'));
  require(!productFacing || uxRemainingReferences.has(entry.key), `UX coverage never references open product-path owner ${entry.key}`);
}

// Cached map body (#15): string equality with the live body is checked in --remote mode;
// offline we still reject the count-restating drift class and stale execution-order rows.
require(typeof manifest.mapBody === 'string' && manifest.mapBody.length > 0, 'cached map body missing');
if (typeof manifest.mapBody === 'string') {
  for (const [pattern, message] of [
    [/\d+ native children/, 'mapBody restates the native-children count'],
    [/\d+ core dependency edges/, 'mapBody restates the core-edge count'],
    [/(?:\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty)(?: [a-z-]+){0,3} remain\b/i, 'mapBody restates a remaining-work count'],
  ]) {
    require(!pattern.test(manifest.mapBody), message);
  }
  const mapBodyJ5Row = manifest.mapBody.match(/^\| \[J5 #64\]\([^)]*\) \| [^|]* \| ([^|]*) \|/m);
  require(mapBodyJ5Row !== null, 'mapBody execution-order row for J5 missing');
  if (mapBodyJ5Row) {
    const mapBodyJ5Blockers = cellTokens(mapBodyJ5Row[1], 'mapBody J5 execution order').filter(token => byKey.has(token.label)).map(token => token.label);
    require(mapBodyJ5Blockers.join(',') === byKey.get('J5').blockedBy.join(','), 'mapBody J5 execution-order blockers differ from manifest blockedBy');
  }
}

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
      require(remote.state.toUpperCase() === entry.state, `${entry.key}: GitHub state differs from cached state`);
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
    note: 'Native readiness still requires resource and active path ownership checks. Cached states change only through bounded administration PRs that rerun this audit and keep every derived table consistent with the manifest.'
  };
}
console.log(JSON.stringify({ result: errors.length ? 'FAIL' : 'PASS', entries: entries.length, coreEdges: edges, uxRows: uxKeys.length, live, errors }, null, 2));
if (errors.length) process.exitCode = 1;
