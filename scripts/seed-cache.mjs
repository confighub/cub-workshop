#!/usr/bin/env node
// Publish the shipped renders as certified bundles, seed the plugin's cache
// with their bytes, and rewrite the render-form stacks to bundle form, so a
// manifest names an image while certify still works offline.
//
//   node scripts/seed-cache.mjs --registry localhost:5001/workshop \
//     --public europe-west1-docker.pkg.dev/nth-fort-499605-q5/helm-expt/bundles
//
// The digest is reproducible, so pushing to a local registry now and to the
// public one later yields the same digest; the receipt records the public
// reference and the manifests name it.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseDocs, pluginRoot } from "../lib/common.mjs";
import { publishBundle } from "../lib/oci.mjs";
import { buildReceipt } from "../lib/receipt.mjs";

const args = process.argv.slice(2);
const opt = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
const registry = opt("--registry");
const publicBase = opt("--public") ?? registry;
if (!registry) { console.error("usage: node scripts/seed-cache.mjs --registry <host/repo> [--public <host/repo>]"); process.exit(2); }

const rendersDir = join(pluginRoot, "renders");
const receiptsDir = join(pluginRoot, "receipts", "workshop");
mkdirSync(receiptsDir, { recursive: true });
const published = {};
for (const file of readdirSync(rendersDir).filter((entry) => entry.endsWith(".yaml")).sort()) {
  const name = file.replace(/\.yaml$/, "");
  const content = readFileSync(join(rendersDir, file));
  const objects = parseDocs(content.toString("utf8")).filter((doc) => doc?.kind && doc.metadata?.name).length;
  const files = [{ path: `${name}.yaml`, content }];
  const receipt = buildReceipt({ name, source: { kind: "render", name, origin: "cub-workshop renders/" }, files, checks: [["PASS", `${objects} objects`]] });
  const result = publishBundle({ reference: `oci://${registry}/workshop-${name}:v1`, files, receipt, title: name });
  receipt.spec.bundle.reference = `oci://${publicBase}/workshop-${name}@${result.digest}`;
  writeFileSync(join(receiptsDir, `${name}.json`), JSON.stringify(receipt, null, 2));
  const cacheDir = join(pluginRoot, "cache", result.digest.slice(7, 23));
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(join(cacheDir, `${name}.yaml`), content);
  published[name] = result.digest;
  console.log(`${name}: ${result.digest}`);
}

const stacksDir = join(pluginRoot, "stacks");
for (const file of readdirSync(stacksDir).filter((entry) => entry.endsWith(".yaml"))) {
  const path = join(stacksDir, file);
  let text = readFileSync(path, "utf8");
  let changed = false;
  text = text.replace(/^(\s*)render: "renders\/([a-z0-9-]+)\.yaml"\s*$/gm, (match, indent, name) => {
    if (!published[name]) return match;
    changed = true;
    return `${indent}bundle: "oci://${publicBase}/workshop-${name}@${published[name]}"\n${indent}receipt: "receipts/workshop/${name}.json"`;
  });
  // Already-migrated components: refresh the digest if the bytes republished differently.
  text = text.replace(/^(\s*)bundle: "oci:\/\/[^"]*\/workshop-([a-z0-9-]+)@sha256:[0-9a-f]{64}"\s*$/gm, (match, indent, name) => {
    if (!published[name]) return match;
    const next = `${indent}bundle: "oci://${publicBase}/workshop-${name}@${published[name]}"`;
    if (next !== match) changed = true;
    return next;
  });
  if (changed) { writeFileSync(path, text); console.log(`rewrote ${file}`); }
}
