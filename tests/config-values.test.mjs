import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { diagnose, elsewhere, generatedFields, leafPaths, lookup, nearest, presetPaths, without } from '../lib/config-values.mjs';
import { pullReference } from '../lib/common.mjs';

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

    const refusedOut = join(work, 'refused-diagnosis.json');
    const refusedRender = join(work, 'refused-candidate.yaml');
    const refused = spawnSync(join(root, 'bin/cub-config'), ['values', chart, '--values', file, '--release', 'shop-redis', '--namespace', 'shop', '--json', '--out', refusedOut, '--render-out', refusedRender, '--exit-code'], { encoding: 'utf8' });
    assert.equal(refused.status, 1, 'a refused diagnosis is still retained');
    assert.equal(refused.stdout, readFileSync(refusedOut, 'utf8'), '--json remains a single parseable result');
    const refusedReport = JSON.parse(refused.stdout);
    assert.deepEqual(Object.keys(refusedReport).sort(), Object.keys(report).sort(), 'saving a candidate does not change the diagnosis shape');
    assert.equal(refusedReport.valuesFile.sha256, `sha256:${createHash('sha256').update(readFileSync(file)).digest('hex')}`, 'the diagnosis is bound to the bytes it read');
    assert.match(refusedReport.rendered.sha256, /^sha256:[a-f0-9]{64}$/);
    assert.equal(`sha256:${createHash('sha256').update(readFileSync(refusedRender)).digest('hex')}`, refusedReport.rendered.sha256, 'the retained first render has the hash named by the report, even when the chart generates a Secret');
    assert.deepEqual(refusedReport.chart, { reference: chart, version: null, repository: null, release: 'shop-redis', namespace: 'shop' });
    assert.equal(JSON.stringify(refusedReport).includes('hunter2'), false, 'the retained result excludes values');
    assert.equal(statSync(refusedOut).mode & 0o777, 0o600, 'the local result is private by default');
    assert.equal(statSync(refusedRender).mode & 0o777, 0o600, 'the candidate can contain Secrets and is private by default');

    const repaired = join(work, 'repaired.yaml');
    writeFileSync(repaired, 'replicaCount: 3\n');
    const acceptedOut = join(work, 'accepted-diagnosis.json');
    const accepted = spawnSync(join(root, 'bin/cub-config'), ['values', chart, '--values', repaired, '--out', acceptedOut, '--exit-code'], { encoding: 'utf8' });
    assert.equal(accepted.status, 0, accepted.stderr);
    assert.match(accepted.stdout, /Saved .*accepted-diagnosis\.json/);
    assert.equal(JSON.parse(readFileSync(acceptedOut, 'utf8')).summary.ignored, 0);

    const renderOnly = join(work, 'render-only.yaml');
    const rendered = spawnSync(join(root, 'bin/cub-config'), ['values', chart, '--values', repaired, '--render-out', renderOnly], { encoding: 'utf8' });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.ok(existsSync(renderOnly), '--render-out works without a retained diagnosis');

    const existing = spawnSync(join(root, 'bin/cub-config'), ['values', 'not-a-chart', '--values', file, '--out', refusedOut], { encoding: 'utf8' });
    assert.equal(existing.status, 2, 'an existing result path is refused before the chart is resolved');
    assert.match(existing.stderr, /EEXIST/);
    assert.equal(readFileSync(refusedOut, 'utf8'), refused.stdout, 'an earlier diagnosis is never overwritten');

    const existingRender = join(work, 'existing-candidate.yaml');
    writeFileSync(existingRender, 'keep\n');
    const existingCandidate = spawnSync(join(root, 'bin/cub-config'), ['values', 'not-a-chart', '--values', file, '--render-out', existingRender], { encoding: 'utf8' });
    assert.equal(existingCandidate.status, 2, 'an existing candidate path is refused before the chart is resolved');
    assert.match(existingCandidate.stderr, /EEXIST/);
    assert.equal(readFileSync(existingRender, 'utf8'), 'keep\n', 'an earlier candidate is never overwritten');

    const samePath = join(work, 'same-output');
    const same = spawnSync(join(root, 'bin/cub-config'), ['values', 'not-a-chart', '--values', file, '--out', samePath, '--render-out', samePath], { encoding: 'utf8' });
    assert.equal(same.status, 2);
    assert.match(same.stderr, /must name different files/);
    assert.equal(existsSync(samePath), false, 'matching output paths leave no reservation behind');

    const missingOut = spawnSync(join(root, 'bin/cub-config'), ['values', chart, '--values', file, '--out'], { encoding: 'utf8' });
    assert.equal(missingOut.status, 2);
    assert.match(missingOut.stderr, /--out requires a file path/);

    const missingRenderOut = spawnSync(join(root, 'bin/cub-config'), ['values', chart, '--values', file, '--render-out'], { encoding: 'utf8' });
    assert.equal(missingRenderOut.status, 2);
    assert.match(missingRenderOut.stderr, /--render-out requires a file path/);

    const malformed = join(work, 'malformed.yaml');
    const retryOut = join(work, 'retry-diagnosis.json');
    const retryRender = join(work, 'retry-candidate.yaml');
    writeFileSync(malformed, 'metrics: not-a-map\n');
    const failedRender = spawnSync(join(root, 'bin/cub-config'), ['values', chart, '--values', malformed, '--out', retryOut, '--render-out', retryRender], { encoding: 'utf8' });
    assert.equal(failedRender.status, 2, 'a Helm template error is an execution failure');
    assert.equal(existsSync(retryOut), false, 'a failed render leaves no empty result reservation');
    assert.equal(existsSync(retryRender), false, 'a failed render leaves no empty candidate reservation');
    const retry = spawnSync(join(root, 'bin/cub-config'), ['values', chart, '--values', repaired, '--out', retryOut], { encoding: 'utf8' });
    assert.equal(retry.status, 0, retry.stderr);
    assert.ok(existsSync(retryOut), 'the same path is available for a repaired retry');

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

