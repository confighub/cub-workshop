// Inventory selected Kubernetes references. Presence is static evidence only:
// no target discovery, controller readiness or credential values are inspected.
export function stackPrerequisites(stack) {
  const objects = stack.components.filter(c => c.plane !== 'hub')
    .flatMap(c => c.objects.map(object => ({ component: c.name, object })));
  const groupOf = o => String(o.apiVersion ?? '').includes('/') ? o.apiVersion.split('/')[0] : '';
  const key = r => JSON.stringify([r.group, r.kind, r.namespace, r.name]);
  const namespace = o => o.metadata?.namespace ?? 'default';
  const supplied = new Set(objects.map(({ object: o }) => key({ group: groupOf(o), kind: o.kind,
    namespace: ['Namespace', 'ClusterIssuer', 'ClusterSecretStore', 'IngressClass'].includes(o.kind) ? null : namespace(o), name: o.metadata?.name })));
  const requirements = new Map();
  function add(component, o, field, group, kind, ns, name) {
    if (!name) return;
    const ref = { group, kind, namespace: ns, name };
    const id = key(ref);
    if (!requirements.has(id)) requirements.set(id, { ...ref, status: supplied.has(id) ? 'bundled' : 'unknown', consumers: [],
      remedy: supplied.has(id) ? 'Verify readiness on the selected target before delivery.' : `Include ${kind}/${name}${ns ? ` in namespace ${ns}` : ''} in the stack, or verify it exists on the selected target before delivery.` });
    requirements.get(id).consumers.push({ component, kind: o.kind, name: o.metadata?.name, namespace: o.metadata?.namespace ?? null, field });
  }
  for (const { component, object: o } of objects) {
    if (o.metadata?.namespace) add(component, o, 'metadata.namespace', '', 'Namespace', null, o.metadata.namespace);
    if (groupOf(o) === 'cert-manager.io' && o.kind === 'Certificate') {
      const r = o.spec?.issuerRef;
      add(component, o, 'spec.issuerRef', r?.group ?? 'cert-manager.io', r?.kind ?? 'Issuer', r?.kind === 'ClusterIssuer' ? null : namespace(o), r?.name);
    }
    if (groupOf(o) === 'external-secrets.io' && o.kind === 'ExternalSecret') {
      const r = o.spec?.secretStoreRef;
      add(component, o, 'spec.secretStoreRef', 'external-secrets.io', r?.kind ?? 'SecretStore', r?.kind === 'ClusterSecretStore' ? null : namespace(o), r?.name);
    }
    if (groupOf(o) === 'networking.k8s.io' && o.kind === 'Ingress') {
      add(component, o, 'spec.ingressClassName', 'networking.k8s.io', 'IngressClass', null, o.spec?.ingressClassName);
    }
  }
  return { scope: 'explicit-namespaces-and-certificate-secret-store-ingress-class-references', targetChecked: false,
    requirements: [...requirements.values()].sort((a, b) => key(a).localeCompare(key(b))) };
}
