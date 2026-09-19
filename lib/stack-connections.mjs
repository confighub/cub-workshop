import { createRequire } from "node:module";
import { isIP } from "node:net";

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

function promtailContainers(workload) {
  const containers = workload.spec?.template?.spec?.containers ?? [];
  const identified = containers.filter((container) => /promtail/i.test(String(container.name ?? "")) || /promtail/i.test(String(container.image ?? "")));
  if (identified.length) return identified;
  // A workload name alone is weak evidence. In that case follow only a
  // container that explicitly selects a Promtail config file.
  return /promtail/i.test(String(workload.metadata?.name ?? ""))
    ? containers.filter((container) => (container.args ?? []).some((arg) => /(?:^|-)config\.file(?:=|$)/.test(String(arg))))
    : [];
}

function mountedSources(workload) {
  const pod = workload.spec?.template?.spec ?? {};
  const volumes = new Map((pod.volumes ?? []).filter((volume) => volume?.name).map((volume) => [volume.name, volume]));
  const sources = new Map();
  for (const container of promtailContainers(workload)) {
    for (const mount of container.volumeMounts ?? []) {
      const volume = volumes.get(mount.name);
      const source = volume?.secret ? { kind: "Secret", name: volume.secret.secretName, items: volume.secret.items } : volume?.configMap ? { kind: "ConfigMap", name: volume.configMap.name, items: volume.configMap.items } : null;
      if (!source?.name) continue;
      const id = `${source.kind}|${source.name}`;
      let keys = source.items ? new Set(source.items.filter((item) => item?.key && (!mount.subPath || item.path === mount.subPath)).map((item) => item.key)) : null;
      if (mount.subPath && !source.items) keys = new Set([mount.subPath]);
      if (!sources.has(id)) sources.set(id, keys);
      else if (keys === null) sources.set(id, null);
      else if (sources.get(id) !== null) for (const key of keys) sources.get(id).add(key);
    }
  }
  return sources;
}

function mountedConfigValues(workload, objects) {
  const ns = namespace(workload);
  const wanted = mountedSources(workload);
  return objects.filter((object) => wanted.has(`${object.kind}|${object.metadata?.name}`) && namespace(object) === ns)
    .flatMap((object) => {
      const keys = wanted.get(`${object.kind}|${object.metadata?.name}`);
      if (object.kind === "ConfigMap") return Object.entries(object.data ?? {}).filter(([key, value]) => (!keys || keys.has(key)) && typeof value === "string").map(([, value]) => ({ object, value }));
      const values = [];
      const stringData = object.stringData ?? {};
      for (const [key, value] of Object.entries(stringData)) if ((!keys || keys.has(key)) && typeof value === "string") values.push({ object, value });
      for (const [key, value] of Object.entries(object.data ?? {})) {
        if ((!keys || keys.has(key)) && !Object.hasOwn(stringData, key) && typeof value === "string") values.push({ object, value: Buffer.from(value, "base64").toString("utf8") });
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

function namespaceIndex(objects) {
  return new Set(objects.filter((object) => object.kind === "Namespace" && object.metadata?.name).map((object) => object.metadata.name));
}

function destination(url) {
  let parsed;
  try { parsed = new URL(url); } catch { return null; }
  if (!["http:", "https:"].includes(parsed.protocol)) return null;
  const host = String(parsed.hostname ?? "").toLowerCase().replace(/\.$/, "");
  if (!host || isIP(host)) return null;
  const labels = host.split(".");
  if (labels.length === 1) return { host, service: labels[0], explicitNamespace: null, serviceDns: true };
  if (labels.length === 2) return { host, service: labels[0], explicitNamespace: labels[1], serviceDns: false, ambiguous: true };
  if (labels.length === 3 && labels[2] === "svc") return { host, service: labels[0], explicitNamespace: labels[1], serviceDns: true };
  if (labels.length === 5 && labels[2] === "svc" && labels[3] === "cluster" && labels[4] === "local") return { host, service: labels[0], explicitNamespace: labels[1], serviceDns: true };
  return { host, service: labels[0], explicitNamespace: null, serviceDns: false, ambiguous: false };
}

export function checkPromtailLokiConnections(stack) {
  const objects = stack.components.flatMap((component) => component.objects ?? []);
  const services = serviceIndex(objects);
  const declaredNamespaces = namespaceIndex(objects);
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
      if (target.ambiguous && !declaredNamespaces.has(target.explicitNamespace)) { unknown.push({ component: component.name, workload: workload.metadata?.name, host: target.host, reason: "ambiguous-endpoint" }); continue; }
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
