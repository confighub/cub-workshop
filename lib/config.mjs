#!/usr/bin/env node
import { loadInput } from "./local-input.mjs";
// cub config — the smallest noun: one config, one chart.
//
//   cub config list
//   cub config check <name | local.yaml> [--images]   render it for free and see what it installs
//
// This is the CLI form of the anonymous browser Check: render a chart from the
// catalog, see what it installs, and see the lifecycle work it carries (CRDs,
// hooks, admission webhooks, setup Jobs). No cluster, no account. It is the
// first rung of the noun family: cub config, cub app, cub stack, cub fleet.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocs, pluginRoot, pullReference } from "./common.mjs";
import { publishBundle, signDigest, verifyBundle } from "./oci.mjs";
import { buildReceipt, printPublished } from "./receipt.mjs";

const RENDERS_DIR = join(pluginRoot, "renders");
const DEFAULT_CATALOG_INDEX = "https://confighub.github.io/helm-expt/site/listings/index.json";
const ROLES = new Set(["cache", "database", "ingress", "certificates", "metrics", "logs", "secrets", "queue", "gpu"]);
const COMPONENT_TYPES = new Set(["service", "operator", "agent"]);
const args = process.argv.slice(2);
const [verb, name] = args;
const IMAGES = args.includes("--images");
const OUT = args.includes("--out") ? args[args.indexOf("--out") + 1] : null;
const SIGN = args.includes("--sign") ? args[args.indexOf("--sign") + 1] : null;
const KEY = args.includes("--key") ? args[args.indexOf("--key") + 1] : null;

function parseListArgs(values) {
  let role = null;
  let catalogIndex = DEFAULT_CATALOG_INDEX;
  let catalogIndexSeen = false;
  let json = false;
  for (let index = 0; index < values.length; index += 1) {
    const arg = values[index];
    if (arg === "--json") {
      if (json) throw new Error("--json may be specified only once");
      json = true;
    } else if (arg === "--role") {
      if (role) throw new Error("--role may be specified only once");
      role = values[++index];
      if (!role || role.startsWith("--")) throw new Error("--role requires a value");
    } else if (arg === "--catalog-index") {
      if (catalogIndexSeen) throw new Error("--catalog-index may be specified only once");
      catalogIndexSeen = true;
      catalogIndex = values[++index];
      if (!catalogIndex || catalogIndex.startsWith("--")) throw new Error("--catalog-index requires a file path or https URL");
    } else {
      throw new Error(`unknown list option: ${arg}`);
    }
  }
  if (!role && (json || catalogIndexSeen)) throw new Error("--json and --catalog-index require --role");
  if (role && !ROLES.has(role)) throw new Error(`unknown role "${role}" (choose one of ${[...ROLES].join(", ")})`);
  return { role, catalogIndex, json };
}

