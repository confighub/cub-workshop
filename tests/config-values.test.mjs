import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { diagnose, elsewhere, leafPaths, lookup, nearest, without } from '../lib/config-values.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const chart = join(root, 'tests/fixtures/values-chart');
const hasHelm = spawnSync('helm', ['version', '--short']).status === 0;
const defaults = { replicaCount: 1, auth: { enabled: true, password: '' }, metrics: { enabled: false, port: 9121 }, podAnnotations: {} };

test('a list and an empty map are each one value, and maps are walked', () => {
  const leaves = leafPaths({ a: { b: 1, c: [1, 2] }, d: {}, e: 'x' }).map((leaf) => leaf.path.join('.'));
  assert.deepEqual(leaves, ['a.b', 'a.c', 'd', 'e']);
});

test('a path is known, open under a free-form map, or unknown beside declared keys', () => {
  assert.equal(lookup(defaults, ['auth', 'password']).status, 'known');
  assert.equal(lookup(defaults, ['podAnnotations', 'team']).status, 'open');
  const miss = lookup(defaults, ['auth', 'passwrod']);
  assert.equal(miss.status, 'unknown');
  assert.deepEqual(miss.siblings, ['enabled', 'password']);
  assert.equal(nearest('passwrod', miss.siblings), 'password');
  assert.equal(nearest('somethingElseEntirely', miss.siblings), null);
});

test('a setting put in the wrong place is found where the chart declares it', () => {
  const chartDefaults = { replicaCount: 1, persistence: { size: '8Gi' }, resources: { limits: { memory: '' } }, metrics: { resources: { limits: { memory: '' } } } };
  assert.deepEqual(elsewhere(chartDefaults, ['master', 'persistence', 'size']), ['persistence.size']);
  assert.deepEqual(elsewhere(chartDefaults, ['replica', 'replicaCount']), ['replicaCount']);
  assert.deepEqual(elsewhere(chartDefaults, ['master', 'resources', 'limits', 'memory']), ['resources.limits.memory', 'metrics.resources.limits.memory']);
  assert.deepEqual(elsewhere(chartDefaults, ['nothing', 'likeThis']), []);
});

test('taking one value out removes the maps it leaves empty', () => {
  assert.deepEqual(without({ auth: { passwrod: 'x' }, replicaCount: 3 }, ['auth', 'passwrod']), { replicaCount: 3 });
  assert.deepEqual(without({ auth: { a: 1, b: 2 } }, ['auth', 'a']), { auth: { b: 2 } });
});

test('the verdicts follow the render, with a renderer that needs no Helm', () => {
  let nonce = 0;
  const render = (values) => Buffer.from(JSON.stringify({
    apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'demo' },
    data: { replicas: String(values.replicaCount ?? 1), generated: `token-${nonce += 1}` },
  }));
  const report = diagnose({ values: { replicaCount: 3, auth: { passwrod: 'x' } }, defaults, render });
  assert.deepEqual(report.values.map((value) => [value.path, value.verdict]), [['replicaCount', 'APPLIED'], ['auth.passwrod', 'IGNORED']]);
  assert.equal(report.values[1].suggestion, 'password');
  assert.equal(report.unstableFields, 1, 'the generated token is left out of every comparison');
  assert.equal(JSON.stringify(report).includes('"x"'), false, 'no value is ever reported');
});

test('against a real chart: a typo, a switched-off setting, a default, a free-form map and a generated password', { skip: !hasHelm }, () => {
  const work = mkdtempSync(join(tmpdir(), 'cub-values-test-'));
  try {
    const file = join(work, 'values.yaml');
    writeFileSync(file, 'replicaCount: 3\nauth:\n  passwrod: hunter2\nmetrics:\n  enabled: false\n  port: 9999\npodAnnotations:\n  team: shop\n');
    const run = spawnSync(join(root, 'bin/cub-config'), ['values', chart, '--values', file, '--json', '--exit-code'], { encoding: 'utf8' });
    assert.equal(run.status, 1, 'values that did nothing fail the gate');
    const report = JSON.parse(run.stdout);
    const verdicts = Object.fromEntries(report.values.map((value) => [value.path, value.verdict]));
    assert.deepEqual(verdicts, {
      replicaCount: 'APPLIED', 'auth.passwrod': 'IGNORED', 'metrics.enabled': 'DEFAULT', 'metrics.port': 'NO EFFECT', 'podAnnotations.team': 'APPLIED',
    });
    assert.deepEqual(report.summary, { set: 5, applied: 2, ignored: 1, noEffect: 1, sameAsDefault: 1, notChecked: 0 });
    assert.ok(report.unstableFields >= 1, 'the generated password is recognised as moving');
    assert.equal(run.stdout.includes('hunter2'), false, 'the secret value is never printed');

    const human = spawnSync(join(root, 'bin/cub-config'), ['values', chart, '--values', file], { encoding: 'utf8' });
    assert.equal(human.status, 0, 'without --exit-code the report is advice');
    assert.match(human.stdout, /\[IGNORED\]\s+auth\.passwrod\s+matched no key under auth, and it changed nothing\. Did you mean password\?/);
    assert.match(human.stdout, /2 of 5 values did nothing\./);
    assert.equal(human.stdout.includes('hunter2'), false);
  } finally { rmSync(work, { recursive: true, force: true }); }
});

test('a missing values file or chart is a usage error', () => {
  const run = spawnSync(join(root, 'bin/cub-config'), ['values', chart], { encoding: 'utf8' });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /usage: cub config values/);
});
