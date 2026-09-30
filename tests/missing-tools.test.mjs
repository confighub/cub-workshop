import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const lib = (file) => fileURLToPath(new URL(`../lib/${file}`, import.meta.url));

// A PATH holding only node, so oras, helm and cosign are all absent whatever the host has installed.
function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'missing-tools-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  symlinkSync(process.execPath, join(bin, 'node'));
  return { dir, env: { ...process.env, PATH: bin } };
}

const tail = 'Install it and run the command again.';
const run = (env, args) => spawnSync(process.execPath, args, { cwd: root, env, encoding: 'utf8' });
const inLib = (env, code) => run(env, ['--input-type=module', '-e', code]);

test('config values names helm when it is not installed', () => {
  const { dir, env } = sandbox();
  try {
    const chart = join(dir, 'chart');
    mkdirSync(chart);
    writeFileSync(join(chart, 'Chart.yaml'), 'apiVersion: v2\nname: demo\nversion: 0.1.0\n');
    writeFileSync(join(chart, 'values.yaml'), 'replicaCount: 1\n');
    const values = join(dir, 'values.yaml');
    writeFileSync(values, 'replicaCount: 3\n');
    const result = run(env, [join(root, 'bin/cub-config'), 'values', chart, '--values', values]);
    assert.equal(result.status, 2);
    assert.equal(result.stderr.trim(), `Failed: helm is not installed; values needs it to pull and render the chart. ${tail}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('config check --images names oras instead of calling every image unchecked', () => {
  const { dir, env } = sandbox();
  try {
    const file = join(dir, 'app.yaml');
    writeFileSync(file, JSON.stringify({ apiVersion: 'apps/v1', kind: 'Deployment', metadata: { name: 'a', namespace: 'shop' }, spec: { template: { spec: { containers: [{ name: 'app', image: 'nginx:1.27.0' }] } } } }));
    const result = run(env, [join(root, 'bin/cub-config'), 'check', file, '--images']);
    assert.equal(result.status, 1);
    assert.equal(result.stderr.trim(), `Failed: oras is not installed; check --images needs it to ask each image's registry whether it can be pulled. ${tail}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('resolving an uncached bundle names oras', () => {
  const { dir, env } = sandbox();
  try {
    const source = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\n';
    const receipt = join(dir, 'receipt.json');
    writeFileSync(receipt, JSON.stringify({ spec: { bundle: { files: [{ path: 'config.yaml', sha256: createHash('sha256').update(source).digest('hex') }] } } }));
    const component = { name: 'fixture', bundle: `oci://localhost:5001/fixture@sha256:${'e'.repeat(64)}`, receipt };
    const result = inLib({ ...env, TMPDIR: dir }, `import { resolveBundle } from ${JSON.stringify(lib('common.mjs'))}; try { resolveBundle(${JSON.stringify(component)}); } catch (error) { console.log(error.message); }`);
    assert.equal(result.stdout.trim(), `oras is not installed; resolving an uncached bundle needs it to pull the bundle by digest. ${tail}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('publish, discover, sign and verify name the tool they could not start', () => {
  const { dir, env } = sandbox();
  try {
    const digest = `sha256:${'a'.repeat(64)}`;
    const reference = `oci://localhost:5001/team/app@${digest}`;
    const code = `import * as oci from ${JSON.stringify(lib('oci.mjs'))};
      const attempt = (fn) => { try { fn(); return 'no error'; } catch (error) { return error.message; } };
      console.log(JSON.stringify([
        attempt(() => oci.discoverRecords(${JSON.stringify(reference)})),
        attempt(() => oci.pullBundle(${JSON.stringify(reference)})),
        attempt(() => oci.copyIntoRepo(${JSON.stringify(reference)}, 'localhost:5001/other', { plain: true })),
        attempt(() => oci.signDigest({ reference: ${JSON.stringify(reference)}, digest: ${JSON.stringify(digest)}, key: 'cosign.key' })),
        attempt(() => oci.verifySignature({ reference: ${JSON.stringify(reference)}, digest: ${JSON.stringify(digest)}, key: 'cosign.pub' })),
      ]));`;
    const result = inLib(env, code);
    const [discover, pull, copy, sign, verify] = JSON.parse(result.stdout);
    assert.equal(discover, `oras is not installed; reading a receipt needs it to list what is attached to the digest. ${tail}`);
    assert.equal(pull, `oras is not installed; pulling a bundle needs it to fetch the bundle from the registry. ${tail}`);
    assert.equal(copy, `oras is not installed; publish needs it to copy the bundle into the target repository. ${tail}`);
    assert.equal(sign, `cosign is not installed; signing needs it to sign the bundle digest with --sign. ${tail}`);
    assert.equal(verify, `cosign is not installed; verifying with --key needs it to check the signature. ${tail}`);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
