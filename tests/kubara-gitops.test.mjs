import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseDocs, readYamlFile } from '../lib/common.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [join(root, 'bin/cub-stack'), ...args], {encoding:'utf8', timeout:60000});
test('GitOps selection retains the full existing app stack and adds pinned Argo CD objects', () => {
  const base = readYamlFile(join(root, 'stacks/kubara-shop-platform.yaml'));
  const candidate = readYamlFile(join(root, 'stacks/kubara-gitops-shop.yaml'));
  for (const component of base.spec.components) {
    const actual = candidate.spec.components.find(c => c.name === component.name);
    assert.deepEqual({...actual, order: component.order}, component);
  }
  const argo = candidate.spec.components.find(c => c.name === 'argo-cd');
  const receipt = JSON.parse(readFileSync(join(root, argo.receipt)));
  assert.equal(argo.bundle, receipt.spec.bundle.reference);
  const checked = run('certify', 'kubara-gitops-shop', '--json');
  assert.equal(checked.status, 0, checked.stderr);
  const result = JSON.parse(checked.stdout);
  assert.equal(result.certified, true);
  assert.equal(result.objectCount, 184);
  assert.equal(result.scope.targetAvailability, 'not-checked');
  assert.equal(result.scope.applicationHealth, 'not-checked');
  const dir = mkdtempSync(join(tmpdir(), 'gitops-selection-'));
  try {
    const output = join(dir, 'rendered.yaml');
    const render = run('sandbox', 'kubara-gitops-shop', '--out', output);
    assert.equal(render.status, 0, render.stderr);
    const bytes = readFileSync(output);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), result.renderedFile.sha256);
    const objects = parseDocs(bytes.toString());
    assert.ok(objects.some(o => o.kind === 'StatefulSet' && o.metadata.name === 'argo-cd-argocd-application-controller'));
    assert.ok(objects.some(o => o.kind === 'CustomResourceDefinition' && o.metadata.name === 'applications.argoproj.io'));
    assert.ok(objects.some(o => o.kind === 'Deployment' && o.metadata.name === 'shop-web'));
    assert.equal(objects.filter(o => o.kind === 'Application').length, 0, 'no configured delivery binding is claimed');
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
