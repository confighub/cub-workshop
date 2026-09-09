// Check only CRs whose exact group/kind has a CRD in the supplied object set.
// Unmatched objects are not validated; this is not target API discovery.
export function checkStackApiVersions(objects) {
  const definitions = new Map();
  for (const object of objects) {
    if (object.apiVersion !== 'apiextensions.k8s.io/v1' || object.kind !== 'CustomResourceDefinition') continue;
    const key = `${object.spec?.group}/${object.spec?.names?.kind}`;
    const entries = definitions.get(key) ?? [];
    entries.push(object);
    definitions.set(key, entries);
  }
  const checked = [], incompatible = [];
  for (const object of objects) {
    const [group, version] = String(object.apiVersion).split('/');
    const crds = definitions.get(`${group}/${object.kind}`);
    if (!crds) continue;
    const identity = [object.apiVersion, object.kind, object.metadata?.namespace ?? '', object.metadata?.name ?? ''].join('|');
    const servedVersions = [...new Set(crds.flatMap(crd => (crd.spec.versions ?? []).filter(v => v.served === true).map(v => v.name)))].sort();
    const entry = { identity, crds: crds.map(crd => crd.metadata.name).sort(), servedVersions };
    checked.push(entry);
    // Conflicting duplicate CRDs must not be combined into apparent compatibility.
    if (crds.length !== 1 || !servedVersions.includes(version)) {
      incompatible.push({ ...entry, reason: crds.length !== 1 ? 'ambiguous-crd' : 'version-not-served' });
    }
  }
  return { checked, incompatible };
}
