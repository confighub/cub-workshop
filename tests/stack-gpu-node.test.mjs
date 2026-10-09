import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { parseDocs, readYamlFile } from '../lib/common.mjs';

// These tests pull the three published bundles by digest, so they need oras and
// the public registry. The smoke workflow runs this file in its bundles job.
const root = fileURLToPath(new URL('../', import.meta.url));
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const run = (bin, args, env = {}) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', timeout: 120000, env: { ...process.env, ...env } });
const shipped = join(root, 'bin/cub-stack');
const manifest = readYamlFile(join(root, 'stacks/gpu-node.yaml'));
const RECEIPTS = manifest.spec.components.map((component) => component.receipt);
const EVIDENCE_KINDS = /^kind: "?(BundleRoute|BundleTargetRequirements)"?$/m;
const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// A private copy of the plugin with the stack and its three receipts, so a
// test can change a receipt without touching the shipped one. Its bundle cache
// is private too, so a refusal here never reads or disturbs the shared cache.
function pluginCopy(edit) {
  const dir = mkdtempSync(join(tmpdir(), 'gpu-node-'));
  const plugin = join(dir, 'plugin'); mkdirSync(plugin);
  for (const entry of ['lib', 'bin', 'schemas', 'cub-plugin.yaml', 'stacks/gpu-node.yaml', ...RECEIPTS]) {
    mkdirSync(join(plugin, entry, '..'), { recursive: true });
    cpSync(join(root, entry), join(plugin, entry), { recursive: true });
  }
  edit(plugin);
  return { dir, bin: join(plugin, 'bin/cub-stack'), env: { TMPDIR: dir }, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

// Replace the SHA-256 the receipt records for the one file with this role.
function changeRecordedHash(plugin, receipt, role) {
  const path = join(plugin, receipt);
  const file = readYamlFile(path).spec.bundle.files.find((entry) => entry.role === role);
  const text = readFileSync(path, 'utf8');
  const changed = 'f'.repeat(64);
  assert.equal(text.split(`sha256: "${file.sha256}"`).length, 2, `${role} is recorded once in ${receipt}`);
  writeFileSync(path, text.replace(`sha256: "${file.sha256}"`, `sha256: "${changed}"`));
  return { path: file.path, recorded: file.sha256, changed };
}

test('gpu-node resolves from its three pinned bundles and checks with 89 objects', () => {
  const checked = run(shipped, ['check', 'gpu-node', '--json']);
  assert.equal(checked.status, 0, checked.stderr);
  const result = JSON.parse(checked.stdout);
  assert.equal(result.checked, true);
  assert.equal(result.objectCount, 89);
  assert.deepEqual(result.components.map((component) => [component.name, component.objects]), [['gpu-operator', 24], ['nvsentinel', 22], ['cluster-readiness-engine', 43]]);
  assert.deepEqual(result.components.map((component) => component.source), manifest.spec.components.map((component) => component.bundle));
  assert.equal(result.scope.mode, 'static-composition');
  assert.equal(result.scope.targetAvailability, 'not-checked');
  // Schema validation depends on a local tool, so its line is left out here.
  const lines = result.checks.filter((check) => !/^schema validation/.test(check.text)).map((check) => `${check.result} ${check.text}`);
  assert.deepEqual(lines, [
    'PASS no resource conflicts across components (89 objects)',
    'PASS CRD ordering: 12 CRDs are delivered before the 5 custom resources that need them',
    'PASS served API versions: 5 custom resource(s) match their bundled CRD; target availability is not checked',
    'WARN 2 custom resource(s) rely on CRDs this stack does not deliver, which must already exist: monitoring.coreos.com (2)',
    'PASS no admission webhooks need a certificate',
    'WARN namespaces: 0 created, 2 must already exist (gpu-operator, nvcre)',
  ]);

  const text = run(shipped, ['sandbox', 'gpu-node']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(text.stdout, /=> CHECKED/);
  assert.match(text.stdout, /89 objects total\n\s+gpu-operator: 24\n\s+nvsentinel: 22\n\s+cluster-readiness-engine: 43\n/);
});

test('the bundles\' routes are saved as evidence and never counted or rendered as objects', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gpu-node-workspace-'));
  try {
    const workspace = join(dir, 'ws');
    const saved = run(shipped, ['sandbox', 'gpu-node', '--workspace', workspace]);
    assert.equal(saved.status, 0, saved.stderr);
    assert.match(saved.stdout, /Saved 3 receipt-bound lifecycle route file\(s\) as declared-unexecuted evidence; no route was executed\./);
    const baseline = JSON.parse(readFileSync(join(workspace, 'result.json')));
    assert.equal(baseline.objectCount, 89);
    assert.equal(baseline.lifecycleCompanions.state, 'declared-unexecuted');
    const routes = Object.fromEntries(baseline.lifecycleCompanions.entries.map((entry) => [entry.component, entry.companions.map((companion) => companion.role)]));
    assert.deepEqual(routes, { 'gpu-operator': ['route: crd-ordering', 'route: lifecycle-actions'], nvsentinel: [], 'cluster-readiness-engine': ['route: crd-ordering'] });
    for (const entry of baseline.lifecycleCompanions.entries) {
      // Each saved receipt is the shipped one, byte for byte.
      const receipt = readFileSync(join(workspace, entry.receipt.path));
      assert.deepEqual(receipt, readFileSync(join(root, entry.receipt.source)));
      assert.equal(hash(receipt), entry.receipt.sha256);
      for (const companion of entry.companions) {
        assert.equal(companion.suppliedBy, 'bundle');
        assert.equal(companion.state, 'declared-unexecuted');
        assert.equal(hash(readFileSync(join(workspace, companion.path))), companion.sha256);
      }
    }
    // Routes and target requirements are documents about the bundle. None of
    // them is a Kubernetes object in the render or in a component file.
    const rendered = readFileSync(join(workspace, 'rendered.yaml'), 'utf8');
    assert.equal(parseDocs(rendered).length, 89);
    const saveManifest = readYamlFile(join(workspace, 'stack.yaml'));
    for (const text of [rendered, ...saveManifest.spec.components.map((component) => readFileSync(join(workspace, component.render), 'utf8'))]) {
      assert.doesNotMatch(text, EVIDENCE_KINDS);
      assert.doesNotMatch(text, /^apiVersion: "?evidence\.confighub\.com\//m);
    }
    const resumed = run(shipped, ['check', join(workspace, 'stack.yaml'), '--json']);
    assert.equal(resumed.status, 0, resumed.stderr);
    assert.equal(JSON.parse(resumed.stdout).objectCount, 89);
    assert.equal(JSON.parse(resumed.stdout).renderedFile.sha256, baseline.renderedFile.sha256);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a receipt whose recorded configuration hash was changed refuses the stack', () => {
  let edit;
  const copy = pluginCopy((plugin) => { edit = changeRecordedHash(plugin, RECEIPTS[0], 'rendered object set'); });
  try {
    for (const args of [['check', 'gpu-node'], ['sandbox', 'gpu-node', '--workspace', join(copy.dir, 'ws')]]) {
      const result = run(copy.bin, args, copy.env);
      assert.equal(result.status, 1, result.stdout);
      assert.doesNotMatch(result.stdout, /CHECKED/);
      assert.match(result.stderr, new RegExp(`component "gpu-operator" pulled files do not match its receipt: ${escaped(edit.path)} has sha256 ${edit.recorded.slice(0, 12)}, the receipt records ${edit.changed.slice(0, 12)}$`, 'm'));
    }
    assert.equal(existsSync(join(copy.dir, 'ws')), false);
    // Nothing unverified is left where a later run would read it.
    assert.equal(existsSync(join(copy.dir, 'cub-stack-bundles')), false);
  } finally { copy.cleanup(); }
});

test('a receipt whose recorded route hash was changed refuses to save the workspace', () => {
  let edit;
  const copy = pluginCopy((plugin) => { edit = changeRecordedHash(plugin, RECEIPTS[0], 'route: lifecycle-actions'); });
  try {
    const workspace = join(copy.dir, 'ws');
    const result = run(copy.bin, ['sandbox', 'gpu-node', '--workspace', workspace], copy.env);
    assert.equal(result.status, 1, result.stdout);
    assert.match(result.stderr, new RegExp(`component "gpu-operator" pulled files do not match its receipt: ${escaped(edit.path)} has sha256 ${edit.recorded.slice(0, 12)}, the receipt records ${edit.changed.slice(0, 12)}$`, 'm'));
    assert.equal(existsSync(workspace), false);
  } finally { copy.cleanup(); }
});
