import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { parseDocs, toYaml } from '../lib/common.mjs';
const root = fileURLToPath(new URL('../proofs/assistant-local-2026-09-09/', import.meta.url));
const read = path => readFileSync(join(root, path));
const json = path => JSON.parse(read(path));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const render = objects => objects.map(toYaml).join('---\n');
test('both assistants retained identical baseline, one-field edit and refused candidate', () => {
  const execution = json('execution.json');
  assert.equal(hash(read('task.txt')), execution.taskSha256);
  const bytes = gunzipSync(read('baseline.yaml.gz'));
  const objects = parseDocs(bytes.toString());
  assert.equal(objects.length, 135);
  const deployment = objects.find(o => o.kind === 'Deployment' && o.metadata.name === 'shop-web' && o.metadata.namespace === 'shop');
  assert.equal(deployment.spec.replicas, 3);
  deployment.spec.replicas = 2;
  const changed = render(objects);
  const secret = objects.find(o => o.kind === 'ExternalSecret' && o.metadata.name === 'shop-web-db');
  assert.equal(secret.apiVersion, 'external-secrets.io/v1');
  secret.apiVersion = 'external-secrets.io/v1beta1';
  const refused = render(objects);
  for (const agent of ['claude', 'codex']) {
    assert.equal(execution.agents[agent].exitCode, 0);
    const baseline = json(`${agent}/baseline.json`);
    const candidate = json(`${agent}/changed.json`);
    const refusal = json(`${agent}/refusal.json`);
    assert.equal(baseline.renderedFile.sha256, hash(bytes));
    assert.equal(candidate.renderedFile.sha256, hash(changed));
    assert.equal(refusal.renderedFile.sha256, hash(refused));
    assert.equal(baseline.certified, true);
    assert.equal(candidate.certified, true);
    assert.equal(refusal.certified, false);
    assert.ok(refusal.checks.some(c => c.result === 'FAIL'));
    assert.ok(refusal.checks.some(c => c.text.includes('version-not-served')));
    for (const r of [baseline, candidate, refusal]) {
      assert.equal(r.objectCount, 135);
      assert.equal(r.scope.targetAvailability, 'not-checked');
      assert.equal(r.scope.applicationHealth, 'not-checked');
    }
    const app = parseDocs(read(`${agent}/refused-app.yaml`).toString());
    assert.deepEqual(app, objects.filter(o => o.metadata?.namespace === 'shop'));
  }
  assert.deepEqual(json('claude/baseline.json').components, json('codex/baseline.json').components);
  assert.deepEqual(json('claude/refusal.json').checks, json('codex/refusal.json').checks);
});
