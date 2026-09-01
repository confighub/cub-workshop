#!/usr/bin/env node
// cub stack — a certified composition of components, spoken by name.
//
//   cub stack list
//   cub stack certify <name>     the gate alone; exits non-zero on a conflict
//   cub stack sandbox <name>     certify, then render the composition for free
//   cub stack upload <name> [--run]   build the base Spaces and profile links in ConfigHub
//
// A stack manifest names its components as digest-pinned certified bundles,
// which are pulled once and hash-verified against the receipts shipped with
// this plugin, or as authored YAML files the stack owns. This command is the
// prototype of the proposed stack verb, packaged so it runs as cub itself.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { canonicalMap, cub, fail, identity, parseDocs, pluginRoot, readYamlFile, resolveBundle } from "./common.mjs";

const STACKS_DIR = join(pluginRoot, "stacks");
const args = process.argv.slice(2);
const verb = args[0];
const name = args[1];
const RUN = args.includes("--run");
const PLANE_RANK = { hub: 0, mgmt: 1, workload: 2 };
const PASS = "PASS"; const WARN = "WARN"; const FAIL = "FAIL";

function loadStack(stackName) {
  const path = join(STACKS_DIR, `${stackName}.yaml`);
  if (!existsSync(path)) fail(`no such stack "${stackName}". Try: cub stack list`);
  const stack = readYamlFile(path);
  const components = (stack.spec?.components ?? []).map((comp) => {
    let objects;
    if (comp.bundle) objects = resolveBundle(comp);
    else {
      const source = comp.render ?? comp.authored;
      const filePath = join(pluginRoot, source ?? "");
      if (!source || !existsSync(filePath)) fail(`component "${comp.name}" source is missing: ${source}`);
      objects = parseDocs(readFileSync(filePath, "utf8"));
    }
    objects = objects.filter((doc) => doc?.kind && doc.metadata?.name);
    return { ...comp, objects };
  });
  if (components.some((comp) => comp.plane)) {
    components.sort((a, b) => (PLANE_RANK[a.plane] ?? 9) - (PLANE_RANK[b.plane] ?? 9) || (a.order ?? 0) - (b.order ?? 0));
  }
  return { name: stack.metadata?.name ?? stackName, description: stack.spec?.description ?? "", bindings: stack.spec?.bindings, components };
}

function certify(stack) {
  const findings = [];
  let hardFailures = 0;
  const owners = new Map();
  let objectCount = 0;
  for (const comp of stack.components) for (const obj of comp.objects) {
    objectCount += 1;
    const id = identity(obj);
    if (!owners.has(id)) owners.set(id, []);
    owners.get(id).push({ comp: comp.name, body: JSON.stringify(obj) });
  }
  const crossConflicts = []; const differingDupes = []; const identicalDupes = [];
  for (const [id, claims] of owners.entries()) {
    if (claims.length < 2) continue;
    const comps = new Set(claims.map((claim) => claim.comp));
    const bodies = new Set(claims.map((claim) => claim.body));
    if (comps.size > 1) crossConflicts.push([id, [...comps]]);
    else if (bodies.size > 1) differingDupes.push([id, claims[0].comp]);
    else identicalDupes.push([id, claims[0].comp, claims.length]);
  }
  if (crossConflicts.length === 0 && differingDupes.length === 0) {
    findings.push([PASS, `no resource conflicts across components (${objectCount} objects)`]);
  } else {
    hardFailures += crossConflicts.length + differingDupes.length;
    if (crossConflicts.length) {
      findings.push([FAIL, `${crossConflicts.length} resource conflict(s) — the same object is claimed by more than one component:`]);
      for (const [id, comps] of crossConflicts.slice(0, 4)) findings.push(["    ", `${id}  <=  ${comps.join(" + ")}`]);
    }
    if (differingDupes.length) {
      findings.push([FAIL, `${differingDupes.length} object(s) appear twice inside one component with different content:`]);
      for (const [id, comp] of differingDupes.slice(0, 4)) findings.push(["    ", `${id}  inside  ${comp}`]);
    }
  }
  if (identicalDupes.length) {
    findings.push([WARN, `${identicalDupes.length} object(s) carried more than once inside one component with identical content; the last occurrence wins at apply:`]);
    for (const [id, comp, count] of identicalDupes.slice(0, 4)) findings.push(["    ", `${id}  x${count}  inside  ${comp}`]);
  }

  const crdGroups = new Map(); let crdCount = 0;
  for (const comp of stack.components) for (const obj of comp.objects) {
    if (obj.kind === "CustomResourceDefinition" && obj.spec?.group) { crdGroups.set(obj.spec.group, comp.name); crdCount += 1; }
  }
  const order = new Map(stack.components.map((comp, index) => [comp.name, index]));
  let crCount = 0; let crOrderingProblems = 0;
  for (const comp of stack.components) for (const obj of comp.objects) {
    const group = String(obj.apiVersion ?? "").split("/")[0];
    if (obj.kind !== "CustomResourceDefinition" && crdGroups.has(group)) {
      crCount += 1;
      if (order.get(crdGroups.get(group)) > order.get(comp.name)) crOrderingProblems += 1;
    }
  }
  if (crdCount === 0) findings.push([PASS, "no CRDs in this stack, so no CRD-before-CR ordering to enforce"]);
  else if (crOrderingProblems === 0) findings.push([PASS, `CRD ordering: ${crdCount} CRDs are delivered before the ${crCount} custom resources that need them`]);
  else { hardFailures += crOrderingProblems; findings.push([FAIL, `${crOrderingProblems} custom resource(s) are ordered before the component that ships their CRD`]); }

  let emptyWebhooks = 0;
  for (const comp of stack.components) for (const obj of comp.objects) {
    if (String(obj.kind).endsWith("WebhookConfiguration") && (obj.webhooks ?? []).some((hook) => !hook.clientConfig?.caBundle)) emptyWebhooks += 1;
  }
  const hasCertManager = crdGroups.has("cert-manager.io") || stack.components.some((comp) => /cert-manager/.test(comp.name));
  if (emptyWebhooks === 0) findings.push([PASS, "no admission webhooks need a certificate"]);
  else findings.push([WARN, `${emptyWebhooks} admission webhook(s) need a caBundle — ${hasCertManager ? "cert-manager is in the stack and can issue it" : "no cert-manager in the stack; the reconciler must supply the certificate"}`]);

  const created = new Set(); const used = new Set();
  for (const comp of stack.components) for (const obj of comp.objects) {
    if (obj.kind === "Namespace") created.add(obj.metadata.name);
    if (obj.metadata?.namespace) used.add(obj.metadata.namespace);
  }
  const prereqs = [...used].filter((namespace) => !created.has(namespace)).sort();
  findings.push([PASS, `namespaces: ${created.size} created, ${prereqs.length} must already exist${prereqs.length ? ` (${prereqs.join(", ")})` : ""}`]);

  return { certified: hardFailures === 0, findings, objectCount };
}

