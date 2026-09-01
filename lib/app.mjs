#!/usr/bin/env node
// cub app — the workload noun.
//
//   cub app list
//   cub app check <name>            render it for free; find out if it needs a platform
//   cub app upload <name> [--run]   create it in ConfigHub, one Unit per resource, release gated on review
//   cub app score <name>            export its workloads to Score (score.dev)
//
// An app is a workload. check renders it with no cluster and no account, and
// reports whether it is self-contained or needs a PLATFORM for its dependencies
// (an ingress controller, cert-manager, a Prometheus operator, external-secrets).
// A standalone app delivers straight from OCI; an app with dependencies lands on
// a platform that carries the stack it needs.

import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cub, parseDocs, pluginRoot, toYaml } from "./common.mjs";

const APPS_DIR = join(pluginRoot, "apps");
const args = process.argv.slice(2);
const verb = args[0];
const name = args[1];
const RUN = args.includes("--run");

function shellQuote(arg) {
  return /[^A-Za-z0-9_./=:-]/.test(arg) ? `'${arg.replace(/'/g, "'\\''")}'` : arg;
}
function splitRawDocs(text) {
  return text.split(/^---\s*$/m).map((part) => part.trim()).filter((part) => /(^|\n)kind:/.test(part));
}

// The platform services an app can depend on, keyed by what appears in its objects.
const DEPENDENCIES = [
  { when: (obj) => obj.kind === "Ingress", service: "an ingress controller", detail: (obj) => `Ingress ${obj.metadata?.name} (class ${obj.spec?.ingressClassName ?? "default"})` },
  { when: (obj) => String(obj.apiVersion).startsWith("cert-manager.io/"), service: "cert-manager", detail: (obj) => `${obj.kind} ${obj.metadata?.name}` },
  { when: (obj) => String(obj.apiVersion).startsWith("monitoring.coreos.com/"), service: "a Prometheus operator (kube-prometheus-stack)", detail: (obj) => `${obj.kind} ${obj.metadata?.name}` },
  { when: (obj) => String(obj.apiVersion).startsWith("external-secrets.io/"), service: "external-secrets", detail: (obj) => `${obj.kind} ${obj.metadata?.name}` },
];

function loadApp(appName) {
  const path = join(APPS_DIR, `${appName}.yaml`);
  if (!existsSync(path)) {
    console.error(`no such app "${appName}". Try: cub app list`);
    process.exit(2);
  }
  const objects = parseDocs(readFileSync(path, "utf8")).filter((doc) => doc?.kind && doc.metadata?.name);
  return { name: appName, path, objects };
}

function analyze(app) {
  const kinds = {};
  const createdNamespaces = new Set();
  const usedNamespaces = new Set();
  for (const obj of app.objects) {
    kinds[obj.kind] = (kinds[obj.kind] ?? 0) + 1;
    if (obj.kind === "Namespace") createdNamespaces.add(obj.metadata.name);
    if (obj.metadata?.namespace) usedNamespaces.add(obj.metadata.namespace);
  }
  const nsPrereqs = [...usedNamespaces].filter((namespace) => !createdNamespaces.has(namespace)).sort();
  const deps = [];
  for (const obj of app.objects) {
    for (const dep of DEPENDENCIES) {
      if (dep.when(obj)) deps.push({ service: dep.service, detail: dep.detail(obj) });
    }
  }
  return { kinds, nsPrereqs, deps };
}

// Convert the app's workloads to Score (score.dev/v1b1), one Workload per
// Deployment or StatefulSet. The objects are already literal, so env values and
// ports resolve rather than dangling.
function toScore(app) {
  const services = app.objects.filter((obj) => obj.kind === "Service");
  const hasIngress = app.objects.some((obj) => obj.kind === "Ingress");
  const workloads = app.objects.filter((obj) => obj.kind === "Deployment" || obj.kind === "StatefulSet");
  return workloads.map((workload) => {
    const containers = {};
    for (const container of workload.spec?.template?.spec?.containers ?? []) {
      const entry = { image: container.image };
      const vars = {};
      for (const env of container.env ?? []) if (env?.value != null) vars[env.name] = String(env.value);
      if (Object.keys(vars).length) entry.variables = vars;
      containers[container.name] = entry;
    }
    const scored = { apiVersion: "score.dev/v1b1", metadata: { name: workload.metadata.name }, containers };
    const service = services.find((svc) => svc.metadata?.name === workload.metadata?.name);
    if (service) {
      const ports = {};
      for (const port of service.spec?.ports ?? []) {
        ports[`port-${port.port}`] = port.targetPort ? { port: port.port, targetPort: port.targetPort } : { port: port.port };
      }
      if (Object.keys(ports).length) scored.service = { ports };
    }
    if (hasIngress) scored.resources = { route: { type: "route" } };
    return scored;
  });
}

const unitSlug = (obj) => `${obj.kind.toLowerCase()}-${obj.metadata.name}`;

