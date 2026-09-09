import test from 'node:test';
import assert from 'node:assert/strict';
import { stackPrerequisites } from '../lib/stack-prerequisites.mjs';
const obj = (apiVersion, kind, name, namespace, spec) => ({ apiVersion, kind, metadata: { name, ...(namespace ? { namespace } : {}) }, ...(spec ? { spec } : {}) });
const check = (...objects) => stackPrerequisites({ components: [{ name: 'app', objects }] });
const cert = (ns = 'shop') => obj('cert-manager.io/v1', 'Certificate', 'web', ns, { issuerRef: { name: 'issuer' } });

test('missing references are unknown with consumers and remedies, never declared unavailable', () => {
  const result = check(cert(), obj('external-secrets.io/v1', 'ExternalSecret', 'secret', 'shop', { secretStoreRef: { kind: 'ClusterSecretStore', name: 'store' } }),
    obj('networking.k8s.io/v1', 'Ingress', 'web', 'shop', { ingressClassName: 'traefik' }));
  assert.equal(result.targetChecked, false);
  assert.equal(result.requirements.length, 4);
  for (const r of result.requirements) {
    assert.equal(r.status, 'unknown');
    assert.ok(r.consumers.length);
    assert.match(r.remedy, /selected target/);
  }
  assert.equal(result.requirements.find(r => r.kind === 'Namespace').consumers.length, 3);
});

test('namespaced references require the exact namespace, kind and API group', () => {
  const wrong = check(cert(), obj('cert-manager.io/v1', 'Issuer', 'issuer', 'other'), obj('other.example/v1', 'Issuer', 'issuer', 'shop'));
  assert.equal(wrong.requirements.find(r => r.kind === 'Issuer').status, 'unknown');
  const right = check(cert(), obj('cert-manager.io/v1', 'Issuer', 'issuer', 'shop'), obj('v1', 'Namespace', 'shop'));
  assert.ok(right.requirements.every(r => r.status === 'bundled'));
  assert.equal(right.targetChecked, false);
});

test('cluster references, default namespace and hub exclusions retain their scope', () => {
  const certificate = cert(); certificate.spec.issuerRef.kind = 'ClusterIssuer';
  const local = cert(); delete local.metadata.namespace;
  const components = [
    { name: 'app', objects: [certificate, local] },
    { name: 'cluster', objects: [obj('cert-manager.io/v1', 'ClusterIssuer', 'issuer')] },
    { name: 'hub', plane: 'hub', objects: [obj('cert-manager.io/v1', 'Issuer', 'issuer', 'default'), obj('v1', 'Namespace', 'shop')] },
  ];
  const result = stackPrerequisites({ components });
  assert.equal(result.requirements.find(r => r.kind === 'ClusterIssuer').status, 'bundled');
  const issuer = result.requirements.find(r => r.kind === 'Issuer');
  assert.equal(issuer.namespace, 'default'); assert.equal(issuer.status, 'unknown');
  assert.equal(result.requirements.find(r => r.kind === 'Namespace').status, 'unknown');
});
