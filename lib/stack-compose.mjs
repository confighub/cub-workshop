#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import childProcess from "node:child_process";
import { parseDocs, pluginRoot, toYaml } from "./common.mjs";

const ROLES_VERDICTS = new Set(["safe-to-flatten", "born-flat"]);
const INDEX_DEFAULT = "https://confighub.github.io/helm-expt/site/listings/index.json";
const TIMEOUT_MS = 10000;

const ACTIONS = {
  invalid_arguments: ["inspect", "repair"],
  entry_not_found: ["select", "inspect"],
  missing_retained_objects: ["inspect", "repair"],
  lifecycle_route_required: ["inspect", "repair"],
  source_integrity_failed: ["inspect", "repair"],
  source_invalid: ["inspect", "repair"],
  network_failed: ["inspect", "repair"],
  output_exists: ["select", "inspect"],
  output_write_failed: ["inspect", "repair"],
  check_failed: ["inspect", "repair"],
  internal_error: ["inspect", "repair"],
};
class ComposeError extends Error {
  constructor(code, message, exitCode = 1) { super(message); this.name = "ComposeError"; this.code = code; this.exitCode = exitCode; this.actions = ACTIONS[code] ?? ACTIONS.invalid_arguments; }
}
const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const fail = (message, exitCode = 2, code = "invalid_arguments") => { throw new ComposeError(code, message, exitCode); };
const usage = "usage: cub stack compose --entry ID [--entry ID ...] --name NAME --out NEW_DIRECTORY [--catalog-index FILE_OR_HTTPS_URL] [--json]";
const isHttps = (value) => /^https:\/\//i.test(value);
const isHttp = (value) => /^https?:\/\//i.test(value);

function parseArgs(args) {
  const entries = [];
  let name = null; let out = null; let catalogIndex = INDEX_DEFAULT; let json = false; let indexSeen = false;
  const take = (flag, index) => { const value = args[index + 1]; if (!value || value.startsWith("--")) fail(`${flag} requires a value`); return value; };
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--entry") { entries.push(take(arg, i)); i += 1; }
    else if (arg === "--name") { if (name !== null) fail("--name may be specified only once"); name = take(arg, i); i += 1; }
    else if (arg === "--out") { if (out !== null) fail("--out may be specified only once"); out = take(arg, i); i += 1; }
    else if (arg === "--catalog-index") { if (indexSeen) fail("--catalog-index may be specified only once"); indexSeen = true; catalogIndex = take(arg, i); i += 1; }
    else if (arg === "--json") json = true;
    else fail(`unknown option: ${arg}`);
  }
  if (entries.length === 0 || !name || !out) fail(usage);
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(name)) fail("--name must be lowercase letters, digits, and dashes");
  if (entries.some((id) => !/^[a-z0-9][a-z0-9-]*$/.test(id))) fail("--entry IDs must be catalog IDs, not paths");
  if (new Set(entries).size !== entries.length) fail("duplicate --entry ID");
  if (out.split(/[\\/]/).includes("..")) fail("--out must not contain path traversal");
  if (isHttp(catalogIndex) && !isHttps(catalogIndex)) fail("catalog index must be a local file or an https URL", 1);
  const target = resolve(out);
  if (target === "/") fail("--out must name a new directory");
  if (existsSync(target)) fail(`output directory already exists: ${out}`, 2, "output_exists");
  return { entries: [...entries].sort(), name, out: target, catalogIndex, json };
}

async function readSource(source, description) {
  if (isHttps(source)) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(source, { signal: controller.signal, redirect: "error" });
      if (!response.ok) fail(`${description} request failed with HTTP ${response.status}`, 1, "network_failed");
      return { bytes: Buffer.from(await response.arrayBuffer()), source, remote: true };
    } catch (error) {
      if (error.exitCode) throw error;
      fail(`${description} request failed: ${error.name === "AbortError" ? `timed out after ${TIMEOUT_MS / 1000} seconds` : "network error"}`, 1, "network_failed");
    } finally { clearTimeout(timer); }
  }
  if (isHttp(source)) fail(`${description} must use https`, 1, "network_failed");
  try { return { bytes: readFileSync(source), source: resolve(source), remote: false }; }
  catch (error) { fail(`could not read ${description}`, 1, "network_failed"); }
}

