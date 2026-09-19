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

test('honors volume items and subPath, ignores sidecar mounts, and stringData wins over data', () => {
  const workload = promtail('default');
  workload.spec.template.spec.volumes[0].secret.items = [{ key: 'promtail.yaml', path: 'promtail.yaml' }];
  workload.spec.template.spec.containers.push({ name: 'sidecar', image: 'example/sidecar', volumeMounts: [{ name: 'sidecar-config', mountPath: '/etc/sidecar' }] });
  workload.spec.template.spec.volumes.push({ name: 'sidecar-config', configMap: { name: 'sidecar-config', items: [{ key: 'config.yaml', path: 'config.yaml' }] } });
  const objects = [{ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'default' } }, { apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'other' } }, workload, {
    apiVersion: 'v1', kind: 'Secret', metadata: { name: 'promtail', namespace: 'default' },
    data: { 'promtail.yaml': Buffer.from('clients:\n  - url: http://loki-gateway.other/loki/api/v1/push\n').toString('base64'), ignored: Buffer.from('clients:\n  - url: http://loki-gateway/loki/api/v1/push\n').toString('base64') },
    stringData: { 'promtail.yaml': 'clients:\n  - url: http://loki-gateway.default/loki/api/v1/push\n' },
  }, service('loki-gateway', 'default'), service('loki-gateway', 'other'), {
    apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'sidecar-config', namespace: 'default' }, data: { 'config.yaml': 'clients:\n  - url: http://loki-gateway.other/loki/api/v1/push\n' },
  }];
  const result = checkPromtailLokiConnections(stack(...objects));
  assert.equal(result.mismatches.length, 0);
  assert.equal(result.checked.length, 1);
});

test('workload-name evidence follows only an explicit config.file container and non-http or IP targets are unknown', () => {
  const workload = promtail('default');
  workload.metadata.name = 'promtail-like';
  workload.spec.template.spec.containers = [{ name: 'agent', args: ['--config.file=/etc/promtail.yaml'], volumeMounts: [{ name: 'config', mountPath: '/etc/promtail.yaml', subPath: 'promtail.yaml' }] }];
  const objects = [workload, secret('default', 'http://loki-gateway/loki/api/v1/push'), service('loki-gateway', 'other')];
  const result = checkPromtailLokiConnections(stack(...objects));
  assert.equal(result.mismatches.length, 1);
  const unknown = checkPromtailLokiConnections(stack(promtail('default'), secret('default', 'tcp://loki-gateway.other:3100'), service('loki-gateway', 'other'), secret('default', 'http://127.0.0.1:3100')));
  assert.equal(unknown.mismatches.length, 0);
  assert.equal(unknown.unknown.length, 2);
});

test('an ambiguous two-label external hostname stays unknown beside a same-name Service', () => {
  const result = checkPromtailLokiConnections(stack(promtail('default'), secret('default', 'https://logs.example/loki/api/v1/push'), service('logs', 'example')));
  assert.equal(result.mismatches.length, 0);
  assert.equal(result.unknown.length, 1);
  const declared = checkPromtailLokiConnections(stack({ apiVersion: 'v1', kind: 'Namespace', metadata: { name: 'example' } }, promtail('default'), secret('default', 'http://logs.example/loki/api/v1/push'), service('logs', 'other')));
  assert.equal(declared.mismatches.length, 1);
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
