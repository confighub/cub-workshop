import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const bin = join(root, 'bin/cub-stack');
const run = (...args) => spawnSync(process.execPath, [bin, 'compose', ...args], { cwd: root, encoding: 'utf8', timeout: 30000 });
const runWithEnv = (env, ...args) => spawnSync(process.execPath, [bin, 'compose', ...args], { cwd: root, encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } });
const digest = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;

function fixture(entries, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stack-compose-'));
  const listings = [];
  for (const entry of entries) {
    const bytes = Buffer.from(entry.yaml);
    const objectFile = `${entry.id}.yaml`;
    writeFileSync(join(dir, objectFile), bytes);
    const listing = {
      identity: { id: entry.id, url: `${entry.id}.json` },
      flattened: { verdict: entry.verdict ?? 'safe-to-flatten', objectCount: entry.count ?? 1,
        ...(entry.flattened ?? {}),
        retainedObjects: { path: entry.path ?? objectFile, url: entry.url ?? objectFile, sha256: entry.sha256 ?? digest(bytes) } },
      evidence: { links: [] },
    };
    writeFileSync(join(dir, `${entry.id}.json`), JSON.stringify(listing));
    listings.push({ id: entry.id, url: `${entry.id}.json` });
  }
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ listings: options.indexListings ?? listings }));
  return { dir, index: join(dir, 'index.json'), out: join(dir, 'out') };
}

