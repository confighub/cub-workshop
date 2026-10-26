import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateObjectSchemas, validateStackSchemas } from '../lib/schema-validation.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const bin = join(root, 'bin/cub-stack');

// A fake flux answers like `flux schema validate -o json`: it records its
// arguments and stdin, then prints the stdout, stderr and exit code the test
// chose. The report shape is the documented schema.plugin.fluxcd.io/v1beta1 one.
function fixture({ stdout = '', stderr = '', exit = 0 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'stack-schema-'));
  const fakeBin = join(dir, 'bin');
  mkdirSync(fakeBin);
  writeFileSync(join(dir, 'stdout'), stdout);
  writeFileSync(join(dir, 'stderr'), stderr);
  writeFileSync(join(fakeBin, 'flux'), [
    '#!/bin/sh', 'echo "$@" > "$FAKE_FLUX_DIR/args"', 'cat > "$FAKE_FLUX_DIR/stdin"',
    'cat "$FAKE_FLUX_DIR/stdout"', 'cat "$FAKE_FLUX_DIR/stderr" >&2', `exit ${exit}`, '',
  ].join('\n'));
  chmodSync(join(fakeBin, 'flux'), 0o755);
  const env = { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin`, FAKE_FLUX_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', timeout: 30000, env });
  return { dir, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const report = (results) => JSON.stringify({
  apiVersion: 'schema.plugin.fluxcd.io/v1beta1', kind: 'Report',
  $schema: 'https://raw.githubusercontent.com/fluxcd/flux-schema/main/docs/report-v1beta1.json',
  report: { reporter: 'flux-schema/v0.14.0', timestamp: '2026-09-29T12:00:00Z',
    summary: { total: results.length, valid: results.filter(r => r.status === 'valid').length,
      invalid: results.filter(r => r.status === 'invalid').length, skipped: results.filter(r => r.status === 'skipped').length },
    results },
});
const resource = (name) => ({ apiVersion: 'v1', kind: 'ConfigMap', namespace: 'web', name });
const schemaLine = (stdout) => stdout.split('\n').find(line => line.includes('schema validation'));

test('a clean report passes with the plugin version, and flux is given every object on stdin', () => {
  const f = fixture({ stdout: report([
    { resource: resource('frontend-config'), source: 'stdin', idx: 1, status: 'valid' },
    { resource: resource('backend-config'), source: 'stdin', idx: 2, status: 'valid' },
  ]) });
  try {
    const human = f.run('check', 'web-tiny');
    assert.equal(human.status, 0, human.stderr);
    assert.match(schemaLine(human.stdout), /^ {2}\[PASS\] schema validation: 2 object\(s\) valid against the default and ecosystem catalogs \(flux-schema\/v0\.14\.0\)$/);
    assert.match(human.stdout, /=> CHECKED/);
    assert.equal(readFileSync(join(f.dir, 'args'), 'utf8').trim(), 'schema validate -s default -s ecosystem --skip-missing-schemas -o json');
    const stdin = readFileSync(join(f.dir, 'stdin'), 'utf8');
    assert.match(stdin, /name: frontend-config/);
    assert.match(stdin, /name: backend-config/);
    const body = JSON.parse(f.run('check', 'web-tiny', '--json').stdout);
    assert.equal(body.checked, true);
    assert.equal(body.schemaValidation.status, 'passed');
    assert.equal(body.schemaValidation.reporter, 'flux-schema/v0.14.0');
    assert.deepEqual(body.schemaValidation.summary, { total: 2, valid: 2, invalid: 0, skipped: 0 });
    assert.ok(body.checks.some(check => check.result === 'PASS' && check.text.startsWith('schema validation:')));
  } finally { f.cleanup(); }
});

test('violations fail the check and the sandbox, naming each object and JSON path', () => {
  const f = fixture({ exit: 1, stdout: report([
    { resource: resource('frontend-config'), source: 'stdin', idx: 1, status: 'valid' },
    { resource: resource('backend-config'), source: 'stdin', idx: 2, status: 'invalid', reason: 'schema-violation', violations: [
      { path: '/data/replicas', message: 'got number, want string' },
      { path: '/spec', message: "additional properties 'spec' not allowed" },
    ] },
  ]) });
  try {
    const human = f.run('check', 'web-tiny');
    assert.equal(human.status, 1);
    assert.match(human.stdout, /\[FAIL\] schema validation: 2 violation\(s\) in 1 object\(s\) against the default and ecosystem catalogs \(flux-schema\/v0\.14\.0\); fix the fields in their component and check again:/);
    assert.match(human.stdout, /^ {6}ConfigMap\/web\/backend-config {2}\/data\/replicas: got number, want string$/m);
    assert.match(human.stdout, /^ {6}ConfigMap\/web\/backend-config {2}\/spec: additional properties 'spec' not allowed$/m);
    assert.match(human.stdout, /=> REFUSED/);
    const json = f.run('check', 'web-tiny', '--json');
    assert.equal(json.status, 1);
    const body = JSON.parse(json.stdout);
    assert.equal(body.checked, false);
    assert.equal(body.schemaValidation.status, 'failed');
    assert.deepEqual(body.schemaValidation.violations.map(v => [v.object, v.path]), [['ConfigMap/web/backend-config', '/data/replicas'], ['ConfigMap/web/backend-config', '/spec']]);
    const sandbox = f.run('sandbox', 'web-tiny', '--out', join(f.dir, 'rendered.yaml'));
    assert.equal(sandbox.status, 1);
    assert.match(sandbox.stdout, /Not rendered: fix what failed above/);
  } finally { f.cleanup(); }
});

test('an unreachable catalog is a NOTE and leaves the verdict alone', () => {
  const unreachable = { status: 'invalid', reason: 'schema-load-error', source: 'stdin', violations: [
    { message: 'Get "https://schemas.fluxoperator.dev/catalog/v1/ConfigMap_v1.json": dial tcp: lookup schemas.fluxoperator.dev: no such host' },
  ] };
  const f = fixture({ exit: 1, stdout: report([{ ...unreachable, resource: resource('frontend-config'), idx: 1 }, { ...unreachable, resource: resource('backend-config'), idx: 2 }]) });
  try {
    const human = f.run('check', 'web-tiny');
    assert.equal(human.status, 0, human.stdout);
    assert.match(schemaLine(human.stdout), /\[NOTE\] schema validation: the schema catalog could not be reached for 2 of 2 object\(s\); no violations in the rest; run again with network access/);
    assert.match(human.stdout, /=> CHECKED/);
    const body = JSON.parse(f.run('check', 'web-tiny', '--json').stdout);
    assert.equal(body.checked, true);
    assert.equal(body.schemaValidation.status, 'unreachable');
    assert.equal(body.schemaValidation.unchecked.length, 2);
  } finally { f.cleanup(); }
});

test('a crash without a report is a WARN carrying the last stderr line, and the stack still checks', () => {
  const f = fixture({ exit: 2, stderr: 'panic: runtime error: invalid memory address\n\ngoroutine 1 [running]:\nmain.main() validate.go:42\n' });
  try {
    const human = f.run('check', 'web-tiny');
    assert.equal(human.status, 0, human.stdout);
    assert.match(schemaLine(human.stdout), /\[WARN\] schema validation did not complete: flux schema validate exited 2 without a report: main\.main\(\) validate\.go:42; the verdict does not include it/);
    const body = JSON.parse(f.run('check', 'web-tiny', '--json').stdout);
    assert.equal(body.checked, true);
    assert.equal(body.schemaValidation.status, 'errored');
  } finally { f.cleanup(); }
});

test('a flux without the schema plugin is a WARN whose next step installs it', () => {
  const f = fixture({ exit: 1, stderr: '✗ unknown command "schema" for "flux"\n' });
  try {
    const human = f.run('check', 'web-tiny');
    assert.equal(human.status, 0);
    assert.match(schemaLine(human.stdout), /\[WARN\] schema validation not run: the flux schema plugin is not installed; next: `flux plugin install schema`/);
  } finally { f.cleanup(); }
});

test('without flux on PATH the check gains one WARN and keeps its verdict and exit code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stack-schema-none-'));
  try {
    const env = { ...process.env, PATH: dir };
    const run = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: root, encoding: 'utf8', timeout: 30000, env });
    const human = run('check', 'web-tiny');
    assert.equal(human.status, 0);
    assert.deepEqual(human.stdout.split('\n').filter(line => line.includes('schema validation')),
      ['  [WARN] schema validation not run: flux is not on PATH; install the Flux CLI, then `flux plugin install schema`']);
    const body = JSON.parse(run('check', 'web-tiny', '--json').stdout);
    assert.equal(body.checked, true);
    assert.equal(body.schemaValidation.status, 'unavailable');
    assert.equal(body.schemaValidation.next, 'flux plugin install schema');
    const refused = run('check', 'conflict-demo');
    assert.equal(refused.status, 1, 'a refused stack stays refused');
    const workspace = join(dir, 'workspace');
    assert.equal(run('sandbox', 'web-tiny', '--workspace', workspace).status, 0);
    assert.equal(JSON.parse(readFileSync(join(workspace, 'result.json'), 'utf8')).schemaValidation.status, 'unavailable');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the Kubernetes version a receipt rendered for is named beside a pass, and hub objects are not sent', () => {
  const seen = [];
  const run = (command, args, options) => {
    seen.push(options.input);
    return { status: 0, stdout: report([{ resource: resource('app'), status: 'valid' }]), stderr: '' };
  };
  const stack = { path: join(root, 'stacks/web-tiny.yaml'), components: [
    { name: 'traefik', receipt: 'receipts/catalog/traefik-traefik-41.0.2-default.yaml', objects: [{ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'app', namespace: 'web' } }] },
    { name: 'hub', plane: 'hub', objects: [{ apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'held', namespace: 'hub' } }] },
  ] };
  const { findings, record } = validateStackSchemas(stack, { run });
  assert.deepEqual(record.targetVersions, { kubernetes: ['1.30.0'] });
  assert.match(findings[0][1], /; receipts render for Kubernetes 1\.30\.0, the catalogs hold the latest stable APIs$/);
  assert.doesNotMatch(seen[0], /held/);
});

// Only a number at a Quantity field of a built-in kind is accepted. The same
// path in a custom resource, a string reported as wrong there, or a result that
// does not match the object it counts as all still fail.
test('a numeric quantity is accepted only for the built-in kind and object the result names', () => {
  const pod = (apiVersion, kind, value) => ({ apiVersion, kind, metadata: { name: 'w', namespace: 'web' },
    spec: { containers: [{ name: 'c', image: 'nginx', resources: { limits: { cpu: value } } }] } });
  const path = '/spec/containers/0/resources/limits/cpu';
  const check = (object, { name = 'w', message = 'got number, want string' } = {}) => validateObjectSchemas([object], {
    run: () => ({ status: 1, stdout: report([{ resource: { apiVersion: object.apiVersion, kind: object.kind, namespace: 'web', name }, source: 'stdin', idx: 1,
      status: 'invalid', reason: 'schema-violation', violations: [{ path, message }] }]) }),
  }).record;

  const accepted = check(pod('v1', 'Pod', 1));
  assert.equal(accepted.status, 'passed');
  assert.deepEqual(accepted.numericQuantities, [{ object: 'Pod/web/w', path, value: 1 }]);
  assert.deepEqual(accepted.summary, { total: 1, valid: 1, invalid: 0, skipped: 0 });
  assert.equal(check(pod('example.com/v1', 'Widget', 1)).status, 'failed');
  assert.equal(check(pod('v1', 'Pod', '1')).status, 'failed');
  assert.equal(check(pod('v1', 'Pod', 1), { name: 'other' }).status, 'failed');
  assert.equal(check(pod('v1', 'Pod', 1), { message: 'got number, want integer' }).status, 'failed');
});

// A null in a custom resource is accepted only where the API server prunes it.
// Each case below was applied with `kubectl apply --dry-run=server` to a kind
// cluster (Kubernetes 1.33.1) holding CRDs that declare these fields: the
// nulls in withDefault, plain, count, nested, nested.a, a map value and a
// required field with a default were dropped and the object stored, while a
// null array item (list[1]: must be of type string) and a null in a required
// field with no default (must: Required value) were refused. The violations
// are what flux-schema 0.16.0 printed for the same object against this CRD.
test('a null in a custom resource is accepted only where its CRD shows the API server prunes it', () => {
  const crd = { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: 'widgets.example.com' },
    spec: { group: 'example.com', scope: 'Namespaced', names: { kind: 'Widget', plural: 'widgets' }, versions: [{ name: 'v1', served: true, storage: true,
      schema: { openAPIV3Schema: { type: 'object', properties: { spec: { type: 'object', required: ['must', 'mustWithDefault'], properties: {
        withDefault: { type: 'string', default: 'fallback' }, plain: { type: 'string' }, count: { type: 'integer' },
        nested: { type: 'object', properties: { a: { type: 'string' } } }, labels: { type: 'object', additionalProperties: { type: 'string' } },
        list: { type: 'array', items: { type: 'string' } }, must: { type: 'string' }, mustWithDefault: { type: 'string', default: 'd' },
      } } } } } }] } };
  const widget = (spec, apiVersion = 'example.com/v1') => ({ apiVersion, kind: 'Widget', metadata: { name: 'w', namespace: 'default' }, spec });
  const check = (object, violations, objects = [crd, object]) => validateObjectSchemas(objects, {
    run: () => ({ status: 1, stdout: report([
      ...objects.filter(o => o !== object).map((o, i) => ({ resource: { apiVersion: o.apiVersion, kind: o.kind, name: o.metadata.name }, source: 'stdin', idx: i + 1, status: 'valid' })),
      { resource: { apiVersion: object.apiVersion, kind: 'Widget', namespace: 'default', name: 'w' }, source: 'stdin', idx: objects.indexOf(object) + 1,
        status: 'invalid', reason: 'schema-violation', violations },
    ]) }),
  }).record;
  const got = (path, want = 'string') => ({ path, message: `got null, want ${want}` });

  const mixed = check(widget({ must: null, withDefault: null, nested: { a: null }, list: ['a', null], count: 'x' }), [
    got('/spec/list/1'), got('/spec/must'), got('/spec/nested/a'), got('/spec/withDefault'), { path: '/spec/count', message: 'got string, want integer' },
  ]);
  assert.equal(mixed.status, 'failed');
  assert.deepEqual(mixed.violations.map(v => v.path), ['/spec/list/1', '/spec/must', '/spec/count']);
  assert.deepEqual(mixed.prunedNulls, [
    { object: 'Widget/default/w', path: '/spec/nested/a', message: 'got null, want string' },
    { object: 'Widget/default/w', path: '/spec/withDefault', message: 'got null, want string' },
  ]);

  const clean = check(widget({ must: 'x', plain: null, mustWithDefault: null, count: null, nested: null, labels: { k1: null, k2: 'z' } }), [
    got('/spec/plain'), got('/spec/mustWithDefault'), got('/spec/count', 'integer'), got('/spec/nested', 'object'), got('/spec/labels/k1'),
  ]);
  assert.equal(clean.status, 'passed');
  assert.equal(clean.prunedNulls.length, 5);
  assert.deepEqual(clean.summary, { total: 2, valid: 2, invalid: 0, skipped: 0 });

  // Without its CRD, with a value that is not null, or in a built-in group
  // even when a CRD claims it, the null still fails.
  const plain = widget({ must: 'x', plain: null });
  assert.equal(check(plain, [got('/spec/plain')], [plain]).status, 'failed');
  assert.equal(check(widget({ must: 'x', plain: 'set' }), [got('/spec/plain')]).status, 'failed');
  const apps = { ...crd, spec: { ...crd.spec, group: 'apps' } };
  const builtIn = widget({ must: 'x', plain: null }, 'apps/v1');
  assert.equal(check(builtIn, [got('/spec/plain')], [apps, builtIn]).status, 'failed');
});

// A "validation failed" line goes only when every violation under it went.
test('a validation failed line above an accepted null goes only when nothing else failed under it', () => {
  const crd = { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: 'clusterpolicies.nvidia.com' },
    spec: { group: 'nvidia.com', names: { kind: 'ClusterPolicy' }, versions: [{ name: 'v1', schema: { openAPIV3Schema: { type: 'object', properties: { spec: { type: 'object', properties: {
      migManager: { type: 'object', properties: { enabled: { type: 'boolean' }, config: { type: 'object', properties: { name: { type: 'string', default: 'default-mig-parted-config' } } } } },
    } } } } } }] } };
  const policy = { apiVersion: 'nvidia.com/v1', kind: 'ClusterPolicy', metadata: { name: 'cluster-policy' }, spec: { migManager: { enabled: 'yes', config: { name: null } } } };
  const check = (violations) => validateObjectSchemas([crd, policy], {
    run: () => ({ status: 1, stdout: report([
      { resource: { apiVersion: crd.apiVersion, kind: crd.kind, name: crd.metadata.name }, source: 'stdin', idx: 1, status: 'valid' },
      { resource: { apiVersion: policy.apiVersion, kind: policy.kind, name: 'cluster-policy' }, source: 'stdin', idx: 2, status: 'invalid', reason: 'schema-violation', violations },
    ]) }),
  }).record;
  const parent = { path: '/spec/migManager', message: 'validation failed' };
  const name = { path: '/spec/migManager/config/name', message: 'got null, want string' };
  assert.equal(check([parent, name]).status, 'passed');
  const kept = check([parent, name, { path: '/spec/migManager/enabled', message: 'got string, want boolean' }]);
  assert.equal(kept.status, 'failed');
  assert.deepEqual(kept.violations.map(v => `${v.path}: ${v.message}`), ['/spec/migManager: validation failed', '/spec/migManager/enabled: got string, want boolean']);
});

// The API server validates the object after it prunes the nulls, so a null
// whose removal breaks a rule above it is refused. On the kind cluster, with
// this CRD, gen: {a: null} was refused (spec.gen should have at least 1
// properties), cel: {x: null, y: z} was refused by the CEL rule on spec, and
// one: {p: null} by the oneOf; gen: {a: null, b: z} was stored as gen: {b: z}.
// flux-schema 0.16.0 printed only the null for each.
test('a null stays a violation where pruning it could break a rule above it', () => {
  const crd = { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', metadata: { name: 'probes.example.com' },
    spec: { group: 'example.com', names: { kind: 'Probe' }, versions: [{ name: 'v1', schema: { openAPIV3Schema: { type: 'object', properties: { spec: { type: 'object',
      properties: {
        gen: { type: 'object', minProperties: 1, properties: { a: { type: 'object' }, b: { type: 'string' } } },
        one: { type: 'object', oneOf: [{ required: ['p'] }, { required: ['q'] }], properties: { p: { type: 'string' }, q: { type: 'string' } } },
      } } } } } }] } };
  const withCel = { ...crd, spec: { ...crd.spec, versions: [{ name: 'v1', schema: { openAPIV3Schema: { type: 'object', properties: { spec: { type: 'object',
    'x-kubernetes-validations': [{ rule: '!has(self.cel) || has(self.cel.x)' }],
    properties: { cel: { type: 'object', properties: { x: { type: 'string' }, y: { type: 'string' } } } } } } } } }] } };
  const check = (definition, spec, path, want = 'string') => {
    const probe = { apiVersion: 'example.com/v1', kind: 'Probe', metadata: { name: 'p', namespace: 'default' }, spec };
    return validateObjectSchemas([definition, probe], {
      run: () => ({ status: 1, stdout: report([
        { resource: { apiVersion: definition.apiVersion, kind: definition.kind, name: definition.metadata.name }, source: 'stdin', idx: 1, status: 'valid' },
        { resource: { apiVersion: probe.apiVersion, kind: 'Probe', namespace: 'default', name: 'p' }, source: 'stdin', idx: 2, status: 'invalid', reason: 'schema-violation',
          violations: [{ path, message: `got null, want ${want}` }] },
      ]) }),
    }).record.status;
  };
  assert.equal(check(crd, { gen: { a: null } }, '/spec/gen/a', 'object'), 'failed');
  assert.equal(check(crd, { gen: { a: null, b: 'z' } }, '/spec/gen/a', 'object'), 'passed');
  assert.equal(check(crd, { one: { p: null } }, '/spec/one/p'), 'failed');
  assert.equal(check(withCel, { cel: { x: null, y: 'z' } }, '/spec/cel/x'), 'failed');
});
