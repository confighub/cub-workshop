import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const bin = join(root, 'bin/cub-config');

// The Deployment carries two of the three mistakes the check was added for:
// a quoted replica count and a misspelt field. The third, a selector that does
// not match the pod labels, has its own test at the end.
const deployment = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
spec:
  replicas: "two"
  selector:
    matchLabels: {app: web}
  template:
    metadata:
      labels: {app: web}
    spec:
      containers:
        - name: web
          imagee: nginx:1.27
`;

// A fake flux answers like `flux schema validate -o json`, as in the stack
// check's tests. With `flux: false` there is no flux on PATH at all.
function fixture({ stdout = '', stderr = '', exit = 0, flux = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'config-schema-'));
  const fakeBin = join(dir, 'bin');
  mkdirSync(fakeBin);
  writeFileSync(join(dir, 'stdout'), stdout);
  writeFileSync(join(dir, 'stderr'), stderr);
  writeFileSync(join(dir, 'web.yaml'), deployment);
  if (flux) {
    writeFileSync(join(fakeBin, 'flux'), [
      '#!/bin/sh', 'echo "$@" > "$FAKE_FLUX_DIR/args"', 'cat > "$FAKE_FLUX_DIR/stdin"',
      'cat "$FAKE_FLUX_DIR/stdout"', 'cat "$FAKE_FLUX_DIR/stderr" >&2', `exit ${exit}`, '',
    ].join('\n'));
    chmodSync(join(fakeBin, 'flux'), 0o755);
  }
  const env = { ...process.env, PATH: `${fakeBin}:/usr/bin:/bin`, FAKE_FLUX_DIR: dir };
  const run = (...args) => spawnSync(process.execPath, [bin, ...args], { cwd: dir, encoding: 'utf8', timeout: 30000, env });
  return { dir, run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const report = (results) => JSON.stringify({
  apiVersion: 'schema.plugin.fluxcd.io/v1beta1', kind: 'Report',
  report: { reporter: 'flux-schema/v0.14.0', timestamp: '2026-10-19T12:00:00Z',
    summary: { total: results.length, valid: results.filter(r => r.status === 'valid').length,
      invalid: results.filter(r => r.status === 'invalid').length, skipped: results.filter(r => r.status === 'skipped').length },
    results },
});
const web = { apiVersion: 'apps/v1', kind: 'Deployment', namespace: 'default', name: 'web' };
const schemaLines = (stdout) => stdout.split('\n').filter(line => line.includes('schema validation') || /^ {9}\S/.test(line));

test('a clean report passes, and flux is given the file\'s objects on stdin', () => {
  const f = fixture({ stdout: report([{ resource: web, source: 'stdin', idx: 1, status: 'valid' }]) });
  try {
    const run = f.run('check', 'web.yaml');
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /\nSchema\n {2}\[PASS\] schema validation: 1 object\(s\) valid against the default and ecosystem catalogs \(flux-schema\/v0\.14\.0\)/);
    assert.equal(readFileSync(join(f.dir, 'args'), 'utf8').trim(), 'schema validate -s default -s ecosystem --skip-missing-schemas -o json');
    assert.match(readFileSync(join(f.dir, 'stdin'), 'utf8'), /imagee: nginx:1\.27/);
  } finally { f.cleanup(); }
});

test('a violation fails the check with exit 1, names each field, and writes nothing', () => {
  const f = fixture({ stdout: report([{ resource: web, source: 'stdin', idx: 1, status: 'invalid', reason: 'schema-violation', violations: [
    { path: '/spec/replicas', message: 'got string, want integer' },
    { path: '/spec/template/spec/containers/0', message: "additional properties 'imagee' not allowed" },
    { message: 'selector does not match template labels' },
  ] }]) });
  try {
    const run = f.run('check', 'web.yaml', '--out', 'copy.yaml');
    assert.equal(run.status, 1, run.stdout);
    const lines = schemaLines(run.stdout);
    assert.match(lines[0], /\[FAIL\] schema validation: 3 violation\(s\) in 1 object\(s\) .*; fix these fields and check again:$/);
    assert.ok(lines.some(line => line.includes('Deployment/default/web  /spec/replicas: got string, want integer')));
    assert.ok(lines.some(line => line.includes("additional properties 'imagee' not allowed")));
    assert.ok(lines.some(line => line.includes('(document): selector does not match template labels')));
    assert.match(run.stdout, /\[FAIL\] one or more objects do not match their Kubernetes schema; no output was written\./);
    assert.equal(existsSync(join(f.dir, 'copy.yaml')), false);
  } finally { f.cleanup(); }
});

test('with no flux on PATH the check says how to install it and still passes', () => {
  const f = fixture({ flux: false });
  try {
    const run = f.run('check', 'web.yaml');
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /\[WARN\] schema validation not run: flux is not on PATH; install the Flux CLI, then `flux plugin install schema`/);
  } finally { f.cleanup(); }
});

test('an older flux without the schema plugin is reported, not failed', () => {
  const f = fixture({ stderr: 'Error: unknown command "schema" for "flux"\n', exit: 1 });
  try {
    const run = f.run('check', 'web.yaml');
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /\[WARN\] schema validation not run: the flux schema plugin is not installed/);
  } finally { f.cleanup(); }
});

test('--no-schema skips the step and never runs flux', () => {
  const f = fixture({ stdout: report([]) });
  try {
    const run = f.run('check', 'web.yaml', '--no-schema');
    assert.equal(run.status, 0, run.stderr);
    assert.match(run.stdout, /\[NOTE\] schema validation skipped \(--no-schema\)/);
    assert.equal(existsSync(join(f.dir, 'args')), false);
    const twice = f.run('check', 'web.yaml', '--no-schema', '--no-schema');
    assert.equal(twice.status, 2);
    assert.match(twice.stderr, /--no-schema may be specified only once/);
  } finally { f.cleanup(); }
});

test('a selector that does not match the pod labels is refused before the schema step', () => {
  const f = fixture({ stdout: report([]) });
  try {
    writeFileSync(join(f.dir, 'web.yaml'), deployment.replace('labels: {app: web}', 'labels: {app: other}'));
    const run = f.run('check', 'web.yaml');
    assert.equal(run.status, 1, run.stdout);
    assert.match(run.stdout, /\[INVALID\] Deployment web, spec\.selector\.matchLabels: the pod template's labels do not carry app=web, so the API server will refuse it/);
    assert.equal(existsSync(join(f.dir, 'args')), false);
  } finally { f.cleanup(); }
});

// The default catalog types resource.Quantity as a string, but the API server
// takes a number there too, and charts write one: gatekeeper 3.22.2 renders a
// ResourceQuota with `pods: 100`. The reports below are what flux-schema 0.16.0
// printed for these objects, and a kind cluster accepted each object with
// `kubectl apply --dry-run=server` except the one in the second test.
const quantities = `apiVersion: v1
kind: ResourceQuota
metadata:
  name: gatekeeper-critical-pods
  namespace: gatekeeper-system
