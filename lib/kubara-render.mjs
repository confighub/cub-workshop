// The API versions a set of rendered objects makes available, in the two forms
// `helm template --api-versions` accepts: "group/version" and
// "group/version/Kind". Kubara ships CRDs in bootstrap-crds and renders each
// component offline, so a chart that checks .Capabilities for an API another
// component provides (Traefik's ServiceMonitor, for example) needs them passed.
export function crdApiVersions(objects) {
  const out = new Set();
  for (const obj of objects ?? []) {
    if (obj?.kind !== "CustomResourceDefinition") continue;
    const group = obj.spec?.group;
    const kind = obj.spec?.names?.kind;
    if (!group) continue;
    for (const version of obj.spec?.versions ?? []) {
      if (!version?.name || version.served === false) continue;
      out.add(`${group}/${version.name}`);
      if (kind) out.add(`${group}/${version.name}/${kind}`);
    }
  }
  return [...out].sort();
}

export function apiVersionArgs(apiVersions) {
  return [...apiVersions].sort().flatMap((value) => ["--api-versions", value]);
}
