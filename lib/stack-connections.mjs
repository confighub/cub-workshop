import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const yaml = require("./yaml.cjs");

// Static, deliberately narrow connection check. It only follows configuration
// mounted by a workload identified as Promtail and only reads Promtail's
// clients[].url values from that mounted object.

function namespace(object) {
  return object?.metadata?.namespace ?? "default";
}

function workloadIsPromtail(object) {
  if (!object || !["DaemonSet", "Deployment", "StatefulSet"].includes(object.kind)) return false;
  const containers = object.spec?.template?.spec?.containers ?? [];
  return containers.some((container) => /promtail/i.test(String(container.name ?? "")) || /promtail/i.test(String(container.image ?? "")))
    || /promtail/i.test(String(object.metadata?.name ?? ""));
}

function mountedNames(workload) {
  const pod = workload.spec?.template?.spec ?? {};
  const volumes = new Map((pod.volumes ?? []).filter((volume) => volume?.name).map((volume) => [volume.name, volume]));
  const names = new Set();
  for (const container of pod.containers ?? []) {
    for (const mount of container.volumeMounts ?? []) {
      const volume = volumes.get(mount.name);
      if (volume?.secret?.secretName) names.add(`Secret|${volume.secret.secretName}`);
      if (volume?.configMap?.name) names.add(`ConfigMap|${volume.configMap.name}`);
    }
  }
  return names;
}

function mountedConfigValues(workload, objects) {
  const ns = namespace(workload);
  const wanted = mountedNames(workload);
  return objects.filter((object) => wanted.has(`${object.kind}|${object.metadata?.name}`) && namespace(object) === ns)
    .flatMap((object) => {
      if (object.kind === "ConfigMap") return Object.values(object.data ?? {}).filter((value) => typeof value === "string").map((value) => ({ object, value }));
      const values = [];
      for (const value of Object.values(object.stringData ?? {})) if (typeof value === "string") values.push({ object, value });
      for (const [key, value] of Object.entries(object.data ?? {})) {
        if (typeof value !== "string") continue;
        try { values.push({ object, value: Buffer.from(value, "base64").toString("utf8") }); } catch { /* unknown secret payload */ }
      }
      return values;
    });
}

function clientUrls(value) {
  let parsed;
  try { parsed = yaml.load(value); } catch { return []; }
  if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.clients)) return [];
  return parsed.clients.filter((client) => typeof client?.url === "string").map((client) => client.url);
}

function serviceIndex(objects) {
  const services = new Map();
  for (const object of objects) {
    if (object.kind !== "Service" || !object.metadata?.name) continue;
    const key = object.metadata.name;
    const ns = namespace(object);
    if (!services.has(key)) services.set(key, new Set());
    services.get(key).add(ns);
  }
  return services;
}

function destination(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  const host = String(parsed.hostname ?? "").toLowerCase().replace(/\.$/, "");
  if (!host || host.includes(":")) return null;
  const labels = host.split(".");
  if (labels.length === 1) return { host, service: labels[0], explicitNamespace: null, serviceDns: true };
  if (labels.length === 2) return { host, service: labels[0], explicitNamespace: labels[1], serviceDns: false, ambiguous: true };
  if (labels[2] === "svc") return { host, service: labels[0], explicitNamespace: labels[1], serviceDns: true };
  if (labels.length >= 4 && labels[2] === "svc" && labels[3] === "cluster") return { host, service: labels[0], explicitNamespace: labels[1], serviceDns: true };
  return { host, service: labels[0], explicitNamespace: null, serviceDns: false, ambiguous: false };
}

export function checkPromtailLokiConnections(stack) {
  const objects = stack.components.flatMap((component) => component.objects ?? []);
  const services = serviceIndex(objects);
  const mismatches = [];
  const checked = [];
  const unknown = [];
  for (const component of stack.components) for (const workload of component.objects ?? []) {
    if (!workloadIsPromtail(workload)) continue;
    const callerNamespace = namespace(workload);
    for (const mounted of mountedConfigValues(workload, objects)) for (const url of clientUrls(mounted.value)) {
      const target = destination(url);
      if (!target) { unknown.push({ component: component.name, workload: workload.metadata?.name, reason: "unparseable-url" }); continue; }
      if (!target.serviceDns && !target.ambiguous) { unknown.push({ component: component.name, workload: workload.metadata?.name, host: target.host, reason: "external-endpoint" }); continue; }
      const namespaces = services.get(target.service);
      const expectedNamespace = target.explicitNamespace ?? callerNamespace;
      // A two-label host may be external. Classify it as a Kubernetes service
      // only when the stack supplies concrete same-name Service evidence.
      if (!namespaces) { unknown.push({ component: component.name, workload: workload.metadata?.name, host: target.host, reason: "service-not-shipped" }); continue; }
      checked.push({ component: component.name, workload: workload.metadata?.name, host: target.host, namespace: expectedNamespace });
      if (!namespaces.has(expectedNamespace)) mismatches.push({
        component: component.name,
        workload: workload.metadata?.name,
        workloadNamespace: callerNamespace,
        configKind: mounted.object.kind,
        configName: mounted.object.metadata?.name,
        host: target.host,
        expectedNamespace,
        actualNamespaces: [...namespaces].sort(),
      });
    }
  }
  return { mismatches, checked, unknown };
}