function parseJson(bytes, description) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch (error) { fail(`${description} is not valid JSON`, 1, "source_invalid"); }
}

function requireString(value, label) { if (typeof value !== "string" || !value) fail(`${label} is missing or invalid`, 1, "source_invalid"); return value; }

async function loadListings(options) {
  const indexSource = await readSource(options.catalogIndex, "catalog index");
  const index = parseJson(indexSource.bytes, "catalog index");
  if (!index || typeof index !== "object" || !Array.isArray(index.listings)) fail("catalog index is malformed: expected listings", 1, "source_invalid");
  const byId = new Map();
  for (const entry of index.listings) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || byId.has(entry.id)) fail("catalog index has a duplicate or malformed ID", 1, "source_invalid");
    byId.set(entry.id, entry);
  }
  const records = [];
  for (const id of options.entries) {
    const indexEntry = byId.get(id); if (!indexEntry) fail(`catalog listing not found: ${id}`, 1, "entry_not_found");
    const listingRef = requireString(indexEntry.url, `${id}.url`);
    if (isHttp(listingRef) && !isHttps(listingRef)) fail(`${id}.url must use https`, 1, "network_failed");
    if (indexSource.remote && !isHttps(listingRef)) fail(`${id}.url must be https when the index is remote`, 1, "network_failed");
    const listingSource = isAbsolute(listingRef) || isHttps(listingRef) ? listingRef : join(dirname(indexSource.source), listingRef);
    const listingRead = await readSource(listingSource, `listing ${id}`);
    const listing = parseJson(listingRead.bytes, `listing ${id}`);
    if (listing?.identity?.id !== id) fail(`listing ${id} identity does not match the requested ID`, 1, "source_invalid");
    const retained = listing?.flattened?.retainedObjects;
    if (!retained || typeof retained !== "object") fail(`listing ${id} has no flattened.retainedObjects identity`, 1, "missing_retained_objects");
    if (typeof retained.path !== "string" || !retained.path) fail(`${id}.flattened.retainedObjects.path is missing or invalid`, 1, "missing_retained_objects");
    if (typeof retained.url !== "string" || !retained.url) fail(`${id}.flattened.retainedObjects.url is missing or invalid`, 1, "missing_retained_objects");
    if (!/^sha256:([a-f0-9]{64})$/.test(retained.sha256)) fail(`listing ${id} has an invalid retained object sha256`, 1, "source_invalid");
    const verdict = listing.flattened?.verdict;
    if (!ROLES_VERDICTS.has(verdict)) fail(`listing ${id} is ${verdict ?? "missing a flattening verdict"}; compose accepts only safe-to-flatten or born-flat`, 1, ["unsafe-to-flatten", "flatten-with-routes"].includes(verdict) ? "lifecycle_route_required" : "source_invalid");
    if (isHttp(retained.url) && !isHttps(retained.url)) fail(`${id}.flattened.retainedObjects.url must use https`, 1, "network_failed");
    if (listingRead.remote && !isHttps(retained.url)) fail(`${id}.flattened.retainedObjects.url must be https when the listing is remote`, 1, "network_failed");
    if (!listingRead.remote && isAbsolute(retained.path)) fail(`${id}.flattened.retainedObjects.path must be relative to its listing`, 1, "source_invalid");
    if (retained.path.split(/[\\/]/).includes("..")) fail(`${id}.flattened.retainedObjects.path must not contain path traversal`, 1, "source_invalid");
    const objectRef = isHttps(retained.url) ? retained.url : join(dirname(listingSource), retained.path);
    const objectSource = await readSource(objectRef, `retained objects for ${id}`);
    const actualHash = sha256(objectSource.bytes);
    if (actualHash !== retained.sha256) fail(`retained object hash mismatch for ${id}`, 1, "source_integrity_failed");
    let objects;
    try { objects = parseDocs(objectSource.bytes.toString("utf8")); }
    catch (error) { fail(`retained objects for ${id} are not valid YAML`, 1, "source_invalid"); }
    if (!Number.isInteger(listing.flattened.objectCount) || listing.flattened.objectCount <= 0) fail(`listing ${id} has an invalid flattened.objectCount`, 1, "source_invalid");
    if (objects.some((object) => !object || typeof object !== "object" || Array.isArray(object)
      || typeof object.apiVersion !== "string" || !object.apiVersion
      || typeof object.kind !== "string" || !object.kind
      || typeof object.metadata?.name !== "string" || !object.metadata.name)) {
      fail(`retained objects for ${id} contain an empty, unnamed, or malformed Kubernetes document`, 1, "source_invalid");
    }
    if (listing.flattened.objectCount !== objects.length) fail(`retained object count mismatch for ${id}`, 1, "source_invalid");
    records.push({ id, listing, listingSource, listingBytes: listingRead.bytes, listingHash: sha256(listingRead.bytes), objectSource, objectHash: actualHash, objects });
  }
  return records;
}

