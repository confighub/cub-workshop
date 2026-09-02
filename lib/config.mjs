#!/usr/bin/env node
// cub config — the smallest noun: one config, one chart.
//
//   cub config list
//   cub config check <name>   render it for free and see what it installs
//
// This is the CLI form of the anonymous browser Check: render a chart from the
// catalog, see what it installs, and see the lifecycle work it carries (CRDs,
// hooks, admission webhooks, setup Jobs). No cluster, no account. It is the
// first rung of the noun family: cub config, cub app, cub stack, cub fleet.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocs, pluginRoot } from "./common.mjs";
import { publishBundle, verifyBundle } from "./oci.mjs";
import { buildReceipt, printPublished } from "./receipt.mjs";

const RENDERS_DIR = join(pluginRoot, "renders");
const args = process.argv.slice(2);
const [verb, name] = args;
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;

function loadConfig(configName) {
  const path = join(RENDERS_DIR, `${configName}.yaml`);
  if (!existsSync(path)) {
    console.error(`no such config "${configName}". Try: cub config list`);
    process.exit(2);
  }
  const objects = parseDocs(readFileSync(path, "utf8")).filter((doc) => doc?.kind && doc.metadata?.name);
  return { name: configName, objects };
}

function analyze(config) {
  const kinds = {};
  const created = new Set();
  const used = new Set();
  const crds = [];
  let hooks = 0;
  let jobs = 0;
  let webhooksNeedingCa = 0;
  for (const obj of config.objects) {
    kinds[obj.kind] = (kinds[obj.kind] ?? 0) + 1;
    if (obj.kind === "Namespace") created.add(obj.metadata.name);
    if (obj.metadata?.namespace) used.add(obj.metadata.namespace);
    if (obj.kind === "CustomResourceDefinition") crds.push(obj.metadata.name);
    if (obj.metadata?.annotations?.["helm.sh/hook"]) hooks += 1;
    if (obj.kind === "Job") jobs += 1;
    if (String(obj.kind).endsWith("WebhookConfiguration") && (obj.webhooks ?? []).some((hook) => !hook.clientConfig?.caBundle)) webhooksNeedingCa += 1;
  }
  const nsPrereqs = [...used].filter((namespace) => !created.has(namespace)).sort();
  return { kinds, nsPrereqs, crds, hooks, jobs, webhooksNeedingCa };
}

if (verb === "list") {
  console.log(`\nAvailable configs (verified chart renders shipped with the plugin)\n`);
  for (const file of readdirSync(RENDERS_DIR).filter((entry) => entry.endsWith(".yaml")).sort()) {
    console.log(`  ${file.replace(/\.yaml$/, "")}`);
  }
  console.log(`\ncub config check <name>   # render and check, free\n`);
} else if (verb === "check") {
  if (!name) {
    console.error("usage: cub config check <name>");
    process.exit(2);
  }
  const config = loadConfig(name);
  const facts = analyze(config);

  console.log(`\nConfig: ${config.name}`);
  console.log(`Rendering the chart from the catalog (free, no infrastructure)\n`);
  console.log("Installs");
  console.log(`  ${config.objects.length} objects: ${Object.entries(facts.kinds).sort().map(([kind, count]) => `${count} ${kind}`).join(", ")}`);
  console.log(`  namespaces that must already exist: ${facts.nsPrereqs.length ? facts.nsPrereqs.join(", ") : "none"}\n`);

  console.log("Lifecycle work");
  console.log(`  ${facts.crds.length ? "[NOTE]" : "[PASS]"} CRDs: ${facts.crds.length}${facts.crds.length ? " (apply and establish before any custom resource)" : ""}`);
  console.log(`  ${facts.hooks ? "[NOTE]" : "[PASS]"} Helm hooks: ${facts.hooks}`);
  console.log(`  ${facts.jobs ? "[NOTE]" : "[PASS]"} setup Jobs: ${facts.jobs}`);
  console.log(`  ${facts.webhooksNeedingCa ? "[NOTE]" : "[PASS]"} admission webhooks needing a certificate: ${facts.webhooksNeedingCa}`);
  console.log(`\n  Free look before you install. Compose it into a cub stack, or run it as a cub app.\n`);
  if (OUT && OUT.startsWith("oci://")) {
    const content = readFileSync(join(RENDERS_DIR, `${config.name}.yaml`));
    const files = [{ path: `${config.name}.yaml`, content }];
    const checks = [
      ["PASS", `${config.objects.length} objects`],
      [facts.crds.length ? "NOTE" : "PASS", `CRDs: ${facts.crds.length}`],
      [facts.hooks ? "NOTE" : "PASS", `Helm hooks: ${facts.hooks}`],
      [facts.jobs ? "NOTE" : "PASS", `setup Jobs: ${facts.jobs}`],
      [facts.webhooksNeedingCa ? "NOTE" : "PASS", `admission webhooks needing a certificate: ${facts.webhooksNeedingCa}`],
      ["PASS", `namespaces that must already exist: ${facts.nsPrereqs.join(", ") || "none"}`],
    ];
    const receipt = buildReceipt({ name: config.name, source: { kind: "render", name: config.name, origin: "cub-workshop renders/" }, files, checks });
    const published = publishBundle({ reference: OUT, files, receipt, title: config.name });
    printPublished(`config ${config.name}`, { ...published, receipt });
    const back = verifyBundle(receipt.spec.bundle.reference);
    console.log(`    pull-back: ${back.verified ? "verified" : "REFUSED"}\n`);
    if (!back.verified) process.exit(1);
  } else if (OUT) {
    writeFileSync(OUT, readFileSync(join(RENDERS_DIR, `${config.name}.yaml`)));
    console.log(`  Wrote the render to ${OUT}\n`);
  }
} else if (verb === "verify") {
  if (!name) { console.error("usage: cub config verify oci://<repo>@sha256:<digest>"); process.exit(2); }
  const result = verifyBundle(name);
  console.log(`\nVerify ${name}\n`);
  for (const [mark, text] of result.findings) console.log(`  [${mark}] ${text}`);
  if (result.receipt) {
    const spec = result.receipt.spec ?? {};
    console.log(`  producer: ${spec.producer?.name ?? "unknown"} ${spec.producer?.version ?? ""}`.trimEnd());
    for (const check of spec.checks ?? []) console.log(`  [${check.result}] ${check.text}`);
  }
  console.log(`  => ${result.verified ? "VERIFIED" : "REFUSED"}\n`);
  process.exit(result.verified ? 0 : 1);
} else {
  console.log(`cub config — one config, one chart: render it for free and see what it installs

Usage:
  cub config list
  cub config check <name> [--out oci://<repo>[:tag] | --out file.yaml]
  cub config verify oci://<repo>@sha256:<digest>

This is the prototype of the proposed config verb, packaged as a cub plugin.`);
  process.exit(verb ? 2 : 0);
}
