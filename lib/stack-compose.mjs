#!/usr/bin/env node
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { parseDocs, pluginRoot, toYaml } from "./common.mjs";

const ROLES_VERDICTS = new Set(["safe-to-flatten", "born-flat"]);
const HEX = /^[a-f0-9]{64}$/;
const INDEX_DEFAULT = "https://confighub.github.io/helm-expt/site/listings/index.json";
const TIMEOUT_MS = 10000;

const sha256 = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const fail = (message, code = 2) => { const error = new Error(message); error.exitCode = code; throw error; };
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
    else if (arg === "--name") { name = take(arg, i); i += 1; }
    else if (arg === "--out") { out = take(arg, i); i += 1; }
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
  if (target === "/" || target === resolve(".") || target.endsWith(`${relative(target, dirname(target))}/..`)) fail("--out must name a new directory");
  if (existsSync(target)) fail(`output directory already exists: ${out}`);
  return { entries: [...entries].sort(), name, out: target, catalogIndex, json };
}

async function readSource(source, description) {
  if (isHttps(source)) {
    const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await fetch(source, { signal: controller.signal });
      if (!response.ok) fail(`${description} request failed with HTTP ${response.status}`, 1);
      return { bytes: Buffer.from(await response.arrayBuffer()), source, remote: true };
    } catch (error) {
      if (error.exitCode) throw error;
      fail(`${description} request failed: ${error.name === "AbortError" ? `timed out after ${TIMEOUT_MS / 1000} seconds` : error.message}`, 1);
    } finally { clearTimeout(timer); }
  }
  if (isHttp(source)) fail(`${description} must use https`, 1);
  try { return { bytes: readFileSync(source), source: resolve(source), remote: false }; }
  catch (error) { fail(`could not read ${description}: ${error.message}`, 1); }
}

function parseJson(bytes, description) {
  try { return JSON.parse(bytes.toString("utf8")); }
  catch (error) { fail(`${description} is not valid JSON: ${error.message}`, 1); }
}

function requireString(value, label) { if (typeof value !== "string" || !value) fail(`${label} is missing or invalid`, 1); return value; }

async function loadListings(options) {
  const indexSource = await readSource(options.catalogIndex, "catalog index");
  const index = parseJson(indexSource.bytes, "catalog index");
  if (!index || typeof index !== "object" || !Array.isArray(index.listings)) fail("catalog index is malformed: expected listings", 1);
  const byId = new Map();
  for (const entry of index.listings) {
    if (!entry || typeof entry !== "object" || typeof entry.id !== "string" || byId.has(entry.id)) fail(`catalog index has duplicate or malformed ID: ${entry?.id ?? "unknown"}`, 1);
    byId.set(entry.id, entry);
  }
  const records = [];
  for (const id of options.entries) {
    const indexEntry = byId.get(id); if (!indexEntry) fail(`catalog listing not found: ${id}`, 1);
    const listingRef = requireString(indexEntry.url, `${id}.url`);
    if (indexSource.remote && !isHttps(listingRef)) fail(`${id}.url must be https when the index is remote`, 1);
    const listingSource = isAbsolute(listingRef) || isHttps(listingRef) ? listingRef : join(dirname(indexSource.source), listingRef);
    const listingRead = await readSource(listingSource, `listing ${id}`);
    const listing = parseJson(listingRead.bytes, `listing ${id}`);
    if (listing?.identity?.id !== id) fail(`listing ${id} identity does not match the requested ID`, 1);
    const retained = listing?.flattened?.retainedObjects;
    if (!retained || typeof retained !== "object") fail(`listing ${id} has no flattened.retainedObjects identity`, 1);
    requireString(retained.path, `${id}.flattened.retainedObjects.path`);
    requireString(retained.url, `${id}.flattened.retainedObjects.url`);
    if (!/^sha256:([a-f0-9]{64})$/.test(retained.sha256)) fail(`listing ${id} has an invalid retained object sha256`, 1);
    const verdict = listing.flattened?.verdict;
    if (!ROLES_VERDICTS.has(verdict)) fail(`listing ${id} is ${verdict ?? "missing a flattening verdict"}; compose accepts only safe-to-flatten or born-flat`, 1);
    if (indexSource.remote && !isHttps(retained.url)) fail(`${id}.flattened.retainedObjects.url must be https when the index is remote`, 1);
    if (!listingRead.remote && isAbsolute(retained.path)) fail(`${id}.flattened.retainedObjects.path must be relative to its listing`, 1);
    const objectRef = isHttps(retained.url) ? retained.url : join(dirname(listingSource), retained.path);
    const objectSource = await readSource(objectRef, `retained objects for ${id}`);
    const actualHash = sha256(objectSource.bytes);
    if (actualHash !== retained.sha256) fail(`retained object hash mismatch for ${id}: expected ${retained.sha256}, got ${actualHash}`, 1);
    let objects;
    try { objects = parseDocs(objectSource.bytes.toString("utf8")); }
    catch (error) { fail(`retained objects for ${id} are not valid YAML: ${error.message}`, 1); }
    objects = objects.filter(Boolean);
    if (objects.some((object) => !object || typeof object !== "object" || Array.isArray(object) || typeof object.kind !== "string" || !object.metadata?.name)) fail(`retained objects for ${id} contain an unnamed or non-Kubernetes document`, 1);
    if (listing.flattened.objectCount !== objects.length) fail(`retained object count mismatch for ${id}: expected ${listing.flattened.objectCount}, got ${objects.length}`, 1);
    records.push({ id, listing, listingSource, listingHash: sha256(listingRead.bytes), objectSource, objectHash: actualHash, objects });
  }
  return records;
}

