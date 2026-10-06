#!/usr/bin/env node
import { loadInput } from "./local-input.mjs";
// cub app — the workload noun.
//
//   cub app list
//   cub app check <name | local.yaml> [--out oci://<repo>[:tag] [--sign cosign.key] | --out file.yaml]
//                                   render it for free; find out if it needs a platform
//   cub app match <workload.yaml> --target <nodes.yaml> [--json] [--out result.json]
//                                   compare declared node selectors and GPU count offline (lib/app-match.mjs)
//   cub app upload <name> [--run]   import it into ConfigHub as the component's base
//   cub app score <name>            export its workloads to Score (score.dev)
//
// An app is a workload. check renders it with no cluster and no account, and
// reports whether it is self-contained or needs a PLATFORM for its dependencies
// (an ingress controller, cert-manager, a Prometheus operator, external-secrets).
// A standalone app delivers straight from OCI; an app with dependencies lands on
// a platform that carries the stack it needs.

import { DEPENDENCIES } from "./needs.mjs";
import { readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cub, pluginRoot, readYamlFile, toYaml } from "./common.mjs";
import { publishBundle, signDigest, verifyBundle } from "./oci.mjs";
import { buildReceipt, printPublished } from "./receipt.mjs";

const APPS_DIR = join(pluginRoot, "apps");
const args = process.argv.slice(2);
const verb = args[0];
const name = args[1];
const RUN = args.includes("--run");
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
const SIGN = args.includes("--sign") ? args[args.indexOf("--sign") + 1] : null;

function shellQuote(arg) {
  return /[^A-Za-z0-9_./=:-]/.test(arg) ? `'${arg.replace(/'/g, "'\\''")}'` : arg;
}
// The platform services an app can depend on live in needs.mjs, shared with stack check.

