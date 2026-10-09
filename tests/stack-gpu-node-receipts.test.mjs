import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { readYamlFile } from '../lib/common.mjs';

// What can be said about the gpu-node stack without pulling a bundle. The
// tests that pull are in stack-gpu-node.test.mjs.
const root = fileURLToPath(new URL('../', import.meta.url));
const manifest = readYamlFile(join(root, 'stacks/gpu-node.yaml'));
const components = manifest.spec.components;
const routeRoles = (receipt) => receipt.spec.bundle.files.map((file) => file.role).filter((role) => role.startsWith('route:'));

test('gpu-node pins each bundle at the digest its shipped receipt records', () => {
  assert.deepEqual(components.map((component) => component.name), ['gpu-operator', 'nvsentinel', 'cluster-readiness-engine']);
  const receipts = components.map((component) => readYamlFile(join(root, component.receipt)));
  for (const [index, receipt] of receipts.entries()) {
    const bundle = receipt.spec.bundle;
    assert.equal(receipt.kind, 'CatalogLiteralBundlePublicationReceipt');
    assert.equal(receipt.status.result, 'pass');
    assert.equal(components[index].receipt, `receipts/catalog/${receipt.spec.catalogEntry}.yaml`);
    assert.match(bundle.manifestDigest, /^sha256:[0-9a-f]{64}$/);
    assert.equal(components[index].bundle, `oci://${bundle.immutableReference}`);
    assert.ok(components[index].bundle.endsWith(`@${bundle.manifestDigest}`));
    assert.equal(receipt.spec.anonymousPull.manifestDigest, bundle.manifestDigest);
    // One file holds the Kubernetes objects; the resolver reads objects from no other.
    const configuration = bundle.files.filter((file) => !file.role || file.role === 'rendered object set');
    assert.equal(configuration.length, 1);
    assert.equal(`sha256:${configuration[0].sha256}`, bundle.objectSetSha256);
    for (const file of bundle.files) assert.match(file.sha256, /^[0-9a-f]{64}$/, file.path);
  }
  assert.deepEqual(receipts.map((receipt) => receipt.spec.bundle.objectCount), [24, 22, 43]);
  assert.deepEqual(receipts.map(routeRoles), [['route: crd-ordering', 'route: lifecycle-actions'], [], ['route: crd-ordering']]);
});

test('a receipt for another digest is refused before anything is pulled', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpu-node-receipts-'));
  try {
    const plugin = join(dir, 'plugin'); mkdirSync(plugin);
    for (const entry of ['lib', 'bin', 'schemas', 'cub-plugin.yaml', 'stacks/gpu-node.yaml', ...components.map((component) => component.receipt)]) {
      mkdirSync(join(plugin, entry, '..'), { recursive: true });
      cpSync(join(root, entry), join(plugin, entry), { recursive: true });
    }
    const digest = components[0].bundle.split('@')[1];
    const other = `sha256:${'0'.repeat(64)}`;
    const path = join(plugin, components[0].receipt);
    writeFileSync(path, readFileSync(path, 'utf8').replaceAll(digest, other));
    // A PATH with no oras on it: a pull would fail with a different message.
    const result = spawnSync(process.execPath, [join(plugin, 'bin/cub-stack'), 'check', 'gpu-node'], { encoding: 'utf8', timeout: 30000, env: { ...process.env, PATH: join(dir, 'no-tools'), TMPDIR: dir } });
    assert.equal(result.status, 2, result.stdout);
    assert.equal(result.stderr.trim(), `error: component "gpu-operator" receipt is for ${other}, not ${digest}`);
    assert.doesNotMatch(result.stdout, /CHECKED/);
    assert.equal(existsSync(join(dir, 'cub-stack-bundles')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
