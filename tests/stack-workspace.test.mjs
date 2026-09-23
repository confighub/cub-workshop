import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, renameSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseDocs, readYamlFile, toYaml } from '../lib/common.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (bin, ...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', timeout: 30000 });
const runWithEnv = (env, bin, ...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', timeout: 30000, env: { ...process.env, ...env } });
const bin = join(root, 'bin/cub-stack');
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

test('save, move, edit one field, and resume with only a clean plugin runtime', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-test-'));
  try {
    const workspace = join(dir, 'first copy');
    const saved = run(bin, 'sandbox', 'kubara-shop-platform', '--workspace', workspace);
    assert.equal(saved.status, 0, saved.stderr);
    const baseline = JSON.parse(readFileSync(join(workspace, 'result.json')));
    assert.equal(baseline.objectCount, 135);
    assert.equal(baseline.prerequisites.targetChecked, false);
    const unknown = baseline.prerequisites.requirements.filter(r => r.status === 'unknown');
    assert.equal(unknown.filter(r => r.kind === 'Namespace').length, 5);
    assert.ok(unknown.some(r => r.kind === 'ClusterIssuer' && r.name === 'letsencrypt'));
    assert.ok(unknown.some(r => r.kind === 'ClusterSecretStore' && r.name === 'platform-store'));
    assert.equal(baseline.prerequisites.requirements.find(r => r.kind === 'IngressClass').status, 'bundled');
    assert.equal(baseline.renderedFile.sha256, hash(readFileSync(join(workspace, 'rendered.yaml'))));
    assert.ok(baseline.components.some(c => c.source.startsWith('oci://')));
    for (const file of baseline.workspaceFiles) assert.equal(hash(readFileSync(join(workspace, file.path))), file.sha256);
    assert.equal(baseline.lifecycleCompanions.state, 'declared-unexecuted');
    const traefikEvidence = baseline.lifecycleCompanions.entries.find(entry => entry.component === 'traefik');
    assert.equal(traefikEvidence.state, 'declared-unexecuted');
    assert.equal(traefikEvidence.companions.length, 1);
    assert.equal(traefikEvidence.companions[0].role, 'route: crd-ordering');
    assert.equal(hash(readFileSync(join(workspace, traefikEvidence.receipt.path))), traefikEvidence.receipt.sha256);
    assert.equal(hash(readFileSync(join(workspace, traefikEvidence.companions[0].path))), traefikEvidence.companions[0].sha256);
    assert.ok(!parseDocs(readFileSync(join(workspace, 'rendered.yaml'), 'utf8')).some(object => object.kind === 'BundleRoute'));
    const manifest = readYamlFile(join(workspace, 'stack.yaml'));
    assert.equal(manifest.spec.components.filter(c => c.authored).length, 1);
    assert.equal(manifest.spec.components.filter(c => c.render).length, 4);

    const moved = join(dir, 'handoff');
    renameSync(workspace, moved);
    // No installed plugin state, shipped components, bundle caches or source
    // manifests in this runtime copy. Continued work must use the saved files.
    const runtime = join(dir, 'runtime');
    mkdirSync(runtime);
    for (const entry of ['lib', 'bin', 'schemas', 'cub-plugin.yaml']) cpSync(join(root, entry), join(runtime, entry), { recursive: true });
    const resume = (...args) => run(join(runtime, 'bin/cub-stack'), ...args);
    const unchanged = resume('check', join(moved, 'stack.yaml'), '--json');
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.equal(JSON.parse(unchanged.stdout).renderedFile.sha256, baseline.renderedFile.sha256);

    const appPath = join(moved, manifest.spec.components.find(c => c.authored).authored);
    const app = parseDocs(readFileSync(appPath, 'utf8'));
    const deployment = app.find(o => o.kind === 'Deployment' && o.metadata.name === 'shop-web');
    assert.equal(deployment.spec.replicas, 3);
    deployment.spec.replicas = 2;
    writeFileSync(appPath, app.map(toYaml).join('---\n'));
    const changed = resume('check', join(moved, 'stack.yaml'), '--json');
    assert.equal(changed.status, 0, changed.stderr);
    const result = JSON.parse(changed.stdout);
    assert.notEqual(result.renderedFile.sha256, baseline.renderedFile.sha256);
    assert.equal(result.objectCount, 135);
    assert.equal(result.scope.applicationHealth, 'not-checked');
    const output = join(moved, 'changed.yaml');
    assert.equal(resume('sandbox', join(moved, 'stack.yaml'), '--out', output).status, 0);
    assert.equal(hash(readFileSync(output)), result.renderedFile.sha256);
    const expected = parseDocs(readFileSync(join(moved, 'rendered.yaml'), 'utf8'));
    expected.find(o => o.kind === 'Deployment' && o.metadata.name === 'shop-web').spec.replicas = 2;
    assert.deepEqual(parseDocs(readFileSync(output, 'utf8')), expected);
    assert.equal(hash(readFileSync(join(moved, 'rendered.yaml'))), baseline.renderedFile.sha256);

    // A moved workspace carries its receipt-bound routes forward without
    // re-resolving a registry bundle. They remain declared evidence, not
    // rendered Kubernetes objects or a delivery claim.
    const resaved = join(dir, 'second copy');
    const savedAgain = resume('sandbox', join(moved, 'stack.yaml'), '--workspace', resaved);
    assert.equal(savedAgain.status, 0, savedAgain.stderr);
    const secondBaseline = JSON.parse(readFileSync(join(resaved, 'result.json')));
    assert.equal(secondBaseline.lifecycleCompanions.entries.find(entry => entry.component === 'traefik').companions[0].sha256, traefikEvidence.companions[0].sha256);

    const originalResult = readFileSync(join(moved, 'result.json'));
    const missingRoute = JSON.parse(originalResult);
    missingRoute.lifecycleCompanions.entries.find(entry => entry.component === 'traefik').companions = [];
    writeFileSync(join(moved, 'result.json'), JSON.stringify(missingRoute, null, 2));
    const missingRouteWorkspace = join(dir, 'missing route copy');
    const missingRouteResult = resume('sandbox', join(moved, 'stack.yaml'), '--workspace', missingRouteWorkspace);
    assert.equal(missingRouteResult.status, 2);
    assert.match(missingRouteResult.stderr, /missing or changed a required route/);
    assert.equal(existsSync(missingRouteWorkspace), false);

    writeFileSync(join(moved, 'result.json'), originalResult);
    writeFileSync(join(moved, traefikEvidence.companions[0].path), 'changed route evidence\n');
    const refusedWorkspace = join(dir, 'refused copy');
    const refused = resume('sandbox', join(moved, 'stack.yaml'), '--workspace', refusedWorkspace);
    assert.equal(refused.status, 2);
    assert.match(refused.stderr, /lifecycle evidence hash mismatch/);
    assert.equal(existsSync(refusedWorkspace), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('refusals, existing paths and bad flags leave no new workspace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-refusal-'));
  try {
    const target = join(dir, 'new');
    assert.equal(run(bin, 'sandbox', 'conflict-demo', '--workspace', target).status, 1);
    assert.equal(existsSync(target), false);
    for (const args of [['sandbox', 'web-tiny', '--workspace'], ['check', 'web-tiny', '--workspace', target],
      ['sandbox', 'web-tiny', '--workspace', target, '--out', join(dir, 'output')]]) {
      assert.equal(run(bin, ...args).status, 2);
      assert.equal(existsSync(target), false);
    }
    mkdirSync(target);
    writeFileSync(join(target, 'keep.txt'), 'user work');
    const existing = run(bin, 'sandbox', 'web-tiny', '--workspace', target);
    assert.equal(existing.status, 1);
    assert.match(existing.stderr, /workspace already exists/);
    assert.equal(readFileSync(join(target, 'keep.txt'), 'utf8'), 'user work');
    assert.equal(existsSync(join(target, 'stack.yaml')), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy bundle routes are required only when saving a workspace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-legacy-route-'));
  try {
    const digest = createHash('sha256').update(dir).digest('hex');
    const source = join(dir, 'bundle'); mkdirSync(source);
    const config = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: legacy\n';
    writeFileSync(join(source, 'config.yaml'), config);
    const receipt = { spec: { bundle: { manifestDigest: `sha256:${digest}`, files: [
      { path: 'config.yaml', sha256: hash(Buffer.from(config)), role: 'rendered object set' },
      { path: 'routes/required.yaml', sha256: '0'.repeat(64), role: 'route: apply-ordering' },
    ] } } };
    writeFileSync(join(dir, 'receipt.json'), JSON.stringify(receipt));
    const manifest = join(dir, 'stack.yaml');
    writeFileSync(manifest, `apiVersion: helm-expt.confighub.com/v1alpha1\nkind: Stack\nmetadata:\n  name: legacy\nspec:\n  components:\n    - name: legacy\n      bundle: oci://registry.test/legacy@sha256:${digest}\n      receipt: receipt.json\n`);
    const fakeBin = join(dir, 'bin'); mkdirSync(fakeBin);
    const fakeOras = join(fakeBin, 'oras');
    writeFileSync(fakeOras, '#!/bin/sh\nset -eu\n[ "$1" = pull ]\nout=""\nfor arg in "$@"; do if [ "${previous-}" = -o ]; then out="$arg"; fi; previous="$arg"; done\nmkdir -p "$out"\ntar -cf "$out/bundle.tar" -C "$FAKE_BUNDLE_SOURCE" config.yaml\n');
    chmodSync(fakeOras, 0o755);
    const env = { PATH: `${fakeBin}:${process.env.PATH}`, FAKE_BUNDLE_SOURCE: source };
    const plain = join(dir, 'plain.yaml');
    const plainResult = runWithEnv(env, bin, 'sandbox', manifest, '--out', plain);
    assert.equal(plainResult.status, 0, plainResult.stderr);
    assert.ok(existsSync(plain));
    const workspace = join(dir, 'workspace');
    const workspaceResult = runWithEnv(env, bin, 'sandbox', manifest, '--workspace', workspace);
    assert.equal(workspaceResult.status, 2);
    assert.match(workspaceResult.stderr, /cache is marked complete but does not match its receipt/);
    assert.equal(existsSync(workspace), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a snapshot-bound workspace permits only appended authored components', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-add-app-'));
  try {
    const original = join(dir, 'original');
    const initial = run(bin, 'sandbox', 'kubara-shop-platform', '--workspace', original);
    assert.equal(initial.status, 0, initial.stderr);
    const baseline = JSON.parse(readFileSync(join(original, 'result.json')));
    const snapshot = 'evidence/original-stack.yaml';
    const snapshotFile = baseline.workspaceFiles.find(file => file.path === snapshot);
    assert.ok(snapshotFile);
    assert.equal(hash(readFileSync(join(original, snapshot))), snapshotFile.sha256);
    assert.equal(hash(readFileSync(join(original, snapshot))), baseline.workspaceFiles.find(file => file.path === 'stack.yaml').sha256);

    const appended = join(dir, 'appended'); cpSync(original, appended, { recursive: true });
    const appendManifest = readYamlFile(join(appended, 'stack.yaml'));
    writeFileSync(join(appended, 'components', '99-own-app.yaml'), 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: own-app\n');
    appendManifest.spec.components.push({ name: 'own-app', authored: 'components/99-own-app.yaml' });
    writeFileSync(join(appended, 'stack.yaml'), toYaml(appendManifest));
    const saved = join(dir, 'saved');
    const addResult = run(bin, 'sandbox', join(appended, 'stack.yaml'), '--workspace', saved);
    assert.equal(addResult.status, 0, addResult.stderr);
    const savedResult = JSON.parse(readFileSync(join(saved, 'result.json')));
    assert.equal(savedResult.lifecycleCompanions.entries.length, baseline.lifecycleCompanions.entries.length);
    assert.equal(savedResult.lifecycleCompanions.entries.flatMap(entry => entry.companions).length, baseline.lifecycleCompanions.entries.flatMap(entry => entry.companions).length);
    const resumed = run(bin, 'sandbox', join(saved, 'stack.yaml'), '--workspace', join(dir, 'resaved'));
    assert.equal(resumed.status, 0, resumed.stderr);

    const changed = (name, mutate, expected = /only new authored components may be appended/) => {
      const target = join(dir, name); cpSync(original, target, { recursive: true });
      const manifest = readYamlFile(join(target, 'stack.yaml')); mutate(manifest, target);
      writeFileSync(join(target, 'stack.yaml'), toYaml(manifest));
      const output = join(dir, `${name}-out`); const result = run(bin, 'sandbox', join(target, 'stack.yaml'), '--workspace', output);
      assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, expected); assert.equal(existsSync(output), false);
    };
    changed('stack-renamed', manifest => { manifest.metadata.name = 'renamed-stack'; }, /does not match this stack name/);
    changed('changed-source', manifest => { manifest.spec.components[0].render = manifest.spec.components[1].render; });
    changed('renamed', manifest => { manifest.spec.components[0].name = 'renamed'; });
    changed('removed', manifest => { manifest.spec.components.pop(); });
    changed('reordered', manifest => { [manifest.spec.components[0], manifest.spec.components[1]] = [manifest.spec.components[1], manifest.spec.components[0]]; });
    changed('bindings', manifest => { manifest.spec.bindings = { pathBindings: [] }; });

    const evidenceFailure = (name, mutate, expected) => {
      const target = join(dir, name); cpSync(original, target, { recursive: true });
      const manifest = readYamlFile(join(target, 'stack.yaml'));
      writeFileSync(join(target, 'components', '99-own-app.yaml'), 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: own-app\n');
      manifest.spec.components.push({ name: 'own-app', authored: 'components/99-own-app.yaml' });
      writeFileSync(join(target, 'stack.yaml'), toYaml(manifest)); mutate(target);
      const result = run(bin, 'sandbox', join(target, 'stack.yaml'), '--workspace', join(dir, `${name}-out`));
      assert.equal(result.status, 2, result.stderr); assert.match(result.stderr, expected);
    };
    evidenceFailure('missing-snapshot', target => rmSync(join(target, snapshot)), /missing original stack snapshot/);
    evidenceFailure('tampered-snapshot', target => writeFileSync(join(target, snapshot), 'changed\n'), /hash mismatch: original stack snapshot/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
