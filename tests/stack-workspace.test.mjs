import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, cpSync, renameSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseDocs, readYamlFile, toYaml } from '../lib/common.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (bin, ...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', timeout: 30000 });
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
    assert.equal(baseline.renderedFile.sha256, hash(readFileSync(join(workspace, 'rendered.yaml'))));
    assert.ok(baseline.components.some(c => c.source.startsWith('oci://')));
    for (const file of baseline.workspaceFiles) assert.equal(hash(readFileSync(join(workspace, file.path))), file.sha256);
    const manifest = readYamlFile(join(workspace, 'stack.yaml'));
    assert.equal(manifest.spec.components.filter(c => c.authored).length, 1);
    assert.equal(manifest.spec.components.filter(c => c.render).length, 4);

    const moved = join(dir, 'handoff');
    renameSync(workspace, moved);
    // No installed plugin state, shipped components, bundle caches or source
    // manifests in this runtime copy. Continued work must use the saved files.
    const runtime = join(dir, 'runtime');
    mkdirSync(runtime);
    for (const entry of ['lib', 'bin', 'cub-plugin.yaml']) cpSync(join(root, entry), join(runtime, entry), { recursive: true });
    const resume = (...args) => run(join(runtime, 'bin/cub-stack'), ...args);
    const unchanged = resume('certify', join(moved, 'stack.yaml'), '--json');
    assert.equal(unchanged.status, 0, unchanged.stderr);
    assert.equal(JSON.parse(unchanged.stdout).renderedFile.sha256, baseline.renderedFile.sha256);

    const appPath = join(moved, manifest.spec.components.find(c => c.authored).authored);
    const app = parseDocs(readFileSync(appPath, 'utf8'));
    const deployment = app.find(o => o.kind === 'Deployment' && o.metadata.name === 'shop-web');
    assert.equal(deployment.spec.replicas, 3);
    deployment.spec.replicas = 2;
    writeFileSync(appPath, app.map(toYaml).join('---\n'));
    const changed = resume('certify', join(moved, 'stack.yaml'), '--json');
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
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('refusals, existing paths and bad flags leave no new workspace', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workspace-refusal-'));
  try {
    const target = join(dir, 'new');
    assert.equal(run(bin, 'sandbox', 'conflict-demo', '--workspace', target).status, 1);
    assert.equal(existsSync(target), false);
    for (const args of [['sandbox', 'web-tiny', '--workspace'], ['certify', 'web-tiny', '--workspace', target],
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