const yaml = (name, value = 'one') => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\ndata:\n  value: ${value}\n`;

test('composes two explicit safe retained objects deterministically and saves the check', () => {
  const f = fixture([{ id: 'z-part', yaml: yaml('z') }, { id: 'a-part', yaml: yaml('a') }]);
  try {
    const result = run('--entry', 'z-part', '--entry', 'a-part', '--name', 'demo', '--out', f.out, '--catalog-index', f.index, '--json');
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.deepEqual(body.entries, ['a-part', 'z-part']);
    assert.equal(JSON.parse(readFileSync(join(f.out, 'result.json'))).checked, true);
    assert.deepEqual(JSON.parse(readFileSync(join(f.out, 'provenance.json'))).entries.map((e) => e.id), ['a-part', 'z-part']);
    const provenanceEntry = JSON.parse(readFileSync(join(f.out, 'provenance.json'))).entries[0];
    assert.equal(provenanceEntry.listingSnapshot.flattened.action, undefined);
    assert.equal(provenanceEntry.listingSnapshot.identity.id, 'a-part');
    assert.equal(digest(Buffer.from(provenanceEntry.listingBytesBase64, 'base64')), provenanceEntry.listingSha256);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('rejects duplicate name and out flags and invalid retained object counts or documents', () => {
  const duplicateFlags = fixture([{ id: 'safe', yaml: yaml('safe') }]);
  try {
    assert.equal(run('--entry', 'safe', '--name', 'demo', '--name', 'again', '--out', duplicateFlags.out, '--catalog-index', duplicateFlags.index).status, 2);
    assert.equal(run('--entry', 'safe', '--name', 'demo', '--out', duplicateFlags.out, '--out', `${duplicateFlags.out}-again`, '--catalog-index', duplicateFlags.index).status, 2);
  } finally { rmSync(duplicateFlags.dir, { recursive: true, force: true }); }

  for (const entry of [
    { id: 'zero', yaml: yaml('zero'), count: 0 },
    { id: 'wrong-count', yaml: yaml('wrong-count'), count: 2 },
    { id: 'bad-doc', yaml: 'kind: ConfigMap\nmetadata:\n  name: bad\n' },
  ]) {
    const f = fixture([entry]);
    if (entry.id === 'bad-doc') {
      const listing = JSON.parse(readFileSync(join(f.dir, `${entry.id}.json`)));
      listing.flattened.objectCount = 1;
      writeFileSync(join(f.dir, `${entry.id}.json`), JSON.stringify(listing));
    }
    try {
      const result = run('--entry', entry.id, '--name', 'demo', '--out', f.out, '--catalog-index', f.index);
      assert.equal(result.status, 1);
      assert.equal(existsSync(f.out), false);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('rejects HTTP retained references before path joining', () => {
  const f = fixture([{ id: 'http-ref', yaml: yaml('http-ref'), url: 'http://127.0.0.1:9/objects.yaml' }]);
  try {
    const result = run('--entry', 'http-ref', '--name', 'demo', '--out', f.out, '--catalog-index', f.index);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /must use https/);
    assert.equal(existsSync(f.out), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('accepts an HTTPS retained URL and verifies its fetched bytes', () => {
  const f = fixture([{ id: 'https-ref', yaml: yaml('https-ref'), url: 'https://catalog.test/objects.yaml' }]);
  const preload = join(f.dir, 'fetch.mjs');
  const bytes = readFileSync(join(f.dir, 'https-ref.yaml'));
  writeFileSync(preload, `globalThis.fetch = async () => new Response(Buffer.from(${JSON.stringify(bytes.toString('base64'))}, 'base64'), { status: 200 });\n`);
  try {
    const result = runWithEnv({ NODE_OPTIONS: `--import ${preload}` }, '--entry', 'https-ref', '--name', 'demo', '--out', f.out, '--catalog-index', f.index);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(JSON.parse(readFileSync(join(f.out, 'result.json'))).checked, true);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('rejects a remote listing that points at a local retained path', () => {
  const f = fixture([{ id: 'remote-listing', yaml: yaml('remote-listing') }]);
  const listing = JSON.parse(readFileSync(join(f.dir, 'remote-listing.json')));
  listing.flattened.retainedObjects.url = 'objects.yaml';
  const preload = join(f.dir, 'fetch.mjs');
  writeFileSync(preload, `globalThis.fetch = async () => new Response(${JSON.stringify(JSON.stringify(listing))}, { status: 200 });\n`);
  const remoteIndex = join(f.dir, 'remote-index.json');
  writeFileSync(remoteIndex, JSON.stringify({ listings: [{ id: 'remote-listing', url: 'https://catalog.test/listing.json' }] }));
  try {
    const result = runWithEnv({ NODE_OPTIONS: `--import ${preload}` }, '--entry', 'remote-listing', '--name', 'demo', '--out', f.out, '--catalog-index', remoteIndex);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /retainedObjects.url must be https when the listing is remote/);
    assert.equal(existsSync(f.out), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('retains refused stack check output and evidence', () => {
  const f = fixture([{ id: 'one', yaml: yaml('same', 'one') }, { id: 'two', yaml: yaml('same', 'two') }]);
  try {
    const result = run('--entry', 'one', '--entry', 'two', '--name', 'conflict', '--out', f.out, '--catalog-index', f.index, '--json');
    assert.equal(result.status, 1);
    assert.equal(JSON.parse(result.stdout).result.checked, false);
    assert.ok(existsSync(join(f.out, 'provenance.json')));
    assert.ok(existsSync(join(f.out, 'result.json')));
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('rejects unsafe or routed entries before creating output', () => {
  for (const verdict of ['unsafe-to-flatten', 'flatten-with-routes']) {
    const f = fixture([{ id: 'unsafe', yaml: yaml('unsafe'), verdict }]);
    try { const result = run('--entry', 'unsafe', '--name', 'demo', '--out', f.out, '--catalog-index', f.index); assert.equal(result.status, 1); assert.match(result.stderr, /compose accepts only/); assert.equal(existsSync(f.out), false); }
    finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('rejects bad hashes, duplicate IDs, path IDs, and existing output without writing', () => {
  const bad = fixture([{ id: 'bad', yaml: yaml('bad'), sha256: `sha256:${'0'.repeat(64)}` }]);
  try { const result = run('--entry', 'bad', '--name', 'demo', '--out', bad.out, '--catalog-index', bad.index); assert.equal(result.status, 1); assert.match(result.stderr, /hash mismatch/); assert.equal(existsSync(bad.out), false); }
  finally { rmSync(bad.dir, { recursive: true, force: true }); }
  const duplicate = fixture([{ id: 'same', yaml: yaml('same') }, { id: 'same', yaml: yaml('same2') }]);
  try { const result = run('--entry', 'same', '--name', 'demo', '--out', duplicate.out, '--catalog-index', duplicate.index); assert.equal(result.status, 1); assert.match(result.stderr, /duplicate/); }
  finally { rmSync(duplicate.dir, { recursive: true, force: true }); }
  const traversal = fixture([{ id: 'safe', yaml: yaml('safe') }], { indexListings: [{ id: '../escape', url: 'safe.json' }] });
  try { const result = run('--entry', '../escape', '--name', 'demo', '--out', traversal.out, '--catalog-index', traversal.index); assert.equal(result.status, 2); assert.match(result.stderr, /catalog IDs/); }
  finally { rmSync(traversal.dir, { recursive: true, force: true }); }
  const retainedTraversal = fixture([{ id: 'retained-traversal', yaml: yaml('retained-traversal'), path: '../outside.yaml' }]);
  try { const result = run('--entry', 'retained-traversal', '--name', 'demo', '--out', retainedTraversal.out, '--catalog-index', retainedTraversal.index); assert.equal(result.status, 1); assert.match(result.stderr, /path traversal/); assert.equal(existsSync(retainedTraversal.out), false); }
  finally { rmSync(retainedTraversal.dir, { recursive: true, force: true }); }
  const existing = fixture([{ id: 'safe', yaml: yaml('safe') }]); mkdirSync(existing.out); writeFileSync(join(existing.out, 'keep'), 'keep');
  try { const result = run('--entry', 'safe', '--name', 'demo', '--out', existing.out, '--catalog-index', existing.index); assert.equal(result.status, 2); assert.match(result.stderr, /already exists/); assert.equal(readFileSync(join(existing.out, 'keep'), 'utf8'), 'keep'); }
  finally { rmSync(existing.dir, { recursive: true, force: true }); }
});
