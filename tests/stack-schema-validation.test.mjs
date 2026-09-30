import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateStackSchemas } from '../lib/schema-validation.mjs';

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
