import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { findExamples } from '../scripts/find-example.mjs';

const snapshot = readFileSync(new URL('../catalog/examples.json', import.meta.url));
const source = JSON.parse(readFileSync(new URL('../catalog/source.json', import.meta.url), 'utf8'));

test('snapshot is tied to an exact public corpus revision', () => {
  assert.match(source.revision, /^[a-f0-9]{40}$/);
  assert.equal(createHash('sha256').update(snapshot).digest('hex'), source.sha256);
  assert.equal(JSON.parse(snapshot).schema_version, 1);
});

test('user problems reach a pinned guide and preserve eligibility limits', () => {
  const cases = {
    'what an app looks like': 'first-app-realistic',
    'existing chart values': 'governed-helm-change',
    'existing Argo app': 'argo-beginner-applicationset',
    'existing Flux app': 'flux-beginner',
    'app settings provider': 'app-only-provider-config',
    'layered platform': 'layered-platform-recipe',
    'GPU recipe': 'gpu-layered-recipe',
  };
  for (const [request, wanted] of Object.entries(cases)) {
    const candidates = findExamples(request);
    assert.ok(candidates.some(entry => entry.id === wanted), `${request} missed ${wanted}`);
    for (const entry of candidates) {
      assert.equal(entry.visibility, 'public');
      assert.equal(entry.lifecycle, 'maintained');
      assert.equal(entry.role, 'walkthrough');
      assert.equal(entry.admission, 'verified-source');
      assert.ok(entry.source.url.includes(entry.source.revision));
      assert.ok(entry.stop_when);
      assert.ok(entry.evidence.static);
      assert.ok(entry.requirements.local.tested_tool_versions);
      assert.ok(entry.requirements.local.cleanup);
      assert.ok(entry.requirements.connected.qualification);
      assert.equal(entry.maintainer_acceptance, 'pending-maintainer-review');
    }
  }
  assert.equal(findExamples('what an app looks like')[0].id, 'first-app-realistic');
  assert.ok(!findExamples('promotion').some(entry => entry.id === 'promotion-demo-data'));
  assert.ok(findExamples('promotion', { all: true }).some(entry => entry.id === 'promotion-demo-data'));
});

test('read-only CLI gives an agent the same structured results', () => {
  const result = spawnSync(process.execPath, [new URL('../bin/cub-config', import.meta.url).pathname, 'examples', 'existing chart values', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.ok(output.entries.some(entry => entry.id === 'governed-helm-change'));
  const firstApp = spawnSync(process.execPath, [new URL('../bin/cub-config', import.meta.url).pathname, 'examples', 'what an app looks like'], { encoding: 'utf8' });
  assert.equal(firstApp.status, 0, firstApp.stderr);
  assert.match(firstApp.stdout, /catalog\/FIRST_APP\.md/);
  assert.match(firstApp.stdout, /Tested local tools:/);
  assert.match(firstApp.stdout, /Connected qualification: scoped-config-hub-verified/);
  assert.match(firstApp.stdout, /Connected receipt: .*catalog\/first-app-connected-receipt\.json/);
  assert.match(firstApp.stdout, /Maintainer acceptance: pending-maintainer-review/);
  assert.ok(firstApp.stdout.indexOf('What it shows:') < firstApp.stdout.indexOf('Evidence:'));
});