function loadApp(name) {
  try { return loadInput(name, APPS_DIR, "app"); }
  catch (error) { console.error(error.message); process.exit(2); }
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

if (verb === "list") {
  const files = readdirSync(APPS_DIR).filter((file) => file.endsWith(".yaml"));
  console.log(`\nAvailable apps\n`);
  for (const file of files.sort()) {
    const app = loadApp(file.replace(/\.yaml$/, ""));
    const { deps } = analyze(app);
    const tag = deps.length ? `needs a platform (${[...new Set(deps.map((dep) => dep.service))].length} deps)` : "standalone";
    console.log(`  ${app.name}  —  ${app.objects.length} objects, ${tag}`);
  }
  console.log(`\ncub app check <name | local.yaml>   # render and analyze, free\n`);
} else if (verb === "check") {
  if (!name) {
    console.error("usage: cub app check <name | local.yaml> [--out oci://<repo>[:tag] [--sign cosign.key] | --out file.yaml]");
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
    console.log("  [NOTE] no recognized platform-service dependencies in these objects");
    console.log("  Target prerequisites and application readiness are not checked.\n");
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
    // A shipped stack that already places this app is the one to point at,
    // leaving out the demonstrations built to be refused; otherwise any
    // platform carrying these services will do.
    const placing = readdirSync(join(pluginRoot, "stacks")).filter((file) => file.endsWith(".yaml"))
      .map((file) => ({ name: file.replace(/\.yaml$/, ""), stack: readYamlFile(join(pluginRoot, "stacks", file)) }))
      .filter(({ stack }) => !/refuse/i.test(stack?.spec?.description ?? "") && (stack?.spec?.components ?? []).some((comp) => comp.authored === `apps/${app.name}.yaml`))
      .map(({ name }) => name).sort((a, b) => a.length - b.length || a.localeCompare(b));
    console.log(placing.length
      ? `\n  Install onto a platform that carries those services. ${placing.map((stack) => `cub stack sandbox ${stack}`).join(" or ")}\n  checks one that already places ${app.name}; then your Argo CD or Flux reconciles it.\n`
      : `\n  Install onto a platform that carries those services (for example a cub stack such\n  as web-platform), then your Argo CD or Flux reconciles it.\n`);
  }
  if (OUT && OUT.startsWith("oci://")) {
    const content = app.bytes;
    const files = [{ path: `${app.name}.yaml`, content }];
    const services = [...new Set(deps.map((dep) => dep.service))];
    const checks = [
      ["PASS", `${app.objects.length} objects`],
      [services.length ? "NEEDS" : "NOTE", services.length ? `needs a platform for ${services.join(", ")}` : "no recognized platform-service dependencies; target readiness not checked"],
      ["PASS", `namespaces that must already exist: ${nsPrereqs.join(", ") || "none"}`],
    ];
    const receipt = buildReceipt({ name: app.name, source: { kind: "authored", name: app.name, origin: app.local ? "local-file" : "cub-workshop apps/" }, files, checks });
    const published = publishBundle({ reference: OUT, files, receipt, title: app.name });
    if (SIGN) signDigest({ reference: receipt.spec.bundle.reference, digest: published.digest, key: SIGN });
    printPublished(`app ${app.name}`, { ...published, receipt });
    const back = verifyBundle(receipt.spec.bundle.reference);
    console.log(`    pull-back: ${back.verified ? "verified" : "REFUSED"}\n`);
    if (!back.verified) process.exit(1);
  } else if (OUT) {
    writeFileSync(OUT, app.bytes, { flag: "wx" });
    console.log(`  Wrote the local input to ${OUT}\n`);
  }
} else if (verb === "upload") {
  if (!name) {
    console.error("usage: cub app upload <name> [--run]");
    process.exit(2);
  }
  if (args.slice(2).some((arg) => arg !== "--run") || args.filter((arg) => arg === "--run").length > 1) {
    console.error("usage: cub app upload <name> [--run]");
    process.exit(2);
  }
  const app = loadApp(name);
  const { deps } = analyze(app);
  const space = `${app.name}-base`;
  const namespaces = [...new Set(app.objects.map((obj) => obj.metadata?.namespace).filter(Boolean))];
  const createdNamespaces = new Set(app.objects.filter((obj) => obj.kind === "Namespace").map((obj) => obj.metadata.name));
  const missingNamespaces = namespaces.filter((namespace) => !createdNamespaces.has(namespace));
  const namespaceArgs = missingNamespaces.length === 1 && namespaces.length === 1
    ? ["--namespace", namespaces[0], "--create-namespace"] : [];
  const upload = ["variant", "upload", "--component", app.name, "--variant", "base", "--owner", app.name, ...namespaceArgs, app.path];

  console.log(`\nApp import ${app.name} ${RUN ? "(live)" : "(dry run, no changes)"}\n`);
  if (deps.length) {
    console.log(`  This app needs a platform for ${[...new Set(deps.map((dep) => dep.service))].join(", ")}. Importing its base is safe; do not deploy it alone.\n`);
  }
  console.log("  Import one source bundle as the reusable base:");
  console.log(`    cub ${upload.map(shellQuote).join(" ")}`);
  console.log("");

  if (!RUN) {
    console.log(`  Dry run. Add --run to create ${space}. Nothing is deployed.\n`);
    process.exit(0);
  }

  process.stdout.write(`  importing ${space}... `);
  cub(upload);
  console.log("ok");
  console.log(`\n  Created or updated ${space}. Nothing is deployed.`);
  console.log(`  Review the imported Component: cub component open ${app.name}`);
  if (deps.length === 0) {
    const namespace = namespaces.length === 1 ? ` --namespace ${shellQuote(namespaces[0])}` : "";
    console.log("  After `cub cluster up --name demo`, put a deployment on its target:");
    console.log(`    cub variant create dev ${space} --target demo/target${namespace}`);
    console.log(`    cub release publish ${app.name}-dev`);
  } else {
    console.log("  Next: choose a checked platform that carries the named dependencies, then create its target-bound variant.");
  }
  console.log(`  Tear down the imported base: cub space delete --recursive-force ${space}\n`);
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
  console.log(`cub app — a workload: check it, match it to nodes, import its reusable base, export it to Score

Usage:
  cub app list
  cub app check <name | local.yaml> [--out oci://<repo>[:tag] [--sign cosign.key] | --out file.yaml]
  cub app match <workload.yaml> --target <nodes.yaml> [--json] [--out result.json]
  cub app upload <name> [--run]
  cub app score <name>

match compares a workload's declared node selectors and GPU count with a node list, offline.
A candidate is not readiness or execution proof. upload is a dry run until --run and never deploys.

This is the prototype of the proposed app verb, packaged as a cub plugin.`);
  process.exit(verb ? 2 : 0);
}