async function readCatalogIndex(source) {
  const catalogFailure = (message) => Object.assign(new Error(message), { exitCode: 1 });
  let text;
  if (/^https:\/\//i.test(source)) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await fetch(source, { signal: controller.signal });
      if (!response.ok) throw catalogFailure(`catalog index request failed with HTTP ${response.status}`);
      text = await response.text();
    } catch (error) {
      if (error.name === "AbortError") throw catalogFailure("catalog index request timed out after 10 seconds");
      if (error.exitCode === 1) throw error;
      throw catalogFailure(`could not read catalog index: ${error.message}`);
    } finally {
      clearTimeout(timer);
    }
  } else if (/^https?:\/\//i.test(source)) {
    throw catalogFailure("catalog index must be a local file or an https URL");
  } else {
    try { text = readFileSync(source, "utf8"); }
    catch (error) { throw catalogFailure(`could not read catalog index file: ${error.message}`); }
  }
  let index;
  try { index = JSON.parse(text); }
  catch (error) { throw catalogFailure(`catalog index is not valid JSON: ${error.message}`); }
  if (!index || typeof index !== "object" || Array.isArray(index) || !Array.isArray(index.listings)) {
    throw catalogFailure("catalog index is malformed: expected an object with a listings array");
  }
  const ids = new Set();
  for (const [position, listing] of index.listings.entries()) {
    if (!listing || typeof listing !== "object" || Array.isArray(listing)) throw catalogFailure(`catalog index listing ${position + 1} is malformed`);
    for (const field of ["id", "url", "version", "base"]) {
      if (typeof listing[field] !== "string" || listing[field].length === 0) throw catalogFailure(`catalog index listing ${position + 1} has an invalid ${field}`);
    }
    if (ids.has(listing.id)) throw catalogFailure(`catalog index has duplicate listing id ${listing.id}`);
    ids.add(listing.id);
    const discovery = listing.discovery;
    if (!discovery || typeof discovery !== "object" || Array.isArray(discovery) || !["classified", "not-classified"].includes(discovery.status)) {
      throw catalogFailure(`catalog index listing ${listing.id} has an unknown discovery status`);
    }
    if (!Array.isArray(discovery.roles)) throw catalogFailure(`catalog index listing ${listing.id} has malformed discovery roles`);
    if (discovery.status === "classified" && discovery.roles.length === 0) throw catalogFailure(`catalog index listing ${listing.id} is classified but has no discovery roles`);
    if (discovery.status === "not-classified" && discovery.roles.length > 0) throw catalogFailure(`catalog index listing ${listing.id} is not-classified but has discovery roles`);
    const roles = new Set();
    for (const candidate of discovery.roles) {
      if (!candidate || typeof candidate !== "object" || !ROLES.has(candidate.role) || !COMPONENT_TYPES.has(candidate.componentType)) {
        throw catalogFailure(`catalog index listing ${listing.id} has a malformed discovery role`);
      }
      if (roles.has(candidate.role)) throw catalogFailure(`catalog index listing ${listing.id} has duplicate discovery role ${candidate.role}`);
      roles.add(candidate.role);
    }
  }
  return index;
}

async function listRole(role, source, json) {
  const index = await readCatalogIndex(source);
  const candidates = index.listings
    .filter((listing) => listing.discovery.status === "classified" && listing.discovery.roles.some((entry) => entry.role === role))
    .map(({ id, url, version, base, discovery }) => ({ id, url, version, base, discovery }))
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  if (json) {
    console.log(JSON.stringify(candidates, null, 2));
    return;
  }
  console.log(`\nCatalog candidates for role: ${role}\n`);
  if (candidates.length === 0) {
    console.log("  No classified candidates found.");
  } else {
    for (const candidate of candidates) {
      const types = [...new Set(candidate.discovery.roles.filter((entry) => entry.role === role).map((entry) => entry.componentType))].sort();
      console.log(`  ${candidate.id} (${candidate.version}) — ${types.join(", ")}: ${candidate.url}`);
      console.log("    Inspect the full listing and its evidence before choosing a candidate.");
    }
  }
  console.log("\nThese are discovery candidates, not runtime claims or an automatic selection.\n");
}

function loadConfig(name) {
  try { return loadInput(name, RENDERS_DIR, "config"); }
  catch (error) { console.error(error.message); process.exit(2); }
}

// Ask each image's own registry, anonymously, whether it can be pulled. This is the
// one part of check that needs a network, so it happens only with --images. A private
// image a cluster can pull with its own credentials is reported as needing them, not
// as missing.
function canPull(images) {
  return images.map((image) => {
    const reference = pullReference(image);
    try {
      const described = execFileSync("oras", ["manifest", "fetch", "--descriptor", reference], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60000, env: { ...process.env, DOCKER_CONFIG: "/nonexistent-so-the-pull-is-anonymous" } });
      // The registry answers with the digest of the bytes behind that name. A tag can
      // move; the digest is what you would pin to keep these exact bytes.
      const digest = (String(described).match(/"digest"\s*:\s*"(sha256:[0-9a-f]{64})"/) ?? [])[1] ?? null;
      return { image, result: "pulls", digest, pinned: image.includes("@sha256:") };
    } catch (error) {
      const said = String(error.stderr ?? error.message);
      if (/unauthorized|authentication required|credential|denied/i.test(said)) return { image, result: "needs credentials" };
      if (/not found|manifest unknown|NAME_UNKNOWN|MANIFEST_UNKNOWN|404/i.test(said)) return { image, result: "NOT FOUND" };
      return { image, result: "could not be checked" };
    }
  });
}

