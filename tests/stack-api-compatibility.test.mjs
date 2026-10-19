import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { checkStackApiVersions } from '../lib/stack-api-compatibility.mjs';

const crd = {
  apiVersion: 'apiextensions.k8s.io/v1', kind: 'CustomResourceDefinition',
  metadata: { name: 'widgets.example.com' },
  spec: { group: 'example.com', names: { kind: 'Widget' }, versions: [
    { name: 'v1', served: true, storage: true },
    { name: 'v1beta1', served: false, storage: false },
  ] },
};
const cr = { apiVersion: 'example.com/v1beta1', kind: 'Widget', metadata: { name: 'demo' } };

test('rejects unserved and undeclared versions, accepts the served version', () => {
  for (const version of ['v1beta1', 'v2']) {
    const result = checkStackApiVersions([crd, { ...cr, apiVersion: `example.com/${version}` }]);
    assert.equal(result.incompatible[0].reason, 'version-not-served');
    assert.deepEqual(result.incompatible[0].servedVersions, ['v1']);
  }
  assert.deepEqual(checkStackApiVersions([crd, { ...cr, apiVersion: 'example.com/v1' }]).incompatible, []);
});

test('requires exact group and kind; an absent CRD is not a compatibility check', () => {
  for (const object of [{ ...cr, kind: 'Different' }, { ...cr, apiVersion: 'other.example.com/v1' }]) {
    assert.equal(checkStackApiVersions([crd, object]).checked.length, 0);
  }
  assert.equal(checkStackApiVersions([cr]).checked.length, 0);
});

test('does not combine conflicting CRD declarations into a pass', () => {
  const other = structuredClone(crd);
  other.spec.versions[1].served = true;
  assert.equal(checkStackApiVersions([crd, other, cr]).incompatible[0].reason, 'ambiguous-crd');
});

test('CLI refuses bad API versions before writing a sandbox and accepts the repair', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stack-api-test-'));
  const stack = join(dir, 'stack.yaml'), objects = join(dir, 'objects.yaml'), output = join(dir, 'rendered.yaml');
  const bin = fileURLToPath(new URL('../bin/cub-stack', import.meta.url));
  // The CRD is cut down to its versions. A flux that lacks the schema plugin
  // stands in for whatever flux this machine has, so the schema step reports
  // itself as not run and the test reads only the API version check.
  const fakeBin = join(dir, 'bin');
  mkdirSync(fakeBin);
  writeFileSync(join(fakeBin, 'flux'), '#!/bin/sh\necho \'Error: unknown command "schema" for "flux"\' >&2\nexit 1\n');
  chmodSync(join(fakeBin, 'flux'), 0o755);
  const env = { ...process.env, PATH: `${fakeBin}:${process.env.PATH}` };
  const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', timeout: 15000, env });
  const manifest = { apiVersion: 'helm-expt.confighub.com/v1alpha1', kind: 'Stack', metadata: { name: 'api-test' }, spec: { components: [{ name: 'objects', render: 'objects.yaml' }] } };
  try {
    writeFileSync(stack, JSON.stringify(manifest));
    writeFileSync(objects, [crd, cr].map(x => JSON.stringify(x)).join('\n---\n'));
    const bad = run('check', stack);
    assert.equal(bad.status, 1, bad.stderr);
    assert.match(bad.stdout, /version-not-served/);
    assert.match(bad.stdout, /=> REFUSED/);
    const sandbox = run('sandbox', stack, '--out', output);
    assert.equal(sandbox.status, 1, sandbox.stderr);
    assert.equal(existsSync(output), false);
    writeFileSync(objects, [crd, { ...cr, apiVersion: 'example.com/v1' }].map(x => JSON.stringify(x)).join('\n---\n'));
    const good = run('sandbox', stack, '--out', output);
    assert.equal(good.status, 0, good.stderr);
    assert.match(good.stdout, /target availability is not checked/);
    assert.equal(existsSync(output), true);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