function printHeader(stack) {
  console.log(`\nStack: ${stack.name}  —  ${stack.description}`);
  console.log(`Resolving ${stack.components.length} components: ${stack.components.map((comp) => comp.name).join(", ")}\n`);
}

function printCertify(result) {
  console.log("Certify");
  for (const [mark, text] of result.findings) console.log(mark === "    " ? `      ${text}` : `  [${mark}] ${text}`);
  console.log(`  => ${result.certified ? "CERTIFIED" : "REJECTED"}\n`);
}

if (verb === "list") {
  console.log(`\nAvailable stacks\n`);
  for (const file of readdirSync(STACKS_DIR).filter((entry) => entry.endsWith(".yaml")).sort()) {
    const stack = readYamlFile(join(STACKS_DIR, file));
    console.log(`  ${stack.metadata?.name ?? file}  —  ${stack.spec?.description ?? ""}`);
    console.log(`      ${(stack.spec?.components ?? []).map((comp) => comp.name).join(", ")}`);
  }
  console.log(`\ncub stack sandbox <name>   # certify and render, free\n`);
} else if (verb === "certify" || verb === "sandbox") {
  if (!name) fail(`usage: cub stack ${verb} <name>`);
  const stack = loadStack(name);
  printHeader(stack);
  const result = certify(stack);
  printCertify(result);
  if (verb === "sandbox") {
    if (result.certified) {
      console.log("Sandbox render  (free, no infrastructure)");
      console.log(`  ${result.objectCount} objects total`);
      for (const comp of stack.components) {
        const planeNote = comp.plane ? `  [${comp.plane}${comp.plane === "hub" ? ": held in ConfigHub, never applied" : ""}]` : "";
        console.log(`      ${comp.name}: ${comp.objects.length}${planeNote}${comp.authored ? "  [authored]" : ""}`);
      }
      console.log(`\n  Ready. \`cub stack upload ${stack.name} --run\` builds the base Spaces and links in ConfigHub.\n`);
    } else {
      console.log("Not rendered: fix the conflict above before this stack can be certified.\n");
    }
  }
  process.exit(result.certified ? 0 : 1);
} else if (verb === "upload") {
  if (!name) fail("usage: cub stack upload <name> [--run]");
  const stack = loadStack(name);
  const result = certify(stack);
  printHeader(stack);
  printCertify(result);
  if (!result.certified) { console.log("Upload refused: the composition is not certified.\n"); process.exit(1); }
  const steps = stack.components.map((comp) => comp.bundle
    ? ["variant", "upload", "--component", comp.name, "--variant", "base", "--granularity", "per-file", "--owner", stack.name, comp.bundle]
    : ["variant", "upload", "--component", comp.name, "--variant", "base", "--granularity", "per-resource", "--owner", stack.name, join(pluginRoot, comp.render ?? comp.authored)]);
  console.log(RUN ? "Uploading (live)\n" : "Upload plan (dry run, no changes)\n");
  for (const step of steps) console.log(`  cub ${step.join(" ")}`);
  if (stack.bindings) console.log(`  … then ${ (stack.bindings.pathBindings ?? []).length } path binding(s) and ${ (stack.bindings.envBindings ?? []).length } env binding(s) as links`);
  console.log("");
  if (!RUN) { console.log("  Dry run. Add --run to execute.\n"); process.exit(0); }
  for (const step of steps) { process.stdout.write(`  ${step[3]}... `); cub(step); console.log("ok"); }
  console.log("\n  Bases uploaded. Variants, links, and releases continue with the generic cub verbs.\n");
} else {
  console.log(`cub stack — a certified composition of components, spoken by name

Usage:
  cub stack list
  cub stack certify <name>
  cub stack sandbox <name>
  cub stack upload <name> [--run]

This is the prototype of the proposed stack verb, packaged as a cub plugin.`);
  process.exit(verb ? 2 : 0);
}