function analyze(config) {
  const kinds = {};
  const created = new Set();
  const used = new Set();
  const crds = [];
  let hooks = 0;
  let jobs = 0;
  let webhooksNeedingCa = 0;
  const floating = new Set();
  const allImages = new Set();
  // An image named without a digest, and tagged latest or not at all, can be different bytes tomorrow.
  const podSpecs = (obj) => [obj.spec?.template?.spec, obj.spec?.jobTemplate?.spec?.template?.spec, obj.kind === "Pod" ? obj.spec : null].filter(Boolean);
  for (const obj of config.objects) {
    for (const pod of podSpecs(obj)) {
      for (const container of [...(pod.initContainers ?? []), ...(pod.containers ?? []), ...(pod.ephemeralContainers ?? [])]) {
        const image = String(container.image ?? "");
        if (!image) continue;
        allImages.add(image);
        if (image.includes("@sha256:")) continue;
        const tag = image.slice(image.lastIndexOf("/") + 1).split(":")[1];
        if (!tag || tag === "latest") floating.add(image);
      }
    }
    kinds[obj.kind] = (kinds[obj.kind] ?? 0) + 1;
    if (obj.kind === "Namespace") created.add(obj.metadata.name);
    if (obj.metadata?.namespace) used.add(obj.metadata.namespace);
    if (obj.kind === "CustomResourceDefinition") crds.push(obj.metadata.name);
    if (obj.metadata?.annotations?.["helm.sh/hook"]) hooks += 1;
    if (obj.kind === "Job") jobs += 1;
    if (String(obj.kind).endsWith("WebhookConfiguration") && (obj.webhooks ?? []).some((hook) => !hook.clientConfig?.caBundle)) webhooksNeedingCa += 1;
  }
  const nsPrereqs = [...used].filter((namespace) => !created.has(namespace)).sort();
  return { kinds, nsPrereqs, crds, hooks, jobs, webhooksNeedingCa, floating: [...floating].sort(), images: [...allImages].sort() };
}