spec:
  hard:
    pods: 100
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: web
  namespace: default
spec:
  replicas: 1
  selector:
    matchLabels: {app: web}
  template:
    metadata:
      labels: {app: web}
    spec:
      containers:
        - name: web
          image: nginx:1.27
          resources:
            limits: {cpu: 1, memory: 128Mi, nvidia.com/gpu: 1}
            requests: {cpu: 0.5}
      volumes:
        - name: scratch
          emptyDir: {sizeLimit: 1073741824}
`;
const quota = { apiVersion: 'v1', kind: 'ResourceQuota', namespace: 'gatekeeper-system', name: 'gatekeeper-critical-pods' };
const numberForString = (path, nullable = false) => ({ path, message: `got number, want ${nullable ? 'null or ' : ''}string` });

test('a quantity written as a number passes, as the API server accepts it', () => {
  const f = fixture({ stdout: report([
    { resource: quota, source: 'stdin', idx: 1, status: 'invalid', reason: 'schema-violation', violations: [numberForString('/spec/hard/pods')] },
    { resource: web, source: 'stdin', idx: 2, status: 'invalid', reason: 'schema-violation', violations: [
      { path: '/spec/template/spec/containers/0/resources', message: 'validation failed' },
      numberForString('/spec/template/spec/containers/0/resources/limits/cpu'),
      numberForString('/spec/template/spec/containers/0/resources/limits/nvidia.com~1gpu'),
      numberForString('/spec/template/spec/containers/0/resources/requests/cpu'),
      numberForString('/spec/template/spec/volumes/0/emptyDir/sizeLimit', true),
    ] },
  ]) });
  try {
    writeFileSync(join(f.dir, 'web.yaml'), quantities);
    const run = f.run('check', 'web.yaml', '--out', 'copy.yaml');
    assert.equal(run.status, 0, run.stdout);
    assert.match(run.stdout, /\[PASS\] schema validation: 2 object\(s\) valid against the default and ecosystem catalogs \(flux-schema\/v0\.14\.0\); 5 quantities written as a number, which the API server accepts/);
    assert.equal(existsSync(join(f.dir, 'copy.yaml')), true);
  } finally { f.cleanup(); }
});

test('a number where the API server wants a string still fails beside an accepted quantity', () => {
  // replicas: "two" and imagee as in the first Deployment, plus an env value
  // and a label written as numbers, which the API server refuses.
  const mixed = deployment
    .replace('labels: {app: web}', 'labels: {app: web, tier: 1}')
    .replace('imagee: nginx:1.27', 'imagee: nginx:1.27\n          env: [{name: PORT, value: 8080}]\n          resources: {requests: {cpu: 1}, limits: {cpu: 2}}');
  const f = fixture({ stdout: report([{ resource: web, source: 'stdin', idx: 1, status: 'invalid', reason: 'schema-violation', violations: [
    { path: '/spec/replicas', message: 'got string, want null or integer' },
    { path: '/spec/template', message: 'validation failed' },
    { path: '/spec/template/spec', message: 'validation failed' },
    { path: '/spec/template/spec/containers/0', message: 'validation failed' },
    numberForString('/spec/template/spec/containers/0/env/0/value', true),
    { path: '/spec/template/spec/containers/0/resources', message: 'validation failed' },
    numberForString('/spec/template/spec/containers/0/resources/limits/cpu'),
    numberForString('/spec/template/spec/containers/0/resources/requests/cpu'),
    { path: '/spec/template/spec/containers/0', message: "additional properties 'imagee' not allowed" },
    numberForString('/spec/template/metadata/labels/tier'),
  ] }]) });
  try {
    writeFileSync(join(f.dir, 'web.yaml'), mixed);
    const run = f.run('check', 'web.yaml', '--out', 'copy.yaml');
    assert.equal(run.status, 1, run.stdout);
    const lines = schemaLines(run.stdout);
    assert.match(lines[0], /\[FAIL\] schema validation: 7 violation\(s\) in 1 object\(s\)/);
    for (const kept of ['/spec/replicas: got string', '/env/0/value: got number, want null or string', "additional properties 'imagee' not allowed",
      '/metadata/labels/tier: got number, want string', '/spec/template/spec/containers/0: validation failed']) {
      assert.ok(lines.some(line => line.includes(kept)), kept);
    }
    assert.ok(!lines.some(line => line.includes('/resources')), lines.join('\n'));
    assert.equal(existsSync(join(f.dir, 'copy.yaml')), false);
  } finally { f.cleanup(); }
});

// gpu-operator v25.10.1 renders its ClusterPolicy with `migManager.config.name:
// null`, and its CRD types that field as a string with a default, not
// nullable. The API server prunes the null before defaulting: on a kind
// cluster (Kubernetes 1.33.1) with this CRD, `kubectl apply --dry-run=server`
// accepted the ClusterPolicy and stored name: default-mig-parted-config, and
// refused `name: 7`. The CRD below keeps the chart's schema for that field;
// the violation is what flux-schema 0.16.0 printed for the rendered object.
const clusterPolicyCrd = `apiVersion: apiextensions.k8s.io/v1
kind: CustomResourceDefinition
metadata:
  name: clusterpolicies.nvidia.com
spec:
  group: nvidia.com
  scope: Cluster
  names: {kind: ClusterPolicy, listKind: ClusterPolicyList, plural: clusterpolicies, singular: clusterpolicy}
  versions:
    - name: v1
      served: true
      storage: true
      schema:
        openAPIV3Schema:
          type: object
          properties:
            spec:
              type: object
              properties:
                migManager:
                  type: object
                  properties:
                    enabled: {type: boolean}
                    config:
                      type: object
                      properties:
                        default: {type: string, default: all-disabled, enum: [all-disabled, ""]}
                        name: {type: string, default: default-mig-parted-config}
`;
const clusterPolicy = `apiVersion: nvidia.com/v1
kind: ClusterPolicy
metadata:
  name: cluster-policy
spec:
  migManager:
    enabled: true
    config:
      name:
      default: "all-disabled"
`;
const policy = { apiVersion: 'nvidia.com/v1', kind: 'ClusterPolicy', name: 'cluster-policy' };
const crdResource = { apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition', name: 'clusterpolicies.nvidia.com' };
const migName = { path: '/spec/migManager/config/name', message: 'got null, want string' };

test('a null the API server prunes from a custom resource field passes when its CRD is checked too', () => {
  const f = fixture({ stdout: report([
    { resource: crdResource, source: 'stdin', idx: 1, status: 'valid' },
    { resource: policy, source: 'stdin', idx: 2, status: 'invalid', reason: 'schema-violation', violations: [migName] },
  ]) });
  try {
    writeFileSync(join(f.dir, 'gpu.yaml'), `${clusterPolicyCrd}---\n${clusterPolicy}`);
    const run = f.run('check', 'gpu.yaml', '--out', 'copy.yaml');
    assert.equal(run.status, 0, run.stdout);
    assert.match(run.stdout, /\[PASS\] schema validation: 2 object\(s\) valid against the default and ecosystem catalogs \(flux-schema\/v0\.14\.0\); 1 null in a custom resource field, which the API server drops before defaulting/);
    assert.equal(existsSync(join(f.dir, 'copy.yaml')), true);
  } finally { f.cleanup(); }
});

test('the same null fails when the CRD is not among the checked objects', () => {
  const f = fixture({ stdout: report([{ resource: policy, source: 'stdin', idx: 1, status: 'invalid', reason: 'schema-violation', violations: [migName] }]) });
  try {
    writeFileSync(join(f.dir, 'gpu.yaml'), clusterPolicy);
    const run = f.run('check', 'gpu.yaml', '--out', 'copy.yaml');
    assert.equal(run.status, 1, run.stdout);
    assert.ok(schemaLines(run.stdout).some(line => line.includes('ClusterPolicy/cluster-policy  /spec/migManager/config/name: got null, want string')), run.stdout);
    assert.equal(existsSync(join(f.dir, 'copy.yaml')), false);
  } finally { f.cleanup(); }
});

test('a null in a built-in kind still fails, as the API server refuses it', () => {
  // flux-schema 0.16.0 printed this violation for a container named null, and
  // the kind cluster refused it: containers[0].name: Required value.
  const f = fixture({ stdout: report([{ resource: web, source: 'stdin', idx: 1, status: 'invalid', reason: 'schema-violation',
    violations: [{ path: '/spec/template/spec/containers/0/name', message: 'got null, want string' }] }]) });
  try {
    writeFileSync(join(f.dir, 'web.yaml'), deployment.replace('replicas: "two"', 'replicas: 1').replace('- name: web\n          imagee: nginx:1.27', '- name: null\n          image: nginx:1.27'));
    const run = f.run('check', 'web.yaml', '--out', 'copy.yaml');
    assert.equal(run.status, 1, run.stdout);
    const lines = schemaLines(run.stdout);
    assert.match(lines[0], /\[FAIL\] schema validation: 1 violation\(s\) in 1 object\(s\)/);
    assert.ok(lines.some(line => line.includes('Deployment/default/web  /spec/template/spec/containers/0/name: got null, want string')), lines.join('\n'));
  } finally { f.cleanup(); }
});
