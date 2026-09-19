import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkPromtailLokiConnections } from '../lib/stack-connections.mjs';

const secret = (namespace, url, key = 'promtail.yaml', encoded = false) => ({
  apiVersion: 'v1', kind: 'Secret', metadata: { name: 'promtail', namespace },
  ...(encoded ? { data: { [key]: Buffer.from(`clients:\n  - url: ${url}\n`).toString('base64') } } : { stringData: { [key]: `clients:\n  - url: ${url}\n` } }),
});
const promtail = (namespace = 'default', secretName = 'promtail') => ({
  apiVersion: 'apps/v1', kind: 'DaemonSet', metadata: { name: 'promtail', namespace },
  spec: { template: { spec: { containers: [{ name: 'promtail', image: 'grafana/promtail:3.5.1', volumeMounts: [{ name: 'config', mountPath: '/etc/promtail' }] }], volumes: [{ name: 'config', secret: { secretName } }] } } },
});
const service = (name, namespace) => ({ apiVersion: 'v1', kind: 'Service', metadata: { name, namespace } });
const stack = (...objects) => ({ components: [{ name: 'logs', objects }] });

test('retained Promtail shape refuses a Loki service in the wrong namespace', () => {
  const result = checkPromtailLokiConnections(stack(promtail('default'), secret('default', 'http://loki-gateway/loki/api/v1/push'), service('loki-gateway', 'loki')));
  assert.equal(result.mismatches.length, 1);
  assert.equal(result.mismatches[0].host, 'loki-gateway');
  assert.deepEqual(result.mismatches[0].actualNamespaces, ['loki']);
});

test('explicit service DNS, external URLs, unmounted config, and base64 Secret data stay bounded', () => {
  const objects = [promtail('default'), secret('default', 'http://loki-gateway.loki.svc.cluster.local/loki/api/v1/push', 'promtail.yaml', true), service('loki-gateway', 'loki'), service('logs', 'other'),
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'unmounted', namespace: 'default' }, data: { 'promtail.yaml': 'clients:\n  - url: http://logs:3100/loki/api/v1/push\n' } }];
  const result = checkPromtailLokiConnections(stack(...objects));
  assert.equal(result.mismatches.length, 0);
  assert.equal(result.checked.length, 1);
  const external = checkPromtailLokiConnections(stack(promtail('default'), secret('default', 'https://logs.example.net/loki/api/v1/push'), service('loki-gateway', 'loki'), service('logs', 'other')));
  assert.equal(external.mismatches.length, 0);
  assert.equal(external.unknown.length, 1);
});

test('CLI refuses the mutated retained namespace fixture without leaking URL data', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stack-connections-'));
  try {
    const stackPath = join(dir, 'stack.yaml');
    const objectsPath = join(dir, 'objects.yaml');
    writeFileSync(stackPath, `apiVersion: helm-expt.confighub.com/v1alpha1\nkind: Stack\nmetadata: {name: connections}\nspec:\n  components:\n    - name: retained-logs\n      render: objects.yaml\n`);
    writeFileSync(objectsPath, [promtail('default'), secret('default', 'http://loki-gateway/loki/api/v1/push'), service('loki-gateway', 'loki')].map(JSON.stringify).join('\n---\n'));
    const bin = join(process.cwd(), 'bin/cub-stack');
    const result = spawnSync(process.execPath, [bin, 'check', stackPath], { encoding: 'utf8', timeout: 15000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stdout, /Promtail Loki destination/);
    assert.match(result.stdout, /loki-gateway expects default/);
    assert.doesNotMatch(result.stdout, /loki\/api\/v1\/push/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
