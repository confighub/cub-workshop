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
  const existing = fixture([{ id: 'safe', yaml: yaml('safe') }]); mkdirSync(existing.out); writeFileSync(join(existing.out, 'keep'), 'keep');
  try { const result = run('--entry', 'safe', '--name', 'demo', '--out', existing.out, '--catalog-index', existing.index); assert.equal(result.status, 2); assert.match(result.stderr, /already exists/); assert.equal(readFileSync(join(existing.out, 'keep'), 'utf8'), 'keep'); }
  finally { rmSync(existing.dir, { recursive: true, force: true }); }
});