function provenance(records) {
  return {
    kind: "CatalogRetainedComposition",
    contract: "Exact retained catalog objects only; no OCI bundle, receipt, readiness, compatibility, or runtime claim is created.",
    entries: records.map(({ id, listing, listingSource, listingBytes, listingHash, objectSource, objectHash }) => ({
      id, listing: listingSource, listingSha256: listingHash,
      listingBytesBase64: listingBytes.toString("base64"), listingBytesEncoding: "base64",
      listingSnapshot: listing,
      objects: objectSource.source, objectsSha256: objectHash,
      originalVerdict: listing.flattened.verdict,
      routing: listing.flattened.routing ?? listing.routing ?? null,
      evidence: listing.evidence ?? null,
      boundaries: listing.flattened.boundaries ?? listing.flattened.boundary ?? null,
    })),
  };
}

async function compose(args) {
  const options = parseArgs(args); const records = await loadListings(options);
  try { mkdirSync(options.out); } catch (error) {
    if (error.code === "EEXIST") fail("output directory already exists", 2, "output_exists");
    fail("could not create output directory", 1, "output_write_failed");
  }
  try { mkdirSync(join(options.out, "components")); } catch (error) { fail("could not create output components directory", 1, "output_write_failed"); }
  const writeOutput = (path, data) => {
    try { writeFileSync(path, data, { flag: "wx" }); }
    catch (error) { fail("could not write composition output", 1, "output_write_failed"); }
  };
  const components = records.map((record, index) => ({ name: record.id, render: `components/${String(index + 1).padStart(2, "0")}-${record.id}.yaml` }));
  for (let i = 0; i < records.length; i += 1) writeOutput(join(options.out, components[i].render), records[i].objectSource.bytes);
  const manifest = { apiVersion: "helm-expt.confighub.com/v1alpha1", kind: "Stack", metadata: { name: options.name }, spec: { description: "Explicit catalog retained-object composition", components } };
  writeOutput(join(options.out, "stack.yaml"), toYaml(manifest));
  writeOutput(join(options.out, "provenance.json"), `${JSON.stringify(provenance(records), null, 2)}\n`);
  const checked = childProcess.spawnSync(process.execPath, [join(pluginRoot, "bin/cub-stack"), "check", join(options.out, "stack.yaml"), "--json"], { encoding: "utf8", timeout: 30000 });
  if (checked.error || checked.status === null) fail("stack check subprocess failed", 1, "check_failed");
  let result; try { result = JSON.parse(checked.stdout); } catch { fail("stack check did not return JSON", 1, "check_failed"); }
  writeOutput(join(options.out, "result.json"), `${JSON.stringify(result, null, 2)}\n`);
  const output = { kind: "CatalogRetainedCompositionResult", name: options.name, output: options.out, entries: records.map((record) => record.id), provenance: "provenance.json", result: { ...result, exitCode: checked.status } };
  if (options.json) console.log(JSON.stringify(output, null, 2));
  else console.log(`${options.name}: ${records.length} retained catalog component(s); stack check ${checked.status === 0 ? "CHECKED" : "REFUSED"}. Files: ${options.out}`);
  if (checked.status !== 0) { if (!options.json) console.error("The retained files and evidence were preserved for inspection."); process.exitCode = 1; }
}

export { compose };
await compose(process.argv.slice(3));
