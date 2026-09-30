#!/usr/bin/env node
// cub stack — a composition of components, checked before anything runs.
//
//   cub stack list
//   cub stack schema             print the manifest contract this version validates against
//   cub stack compose --entry ID ... --name NAME --out DIR   write a new stack from catalog entries (lib/stack-compose.mjs)
//   cub stack check <name>       read the composition; exits non-zero on a conflict (certify is the old name)
//   cub stack sandbox <name>     check, then render the composition for free; --out or --workspace keeps the render
//   cub stack publish <name> --out oci://<repo>[:tag]   publish the index of component images with the manifest and verdict
//   cub stack upload <name> [--run]   upload the base Spaces, then link their declared path bindings
//   cub stack from-kubara <kubara-work-dir>   write a stack manifest from a Kubara platform, one component per service
//
// A stack manifest names its components as digest-pinned bundles with receipts,
// which are pulled once and hash-verified against the receipts shipped with
// this plugin, or as authored YAML files the stack owns. This command is the
// prototype of the proposed stack verb, packaged so it runs as cub itself.

import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { cub, fail, identity, parseDocs, pluginRoot, readYamlFile, resolveBundle, resolveBundleDetails, sha256, toYaml } from "./common.mjs";
import { attachRecord, copyIntoRepo, discoverReceipt, parseReference, publishBundle, publishIndex, signDigest, verifyBundle } from "./oci.mjs";
import { buildReceipt, printPublished } from "./receipt.mjs";
import { checkNeeds } from "./needs.mjs";
import { checkStackApiVersions } from "./stack-api-compatibility.mjs";
import { stackPrerequisites } from "./stack-prerequisites.mjs";
import { certificationResult } from "./stack-result.mjs";
import { writeStackWorkspace } from "./stack-workspace.mjs";
import { cubKubaraVersion, ownedObjects, readKubaraConfig, readKubaraRender, runKubaraRender } from "./kubara-render.mjs";
import { validateStackManifest } from "./stack-manifest.mjs";
import { loadIndexStack } from "./stack-index.mjs";
import { checkPromtailLokiConnections } from "./stack-connections.mjs";
import { addSchemaValidation } from "./schema-validation.mjs";
import { describeBinding, planBindingLinks } from "./stack-links.mjs";
import { cubFound, spaceExists } from "./cub-lookup.mjs";

const STACKS_DIR = join(pluginRoot, "stacks");
const rawArgs = process.argv.slice(2);
const JSON_OUTPUT = rawArgs.includes("--json");
const args = rawArgs.filter((arg) => arg !== "--json");
const verb = args[0];
const name = args[1];
const RUN = args.includes("--run");
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
const SIGN = args.includes("--sign") ? args[args.indexOf("--sign") + 1] : null;
const WORKSPACE_REQUESTED = args.includes("--workspace");
// A platform stack carries each cluster's render of a component as a variant of
// its base; --cluster reads the stack as that one cluster runs it.
const SELECTED_CLUSTER = verb !== "from-kubara" && args.includes("--cluster") ? args[args.indexOf("--cluster") + 1] : null;
if (verb !== "from-kubara" && args.includes("--cluster") && (!SELECTED_CLUSTER || SELECTED_CLUSTER.startsWith("--"))) fail("--cluster takes the name of a cluster the stack's variants name");
const WORKSPACE = WORKSPACE_REQUESTED ? args[args.indexOf("--workspace") + 1] : null;
if (WORKSPACE_REQUESTED && (verb !== "sandbox" || args.length !== 4 || args[2] !== "--workspace" || !WORKSPACE || WORKSPACE.startsWith("--") || WORKSPACE.startsWith("oci://"))) {
  fail("usage: cub stack sandbox <name | manifest | OCI reference> --workspace <new local directory>");
}
if (verb === "schema") {
  if (rawArgs.length !== 1) fail("usage: cub stack schema");
  process.stdout.write(readFileSync(join(pluginRoot, "schemas", "stack-manifest.schema.json"), "utf8"));
  process.exit(0);
}
const PLANE_RANK = { hub: 0, mgmt: 1, workload: 2 };
const PASS = "PASS"; const WARN = "WARN"; const FAIL = "FAIL";
// check reads the composition and says what is wrong. certify is the name it had
// first, kept so older scripts and manifests keep working.
const CHECKS = new Set(["check", "certify"]);

if (JSON_OUTPUT && (!CHECKS.has(verb) || args.length !== (SELECTED_CLUSTER ? 4 : 2) || name.startsWith("--"))) {
  fail("usage: cub stack check <name | manifest | OCI reference> [--cluster <name>] --json (no other flags)");
}

