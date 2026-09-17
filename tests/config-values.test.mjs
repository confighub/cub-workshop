import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { diagnose, elsewhere, generatedFields, leafPaths, lookup, nearest, presetPaths, without } from '../lib/config-values.mjs';

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

test('a setting under a map the chart declares empty is pointed at that map', () => {
  const open = { resources: {}, sentinel: { resources: {} }, persistence: { size: '8Gi' } };
  assert.deepEqual(elsewhere(open, ['master', 'resources', 'limits', 'memory']), ['resources.limits.memory', 'sentinel.resources.limits.memory']);
  assert.deepEqual(elsewhere(open, ['master', 'resources']), ['resources', 'sentinel.resources']);
});

test('--help is never read as a name, and exits 0', () => {
  for (const [bin, verb] of [['cub-config', 'check'], ['cub-config', 'values'], ['cub-config', 'diff'], ['cub-app', 'check'], ['cub-app', 'match'], ['cub-stack', 'certify'], ['cub-stack', 'sandbox'], ['cub-fleet', 'plan']]) {
    const run = spawnSync(process.execPath, [join(root, 'bin', bin), verb, '--help'], { encoding: 'utf8' });
    assert.equal(run.status, 0, `${bin} ${verb} --help`);
    assert.match(run.stdout, /cub (config|app|stack|fleet)/, `${bin} ${verb} --help prints usage`);
    assert.doesNotMatch(run.stdout + run.stderr, /no such/, `${bin} ${verb} --help`);
  }
});

test('a preset in force and a field that changes on every render are both reported', () => {
  const presetDefaults = { architecture: 'standalone', master: { resourcesPreset: 'nano', resources: {} }, replica: { resourcesPreset: 'nano', resources: {} } };
  assert.deepEqual(presetPaths(presetDefaults).map((entry) => entry.path.join('.')), ['master.resourcesPreset', 'replica.resourcesPreset']);
  let seed = 0;
  // The replica preset is for pods that standalone never renders, so only the master's is in force.
  const render = (values) => {
    const merged = { ...presetDefaults, ...values, master: { ...presetDefaults.master, ...(values.master ?? {}) } };
    const limits = merged.master.resourcesPreset === 'none' ? {} : { memory: '192Mi' };
    return Buffer.from([
      JSON.stringify({ apiVersion: 'apps/v1', kind: 'StatefulSet', metadata: { name: 'db-master', namespace: 'shop' }, spec: { template: { spec: { containers: [{ name: 'db', image: 'db:1', resources: { limits } }] } } } }),
      JSON.stringify({ apiVersion: 'v1', kind: 'Secret', metadata: { name: 'db', namespace: 'shop' }, data: { password: Buffer.from(`generated-${seed += 1}`).toString('base64') } }),
    ].join('\n---\n'));
  };
  const report = diagnose({ values: { architecture: 'standalone' }, defaults: presetDefaults, render });
  assert.deepEqual(report.presets.map((preset) => [preset.path, preset.preset, preset.resources]), [['master.resourcesPreset', 'nano', 'master.resources']]);
  assert.deepEqual(report.presets[0].objects, [{ apiVersion: 'apps/v1', kind: 'StatefulSet', namespace: 'shop', name: 'db-master' }]);
  assert.deepEqual(report.generated, [{ object: { kind: 'Secret', name: 'db' }, path: '/data/password' }]);
  assert.doesNotMatch(JSON.stringify(report), /generated-\d/);

  const own = diagnose({ values: { master: { resources: { limits: { memory: '512Mi' } } } }, defaults: presetDefaults, render });
  assert.deepEqual(own.presets, [], 'a preset the user replaced with their own resources is not reported');
  assert.deepEqual(generatedFields(Buffer.from('{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"c"},"data":{"a":"1"}}'), Buffer.from('{"apiVersion":"v1","kind":"ConfigMap","metadata":{"name":"c"},"data":{"a":"1"}}')), []);
});

test('check names images tagged latest or not tagged, and passes a digest or a fixed tag', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-images-'));
  try {
    const pod = (name, image) => ({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name, namespace: 'shop' }, spec: { template: { spec: { initContainers: [{ name: 'init', image: 'busybox' }], containers: [{ name: 'app', image }] } } } });
    const file = join(dir, 'app.yaml');
    writeFileSync(file, [pod('a', 'registry-1.docker.io/bitnami/redis:latest'), pod('b', 'localhost:5000/team/app:1.2.3'), pod('c', 'ghcr.io/x/y@sha256:' + '0'.repeat(64))].map((doc) => JSON.stringify(doc)).join('\n---\n'));
    const run = spawnSync(process.execPath, [join(root, 'bin/cub-config'), 'check', file], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /\[NOTE\] images tagged latest or not tagged: 2 \(busybox, registry-1\.docker\.io\/bitnami\/redis:latest\)/);
    writeFileSync(file, JSON.stringify(pod('d', 'nginx:1.27.0')).replace('"busybox"', '"busybox:1.36"'));
    const pinned = spawnSync(process.execPath, [join(root, 'bin/cub-config'), 'check', file], { encoding: 'utf8' });
    assert.match(pinned.stdout, /\[PASS\] images tagged latest or not tagged: 0/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