test('an image name becomes the reference its own registry answers to', () => {
  const cases = [
    ['redis:8', 'docker.io/library/redis:8'],
    ['docker.io/redis:8', 'docker.io/library/redis:8'],
    ['bitnami/redis:latest', 'docker.io/bitnami/redis:latest'],
    ['registry-1.docker.io/bitnami/mysql:9.4.0-debian-12-r1', 'registry-1.docker.io/bitnami/mysql:9.4.0-debian-12-r1'],
    ['ghcr.io/team/app:1.2.3', 'ghcr.io/team/app:1.2.3'],
    ['localhost:5000/team/app:1', 'localhost:5000/team/app:1'],
    ['quay.io/jetstack/cert-manager-controller:v1.20.2', 'quay.io/jetstack/cert-manager-controller:v1.20.2'],
  ];
  for (const [image, reference] of cases) assert.equal(pullReference(image), reference, image);
});

test('check without --images makes no network call, and check rejects unknown options', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-flag-'));
  try {
    const file = join(dir, 'app.yaml');
    writeFileSync(file, JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'p', namespace: 'shop' }, spec: { containers: [{ name: 'c', image: 'ghcr.io/team/app:1.2.3' }] } }));
    const quiet = spawnSync(process.execPath, [join(root, 'bin/cub-config'), 'check', file], { encoding: 'utf8' });
    assert.equal(quiet.status, 0, quiet.stderr);
    assert.doesNotMatch(quiet.stdout, /images that pull anonymously/);
    assert.match(spawnSync(process.execPath, [join(root, 'bin/cub-config'), 'check', '--help'], { encoding: 'utf8' }).stdout, /\[--images\] \[--exit-code\]/);
    const unknown = spawnSync(process.execPath, [join(root, 'bin/cub-config'), 'check', file, '--imagess'], { encoding: 'utf8' });
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /unknown check option: --imagess/);
    const shortUnknown = spawnSync(process.execPath, [join(root, 'bin/cub-config'), 'check', file, '-i'], { encoding: 'utf8' });
    assert.equal(shortUnknown.status, 2);
    assert.match(shortUnknown.stderr, /unknown check option: -i/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('strict image checks fail only for confirmed missing images and refuse output when incomplete', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-images-exit-'));
  try {
    const file = join(dir, 'app.yaml');
    const bin = join(dir, 'bin');
    const output = join(dir, 'candidate.yaml');
    mkdirSync(bin, { recursive: true });
    writeFileSync(file, JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'p', namespace: 'shop' }, spec: { containers: [{ name: 'c', image: 'registry.example/team/app:1.2.3' }] } }));
    writeFileSync(join(bin, 'oras'), `#!/bin/sh
case "$CUB_TEST_ORAS_RESULT" in
  present) echo '{"digest":"sha256:${'2'.repeat(64)}"}' ;;
  missing) echo 'Error: manifest unknown' >&2; exit 1 ;;
  auth) echo 'Error: authentication required' >&2; exit 1 ;;
  mixed) case "$*" in *missing*) echo 'Error: manifest unknown' >&2 ;; *) echo 'Error: authentication required' >&2 ;; esac; exit 1 ;;
  *) echo 'Error: dial tcp: network unreachable' >&2; exit 1 ;;
esac
`, { mode: 0o755 });
    const run = (result, extra = []) => spawnSync(process.execPath, [join(root, 'bin/cub-config'), 'check', file, '--images', ...extra], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CUB_TEST_ORAS_RESULT: result },
    });

    assert.equal(run('present', ['--exit-code']).status, 0);
    const missing = run('missing', ['--exit-code', '--out', output]);
    assert.equal(missing.status, 1, missing.stderr);
    assert.match(missing.stdout, /\[FAIL\].*confirmed missing/);
    assert.equal(existsSync(output), false, 'a failed strict check must not write its render');

    const auth = run('auth', ['--exit-code']);
    assert.equal(auth.status, 2, auth.stderr);
    assert.match(auth.stdout, /\[INCOMPLETE\].*could not verify every image/);
    assert.doesNotMatch(auth.stdout, /confirmed missing/);

    const network = run('network', ['--exit-code']);
    assert.equal(network.status, 2, network.stderr);
    assert.match(network.stdout, /could not be checked: registry\.example\/team\/app:1\.2\.3/);

    assert.equal(run('missing').status, 0, 'without --exit-code the report remains advice');

    writeFileSync(file, [
      { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'missing', namespace: 'shop' }, spec: { containers: [{ name: 'c', image: 'registry.example/team/missing:1' }] } },
      { apiVersion: 'v1', kind: 'Pod', metadata: { name: 'auth', namespace: 'shop' }, spec: { containers: [{ name: 'c', image: 'registry.example/team/auth:1' }] } },
    ].map(JSON.stringify).join('\n---\n'));
    const mixed = run('mixed', ['--exit-code']);
    assert.equal(mixed.status, 1, mixed.stderr);
    assert.match(mixed.stdout, /NOT FOUND: registry\.example\/team\/missing:1/);
    assert.match(mixed.stdout, /needs credentials: registry\.example\/team\/auth:1/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the images check names what a tag resolves to, and says which images are pinned', () => {
  const dir = mkdtempSync(join(tmpdir(), 'check-digests-'));
  try {
    const pinned = 'ghcr.io/team/app@sha256:' + '1'.repeat(64);
    const file = join(dir, 'app.yaml');
    writeFileSync(file, JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'p', namespace: 'shop' }, spec: { containers: [{ name: 'c', image: pinned }] } }));
    // A fake oras on PATH answers like the real one, so the test needs no registry.
    const bin = join(dir, 'bin');
    writeFileSync(join(dir, 'oras'), '', { flag: 'w' });
    rmSync(join(dir, 'oras'));
    mkdirSync(bin, { recursive: true });
    writeFileSync(join(bin, 'oras'), `#!/bin/sh\necho '{"mediaType":"application/vnd.oci.image.index.v1+json","digest":"sha256:${'1'.repeat(64)}","size":42}'\n`, { mode: 0o755 });
    const run = spawnSync(process.execPath, [join(root, 'bin/cub-config'), 'check', file, '--images'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /images that pull anonymously: 1 of 1/);
    assert.match(run.stdout, /pinned\s+ghcr\.io\/team\/app@sha256:1{64}/);
    assert.doesNotMatch(run.stdout, /named by tag/, 'a pinned image is not reported as loose');

    writeFileSync(file, JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'p', namespace: 'shop' }, spec: { containers: [{ name: 'c', image: 'ghcr.io/team/app:1.2.3' }] } }));
    const loose = spawnSync(process.execPath, [join(root, 'bin/cub-config'), 'check', file, '--images'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.match(loose.stdout, /resolves ghcr\.io\/team\/app:1\.2\.3 -> sha256:1{64}/);
    assert.match(loose.stdout, /1 image is named by tag\. Pin with name@digest/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