function stableManifest(value) {
  if (Array.isArray(value)) return `[${value.map(stableManifest).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableManifest(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}

function onlyAddsAuthoredComponents(original, current) {
  if (stableManifest({ ...original, spec: { ...original.spec, components: undefined } })
    !== stableManifest({ ...current, spec: { ...current.spec, components: undefined } })) return false;
  const originalComponents = original.spec?.components;
  const currentComponents = current.spec?.components;
  if (!Array.isArray(originalComponents) || !Array.isArray(currentComponents) || currentComponents.length < originalComponents.length) return false;
  if (originalComponents.some((component, index) => stableManifest(component) !== stableManifest(currentComponents[index]))) return false;
  const known = new Set(originalComponents.map((component) => component.name));
  return currentComponents.slice(originalComponents.length).every((component) => {
    if (!component.authored || component.render || component.bundle || known.has(component.name)) return false;
    known.add(component.name);
    return true;
  });
}

function restoreWorkspaceEvidence(path, stack, components) {
  const resultPath = join(dirname(path), "result.json");
  if (!existsSync(resultPath)) return;
  let saved;
  try { saved = JSON.parse(readFileSync(resultPath, "utf8")); } catch { return; }
  if (saved?.kind !== "StackCertificationResult" || !saved.lifecycleCompanions) return;
  if (saved.name !== (stack.metadata?.name ?? "") && saved.lifecycleCompanions?.entries?.length) fail("workspace lifecycle evidence does not match this stack name");
  const entries = saved.lifecycleCompanions?.entries;
  if (!Array.isArray(entries) || !Array.isArray(saved.workspaceFiles)) fail("workspace lifecycle evidence is malformed; preserve the saved workspace or repair its evidence");
  if (entries.length === 0) return;
  const expected = new Map(saved.workspaceFiles.map((file) => [file.path, file.sha256]));
  const root = realpathSync(dirname(path));
  const readVerified = (relative, expectedHash, label) => {
    if (typeof relative !== "string" || !relative || isAbsolute(relative) || relative.split(/[\\/]+/).includes("..")) fail(`workspace lifecycle evidence has an unsafe ${label} path`);
    const candidate = join(dirname(path), relative);
    let resolved;
    try { resolved = realpathSync(candidate); } catch { fail(`workspace lifecycle evidence is missing ${label}`); }
    if (resolved !== root && !resolved.startsWith(`${root}/`)) fail(`workspace lifecycle evidence escapes the saved workspace: ${label}`);
    const bytes = readFileSync(resolved);
    if (sha256(bytes) !== expectedHash) fail(`workspace lifecycle evidence hash mismatch: ${label}`);
    return bytes;
  };
  const manifestHash = expected.get("stack.yaml");
  const currentManifest = readFileSync(path);
  if (!manifestHash) fail("workspace lifecycle evidence is malformed; preserve the saved workspace or repair its evidence");
  if (sha256(currentManifest) !== manifestHash) {
    // Older workspaces intentionally have no snapshot and retain the original
    // strict manifest-hash refusal.
    const snapshotHash = expected.get("evidence/original-stack.yaml");
    if (!snapshotHash) fail("workspace lifecycle evidence is stale because stack.yaml changed; preserve the original workspace evidence or create a new stack without it");
    const snapshot = readVerified("evidence/original-stack.yaml", snapshotHash, "original stack snapshot");
    if (sha256(snapshot) !== manifestHash) fail("workspace lifecycle evidence original stack snapshot does not match its saved stack.yaml");
    let original;
    try {
      const documents = parseDocs(snapshot.toString("utf8"));
      if (documents.length !== 1) throw new Error("not one manifest");
      original = documents[0];
      validateStackManifest(original);
    } catch { fail("workspace lifecycle evidence original stack snapshot is malformed"); }
    if (!onlyAddsAuthoredComponents(original, stack)) fail("workspace lifecycle evidence is stale because stack.yaml changed; only new authored components may be appended");
  }
  const byName = new Map(components.map((component) => [component.name, component]));
  const seen = new Set();
  for (const entry of entries) {
    if (!entry || typeof entry.component !== "string" || seen.has(entry.component) || !byName.has(entry.component)) fail("workspace lifecycle evidence does not match this stack");
    seen.add(entry.component);
    if (!entry.receipt || typeof entry.bundle !== "string" || !/^oci:\/\/[^\s@]+@sha256:[0-9a-f]{64}$/.test(entry.bundle)
      || typeof entry.receipt.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.receipt.sha256)) fail(`workspace lifecycle evidence is malformed for ${entry.component}`);
    const receipt = readVerified(entry.receipt.path, entry.receipt.sha256, `${entry.component} receipt`);
    const receiptRecord = parseDocs(receipt.toString("utf8"))[0];
    const receiptDigest = receiptRecord?.spec?.bundle?.digest ?? receiptRecord?.spec?.bundle?.manifestDigest
      ?? (String(receiptRecord?.spec?.bundle?.reference ?? "").match(/@(sha256:[0-9a-f]{64})$/) ?? [])[1];
    const bundleDigest = (entry.bundle.match(/@(sha256:[0-9a-f]{64})$/) ?? [])[1];
    if (receiptDigest !== bundleDigest || entry.receipt.bundleDigest !== bundleDigest) fail(`workspace lifecycle evidence receipt does not bind ${entry.component} to its bundle`);
    const companions = (entry.companions ?? []).map((companion, index) => {
      if (!companion || typeof companion.role !== "string" || !companion.role.startsWith("route:")
        || typeof companion.source !== "string" || typeof companion.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(companion.sha256)
        || companion.state !== "declared-unexecuted") fail(`workspace lifecycle evidence is malformed for ${entry.component} companion ${index + 1}`);
      return { role: companion.role, source: companion.source, sha256: companion.sha256,
        bytes: readVerified(companion.path, companion.sha256, `${entry.component} companion ${index + 1}`) };
    });
    const receiptRoutes = receiptRecord.spec?.bundle?.files?.filter((file) => String(file.role ?? "").startsWith("route:")) ?? [];
    const routeIdentity = (route) => `${route.role}\u0000${route.path ?? route.source}\u0000${route.sha256}`;
    if (receiptRoutes.map(routeIdentity).sort().join("\n") !== companions.map(routeIdentity).sort().join("\n")) {
      fail(`workspace lifecycle evidence is missing or changed a required route for ${entry.component}`);
    }
    if (entry.metadataPath) {
      const metadataHash = expected.get(entry.metadataPath);
      if (!metadataHash) fail(`workspace lifecycle evidence is missing metadata for ${entry.component}`);
      const metadata = readVerified(entry.metadataPath, metadataHash, `${entry.component} metadata`);
      const expectedMetadata = { ...entry }; delete expectedMetadata.metadataPath;
      try {
        if (JSON.stringify(JSON.parse(metadata.toString("utf8"))) !== JSON.stringify(expectedMetadata)) throw new Error("mismatch");
      } catch { fail(`workspace lifecycle evidence metadata does not match ${entry.component}`); }
    }
    byName.get(entry.component).bundleEvidence = { bundle: entry.bundle,
      receipt: { source: entry.receipt.source, sha256: entry.receipt.sha256, bytes: receipt, bundleDigest: entry.receipt.bundleDigest }, companions };
  }
}

// A stack is named (shipped in stacks/) or given as a path to a manifest file.
// Component sources resolve relative to the manifest first, then to the plugin,
// so a manifest written anywhere can reuse the shipped renders and apps.
// A published index is read by lib/stack-index.mjs, which cub fleet shares.

// A platform stack carries each cluster's render of a component as a variant
// of its base. Without --cluster each component is its base; with it, the
// cluster's variant stands in for the base, and components that cluster does
// not run drop out. Components without variants (an authored app) belong
// everywhere. A published index names each variant by digest instead of path.
function selectCluster(label, specComponents, locate, cluster = SELECTED_CLUSTER) {
  const clusters = [...new Set(specComponents.flatMap((comp) => (comp.variants ?? []).map((variant) => variant.cluster)))];
  if (cluster && !clusters.includes(cluster)) {
    fail(clusters.length ? `stack ${label} has no variant for cluster ${cluster}; its clusters are ${clusters.join(", ")}` : `--cluster narrows a stack whose components carry per-cluster variants, and ${label} has none`);
  }
  const selected = specComponents.filter((comp) => !cluster || !comp.variants || comp.variants.some((variant) => variant.cluster === cluster)).map((comp) => {
    if (!comp.variants) return comp;
    const variants = comp.variants.filter((variant) => !cluster || variant.cluster === cluster).map((variant) => {
      if (variant.bundle) return variant;
      const sourcePath = locate(variant.render);
      if (!sourcePath) fail(`component "${comp.name}" variant for cluster ${variant.cluster} is missing: ${variant.render}`);
      return { ...variant, sourcePath };
    });
    const chosen = cluster ? variants[0] : null;
    if (comp.bundle) return { ...comp, baseBundle: comp.bundle, bundle: chosen?.bundle ?? comp.bundle, variants };
    return { ...comp, render: chosen?.render ?? comp.render, baseSourcePath: locate(comp.render), variants };
  });
  return { clusters, selected };
}

function loadStack(stackName, { preserveWorkspaceEvidence = false, cluster = SELECTED_CLUSTER } = {}) {
  if (String(stackName).startsWith("oci://")) {
    const loaded = loadIndexStack(stackName);
    const { clusters, selected } = selectCluster(loaded.stack.metadata?.name ?? stackName, loaded.stack.spec.components, () => null, cluster);
    const components = selected.map((comp) => {
      const bundle = preserveWorkspaceEvidence ? resolveBundleDetails(comp) : null;
      const objects = (bundle?.objects ?? resolveBundle(comp)).filter((doc) => doc?.kind && doc.metadata?.name);
      return { ...comp, objects, ...(bundle ? { bundleEvidence: bundle } : {}) };
    });
    if (components.some((comp) => comp.plane)) {
      components.sort((a, b) => (PLANE_RANK[a.plane] ?? 9) - (PLANE_RANK[b.plane] ?? 9) || (a.order ?? 0) - (b.order ?? 0));
    }
    return { name: loaded.stack.metadata?.name ?? "index", description: loaded.stack.spec?.description ?? "", bindings: loaded.stack.spec?.bindings, components, path: stackName, clusters, cluster };
  }
  const isPath = /\.ya?ml$/.test(stackName) || existsSync(stackName);
  const path = isPath ? resolve(stackName) : join(STACKS_DIR, `${stackName}.yaml`);
  if (!existsSync(path)) {
    fail(isPath ? `no such manifest file: ${stackName}` : `no such stack "${stackName}". Try: cub stack list, or pass a path to a manifest file`);
  }
  const manifestDir = dirname(path);
  const locate = (source) => [join(manifestDir, source), join(pluginRoot, source)].find((candidate) => existsSync(candidate));
  const stack = readYamlFile(path);
  validateStackManifest(stack);
  const { clusters, selected } = selectCluster(stack.metadata?.name ?? stackName, stack.spec?.components ?? [], locate, cluster);
  const components = selected.map((comp) => {
    let objects;
    if (comp.bundle) {
      const receipt = comp.receipt && locate(comp.receipt);
      const source = receipt ? { ...comp, receipt, receiptSource: comp.receipt } : comp;
      const bundle = preserveWorkspaceEvidence ? resolveBundleDetails(source) : null;
      objects = bundle?.objects ?? resolveBundle(source);
      if (bundle) comp = { ...comp, bundleEvidence: bundle };
    } else {
      const source = comp.render ?? comp.authored;
      const filePath = source && locate(source);
      if (!filePath) fail(`component "${comp.name}" source is missing: ${source}`);
      objects = parseDocs(readFileSync(filePath, "utf8"));
      comp = { ...comp, sourcePath: filePath };
    }
    objects = objects.filter((doc) => doc?.kind && doc.metadata?.name);
    return { ...comp, objects };
  });
  if (components.some((comp) => comp.plane)) {
    components.sort((a, b) => (PLANE_RANK[a.plane] ?? 9) - (PLANE_RANK[b.plane] ?? 9) || (a.order ?? 0) - (b.order ?? 0));
  }
  if (preserveWorkspaceEvidence) restoreWorkspaceEvidence(path, stack, components);
  return { name: stack.metadata?.name ?? stackName, description: stack.spec?.description ?? "", bindings: stack.spec?.bindings, components, path, clusters, cluster };
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
    // kubectl apply keeps the last copy, but cub variant upload refuses a
    // component that defines an object twice, so upload checks this first.
    findings.push([WARN, `${identicalDupes.length} object(s) carried more than once inside one component with identical content; kubectl apply keeps the last, but cub stack upload refuses the component:`]);
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

  // Hub-only configuration is retained, not applied to a cluster. For delivered
  // CRs, a group match alone is insufficient: the exact kind/version must be served.
  const apiVersions = checkStackApiVersions(stack.components
    .filter((comp) => comp.plane !== "hub").flatMap((comp) => comp.objects));
  if (apiVersions.incompatible.length) {
    hardFailures += apiVersions.incompatible.length;
    findings.push([FAIL, `${apiVersions.incompatible.length} custom resource API(s) cannot be resolved against the bundled CRDs:`]);
    for (const entry of apiVersions.incompatible) {
      findings.push(["    ", `${entry.identity}: ${entry.reason}; ${entry.crds.join(", ")} serves ${entry.servedVersions.join(", ") || "no versions"}`]);
    }
  } else if (apiVersions.checked.length) {
    findings.push([PASS, `served API versions: ${apiVersions.checked.length} custom resource(s) match their bundled CRD; target availability is not checked`]);
  }

  // Custom resources whose CRD nothing in this stack delivers. The apply will
  // fail unless the CRD already exists, so name them like missing namespaces.
  // Built-in API groups have no dot or end in k8s.io; everything else is taken
  // as a custom resource when the stack ships no CRD for its group. Hub-plane
  // components are held in ConfigHub and never applied, so they are skipped.
  const orphanGroups = new Map();
  for (const comp of stack.components.filter((entry) => entry.plane !== "hub")) for (const obj of comp.objects) {
    const group = String(obj.apiVersion ?? "").split("/")[0];
    if (obj.kind === "CustomResourceDefinition" || !group.includes(".") || group.endsWith("k8s.io") || crdGroups.has(group)) continue;
    orphanGroups.set(group, (orphanGroups.get(group) ?? 0) + 1);
  }
  if (orphanGroups.size > 0) {
    const total = [...orphanGroups.values()].reduce((sum, count) => sum + count, 0);
    findings.push([WARN, `${total} custom resource(s) rely on CRDs this stack does not deliver, which must already exist: ${[...orphanGroups.entries()].map(([group, count]) => `${group} (${count})`).join(", ")}`]);
  }

  let emptyWebhooks = 0;
  for (const comp of stack.components) for (const obj of comp.objects) {
    if (String(obj.kind).endsWith("WebhookConfiguration") && (obj.webhooks ?? []).some((hook) => !hook.clientConfig?.caBundle)) emptyWebhooks += 1;
  }
  // What each authored app needs from the platform, and whether this stack is it.
  const needs = checkNeeds(stack, crdGroups);
  if (needs.length) {
    const unmet = needs.filter((need) => !need.met);
    const apps = [...new Set(needs.map((need) => need.app))];
    if (unmet.length === 0) {
      findings.push([PASS, `app needs met: ${apps.map((app) => `${app} needs ${[...new Set(needs.filter((need) => need.app === app).map((need) => need.service))].join(", ")}`).join("; ")}, all carried by this stack`]);
    } else {
      hardFailures += unmet.length;
      findings.push([FAIL, `${unmet.length} app need(s) this stack does not meet:`]);
      for (const need of unmet.slice(0, 6)) findings.push(["    ", `${need.app}: ${need.hint}`]);
    }
  }
  const connections = checkPromtailLokiConnections(stack);
  if (connections.mismatches.length) {
    hardFailures += connections.mismatches.length;
    findings.push([FAIL, `${connections.mismatches.length} Promtail Loki destination(s) resolve to the wrong namespace:`]);
    for (const mismatch of connections.mismatches.slice(0, 6)) findings.push(["    ", `${mismatch.component}/${mismatch.workload}: ${mismatch.host} expects ${mismatch.expectedNamespace}, but Service exists in ${mismatch.actualNamespaces.join(", ")}`]);
  } else if (connections.checked.length) {
    findings.push([PASS, `Promtail Loki destinations: ${connections.checked.length} service destination(s) have matching namespaces`]);
  }
  if (connections.unknown.length) findings.push([WARN, `Promtail Loki destinations: ${connections.unknown.length} connection(s) remain unknown; target availability is not checked`]);
  const hasCertManager = crdGroups.has("cert-manager.io") || stack.components.some((comp) => /cert-manager/.test(comp.name));
  if (emptyWebhooks === 0) findings.push([PASS, "no admission webhooks need a certificate"]);
  else findings.push([WARN, `${emptyWebhooks} admission webhook(s) need a caBundle — ${hasCertManager ? "cert-manager is in the stack and can issue it" : "no cert-manager in the stack; the reconciler must supply the certificate"}`]);

  const created = new Set(); const used = new Set();
  for (const comp of stack.components) for (const obj of comp.objects) {
    if (obj.kind === "Namespace") created.add(obj.metadata.name);
    if (obj.metadata?.namespace) used.add(obj.metadata.namespace);
  }
  const prereqs = [...used].filter((namespace) => !created.has(namespace)).sort();
  findings.push([prereqs.length ? WARN : PASS, `namespaces: ${created.size} created, ${prereqs.length} must already exist${prereqs.length ? ` (${prereqs.join(", ")})` : ""}`]);

  const prerequisites = stackPrerequisites(stack);
  for (const requirement of prerequisites.requirements.filter(r => r.status === 'unknown' && r.kind !== 'Namespace')) {
    findings.push([WARN, `target prerequisite unknown: ${requirement.kind}/${requirement.name}${requirement.namespace ? ` in ${requirement.namespace}` : ''}; ${requirement.remedy}`]);
  }
  return { certified: hardFailures === 0, findings, objectCount, prerequisites, duplicatedWithin: identicalDupes };
}

function printHeader(stack) {
  console.log(`\nStack: ${stack.name}  —  ${stack.description}`);
  if (stack.cluster) console.log(`Cluster: ${stack.cluster}, each component as that cluster's variant renders it`);
  else if (stack.clusters?.length) console.log(`Clusters: ${stack.clusters.join(", ")}. Checking each component's base; --cluster <name> checks what one cluster runs`);
  console.log(`Resolving ${stack.components.length} components: ${stack.components.map((comp) => comp.name).join(", ")}\n`);
}

