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

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { canonicalMap, cub, fail, identity, parseDocs, pluginRoot, readYamlFile, resolveBundle, toYaml } from "./common.mjs";
import { attachRecord, copyIntoRepo, discoverRecords, discoverReceipt, parseReference, publishBundle, publishIndex, signDigest, verifyBundle } from "./oci.mjs";
import { buildReceipt, printPublished } from "./receipt.mjs";
import { checkNeeds } from "./needs.mjs";

const STACKS_DIR = join(pluginRoot, "stacks");
const args = process.argv.slice(2);
const verb = args[0];
const name = args[1];
const RUN = args.includes("--run");
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
const SIGN = args.includes("--sign") ? args[args.indexOf("--sign") + 1] : null;
const PLANE_RANK = { hub: 0, mgmt: 1, workload: 2 };
const PASS = "PASS"; const WARN = "WARN"; const FAIL = "FAIL";

// A stack is named (shipped in stacks/) or given as a path to a manifest file.
// Component sources resolve relative to the manifest first, then to the plugin,
// so a manifest written anywhere can reuse the shipped renders and apps.
// A published index names its components by digest in one repository, with
// the manifest attached; loading one turns every component into bundle form.
function loadIndexStack(reference) {
  const target = parseReference(reference);
  const found = discoverRecords(reference, "StackIndexRecord")[0];
  if (!found) fail(`${reference} has no stack record attached; publish it with cub stack publish`);
  const record = found.record;
  const parsed = parseDocs(record.spec.manifest)[0];
  const digests = new Map((record.spec.components ?? []).map((entry) => [entry.name, entry.digest]));
  parsed.spec.components = (parsed.spec.components ?? []).map((comp) => {
    const digest = digests.get(comp.name);
    if (!digest) fail(`index record has no digest for component "${comp.name}"`);
    const { render, authored, bundle, receipt, ...rest } = comp;
    return { ...rest, bundle: `oci://${target.repo}@${digest}` };
  });
  return { stack: parsed, path: reference };
}