if (verb === "list") {
  const files = readdirSync(APPS_DIR).filter((file) => file.endsWith(".yaml"));
  console.log(`\nAvailable apps\n`);
  for (const file of files.sort()) {
    const app = loadApp(file.replace(/\.yaml$/, ""));
    const { deps } = analyze(app);
    const tag = deps.length ? `needs a platform (${[...new Set(deps.map((dep) => dep.service))].length} deps)` : "standalone";
    console.log(`  ${app.name}  —  ${app.objects.length} objects, ${tag}`);
  }
  console.log(`\ncub app check <name>   # render and analyze, free\n`);
} else if (verb === "check") {
  if (!name) {
    console.error("usage: cub app check <name>");
    process.exit(2);
  }
  const app = loadApp(name);
  const { kinds, nsPrereqs, deps } = analyze(app);

  console.log(`\nApp: ${app.name}`);
  console.log(`Rendering the workload (free, no infrastructure)\n`);
  console.log("Installs");
  console.log(`  ${app.objects.length} objects: ${Object.entries(kinds).map(([kind, count]) => `${count} ${kind}`).join(", ")}`);
  console.log(`  namespaces that must already exist: ${nsPrereqs.length ? nsPrereqs.join(", ") : "none"}\n`);

  if (deps.length === 0) {
    console.log("Dependencies");
    console.log("  [PASS] standalone — no platform services required");
    console.log("  Delivers straight to a cluster from OCI, reconciled by your own Argo CD or Flux.\n");
  } else {
    console.log("Dependencies (this app needs a platform to provide these)");
    const byService = new Map();
    for (const dep of deps) {
      if (!byService.has(dep.service)) byService.set(dep.service, []);
      byService.get(dep.service).push(dep.detail);
    }
    for (const [service, details] of byService) {
      console.log(`  [NEEDS] ${service}`);
      for (const detail of details) console.log(`             ${detail}`);
    }
    console.log(`\n  Install onto a platform that carries those services (for example a cub stack such`);
    console.log(`  as web-platform), then your Argo CD or Flux reconciles it.\n`);
  }
} else if (verb === "upload") {
  if (!name) {
    console.error("usage: cub app upload <name> [--run]");
    process.exit(2);
  }
  const app = loadApp(name);
  const { deps } = analyze(app);
  const space = `${app.name}-app`;
  const docs = splitRawDocs(readFileSync(app.path, "utf8"));
  if (docs.length !== app.objects.length) {
    console.error(`could not split ${app.name} into one document per object (${docs.length} vs ${app.objects.length})`);
    process.exit(2);
  }

  const steps = [
    { kind: "cmd", desc: "create the app space", args: ["space", "create", space, "--component", app.name, "--variant", "app"] },
    ...app.objects.map((obj, index) => ({ kind: "unit", slug: unitSlug(obj), doc: docs[index], desc: `seed ${obj.kind} ${obj.metadata.name}` })),
    { kind: "cmd", desc: "gate the app release on review", args: ["trigger", "create", "--space", space, "-o", "json", "require-approval", "Mutation", "Kubernetes/YAML", "vet-approvedby", "1"] },
    { kind: "cmd", desc: "re-evaluate the seeded units against the gate", args: ["space", "update", "--patch", space, "--refresh-triggers"] },
  ];

  console.log(`\nApp upload ${app.name} ${RUN ? "(live)" : "(dry run, no changes)"}\n`);
  if (deps.length) {
    console.log(`  Note: needs a platform for ${[...new Set(deps.map((dep) => dep.service))].join(", ")}. Land it on a platform that carries those.\n`);
  }
  console.log("  Steps:");
  for (const step of steps) {
    if (step.kind === "unit") {
      console.log(`    cub unit create --space ${space} ${step.slug} ${step.slug}.yaml --change-desc ${shellQuote(`Seed ${step.slug} for app ${app.name}`)}`);
    } else {
      console.log(`    cub ${step.args.map(shellQuote).join(" ")}`);
    }
  }
  console.log("");

  if (!RUN) {
    console.log(`  Dry run. Add --run to upload, then \`cub unit approve\` releases the gated app.\n`);
    process.exit(0);
  }

  const tmp = mkdtempSync(join(tmpdir(), "cub-app-"));
  try {
    for (const step of steps) {
      process.stdout.write(`  ${step.desc}... `);
      if (step.kind === "unit") {
        const file = join(tmp, `${step.slug}.yaml`);
        writeFileSync(file, `${step.doc}\n`, "utf8");
        cub(["unit", "create", "--space", space, step.slug, file, "--change-desc", `Seed ${step.slug} for app ${app.name}`]);
      } else {
        cub(step.args);
      }
      console.log("ok");
    }
    const first = unitSlug(app.objects[0]);
    const gates = JSON.parse(cub(["unit", "get", first, "--space", space, "-o", "jq=.Unit.ApplyGates"]) || "null");
    const gated = gates && Object.keys(gates).length > 0;
    console.log(`\n  Uploaded. ${space} (${app.objects.length} units).`);
    console.log(`  Review gate on ${space}/${first}: ${gated ? "ACTIVE, release blocked until approved" : "not active"}`);
    console.log(`  The review: cub unit approve ${first} --space ${space}`);
    console.log(`  Tear down:  cub space delete --recursive-force ${space}\n`);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
} else if (verb === "score") {
  if (!name) {
    console.error("usage: cub app score <name>");
    process.exit(2);
  }
  const app = loadApp(name);
  const workloads = toScore(app);
  if (!workloads.length) {
    console.error(`no Deployment or StatefulSet in ${app.name} to convert.`);
    process.exit(1);
  }
  console.log(`# ${workloads.length} Score workload(s) from ${app.name}, ready for score-k8s\n`);
  for (const workload of workloads) console.log(`---\n${toYaml(workload)}`);
} else {
  console.log(`cub app — a workload: check it, upload it under governance, export it to Score

Usage:
  cub app list
  cub app check <name>
  cub app upload <name> [--run]
  cub app score <name>

This is the prototype of the proposed app verb, packaged as a cub plugin.`);
  process.exit(verb ? 2 : 0);
}