function printCertify(result) {
  console.log("Check");
  for (const [mark, text] of result.findings) console.log(mark === "    " ? `      ${text}` : `  [${mark}] ${text}`);
  // CHECKED says what happened: every check passed, statically, with no cluster read.
  // It is not a promise that the stack runs, which is what the WARN lines are for.
  console.log(`  => ${result.certified ? "CHECKED" : "REFUSED"}\n`);
}

if (verb === "list") {
  console.log(`\nAvailable stacks\n`);
  for (const file of readdirSync(STACKS_DIR).filter((entry) => entry.endsWith(".yaml")).sort()) {
    const stack = readYamlFile(join(STACKS_DIR, file));
    console.log(`  ${stack.metadata?.name ?? file}  —  ${stack.spec?.description ?? ""}`);
    console.log(`      ${(stack.spec?.components ?? []).map((comp) => comp.name).join(", ")}`);
  }
  console.log(`\ncub stack sandbox <name>   # certify and render, free\n`);
} else if (CHECKS.has(verb) || verb === "sandbox") {
  if (!name) fail(`usage: cub stack ${verb} <name | manifest | OCI reference> [--cluster <name>]`);
  const stack = loadStack(name, { preserveWorkspaceEvidence: Boolean(WORKSPACE) });
  if (!JSON_OUTPUT) printHeader(stack);
  // Schema validation runs a local tool over every object, so it belongs to the
  // verbs a person runs to check a stack, not to publish and upload, which
  // repeat the composition checks as a gate.
  const result = addSchemaValidation(stack, certify(stack));
  if (JSON_OUTPUT) {
    console.log(JSON.stringify(certificationResult(stack, result), null, 2));
  } else printCertify(result);
  if (verb === "sandbox") {
    if (result.certified) {
      console.log("Sandbox render  (free, no infrastructure)");
      console.log(`  ${result.objectCount} objects total`);
      for (const comp of stack.components) {
        const planeNote = comp.plane ? `  [${comp.plane}${comp.plane === "hub" ? ": held in ConfigHub, never applied" : ""}]` : "";
        console.log(`      ${comp.name}: ${comp.objects.length}${planeNote}${comp.authored ? "  [authored]" : ""}`);
      }
      if (WORKSPACE) {
        const manifestPath = writeStackWorkspace(stack, result, WORKSPACE);
        const quoted = `'${manifestPath.replace(/'/g, "'\\''")}'`;
        console.log(`\n  Saved editable components, stack.yaml, rendered.yaml and baseline result.json in ${WORKSPACE}`);
        const routes = stack.components.reduce((count, component) => count + (component.bundleEvidence?.companions.length ?? 0), 0);
        if (routes) console.log(`  Saved ${routes} receipt-bound lifecycle route file(s) as declared-unexecuted evidence; no route was executed.`);
        console.log(`  Resume: cub stack check ${quoted} --json`);
        console.log("  Edit a component, then save a new result and render before sharing. Target availability is not checked.");
      } else if (OUT && OUT.startsWith("oci://")) {
        // The release form: the whole stack flattened into one bundle with its receipt.
        const objects = stack.components.flatMap((comp) => comp.objects);
        const files = [{ path: `${stack.name}.yaml`, content: objects.map((obj) => toYaml(obj)).join("---\n") }];
        const components = stack.components.map((comp) => ({ name: comp.name, plane: comp.plane ?? null, order: comp.order ?? null, form: comp.bundle ? "bundle" : comp.render ? "render" : "authored", digest: comp.bundle ? (comp.bundle.match(/sha256:[0-9a-f]{64}/) ?? [])[0] : null, objects: comp.objects.length }));
        const receipt = buildReceipt({ name: stack.name, source: { kind: "stack", name: stack.name, form: "flattened" }, files, checks: result.findings.filter(([mark]) => mark.trim()), components });
        receipt.spec.schemaValidation = result.schemaValidation;
        const published = publishBundle({ reference: OUT, files, receipt, title: stack.name });
        if (SIGN) signDigest({ reference: receipt.spec.bundle.reference, digest: published.digest, key: SIGN });
        printPublished(`stack ${stack.name} (flattened, ${objects.length} objects)`, { ...published, receipt });
        const back = verifyBundle(receipt.spec.bundle.reference);
        console.log(`    pull-back: ${back.verified ? "verified" : "REFUSED"}`);
        if (!back.verified) process.exit(1);
      } else if (OUT) {
        const objects = stack.components.flatMap((comp) => comp.objects);
        writeFileSync(OUT, objects.map((obj) => toYaml(obj)).join("---\n"), "utf8");
        console.log(`\n  Wrote ${objects.length} objects in plane order to ${OUT}`);
      }
      // Upload refuses a component that defines an object twice, so the hint
      // does not point at an upload that will be refused.
      const refusing = [...new Set(result.duplicatedWithin.map(([, comp]) => comp))];
      if (!WORKSPACE && refusing.length) console.log(`\n  Rendered, but \`cub stack upload\` will refuse it: ${refusing.join(", ")} define${refusing.length === 1 ? "s" : ""} an object more than once (the WARN above). Rebuild ${refusing.length === 1 ? "that component" : "those components"} or leave ${refusing.length === 1 ? "it" : "them"} out of the manifest.\n`);
      else if (!WORKSPACE) console.log(`\n  Ready. \`cub stack upload ${name.startsWith("oci://") ? stack.name : name} --run\` uploads the base Spaces and links the declared bindings in ConfigHub.\n`);
    } else {
      console.log("Not rendered: fix what failed above, then check again.\n");
    }
  }
  process.exit(result.certified ? 0 : 1);
} else if (verb === "publish") {
  // The catalog form: an image index over the component bundles, with the
  // manifest and the verdict attached to the index digest.
  if (!name || !OUT || !OUT.startsWith("oci://")) fail("usage: cub stack publish <name> --out oci://<repo>[:tag]");
  if (SELECTED_CLUSTER) fail("publish takes the whole platform, every cluster's variant with it; --cluster narrows check, sandbox and upload");
  const stack = loadStack(name);
  printHeader(stack);
  const result = certify(stack);
  printCertify(result);
  if (!result.certified) { console.log("Publish refused: the composition did not check out.\n"); process.exit(1); }
  // The index carries what every cluster runs, so each cluster's composition
  // is checked too: a variant can conflict where the bases do not.
  const clusterChecks = stack.clusters.map((cluster) => ({ cluster, result: certify(loadStack(name, { cluster })) }));
  if (clusterChecks.length) {
    console.log("Check, each cluster as its variants compose");
    for (const { cluster, result: checked } of clusterChecks) {
      const warnings = checked.findings.filter(([mark]) => mark === WARN).length;
      console.log(`  [${checked.certified ? PASS : FAIL}] cluster ${cluster}: ${checked.certified ? "CHECKED" : "REFUSED"}, ${checked.objectCount} objects${warnings ? `, ${warnings} WARN` : ""}`);
      // Each FAIL line with the detail lines under it.
      let underFail = false;
      for (const [mark, text] of checked.certified ? [] : checked.findings) {
        if (mark !== "    ") underFail = mark === FAIL;
        if (underFail) console.log(mark === "    " ? `        ${text}` : `      [${mark}] ${text}`);
      }
    }
    const refused = clusterChecks.filter((entry) => !entry.result.certified).map((entry) => entry.cluster);
    if (refused.length) {
      console.log(`\nPublish refused: the composition of cluster${refused.length === 1 ? "" : "s"} ${refused.join(", ")} did not check out. cub stack check ${name} --cluster ${refused[0]} shows it in full.\n`);
      process.exit(1);
    }
    console.log("");
  }
  const target = parseReference(OUT);
  const tag = target.tag ?? "latest";
  const entries = [];
  console.log("Publishing components into the index repository\n");
  for (const comp of stack.components) {
    if (comp.bundle) {
      // Seeded cache first: republishing the same bytes with the same receipt
      // reproduces the named digest, so an image that has not reached its
      // public registry yet can still enter an index. Copy only otherwise.
      const expected = (comp.bundle.match(/sha256:[0-9a-f]{64}/) ?? [])[0];
      const seededDir = expected && join(pluginRoot, "cache", expected.slice(7, 23));
      const receiptPath = comp.receipt && [join(dirname(stack.path), comp.receipt), join(pluginRoot, comp.receipt)].find((candidate) => existsSync(candidate));
      let digest;
      if (seededDir && existsSync(seededDir) && receiptPath) {
        const receipt = readYamlFile(receiptPath);
        const files = readdirSync(seededDir).filter((entry) => !entry.startsWith(".")).map((entry) => ({ path: entry, content: readFileSync(join(seededDir, entry)) }));
        const republished = publishBundle({ reference: `oci://${target.repo}:${tag}-${comp.name}`, files, receipt: JSON.parse(JSON.stringify(receipt)), title: receipt.metadata?.name ?? comp.name });
        if (republished.digest !== expected) fail(`component "${comp.name}": the cached bytes do not reproduce ${expected} (got ${republished.digest})`);
        digest = republished.digest;
        console.log(`  ${comp.name}: republished from the seeded cache, ${digest.slice(0, 19)} reproduced`);
      } else {
        digest = copyIntoRepo(comp.bundle, target.repo, { plain: target.plain });
        console.log(`  ${comp.name}: copied ${digest.slice(0, 19)}`);
      }
      // A catalog bundle's receipt lives in a repository, not the registry; attach
      // it to the copied digest so a consumer of the index can discover it.
      const copiedRef = `oci://${target.repo}@${digest}`;
      if (!discoverReceipt(copiedRef) && receiptPath) {
        attachRecord({ reference: copiedRef, digest, record: readYamlFile(receiptPath), fileName: "receipt.json" });
      }
      if (SIGN) signDigest({ reference: copiedRef, digest, key: SIGN });
      entries.push({ name: comp.name, plane: comp.plane ?? null, order: comp.order ?? null, form: "bundle", digest, objects: comp.objects.length });
    } else {
      const source = comp.render ?? comp.authored;
      const sourcePath = [join(dirname(stack.path), source), join(pluginRoot, source)].find((candidate) => existsSync(candidate));
      const files = [{ path: `${comp.name}.yaml`, content: readFileSync(sourcePath) }];
      const receipt = buildReceipt({ name: comp.name, source: { kind: comp.render ? "render" : "authored", name: comp.name, stack: stack.name }, files, checks: [["PASS", `${comp.objects.length} objects`]] });
      const published = publishBundle({ reference: `oci://${target.repo}:${tag}-${comp.name}`, files, receipt, title: comp.name });
      if (SIGN) signDigest({ reference: `oci://${target.repo}@${published.digest}`, digest: published.digest, key: SIGN });
      // Each cluster's variant enters the index as its own image, so a consumer
      // of the index reads what every cluster runs by digest, not by local path.
      const variants = (comp.variants ?? []).map((variant) => {
        const variantFiles = [{ path: `${comp.name}.yaml`, content: readFileSync(variant.sourcePath) }];
        const variantObjects = parseDocs(readFileSync(variant.sourcePath, "utf8")).filter((doc) => doc?.kind && doc.metadata?.name).length;
        const variantReceipt = buildReceipt({ name: `${comp.name}-${variant.cluster}`, source: { kind: "render", name: comp.name, stack: stack.name, cluster: variant.cluster }, files: variantFiles, checks: [["PASS", `${variantObjects} objects`]] });
        const out = publishBundle({ reference: `oci://${target.repo}:${tag}-${comp.name}-${variant.cluster}`, files: variantFiles, receipt: variantReceipt, title: `${comp.name} on ${variant.cluster}` });
        if (SIGN) signDigest({ reference: `oci://${target.repo}@${out.digest}`, digest: out.digest, key: SIGN });
        console.log(`  ${comp.name} on ${variant.cluster}: published ${out.digest.slice(0, 19)}`);
        return { cluster: variant.cluster, ...(variant.stage ? { stage: variant.stage } : {}), digest: out.digest, objects: variantObjects };
      });
      entries.push({ name: comp.name, plane: comp.plane ?? null, order: comp.order ?? null, form: comp.render ? "render" : "authored", digest: published.digest, objects: comp.objects.length, ...(variants.length ? { variants } : {}) });
      console.log(`  ${comp.name}: published ${published.digest.slice(0, 19)}`);
    }
  }
  // The attached manifest names each variant by the digest just published, so
  // the index needs nothing from this machine to be read back.
  let manifestText = readFileSync(stack.path, "utf8");
  if (entries.some((entry) => entry.variants)) {
    const manifest = parseDocs(manifestText)[0];
    const byName = new Map(entries.map((entry) => [entry.name, entry]));
    for (const comp of manifest.spec.components) {
      if (!comp.variants) continue;
      const published = new Map(byName.get(comp.name).variants.map((variant) => [variant.cluster, variant.digest]));
      comp.variants = comp.variants.map(({ render, ...variant }) => ({ ...variant, bundle: `oci://${target.repo}@${published.get(variant.cluster)}` }));
    }
    manifestText = toYaml(manifest);
  }
  const record = {
    apiVersion: "evidence.confighub.com/v1alpha1",
    kind: "StackIndexRecord",
    metadata: { name: stack.name, producedAt: new Date().toISOString() },
    spec: { manifest: manifestText, verdict: result.certified ? "CHECKED" : "REFUSED", checks: result.findings.filter(([mark]) => mark.trim()).map(([mark, text]) => ({ result: mark, text })), components: entries,
      ...(clusterChecks.length ? { clusters: clusterChecks.map(({ cluster, result: checked }) => ({ cluster, verdict: checked.certified ? "CHECKED" : "REFUSED", objects: checked.objectCount, checks: checked.findings.filter(([mark]) => mark.trim()).map(([mark, text]) => ({ result: mark, text })) })) } : {}) },
  };
  const index = publishIndex({ reference: OUT, digests: entries.flatMap((entry) => [entry.digest, ...(entry.variants ?? []).map((variant) => variant.digest)]), record, annotations: { "com.confighub.stack": stack.name, "com.confighub.verdict": "CHECKED", "com.confighub.components": String(entries.length) } });
  if (SIGN) signDigest({ reference: `oci://${index.repo}@${index.digest}`, digest: index.digest, key: SIGN });
  console.log(`\n  Published stack ${stack.name} as an index of ${entries.length} images`);
  console.log(`    oci://${index.repo}@${index.digest}`);
  console.log(`    manifest and verdict attached: ${index.recordDigest}\n`);
} else if (verb === "upload") {
  if (!name) fail("usage: cub stack upload <name | manifest> [--cluster <name>] [--space-prefix <prefix>] [--run]");
  const stack = loadStack(name);
  const result = certify(stack);
  printHeader(stack);
  printCertify(result);
  if (!result.certified) { console.log("Upload refused: the composition did not check out.\n"); process.exit(1); }
  // The hub refuses an upload that defines one object twice, and it would say
  // so only after the components before it had landed. Refuse before any write.
  if (result.duplicatedWithin.length) {
    const components = [...new Set(result.duplicatedWithin.map(([, comp]) => comp))];
    console.log(`Upload refused: ${components.join(", ")} define${components.length === 1 ? "s" : ""} ${result.duplicatedWithin.length} object(s) more than once, and cub variant upload refuses a component that does.`);
    for (const [id, comp, count] of result.duplicatedWithin) console.log(`    ${id}  x${count}  inside  ${comp}`);
    console.log(`  Nothing was uploaded. Rebuild ${components.length === 1 ? "that component" : "those components"} so each object appears once, or leave ${components.length === 1 ? "it" : "them"} out of the manifest.\n`);
    process.exit(1);
  }
  // cub 0.5 took --granularity away from variant upload: the server pulls an oci:// bundle
  // by digest itself and records that digest on the Space. --space-prefix keeps this
  // stack's Spaces apart from others in a shared organization (<prefix>-<component>).
  const PREFIX = args.includes("--space-prefix") ? args[args.indexOf("--space-prefix") + 1] : null;
  if (args.includes("--space-prefix") && !/^[a-z0-9][a-z0-9-]*$/.test(PREFIX ?? "")) fail("--space-prefix takes lowercase letters, digits and dashes");
  // With a prefix the Component is named <prefix>-<component> too, so a shared
  // organization gets no bare Components such as cert-manager (#88). The Space
  // pattern is a Go template over the Space's Component and labels; it reads
  // .Component.Slug, since no Component label exists yet when the hub renders
  // the slug for a new Space, and the slug already carries the prefix.
  const component = (comp) => PREFIX ? `${PREFIX}-${comp.name}` : comp.name;
  const spacePattern = PREFIX ? ["--space-pattern", "template:{{.Component.Slug}}"] : [];
  // A platform stack's base holds the change made once. Each cluster's variant
  // is cloned from it, so promotion runs base to cluster, and then takes that
  // cluster's own render as an ordinary upload, merged into the clone.
  const variantPattern = PREFIX ? ["--space-pattern", "template:{{.Component.Slug}}-{{.Labels.Variant}}"] : [];
  const steps = stack.components.flatMap((comp) => [comp.bundle
    ? ["variant", "upload", "--component", component(comp), "--variant", "base", "--owner", stack.name, ...spacePattern, comp.baseBundle ?? comp.bundle]
    : ["variant", "upload", "--component", component(comp), "--variant", "base", "--owner", stack.name, ...spacePattern, comp.baseSourcePath ?? comp.sourcePath ?? join(pluginRoot, comp.render ?? comp.authored)],
  ...(comp.variants ?? []).flatMap((variant) => {
    const stage = variant.stage ? ["--stage", variant.stage] : [];
    const space = PREFIX ? `${PREFIX}-${comp.name}-${variant.cluster}` : `${comp.name}-${variant.cluster}`;
    return [Object.assign(["variant", "create", variant.cluster, PREFIX ? `${PREFIX}-${comp.name}` : `${comp.name}-base`, ...stage, ...variantPattern], { space }),
      ["variant", "upload", "--component", component(comp), "--variant", variant.cluster, "--owner", stack.name, ...stage, ...variantPattern, variant.bundle ?? variant.sourcePath]];
  })]);
  const uploadSpace = (comp, prefix) => prefix ? `${prefix}-${comp.name}` : `${comp.name}-base`;
  const { links, unlinked } = planBindingLinks(stack, (comp) => uploadSpace(comp, PREFIX));
  const printUnlinked = () => {
    if (!unlinked.length) return;
    console.log(`\n  Not linked (${unlinked.length} binding(s)):`);
    for (const entry of unlinked) console.log(`    ${describeBinding(entry)}: ${entry.reason}`);
  };
  console.log(RUN ? "Uploading (live)\n" : "Upload plan (dry run, no changes)\n");
  for (const step of steps) console.log(`  cub ${step.join(" ")}`);
  for (const link of links) console.log(`  echo '${JSON.stringify(link.body)}' | cub ${link.create.join(" ")}`);
  for (const link of links) console.log(`  cub unit update --space ${link.space} --patch --resolve Link:* ${link.from}`);
  if (!RUN) printUnlinked();
  console.log("");
  // The plan stays static: whether a link already exists is a question only the
  // server can answer, which needs credentials and a network a dry run does not.
  if (!RUN) { console.log(`  Dry run. Add --run to execute${links.length ? "; it leaves each link that already exists as is" : ""}.\n`); process.exit(0); }
  // Every run issues every upload. variant upload is create-or-update, so a
  // rerun after a stop (network, quota) is the resume: what landed is re-read
  // unchanged, and a manifest whose digest or render moved updates its base,
  // which skipping an existing Space would silently lose.
  const stopUpload = (what, error, next) => {
    const detail = String(error.stderr || error.message).trim().split("\n").filter((line) => line.trim() && line.trim() !== ".").map((line) => `    ${line.trim()}`).join("\n");
    console.error(`\nStopped: ${what}.\n${detail}\n${next}\n`);
    process.exit(1);
  };
  const rerun = `cub stack upload ${name}${SELECTED_CLUSTER ? ` --cluster ${SELECTED_CLUSTER}` : ""}${PREFIX ? ` --space-prefix ${PREFIX}` : ""} --run`;
  const label = (step) => step[1] === "create" ? `${step[3]} → ${step[2]}` : step[5] === "base" ? step[3] : `${step[3]} ${step[5]}`;
  for (const [index, step] of steps.entries()) {
    process.stdout.write(`  ${label(step)}... `);
    // variant create is the one step that is not create-or-update: a rerun
    // finds the variant already cloned and goes on to the upload into it.
    if (step[1] === "create" && spaceExists(step.space)) { console.log("already cloned"); continue; }
    try { cub(step); }
    catch (error) {
      console.log("stopped");
      const done = steps.slice(0, index).map(label);
      const remaining = steps.slice(index).map(label);
      stopUpload(`${step[1] === "create" ? "cloning" : "the upload of"} ${label(step)} failed`, error, `  Uploaded: ${done.join(", ") || "none"}. Not uploaded: ${remaining.join(", ")}.\n  Fix the cause, then run ${rerun}. Rerunning is safe: every upload is create-or-update, so the ones that landed are re-read, not duplicated.`);
    }
    console.log("ok");
  }
  // Links go in after every base is up, since each joins Units in two Spaces.
  // The Units are named by cub, not by the manifest, so each is confirmed
  // before a link names it; one that is absent leaves its binding unlinked.
  const unitFound = new Map();
  const unitExists = (space, unit) => {
    if (!unitFound.has(`${space}/${unit}`)) unitFound.set(`${space}/${unit}`, cubFound("unit", unit, space));
    return unitFound.get(`${space}/${unit}`);
  };
  // A link that exists is reconciled, not skipped: a binding added to the
  // manifest later reaches a stack linked before it. Each linked Unit is then
  // resolved, so the profile's values are in place when upload ends rather
  // than whenever the profile next changes.
  let created = 0;
  let updated = 0;
  const linkedUnits = [];
  const stopLinks = (what, error) => stopUpload(what, error, `  ${created + updated} link(s) written before the stop. Fix the cause, then run ${rerun}: bases are re-uploaded (create-or-update) and links are reconciled.`);
  for (const link of links) {
    process.stdout.write(`  link ${link.slug} (${link.count} binding(s))... `);
    let exists; let missing;
    try {
      exists = cubFound("link", link.slug, link.space);
      missing = exists ? null : [[link.space, link.from], [link.toSpace, link.to]].find(([space, unit]) => !unitExists(space, unit));
    } catch (error) {
      console.log("stopped");
      stopLinks(`could not tell whether link ${link.slug} or its Units exist in ${link.space}, so no more links were written`, error);
    }
    if (missing) {
      for (const entry of link.bindings) unlinked.push({ ...entry, reason: `${missing[0]} has no Unit ${missing[1]} to link` });
      console.log(`not linked: ${missing[0]} has no Unit ${missing[1]}`);
      continue;
    }
    try { cub(exists ? link.update : link.create, { input: JSON.stringify(link.body), stdio: ["pipe", "pipe", "pipe"] }); }
    catch (error) {
      console.log("stopped");
      stopLinks(`${exists ? "updating" : "creating"} link ${link.slug} in ${link.space} failed`, error);
    }
    if (exists) updated += 1; else created += 1;
    linkedUnits.push(link);
    console.log(exists ? "updated" : "created");
  }
  for (const link of linkedUnits) {
    process.stdout.write(`  resolve ${link.space}/${link.from}... `);
    try { cub(["unit", "update", "--space", link.space, "--patch", "--resolve", "Link:*", link.from]); }
    catch (error) { console.log("stopped"); stopLinks(`resolving ${link.space}/${link.from} failed after its link was written`, error); }
    console.log("ok");
  }
  if (links.length) console.log(`\n  Links: ${created} created, ${updated} reconciled, carrying ${linkedUnits.reduce((sum, link) => sum + link.count, 0)} binding(s); each linked Unit resolved.`);
  printUnlinked();
  console.log(`\n  Bases uploaded${steps.some((step) => step[1] === "create") ? ", and each cluster's variant cloned from its base" : ""}. Links and releases continue with the generic cub verbs.\n`);
} else if (verb === "from-kubara") {
  // Kubara generated the platform: a wrapper chart per service under
  // platform-components/helm, each cluster's values under platform-configs, and
  // config.yaml naming the clusters and the services each enables. `cub kubara
  // render` renders each service the way Kubara's hub Argo CD delivers it, and
  // bootstrap-crds as what kubara bootstrap applies. from-kubara assembles the
  // stack from that render: a component per service, a variant per cluster.
  if (!name) fail("usage: cub stack from-kubara <kubara-work-dir> [--cluster <name>] [--out <dir>] [--app <name>[,<name>]]");
  const workDir = resolve(name);
  if (!existsSync(join(workDir, "platform-components", "helm"))) fail(`${name} has no platform-components/helm; run kubara ... generate --helm first`);
  let config;
  try { config = readKubaraConfig(workDir); } catch (error) { fail(error.message); }
  const clusterNames = config.clusters.map((cluster) => cluster.name);
  // One stack for the whole platform: each service is one component, rendered
  // once per cluster that runs it. --cluster narrows it to one cluster.
  const NARROW = args.includes("--cluster") ? args[args.indexOf("--cluster") + 1] : null;
  if (args.includes("--cluster") && (!NARROW || NARROW.startsWith("--"))) fail("--cluster takes the name of a cluster in config.yaml");
  if (NARROW && !clusterNames.includes(NARROW)) fail(`config.yaml has no cluster ${NARROW}; it names ${clusterNames.join(", ")}`);
  const APPS = args.includes("--app") ? String(args[args.indexOf("--app") + 1]).split(",").filter(Boolean) : [];
  for (const app of APPS) if (!existsSync(join(pluginRoot, "apps", `${app}.yaml`))) fail(`no such app "${app}". Try: cub app list`);
  const outDir = OUT ? resolve(OUT) : join(workDir, "confighub");
  // The render stays beside the stack as evidence: render.json records each
  // service's chart, values files and digest. Secrets keep their keys and lose
  // their values, so none reaches a stack that is published or uploaded.
  const renderDir = join(outDir, "kubara-render");
  let render; let kubaraVersion;
  try {
    kubaraVersion = cubKubaraVersion();
    mkdirSync(outDir, { recursive: true });
    runKubaraRender(workDir, renderDir, NARROW ? [NARROW] : []);
    render = readKubaraRender(renderDir);
  } catch (error) { fail(error.message); }
  const FIRST = ["bootstrap-crds", "cert-manager", "external-secrets", "traefik", "ingress-nginx", "metrics-server", "kube-prometheus-stack"];
  const rank = (comp) => comp === "argo-cd" ? 99 : (FIRST.indexOf(comp) >= 0 ? FIRST.indexOf(comp) : 50);
  const charts = [...new Set(render.clusters.flatMap((cluster) => (cluster.services ?? []).map((service) => service.name)))].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  console.log(`\nKubara platform at ${workDir}: ${render.clusters.length} cluster(s), ${charts.length} components, rendered by cub kubara ${kubaraVersion}\n`);
  const variants = new Map(charts.map((chart) => [chart, []]));
  const emptied = [];
  for (const cluster of render.clusters) {
    mkdirSync(join(outDir, "renders", cluster.name), { recursive: true });
    console.log(`  cluster ${cluster.name}${cluster.type ? ` (${cluster.type}${cluster.stage ? `, ${cluster.stage}` : ""})` : ""}`);
    let dropped = 0;
    const services = [...(cluster.services ?? [])].sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name));
    for (const service of services) {
      const owned = ownedObjects(cluster, service);
      dropped += owned.dropped;
      const renderPath = `renders/${cluster.name}/${service.name}.yaml`;
      writeFileSync(join(outDir, renderPath), owned.objects.map((obj) => toYaml(obj)).join("---\n"));
      console.log(service.delivery === "bootstrap"
        ? `    ${service.name}: ${owned.objects.length} CRDs, what kubara bootstrap applies${service.leftOut ? ` (${service.leftOut} other object(s) in the chart left out)` : ""}`
        : `    ${service.name}: ${owned.objects.length} objects from Kubara's chart and ${(service.valuesFiles ?? []).length} values file(s), release ${service.release}, namespace ${service.namespace}`);
      for (const secret of service.secrets ?? []) emptied.push(`${cluster.name}/${service.name}: ${secret}`);
      variants.get(service.name).push({ cluster: cluster.name, ...(cluster.stage ? { stage: String(cluster.stage) } : {}), render: renderPath, hub: cluster.type === "hub" });
    }
    const owners = [...new Set((cluster.shared ?? []).filter((entry) => entry.owner).map((entry) => entry.owner))];
    if (dropped) console.log(`    one owner per object: dropped ${dropped} copy(ies) of object(s) another service owns (${owners.join(", ")} keep${owners.length === 1 ? "s" : ""} them)`);
    const unowned = (cluster.shared ?? []).filter((entry) => !entry.owner);
    if (unowned.length) console.log(`    ${unowned.length} object(s) rendered by more than one service with no owner; stack check names them`);
  }
  if (emptied.length) {
    console.log(`\n  These Secrets carry their keys and not their values; the values belong in each cluster's secret store:`);
    for (const line of emptied) console.log(`    ${line}`);
  }
  // Each component's base is the hub's render where the hub runs it, else the
  // first cluster's in config.yaml order: the one change is made there, and
  // each cluster's variant carries what differs.
  const components = charts.map((comp, index) => {
    const list = variants.get(comp);
    const base = list.find((variant) => variant.hub) ?? list[0];
    return { name: comp, plane: "mgmt", order: index, render: base.render, variants: list.map(({ hub, ...variant }) => variant) };
  });
  for (const app of APPS) {
    components.push({ name: app, plane: "workload", order: components.length, authored: `apps/${app}.yaml` });
    console.log(`  ${app}: the app, placed on the platform`);
  }
  const platform = basename(workDir).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").replace(/^kubara-/, "") || "platform";
  const manifest = {
    apiVersion: "helm-expt.confighub.com/v1alpha1", kind: "Stack",
    metadata: { name: NARROW ? `kubara-${platform}-${NARROW}` : `kubara-${platform}` },
    spec: {
      description: NARROW
        ? `The platform Kubara generated, narrowed to cluster ${NARROW}: each service rendered as Kubara's ApplicationSets deliver it.`
        : `The platform Kubara generated, ${render.clusters.length} cluster(s): each service one component, rendered as Kubara's ApplicationSets deliver it on every cluster that enables it.`,
      source: { kubara: workDir, ...(NARROW ? { cluster: NARROW } : {}), clusters: render.clusters.map((cluster) => cluster.name) },
      components,
    },
  };
  const manifestPath = join(outDir, "stack.yaml");
  writeFileSync(manifestPath, toYaml(manifest));
  console.log(`\n  Wrote ${manifestPath}\n\n  Next: cub stack check ${manifestPath}\n        cub stack sandbox ${manifestPath}\n        cub stack upload ${manifestPath} --run\n`);
} else {
  console.log(`cub stack — a composition of components, checked before anything runs

Usage:
  cub stack list
  cub stack schema   # print the exact manifest contract used by this installed version
  cub stack compose --entry ID [--entry ID ...] --name NAME --out NEW_DIRECTORY [--catalog-index FILE_OR_HTTPS_URL] [--json]
  cub stack check <name | path/to/manifest.yaml | oci://<repo>@sha256:<index digest>> [--cluster <name>] [--json]   (certify is the old name for this)
  cub stack sandbox <name | path | oci://…@sha256:…> [--cluster <name>] [--out rendered.yaml | --out oci://<repo>[:tag] [--sign cosign.key]]
  cub stack sandbox <name | path | oci://…@sha256:…> --workspace <new directory>
  cub stack publish <name> --out oci://<repo>[:tag] [--sign cosign.key]   # the index of images, manifest and verdict attached
  cub stack upload <name | path/to/manifest.yaml> [--cluster <name>] [--space-prefix <prefix>] [--run]   # a dry run until --run
  cub stack from-kubara <kubara-work-dir> [--cluster <name>] [--out <dir>] [--app <name>[,<name>]]   # Kubara's whole platform as one stack: a component per service, a variant per cluster; --cluster narrows it
  cub fleet up <name | path/to/fleet.yaml>   # a fleet manifest may place a stack by path, such as the one from-kubara writes

A manifest written anywhere may reuse the shipped renders/ and apps/ by relative path.
check and sandbox also validate the delivered objects against their schemas when flux and its
schema plugin are installed (flux plugin install schema); without them the line is a WARN, not a refusal.

This is the prototype of the proposed stack verb, packaged as a cub plugin.`);
  process.exit(verb ? 2 : 0);
}
