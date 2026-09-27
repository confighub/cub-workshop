import assert from 'node:assert/strict';
import test from 'node:test';
import { apiVersionArgs, crdApiVersions } from '../lib/kubara-render.mjs';

const crd = (group, kind, versions) => ({
  apiVersion: 'apiextensions.k8s.io/v1',
  kind: 'CustomResourceDefinition',
  metadata: { name: `${kind.toLowerCase()}s.${group}` },
  spec: { group, names: { kind }, versions },
});

test('served CRD versions become helm --api-versions values in both forms', () => {
  const objects = [
    crd('monitoring.coreos.com', 'ServiceMonitor', [{ name: 'v1', served: true }]),
    crd('example.com', 'Widget', [{ name: 'v1alpha1', served: false }, { name: 'v1', served: true }]),
    { apiVersion: 'v1', kind: 'ConfigMap', metadata: { name: 'not-a-crd' } },
  ];
  assert.deepEqual(crdApiVersions(objects), [
    'example.com/v1',
    'example.com/v1/Widget',
    'monitoring.coreos.com/v1',
    'monitoring.coreos.com/v1/ServiceMonitor',
  ]);
});

test('api versions become repeated --api-versions flags in a stable order', () => {
  assert.deepEqual(apiVersionArgs(new Set(['b/v1', 'a/v1'])), ['--api-versions', 'a/v1', '--api-versions', 'b/v1']);
  assert.deepEqual(apiVersionArgs(new Set()), []);
});
