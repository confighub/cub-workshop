import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseYaml } from "./common.mjs";

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

// Kubara's config.yaml names the clusters, which one is the hub, and which
// services each cluster enables. A directory under platform-configs is not
// evidence of a cluster: a renamed hub leaves its old one behind.
export function readKubaraConfig(workDir) {
  const path = join(workDir, "config.yaml");
  if (!existsSync(path)) throw new Error(`${workDir} has no config.yaml; from-kubara reads the clusters and the services each enables from Kubara's config`);
  const config = parseYaml(readFileSync(path));
  if (!Array.isArray(config?.clusters) || config.clusters.length === 0 || config.clusters.some((cluster) => !cluster?.name)) {
    throw new Error(`${path} names no clusters; is it a Kubara config.yaml?`);
  }
  return config;
}

export function enabledServices(cluster) {
  return Object.entries(cluster?.services ?? {}).filter(([, service]) => service?.status === "enabled").map(([name]) => name).sort();
}

// A cluster's values for one chart, in the order Kubara's ApplicationSet
// passes them: values.generated.yaml, additional-values.yaml, then
// values-*.yaml. The chart's own values.yaml applies first, as always.
export function kubaraValuesFiles(dir) {
  if (!existsSync(dir)) return [];
  const present = new Set(readdirSync(dir));
  const fixed = ["values.generated.yaml", "additional-values.yaml"].filter((file) => present.has(file));
  const extra = [...present].filter((file) => /^values-.*\.yaml$/.test(file)).sort();
  return [...fixed, ...extra].map((file) => join(dir, file));
}

function mergeValues(target, source) {
  for (const [key, value] of Object.entries(source ?? {})) {
    if (value && typeof value === "object" && !Array.isArray(value) && target[key] && typeof target[key] === "object" && !Array.isArray(target[key])) mergeValues(target[key], value);
    else target[key] = value;
  }
  return target;
}

// The services Kubara's hub delivers, as its ApplicationSets name them: the
// chart directory (path), the release name (name), and the namespace, which
// defaults to the name. They are read from the configured hub's argo-cd
// values, merged in the order Argo CD reads them.
export function kubaraApps(workDir, config) {
  const hub = config.clusters.find((cluster) => cluster.type === "hub")?.name;
  if (!hub) throw new Error("config.yaml names no hub, whose Argo CD delivers every service");
  const files = [join(workDir, "platform-components", "helm", "argo-cd", "values.yaml"), ...kubaraValuesFiles(join(workDir, "platform-configs", hub, "helm", "argo-cd"))];
  const merged = {};
  for (const file of files) {
    if (!existsSync(file)) continue;
    let values;
    try { values = parseYaml(readFileSync(file)); } catch (error) { throw new Error(`${file}: ${error.message}`); }
    if (values && typeof values === "object") mergeValues(merged, values);
  }
  const sets = merged.bootstrapValues?.applicationSets ?? {};
  if (Object.keys(sets).length === 0) throw new Error(`the hub ${hub}'s argo-cd values name no ApplicationSets; is this a platform Kubara generated?`);
  const apps = [];
  for (const setName of Object.keys(sets).sort()) {
    const list = sets[setName]?.apps ?? {};
    for (const key of Object.keys(list).sort()) {
      const app = list[key];
      if (!app?.name || !app?.path) continue;
      apps.push({ name: String(app.name), path: String(app.path), namespace: String(app.namespace || app.name), sources: app.sources });
    }
  }
  return apps;
}