function provenance(records) {
  return {
    kind: "CatalogRetainedComposition",
    contract: "Exact retained catalog objects only; no OCI bundle, receipt, readiness, compatibility, or runtime claim is created.",
    entries: records.map(({ id, listing, listingSource, listingHash, objectSource, objectHash }) => ({
      id, listing: listing.identity?.url ?? listingSource, listingSha256: listingHash,
      objects: listing.flattened.retainedObjects.url ?? objectSource.source, objectsSha256: objectHash,
      originalVerdict: listing.flattened.verdict,
      routing: listing.flattened.routing ?? listing.routing ?? null,
      evidence: listing.evidence ?? null,
      boundaries: listing.flattened.boundaries ?? listing.flattened.boundary ?? null,
    })),
  };
}

async function compose(args) {
  const options = parseArgs(args); const records = await loadListings(options);
  mkdirSync(options.out); mkdirSync(join(options.out, "components"));
  const components = records.map((record, index) => ({ name: record.id, render: `components/${String(index + 1).padStart(2, "0")}-${record.id}.yaml` }));
  for (let i = 0; i < records.length; i += 1) writeFileSync(join(options.out, components[i].render), records[i].objectSource.bytes, { flag: "wx" });
  const manifest = { apiVersion: "helm-expt.confighub.com/v1alpha1", kind: "Stack", metadata: { name: options.name }, spec: { description: "Explicit catalog retained-object composition", components } };
  writeFileSync(join(options.out, "stack.yaml"), toYaml(manifest), { flag: "wx" });
  writeFileSync(join(options.out, "provenance.json"), `${JSON.stringify(provenance(records), null, 2)}\n`, { flag: "wx" });
  const checked = spawnSync(process.execPath, [join(pluginRoot, "bin/cub-stack"), "check", join(options.out, "stack.yaml"), "--json"], { encoding: "utf8", timeout: 30000 });
  let result; try { result = JSON.parse(checked.stdout); } catch { fail(`stack check did not return JSON: ${checked.stderr || checked.stdout}`, 1); }
  writeFileSync(join(options.out, "result.json"), `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
  const output = { kind: "CatalogRetainedCompositionResult", name: options.name, output: options.out, entries: records.map((record) => record.id), provenance: "provenance.json", result: { ...result, exitCode: checked.status } };
  if (options.json) console.log(JSON.stringify(output, null, 2));
  else console.log(`${options.name}: ${records.length} retained catalog component(s); stack check ${checked.status === 0 ? "CHECKED" : "REFUSED"}. Files: ${options.out}`);
  if (checked.status !== 0) { if (!options.json) console.error("The retained files and evidence were preserved for inspection."); process.exitCode = 1; }
}

export { compose };
await compose(process.argv.slice(3));