if (verb === "list") {
  try {
    const options = parseListArgs(args.slice(1));
    if (options.role) {
      await listRole(options.role, options.catalogIndex, options.json);
    } else {
      console.log(`\nAvailable configs (verified chart renders shipped with the plugin)\n`);
      for (const file of readdirSync(RENDERS_DIR).filter((entry) => entry.endsWith(".yaml")).sort()) {
        console.log(`  ${file.replace(/\.yaml$/, "")}`);
      }
      console.log(`\ncub config check <name | local.yaml> [--images]   # render and check, free\n`);
    }
  } catch (error) {
    const wrapped = new Error(`usage: cub config list [--role ROLE] [--json] [--catalog-index FILE_OR_HTTPS_URL]\n${error.message}`);
    wrapped.exitCode = error.exitCode ?? 2;
    throw wrapped;
  }
} else if (verb === "check") {
  if (!name) {
    console.error("usage: cub config check <name | local.yaml> [--images]");
    process.exit(2);
  }
  const config = loadConfig(name);
  const facts = analyze(config);

  console.log(`\nConfig: ${config.name}`);
  console.log(config.local ? "Inspecting local Kubernetes objects (static, no infrastructure)\n" : "Rendering the chart from the catalog (free, no infrastructure)\n");
  console.log("Installs");
  console.log(`  ${config.objects.length} objects: ${Object.entries(facts.kinds).sort().map(([kind, count]) => `${count} ${kind}`).join(", ")}`);
  console.log(`  namespaces that must already exist: ${facts.nsPrereqs.length ? facts.nsPrereqs.join(", ") : "none"}\n`);

  console.log("Lifecycle work");
  console.log(`  ${facts.crds.length ? "[NOTE]" : "[PASS]"} CRDs: ${facts.crds.length}${facts.crds.length ? " (apply and establish before any custom resource)" : ""}`);
  console.log(`  ${facts.hooks ? "[NOTE]" : "[PASS]"} Helm hooks: ${facts.hooks}`);
  console.log(`  ${facts.jobs ? "[NOTE]" : "[PASS]"} setup Jobs: ${facts.jobs}`);
  console.log(`  ${facts.webhooksNeedingCa ? "[NOTE]" : "[PASS]"} admission webhooks needing a certificate: ${facts.webhooksNeedingCa}`);
  console.log(`  ${facts.floating.length ? "[NOTE]" : "[PASS]"} images tagged latest or not tagged: ${facts.floating.length}${facts.floating.length ? ` (${facts.floating.slice(0, 3).join(", ")}${facts.floating.length > 3 ? `, and ${facts.floating.length - 3} more` : ""}). The same name can pull different bytes later` : ""}`);
  if (IMAGES) {
    const pulls = canPull(facts.images);
    const broken = pulls.filter((entry) => entry.result !== "pulls");
    const loose = pulls.filter((entry) => entry.result === "pulls" && !entry.pinned && entry.digest);
    console.log(`  ${broken.length ? "[NOTE]" : "[PASS]"} images that pull anonymously: ${pulls.length - broken.length} of ${pulls.length}`);
    for (const entry of broken) console.log(`         ${entry.result}: ${entry.image}`);
    // Every name resolves to bytes. Say which bytes, so a reader can pin what they checked.
    for (const entry of pulls.filter((item) => item.digest)) {
      console.log(`         ${entry.pinned ? "pinned  " : "resolves"} ${entry.image}${entry.pinned ? "" : ` -> ${entry.digest}`}`);
    }
    if (loose.length) console.log(`         ${loose.length} image${loose.length === 1 ? " is" : "s are"} named by tag. Pin with name@digest to keep the bytes checked here.`);
  }
  console.log(`\n  Free look before you install. Compose it into a cub stack, or run it as a cub app.\n`);
  if (OUT && OUT.startsWith("oci://")) {
    const content = config.bytes;
    const files = [{ path: `${config.name}.yaml`, content }];
    const checks = [
      ["PASS", `${config.objects.length} objects`],
      [facts.crds.length ? "NOTE" : "PASS", `CRDs: ${facts.crds.length}`],
      [facts.hooks ? "NOTE" : "PASS", `Helm hooks: ${facts.hooks}`],
      [facts.jobs ? "NOTE" : "PASS", `setup Jobs: ${facts.jobs}`],
      [facts.webhooksNeedingCa ? "NOTE" : "PASS", `admission webhooks needing a certificate: ${facts.webhooksNeedingCa}`],
      [facts.floating.length ? "NOTE" : "PASS", `images tagged latest or not tagged: ${facts.floating.length}`],
      ...(IMAGES ? [[facts.images.every((image) => canPull([image])[0].result === "pulls") ? "PASS" : "NOTE", `images that pull anonymously, checked at ${new Date().toISOString().slice(0, 10)}`]] : []),
      ["PASS", `namespaces that must already exist: ${facts.nsPrereqs.join(", ") || "none"}`],
    ];
    const receipt = buildReceipt({ name: config.name, source: { kind: "render", name: config.name, origin: config.local ? "local-file" : "cub-workshop renders/" }, files, checks });
    const published = publishBundle({ reference: OUT, files, receipt, title: config.name });
    if (SIGN) signDigest({ reference: receipt.spec.bundle.reference, digest: published.digest, key: SIGN });
    printPublished(`config ${config.name}`, { ...published, receipt });
    const back = verifyBundle(receipt.spec.bundle.reference);
    console.log(`    pull-back: ${back.verified ? "verified" : "REFUSED"}\n`);
    if (!back.verified) process.exit(1);
  } else if (OUT) {
    writeFileSync(OUT, config.bytes);
    console.log(`  Wrote the render to ${OUT}\n`);
  }
} else if (verb === "verify") {
  if (!name) { console.error("usage: cub config verify oci://<repo>@sha256:<digest>"); process.exit(2); }
  const result = verifyBundle(name, { key: KEY });
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
  cub config diff <before.yaml> <after.yaml> [--json] [--out result.json] [--exit-code]
  cub config values <chart> --values my-values.yaml [--version X] [--repo URL] [--json] [--out result.json] [--render-out candidate.yaml] [--exit-code]
  cub config list
  cub config list --role ROLE [--json] [--catalog-index FILE_OR_HTTPS_URL]
  cub config check <name | local.yaml> [--images] [--out oci://<repo>[:tag] [--sign cosign.key] | --out file.yaml]
  cub config verify oci://<repo>@sha256:<digest> [--key cosign.pub]

This is the prototype of the proposed config verb, packaged as a cub plugin.`);
  process.exit(verb ? 2 : 0);
}
