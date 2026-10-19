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
