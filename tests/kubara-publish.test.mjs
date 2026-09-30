import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocs } from '../lib/common.mjs';
import { goldenPlatform, installFakeCub } from './kubara-fake-cub.mjs';

// Needs a registry this machine can push to, such as CI's registry:2 service:
// CUB_TEST_REGISTRY=localhost:5000 node --test tests/kubara-publish.test.mjs
const registry = process.env.CUB_TEST_REGISTRY;
const root = fileURLToPath(new URL('../', import.meta.url));
const stackBin = join(root, 'bin', 'cub-stack');
const run = (args, env = {}) => spawnSync(process.execPath, [stackBin, ...args], { encoding: 'utf8', timeout: 120000, env: { ...process.env, ...env } });

test('a whole Kubara platform publishes as one index, and every cluster reads back by digest', { skip: !registry && 'set CUB_TEST_REGISTRY to a registry to push to' }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'kubara-publish-'));
  try {
    cpSync(goldenPlatform, join(dir, 'platform'), { recursive: true });
    const env = { TMPDIR: dir };
    // A fake cub kubara writes the golden render; see tests/kubara-fake-cub.mjs.
    const bin = installFakeCub(join(dir, 'bin'));
    assert.equal(run(['from-kubara', join(dir, 'platform'), '--out', join(dir, 'out')], { PATH: `${bin}:${process.env.PATH}` }).status, 0);
    const manifest = join(dir, 'out', 'stack.yaml');
    const repo = `${registry}/kubara-platform-${process.pid}`;
    assert.match(run(['publish', manifest, '--out', `oci://${repo}:t`, '--cluster', 'hub']).stderr, /publish takes the whole platform/);
    const published = run(['publish', manifest, '--out', `oci://${repo}:t`], env);
    assert.equal(published.status, 0, published.stderr + published.stdout);
    assert.match(published.stdout, /\[PASS\] cluster hub: CHECKED[^\n]*\n\s+\[PASS\] cluster spoke: CHECKED/, 'each cluster checks before anything is pushed');
    assert.match(published.stdout, /web on spoke: published sha256:/);
    const index = published.stdout.match(/oci:\/\/\S+@sha256:[0-9a-f]{64}/g).pop();

    const spoke = JSON.parse(run(['check', index, '--cluster', 'spoke', '--json'], env).stdout);
    assert.equal(spoke.checked, true);
    assert.deepEqual(spoke.components.map((comp) => comp.name), ['bootstrap-crds', 'web']);
    assert.ok(spoke.components.every((comp) => comp.source.startsWith(`oci://${repo}@sha256:`)), 'each variant is read by digest');

    const rendered = join(dir, 'spoke.yaml');
    assert.equal(run(['sandbox', index, '--cluster', 'spoke', '--out', rendered], env).status, 0);
    const settings = parseDocs(readFileSync(rendered, 'utf8')).find((doc) => doc.kind === 'ConfigMap' && doc.metadata.name === 'webapp-settings');
    assert.equal(settings.data.replicas, '5', "the spoke's own render, not the base");

    const plan = run(['upload', index], env).stdout;
    assert.match(plan, new RegExp(`variant upload --component web --variant base .*oci://${repo}@sha256:`));
    assert.match(plan, new RegExp(`variant upload --component web --variant spoke .*--stage prod oci://${repo}@sha256:`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
