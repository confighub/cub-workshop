import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const bin = fileURLToPath(new URL('../bin/cub-config', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', timeout: 15000 });

function withIndex(index, callback) {
  const dir = mkdtempSync(join(tmpdir(), 'config-list-role-'));
  const path = join(dir, 'index.json');
  writeFileSync(path, JSON.stringify(index));
  try { return callback(path); } finally { rmSync(dir, { recursive: true, force: true }); }
}

const listing = (id, roles, status = 'classified') => ({
  id,
  url: `https://example.test/listings/${id}.json`,
  version: '1.0.0',
  base: 'helm',
  discovery: { status, roles },
});

test('role query returns all matching candidates, including operators, in stable JSON', () => withIndex({ listings: [
  listing('z-service', [{ role: 'cache', componentType: 'service' }]),
  listing('a-operator', [{ role: 'cache', componentType: 'operator' }]),
  listing('other', [{ role: 'database', componentType: 'service' }]),
] }, (index) => {
  const result = run('list', '--role', 'cache', '--catalog-index', index, '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  const candidates = JSON.parse(result.stdout);
  assert.deepEqual(candidates.map((candidate) => candidate.id), ['a-operator', 'z-service']);
  assert.equal(candidates[0].discovery.roles[0].componentType, 'operator');
  assert.deepEqual(Object.keys(candidates[0]), ['id', 'url', 'version', 'base', 'discovery']);
}));

test('text role query distinguishes component types and asks the user to inspect evidence', () => withIndex({ listings: [
  listing('operator-one', [{ role: 'cache', componentType: 'operator' }]),
  listing('service-one', [{ role: 'cache', componentType: 'service' }]),
] }, (index) => {
  const result = run('list', '--role', 'cache', '--catalog-index', index);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /operator-one.*operator/);
  assert.match(result.stdout, /service-one.*service/);
  assert.match(result.stdout, /Inspect the full listing and its evidence/);
}));

test('no matching role returns an empty JSON array', () => withIndex({ listings: [
  listing('database-one', [{ role: 'database', componentType: 'service' }]),
] }, (index) => {
  const result = run('list', '--role', 'cache', '--catalog-index', index, '--json');
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), []);
}));

test('malformed index and unknown role are rejected clearly', () => {
  const malformed = withIndex({ listings: [listing('bad', [{ role: 'cache', componentType: 'service' }], 'future')] }, (index) => run('list', '--role', 'cache', '--catalog-index', index));
  assert.equal(malformed.status, 1);
  assert.match(malformed.stderr, /unknown discovery status/);
  const unknown = run('list', '--role', 'not-a-role', '--catalog-index', 'unused.json');
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown role/);
});

test('discovery invariants reject empty classified roles, populated not-classified roles, duplicates, and duplicate default overrides', () => {
  const cases = [
    { listings: [listing('empty', [], 'classified')], message: /classified but has no discovery roles/ },
    { listings: [listing('unclassified', [{ role: 'cache', componentType: 'service' }], 'not-classified')], message: /not-classified but has discovery roles/ },
    { listings: [listing('same', [{ role: 'cache', componentType: 'service' }]), listing('same', [{ role: 'database', componentType: 'service' }])], message: /duplicate listing id/ },
    { listings: [listing('duplicate-role', [{ role: 'cache', componentType: 'service' }, { role: 'cache', componentType: 'operator' }])], message: /duplicate discovery role/ },
  ];
  for (const fixture of cases) withIndex(fixture, (index) => {
    const result = run('list', '--role', 'cache', '--catalog-index', index);
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, fixture.message);
  });
  const duplicateOverride = run('list', '--role', 'cache', '--catalog-index', 'https://confighub.github.io/helm-expt/site/listings/index.json', '--catalog-index', 'https://confighub.github.io/helm-expt/site/listings/index.json');
  assert.equal(duplicateOverride.status, 2);
  assert.match(duplicateOverride.stderr, /may be specified only once/);
});

test('help documents role discovery without fetching the catalog', () => {
  const result = run('list', '--help');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--catalog-index FILE_OR_HTTPS_URL/);
  assert.match(result.stdout, /Roles: cache, database/);
});