function loadStack(stackName) {
  if (String(stackName).startsWith("oci://")) {
    const loaded = loadIndexStack(stackName);
    const components = loaded.stack.spec.components.map((comp) => ({ ...comp, objects: resolveBundle(comp).filter((doc) => doc?.kind && doc.metadata?.name) }));
    if (components.some((comp) => comp.plane)) {
      components.sort((a, b) => (PLANE_RANK[a.plane] ?? 9) - (PLANE_RANK[b.plane] ?? 9) || (a.order ?? 0) - (b.order ?? 0));
    }
    return { name: loaded.stack.metadata?.name ?? "index", description: loaded.stack.spec?.description ?? "", bindings: loaded.stack.spec?.bindings, components, path: stackName };
  }
  const isPath = /\.ya?ml$/.test(stackName) || existsSync(stackName);
  const path = isPath ? resolve(stackName) : join(STACKS_DIR, `${stackName}.yaml`);
  if (!existsSync(path)) {
    fail(isPath ? `no such manifest file: ${stackName}` : `no such stack "${stackName}". Try: cub stack list, or pass a path to a manifest file`);
  }
  const manifestDir = dirname(path);
  const locate = (source) => [join(manifestDir, source), join(pluginRoot, source)].find((candidate) => existsSync(candidate));
  const stack = readYamlFile(path);
  const components = (stack.spec?.components ?? []).map((comp) => {
    let objects;
    if (comp.bundle) {
      const receipt = comp.receipt && locate(comp.receipt);
      objects = resolveBundle(receipt ? { ...comp, receipt } : comp);
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
  return { name: stack.metadata?.name ?? stackName, description: stack.spec?.description ?? "", bindings: stack.spec?.bindings, components, path };
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
      if (OUT && OUT.startsWith("oci://")) {
        // The release form: the whole stack flattened into one certified bundle.
        const objects = stack.components.flatMap((comp) => comp.objects);
        const files = [{ path: `${stack.name}.yaml`, content: objects.map((obj) => toYaml(obj)).join("---\n") }];
        const components = stack.components.map((comp) => ({ name: comp.name, plane: comp.plane ?? null, order: comp.order ?? null, form: comp.bundle ? "bundle" : comp.render ? "render" : "authored", digest: comp.bundle ? (comp.bundle.match(/sha256:[0-9a-f]{64}/) ?? [])[0] : null, objects: comp.objects.length }));
        const receipt = buildReceipt({ name: stack.name, source: { kind: "stack", name: stack.name, form: "flattened" }, files, checks: result.findings.filter(([mark]) => mark.trim()), components });
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
      console.log(`\n  Ready. \`cub stack upload ${stack.name} --run\` builds the base Spaces and links in ConfigHub.\n`);
    } else {
      console.log("Not rendered: fix the conflict above before this stack can be certified.\n");
    }
  }
  process.exit(result.certified ? 0 : 1);
} else if (verb === "publish") {
  // The catalog form: an image index over the component bundles, with the
  // manifest and the verdict attached to the index digest.
  if (!name || !OUT || !OUT.startsWith("oci://")) fail("usage: cub stack publish <name> --out oci://<repo>[:tag]");
  const stack = loadStack(name);
  printHeader(stack);
  const result = certify(stack);
  printCertify(result);
  if (!result.certified) { console.log("Publish refused: the composition is not certified.\n"); process.exit(1); }
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
      entries.push({ name: comp.name, plane: comp.plane ?? null, order: comp.order ?? null, form: comp.render ? "render" : "authored", digest: published.digest, objects: comp.objects.length });
      console.log(`  ${comp.name}: published ${published.digest.slice(0, 19)}`);
    }
  }
  const record = {
    apiVersion: "evidence.confighub.com/v1alpha1",
    kind: "StackIndexRecord",
    metadata: { name: stack.name, producedAt: new Date().toISOString() },
    spec: { manifest: readFileSync(stack.path, "utf8"), verdict: result.certified ? "CERTIFIED" : "REJECTED", checks: result.findings.filter(([mark]) => mark.trim()).map(([mark, text]) => ({ result: mark, text })), components: entries },
  };
  const index = publishIndex({ reference: OUT, digests: entries.map((entry) => entry.digest), record, annotations: { "com.confighub.stack": stack.name, "com.confighub.verdict": "CERTIFIED", "com.confighub.components": String(entries.length) } });
  if (SIGN) signDigest({ reference: `oci://${index.repo}@${index.digest}`, digest: index.digest, key: SIGN });
  console.log(`\n  Published stack ${stack.name} as an index of ${entries.length} images`);
  console.log(`    oci://${index.repo}@${index.digest}`);
  console.log(`    manifest and verdict attached: ${index.recordDigest}\n`);
} else if (verb === "upload") {
  if (!name) fail("usage: cub stack upload <name> [--run]");
  const stack = loadStack(name);
  const result = certify(stack);
  printHeader(stack);
  printCertify(result);
  if (!result.certified) { console.log("Upload refused: the composition is not certified.\n"); process.exit(1); }
  const steps = stack.components.map((comp) => comp.bundle
    ? ["variant", "upload", "--component", comp.name, "--variant", "base", "--granularity", "per-file", "--owner", stack.name, comp.bundle]
    : ["variant", "upload", "--component", comp.name, "--variant", "base", "--granularity", comp.render ? "per-file" : "per-resource", "--owner", stack.name, comp.sourcePath ?? join(pluginRoot, comp.render ?? comp.authored)]);
  console.log(RUN ? "Uploading (live)\n" : "Upload plan (dry run, no changes)\n");
  for (const step of steps) console.log(`  cub ${step.join(" ")}`);
  if (stack.bindings) console.log(`  … then ${ (stack.bindings.pathBindings ?? []).length } path binding(s) and ${ (stack.bindings.envBindings ?? []).length } env binding(s) as links`);
  console.log("");
  if (!RUN) { console.log("  Dry run. Add --run to execute.\n"); process.exit(0); }
  for (const step of steps) { process.stdout.write(`  ${step[3]}... `); cub(step); console.log("ok"); }
  console.log("\n  Bases uploaded. Variants, links, and releases continue with the generic cub verbs.\n");
} else if (verb === "from-kubara") {
  // Kubara generated the platform: an umbrella chart per component and the
  // values for each cluster. Render each with helm, exactly as Kubara meant it,
  // and write a stack manifest the other verbs read.
  if (!name) fail("usage: cub stack from-kubara <kubara-work-dir> [--cluster <name>] [--out <dir>] [--app <name>[,<name>]]");
  const workDir = resolve(name);
  const chartsDir = join(workDir, "platform-components", "helm");
  if (!existsSync(chartsDir)) fail(`${name} has no platform-components/helm; run kubara ... generate --helm first`);
  try { execFileSync("helm", ["version", "--short"], { stdio: "ignore" }); } catch { fail("helm is not installed; from-kubara renders Kubara's umbrella charts with helm"); }
  const configsDir = join(workDir, "platform-configs");
  const clusters = existsSync(configsDir) ? readdirSync(configsDir).filter((entry) => existsSync(join(configsDir, entry, "helm"))) : [];
  const CLUSTER = args.includes("--cluster") ? args[args.indexOf("--cluster") + 1] : (clusters.length === 1 ? clusters[0] : null);
  if (!CLUSTER) fail(clusters.length ? `several clusters generated (${clusters.join(", ")}); pass --cluster <name>` : "no platform-configs/<cluster>/helm found; run kubara generate --helm first");
  const outDir = OUT ? resolve(OUT) : join(workDir, "confighub");
  mkdirSync(join(outDir, "renders"), { recursive: true });
  const FIRST = ["bootstrap-crds", "cert-manager", "external-secrets", "traefik", "ingress-nginx", "metrics-server", "kube-prometheus-stack"];
  const NAMESPACES = { "bootstrap-crds": "kube-system", "cert-manager": "cert-manager", traefik: "traefik", "metrics-server": "kube-system", "argo-cd": "argocd", "external-secrets": "external-secrets", "kube-prometheus-stack": "monitoring" };
  const rank = (comp) => comp === "argo-cd" ? 99 : (FIRST.indexOf(comp) >= 0 ? FIRST.indexOf(comp) : 50);
  const names = readdirSync(chartsDir).filter((entry) => entry !== "template-library" && existsSync(join(chartsDir, entry, "Chart.yaml")))
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b));
  console.log(`\nKubara platform at ${workDir}, cluster ${CLUSTER}: ${names.length} components\n`);
  const components = [];
  const renders = new Map();
  names.forEach((comp, index) => {
    const chartDir = join(chartsDir, comp);
    if (/^dependencies:/m.test(readFileSync(join(chartDir, "Chart.yaml"), "utf8"))) {
      process.stdout.write(`  ${comp}: fetching chart dependencies... `);
      try { execFileSync("helm", ["dependency", "update", chartDir], { stdio: ["ignore", "ignore", "pipe"] }); console.log("ok"); }
      catch (error) { fail(`helm dependency build failed for ${comp}: ${String(error.stderr ?? error.message).trim().split("\n").pop()}`); }
    }
    const valuesDir = join(configsDir, CLUSTER, "helm", comp);
    const valuesFiles = existsSync(valuesDir)
      ? readdirSync(valuesDir).filter((file) => file === "values.generated.yaml" || /^values-.*\.ya?ml$/.test(file))
          .sort((a, b) => (a === "values.generated.yaml" ? -1 : b === "values.generated.yaml" ? 1 : a.localeCompare(b)))
          .map((file) => join(valuesDir, file))
      : [];
    const namespace = NAMESPACES[comp] ?? comp;
    let rendered;
    try {
      rendered = execFileSync("helm", ["template", comp, chartDir, "--namespace", namespace, "--include-crds", ...valuesFiles.flatMap((file) => ["-f", file])], { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) { fail(`helm template failed for ${comp}: ${String(error.stderr ?? error.message).trim().split("\n").pop()}`); }
    const objects = parseDocs(rendered).filter((doc) => doc?.kind && doc.metadata?.name);
    renders.set(comp, { objects, valuesFiles, namespace, index });
  });
  // Kubara delivers CRDs through bootstrap-crds and, for some charts, again
  // through the chart itself. One owner each: bootstrap-crds keeps the CRDs,
  // each chart keeps everything else, and the other copy is dropped and named.
  const bootstrap = renders.get("bootstrap-crds");
  let droppedCrds = 0; let droppedOther = 0;
  if (bootstrap) {
    const crdIds = new Set(bootstrap.objects.filter((obj) => obj.kind === "CustomResourceDefinition").map(identity));
    const chartIds = new Set([...renders.entries()].filter(([name]) => name !== "bootstrap-crds").flatMap(([, entry]) => entry.objects.filter((obj) => obj.kind !== "CustomResourceDefinition").map(identity)));
    for (const [name, entry] of renders.entries()) {
      if (name === "bootstrap-crds") {
        const before = entry.objects.length;
        entry.objects = entry.objects.filter((obj) => obj.kind === "CustomResourceDefinition" || !chartIds.has(identity(obj)));
        droppedOther += before - entry.objects.length;
      } else {
        const before = entry.objects.length;
        entry.objects = entry.objects.filter((obj) => !(obj.kind === "CustomResourceDefinition" && crdIds.has(identity(obj))));
        droppedCrds += before - entry.objects.length;
      }
    }
  }
  for (const [comp, entry] of renders.entries()) {
    writeFileSync(join(outDir, "renders", `${comp}.yaml`), entry.objects.map((obj) => toYaml(obj)).join("---\n"));
    console.log(`  ${comp}: ${entry.objects.length} objects from Kubara's chart and ${entry.valuesFiles.length} values file(s), namespace ${entry.namespace}`);
    components.push({ name: `${CLUSTER}-${comp}`, plane: "mgmt", order: entry.index, render: `renders/${comp}.yaml` });
  }
  if (droppedCrds || droppedOther) console.log(`  one owner per object: dropped ${droppedCrds} CRD copy(ies) from charts (bootstrap-crds keeps them) and ${droppedOther} object(s) from bootstrap-crds that a chart owns`);
  const APPS = args.includes("--app") ? String(args[args.indexOf("--app") + 1]).split(",").filter(Boolean) : [];
  for (const app of APPS) {
    if (!existsSync(join(pluginRoot, "apps", `${app}.yaml`))) fail(`no such app "${app}". Try: cub app list`);
    components.push({ name: app, plane: "workload", order: components.length, authored: `apps/${app}.yaml` });
    console.log(`  ${app}: the app, placed on the platform`);
  }
  const manifest = {
    apiVersion: "helm-expt.confighub.com/v1alpha1", kind: "Stack",
    metadata: { name: `kubara-${CLUSTER}` },
    spec: { description: `The platform Kubara generated for cluster ${CLUSTER}, each component rendered from its own umbrella chart and generated values.`, source: { kubara: workDir, cluster: CLUSTER }, components },
  };
  const manifestPath = join(outDir, "stack.yaml");
  writeFileSync(manifestPath, toYaml(manifest));
  console.log(`\n  Wrote ${manifestPath}\n\n  Next: cub stack certify ${manifestPath}\n        cub stack sandbox ${manifestPath}\n        cub stack upload ${manifestPath} --run\n`);
} else {
  console.log(`cub stack — a certified composition of components, spoken by name

Usage:
  cub stack list
  cub stack certify <name | path/to/manifest.yaml | oci://<repo>@sha256:<index digest>>
  cub stack sandbox <name | path | oci://…@sha256:…> [--out rendered.yaml | --out oci://<repo>[:tag]] [--sign key.pem]
  cub stack publish <name> --out oci://<repo>[:tag] [--sign key.pem]   # the index of images, manifest and verdict attached
  cub stack upload <name> [--run]
  cub stack from-kubara <kubara-work-dir> [--cluster <name>] [--out <dir>] [--app <name>[,<name>]]   # Kubara's generated platform as a stack, rendered with its own values
  cub fleet up <name | path/to/fleet.yaml>   # a fleet manifest may place a stack by path, such as the one from-kubara writes

A manifest written anywhere may reuse the shipped renders/ and apps/ by relative path.

This is the prototype of the proposed stack verb, packaged as a cub plugin.`);
  process.exit(verb ? 2 : 0);
}
