// cub config values — did the values I set actually do anything?
//
//   cub config values <chart> --values my-values.yaml [--version X] [--repo URL]
//                     [--namespace ns] [--release name] [--json] [--out result.json]
//                     [--render-out candidate.yaml] [--exit-code]
//
// Helm accepts a values file without checking it against the chart. A key that
// is misspelled, out of date, or invented is simply ignored, and the install
// succeeds. This command answers, for every value you set, whether it matched a
// key the chart knows and whether it changed the objects the chart renders.
//
// It works by rendering. The chart is rendered with your values, then once more
// for each value with that one value taken out. If the objects are the same
// either way, the value did nothing. Charts generate passwords and checksums,
// so the same input does not always render the same bytes; the fields that move
// between two identical renders are found first and left out of every
// comparison. No cluster, no account, and no value is ever printed.

import { execFileSync } from "node:child_process";
import { closeSync, existsSync, lstatSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import { parseDocs, parseYaml, readYamlFile, sha256, toYaml } from "./common.mjs";
import { diffConfigs } from "./config-diff.mjs";
import { resourceRequirementsFindings, resourceValidationBoundary } from "./resource-requirements.mjs";

const MAX_RENDERS = 60;
const LOOKUP_SCAN_MAX_FILES = 400;
const LOOKUP_SCAN_MAX_FILE_BYTES = 256 * 1024;
const LOOKUP_SCAN_MAX_ARCHIVE_BYTES = 2 * 1024 * 1024;
const LOOKUP_SCAN_MAX_UNPACKED_BYTES = 8 * 1024 * 1024;
const LOOKUP_SCAN_MAX_CALLSITES = 100;
const LOOKUP_SCAN_MAX_MS = 1000;
const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const show = (path) => path.join(".");

function lookupTokens(action) {
  const tokens = [];
  for (let index = 0; index < action.length;) {
    const start = index;
    const character = action[index];
    if (/\s/.test(character) || "|,:".includes(character)) { index += 1; continue; }
    if (character === "(" || character === ")") { tokens.push({ type: "symbol", value: character }); index += 1; continue; }
    if (character === '"' || character === '`') {
      const quote = character;
      let value = "";
      index += 1;
      while (index < action.length && action[index] !== quote) {
        if (quote === '"' && action[index] === "\\" && index + 1 < action.length) index += 1;
        value += action[index++];
      }
      if (action[index] === quote) index += 1;
      tokens.push({ type: "string", value, start });
      continue;
    }
    while (index < action.length && !/\s/.test(action[index]) && !"()|,:".includes(action[index])) index += 1;
    tokens.push({ type: "word", value: action.slice(start, index), start });
  }
  return tokens;
}

function literalSourceCallsites(source, path) {
  const callsites = [];
  let malformed = false;
  let index = 0;
  let line = 1;
  const blocks = [];
  while (index < source.length) {
    const actionStart = source.indexOf("{{", index);
    if (actionStart < 0) break;
    line = (source.slice(0, actionStart).match(/\n/g) ?? []).length + 1;
    const comment = source.slice(actionStart + 2).match(/^[\s-]*\/\*/);
    if (comment) {
      const commentEnd = source.indexOf("*/", actionStart + 2 + comment[0].length);
      if (commentEnd < 0) { malformed = true; break; }
      let delimiter = commentEnd + 2;
      while (delimiter < source.length && /[\s-]/.test(source[delimiter])) delimiter += 1;
      if (source.slice(delimiter, delimiter + 2) !== "}}") { malformed = true; break; }
      index = delimiter + 2;
      continue;
    }
    let close = actionStart + 2;
    let quote = null;
    for (; close < source.length - 1; close += 1) {
      const character = source[close];
      if (quote) {
        if (quote === '"' && character === "\\") { close += 1; continue; }
        if (character === quote) quote = null;
      } else if (character === '"' || character === '`') quote = character;
      else if (source[close] === "}" && source[close + 1] === "}") break;
    }
    if (close >= source.length - 1) { malformed = true; break; }
    const action = source.slice(actionStart + 2, close).replace(/^-?\s*/, "");
    index = close + 2;
    // Helm evaluates actions even in YAML comments and quoted scalars. Quoted
    // string tokens within an action are inert; Go-template comments returned
    // above are consumed before their inner text can be treated as an action.
    const tokens = lookupTokens(action);
    const command = tokens[0]?.type === "word" ? tokens[0].value : null;
    if (["define", "if", "range", "with", "block"].includes(command)) blocks.push({ type: command, ...(command === "define" && tokens[1]?.type === "string" ? { name: tokens[1].value } : {}) });
    if (command === "end") blocks.pop();
    for (let tokenIndex = 0; tokenIndex < tokens.length; tokenIndex += 1) {
      if (tokens[tokenIndex].type !== "word" || tokens[tokenIndex].value !== "lookup") continue;
      const previous = tokens[tokenIndex - 1]?.value;
      if (previous === "." || previous === "$") continue;
      const args = tokens.slice(tokenIndex + 1, tokenIndex + 5);
      const unresolvedArguments = ["apiVersion", "kind", "namespace", "name"].filter((name, argumentIndex) => args[argumentIndex]?.type !== "string");
      const apiVersion = args[0]?.type === "string" ? args[0].value : null;
      const kind = args[1]?.type === "string" ? args[1].value : null;
      const definition = [...blocks].reverse().find((block) => block.type === "define" && block.name);
      callsites.push({
        path,
        line: line + (action.slice(0, tokens[tokenIndex].start).match(/\n/g) ?? []).length,
        scope: definition ? "named-template-definition" : "render-template",
        ...(definition ? { template: definition.name } : {}),
        ...(apiVersion && kind ? { staticGvk: { apiVersion, kind } } : {}),
        unresolvedArguments,
        execution: "not-evaluated",
      });
    }
  }
  return { callsites, malformed };
}

function archiveNumber(header, offset, length) {
  const text = header.subarray(offset, offset + length).toString("utf8").replace(/\0.*$/, "").trim();
  return /^[0-7]+$/.test(text) ? parseInt(text, 8) : null;
}

function safeArchivePath(name) {
  const normalized = name.replace(/\/$/, "");
  return normalized && !normalized.split("/").some((segment) => !segment || segment === "." || segment === "..");
}

// Lists literal Helm lookup source callsites without evaluating templates or
// extracting archive members. The result is complete only within this static
// source scope and only when every eligible file fit the fixed scan limits.
export function templateLookupInventory(source) {
  const callsites = [];
  const notChecked = [];
  let files = 0;
  let stopped = false;
  const deadline = Date.now() + LOOKUP_SCAN_MAX_MS;
  const incomplete = (reason) => {
    if (!notChecked.includes(reason)) notChecked.push(reason);
    stopped = true;
  };
  const add = (text, path) => {
    if (stopped) return;
    if (Date.now() > deadline) return incomplete("static source scan time limit reached");
    if (++files > LOOKUP_SCAN_MAX_FILES) return incomplete("static source file limit reached");
    if (Buffer.byteLength(text) > LOOKUP_SCAN_MAX_FILE_BYTES) return incomplete("static source file size limit reached");
    const found = literalSourceCallsites(text, path);
    if (found.malformed) return incomplete("unterminated Helm template action");
    if (callsites.length + found.callsites.length > LOOKUP_SCAN_MAX_CALLSITES) return incomplete("literal lookup callsite limit reached");
    callsites.push(...found.callsites);
  };
  const scanArchive = (file, path) => {
    if (stopped) return;
    let compressed;
    try { compressed = readFileSync(file); } catch { return incomplete("could not read packaged chart dependency"); }
    if (compressed.length > LOOKUP_SCAN_MAX_ARCHIVE_BYTES) return incomplete("packaged chart dependency size limit reached");
    let bytes;
    try { bytes = gunzipSync(compressed, { maxOutputLength: LOOKUP_SCAN_MAX_UNPACKED_BYTES }); }
    catch { return incomplete("could not read packaged chart dependency"); }
    if (Date.now() > deadline) return incomplete("static source scan time limit reached");
    for (let offset = 0; offset + 512 <= bytes.length && !stopped;) {
      if (Date.now() > deadline) return incomplete("static source scan time limit reached");
      const header = bytes.subarray(offset, offset + 512);
      if (header.every((byte) => byte === 0)) break;
      const size = archiveNumber(header, 124, 12);
      const prefix = header.subarray(345, 500).toString("utf8").replace(/\0.*$/, "");
      const base = header.subarray(0, 100).toString("utf8").replace(/\0.*$/, "");
      const name = prefix ? `${prefix}/${base}` : base;
      if (size === null || offset + 512 + size > bytes.length) return incomplete("malformed packaged chart dependency");
      const dataStart = offset + 512;
      const type = header[156];
      if (!safeArchivePath(name)) return incomplete("unsafe packaged chart dependency path");
      if ((type === 0 || type === 48) && name.includes("/charts/") && name.endsWith(".tgz")) return incomplete("nested packaged chart dependency not scanned");
      if ((type === 0 || type === 48) && name.includes("/templates/")) add(bytes.subarray(dataStart, dataStart + size).toString("utf8"), `${path}!/${name}`);
      offset = dataStart + Math.ceil(size / 512) * 512;
    }
  };
  const walk = (directory) => {
    if (stopped) return;
    let names;
    try { names = readdirSync(directory).sort(); } catch { return incomplete("could not read chart source directory"); }
    for (const name of names) {
      if (stopped) return;
      if (Date.now() > deadline) return incomplete("static source scan time limit reached");
      const file = join(directory, name);
      let stat;
      try { stat = lstatSync(file); } catch { incomplete("could not inspect chart source path"); return; }
      const path = relative(source, file);
      if (stat.isSymbolicLink()) {
        if (name === "templates" || path.split("/").includes("templates")) incomplete("symbolic link chart template not scanned");
        continue;
      }
      if (stat.isDirectory()) { walk(file); continue; }
      if (!stat.isFile()) continue;
      if (name.endsWith(".tgz") && path.split("/").includes("charts")) { scanArchive(file, path); continue; }
      if (!path.split("/").includes("templates")) continue;
      if (stat.size > LOOKUP_SCAN_MAX_FILE_BYTES) { incomplete("static source file size limit reached"); continue; }
      try { add(readFileSync(file, "utf8"), path); } catch { incomplete("could not read chart template"); }
    }
  };
  walk(source);
  return { complete: !notChecked.length, boundary: "Literal source callsites only; template expressions and tpl-supplied code are not evaluated.", callsites, ...(notChecked.length ? { notChecked } : {}) };
}

// Every value the user set, as a path from the top of the file. A list or an
// empty map is one value: that is how Helm merges them, whole.
export function leafPaths(values, prefix = []) {
  if (!isMap(values) || Object.keys(values).length === 0) return prefix.length ? [{ path: prefix, value: values }] : [];
  return Object.keys(values).flatMap((key) => leafPaths(values[key], [...prefix, key]));
}

// Where a path stands against the chart's own defaults.
//   known    the chart declares this key
//   open     the chart declares a free-form map here (annotations, selectors), so any key is fine
//   unknown  the chart declares the parent, with other keys, and not this one
// We deliberately recognise only a complete literal `properties` path. Schema
// composition and references are not interpreted here, and the JSON Schema
// default for additionalProperties must not turn an empty values.yaml map into
// a closed map.
function declaredInSchema(schema, path) {
  let node = schema;
  for (let index = 0; index < path.length; index += 1) {
    if (!isMap(node)) return null;
    const properties = isMap(node.properties) ? node.properties : null;
    if (properties && path[index] in properties) { node = properties[path[index]]; continue; }
    return null;
  }
  return { status: "known", schemaDeclared: true };
}

export function lookup(defaults, path, schema) {
  let node = defaults;
  for (let index = 0; index < path.length; index += 1) {
    if (!isMap(node)) return declaredInSchema(schema, path) ?? { status: "open", at: path.slice(0, index) };
    const keys = Object.keys(node);
    if (keys.length === 0) return declaredInSchema(schema, path) ?? { status: "open", at: path.slice(0, index) };
    if (!(path[index] in node)) return declaredInSchema(schema, path) ?? { status: "unknown", at: path.slice(0, index), missing: path[index], siblings: keys };
    node = node[path[index]];
  }
  return { status: "known", default: node };
}

function distance(a, b) {
  const row = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let previous = row[0];
    row[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const current = row[j];
      row[j] = Math.min(row[j] + 1, row[j - 1] + 1, previous + (a[i - 1] === b[j - 1] ? 0 : 1));
      previous = current;
    }
  }
  return row[b.length];
}

// The closest key the chart does declare, when it is close enough to be a slip.
export function nearest(key, siblings) {
  const ranked = siblings
    .map((sibling) => ({ sibling, score: distance(key.toLowerCase(), sibling.toLowerCase()) }))
    .sort((left, right) => left.score - right.score);
  const best = ranked[0];
  return best && best.score <= Math.max(2, Math.floor(key.length / 3)) ? best.sibling : null;
}

const singular = (token) => token.length > 3 && token.endsWith("s") && !token.endsWith("ss") ? token.slice(0, -1) : token;
const words = (key) => String(key)
  .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
  .split(/[^A-Za-z0-9]+/)
  .filter(Boolean)
  .map((word) => singular(word.toLowerCase()));

// Concrete setting paths the chart itself declares. values.yaml is useful even
// without a schema; a schema adds declared keys whose defaults are omitted.
function declaredPaths(defaults, schema, prefix = [], paths = new Set()) {
  if (isMap(defaults)) {
    const keys = Object.keys(defaults);
    if (prefix.length && keys.length === 0) paths.add(show(prefix));
    for (const key of keys) declaredPaths(defaults[key], null, [...prefix, key], paths);
  } else if (prefix.length) paths.add(show(prefix));

  if (isMap(schema?.properties)) {
    for (const [key, child] of Object.entries(schema.properties)) {
      const path = [...prefix, key];
      paths.add(show(path));
      declaredPaths(undefined, child, path, paths);
    }
  }
  return paths;
}

function candidateScore(path, candidate) {
  const wanted = new Set(words(path[path.length - 1]));
  const declared = new Set(words(candidate.split(".").at(-1)));
  const shared = [...wanted].filter((word) => declared.has(word)).length;
  // One shared word is enough only when it covers at least half of the longer key.
  // That catches plural-to-count renames while avoiding a vague match such as
  // `password` to every key that happens to mention password.
  const coverage = shared / Math.max(wanted.size, declared.size);
  if (!shared || coverage < 0.5) return null;
  const sameParent = candidate.split(".").slice(0, -1).join(".") === path.slice(0, -1).join(".");
  return coverage * 100 + (sameParent ? 1 : 0);
}

// Possible replacements are bounded, fully-qualified paths that the chart
// declares in values.yaml or values.schema.json. They are advice only: this
// command never changes a values file or labels one candidate an equivalent.
export function suggestions(defaults, schema, path, limit = 3) {
  return [...declaredPaths(defaults, schema)]
    .map((candidate) => ({ candidate, score: candidateScore(path, candidate) }))
    .filter((candidate) => candidate.score !== null)
    .sort((left, right) => right.score - left.score || left.candidate.localeCompare(right.candidate))
    .slice(0, limit)
    .map((candidate) => candidate.candidate);
}

// Where the chart does declare a setting the user put in the wrong place: the
// declared paths that end with the longest tail of the user's path.
// master.persistence.size finds persistence.size; replica.replicaCount finds replicaCount.
export function elsewhere(defaults, path, limit = 3) {
  const declared = [];
  const open = [];
  const walk = (node, prefix) => {
    if (!isMap(node) || Object.keys(node).length === 0) {
      if (prefix.length) { declared.push(prefix); if (isMap(node)) open.push(prefix); }
      return;
    }
    for (const key of Object.keys(node)) walk(node[key], [...prefix, key]);
  };
  walk(defaults, []);
  const shortest = (hits) => hits.sort((left, right) => left.length - right.length).slice(0, limit).map(show);
  for (let take = path.length - 1; take >= 1; take -= 1) {
    const tail = path.slice(path.length - take);
    const hits = declared.filter((candidate) => candidate.length >= take && tail.every((segment, index) => candidate[candidate.length - take + index] === segment));
    if (hits.length) return shortest(hits);
    // A free-form map the chart declares empty (resources: {}) takes the rest of the path as it stands.
    const inside = [];
    for (const candidate of open) {
      for (let overlap = Math.min(candidate.length, take - 1); overlap >= 1; overlap -= 1) {
        if (candidate.slice(candidate.length - overlap).every((segment, index) => tail[index] === segment)) {
          inside.push([...candidate, ...tail.slice(overlap)]);
          break;
        }
      }
    }
    if (inside.length) return shortest(inside);
  }
  return [];
}

// The same values with one path taken out, and any map left empty by that removed too.
export function without(values, path) {
  if (!isMap(values)) return values;
  const [head, ...rest] = path;
  const out = {};
  for (const key of Object.keys(values)) {
    if (key !== head) { out[key] = values[key]; continue; }
    if (rest.length === 0) continue;
    const child = without(values[key], rest);
    if (!isMap(child) || Object.keys(child).length > 0) out[key] = child;
  }
  return out;
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const fieldKey = (object, path) => `${JSON.stringify(Object.values(object))}#${path}`;

// Fields that differ between two renders of the same input: generated
// passwords, checksums over them, timestamps. They say nothing about a value.
export function unstableFields(first, second) {
  const moving = new Set();
  for (const change of diffConfigs(first, second).changes) {
    for (const field of change.fields) moving.add(fieldKey(change.object, field.path));
  }
  return moving;
}

// The same fields, named: which object, which path. A field that moves between two
// renders of the same input is one a GitOps controller would change on every sync.
export function generatedFields(first, second) {
  const named = [];
  for (const change of diffConfigs(first, second).changes) {
    for (const field of change.fields) named.push({ object: { kind: change.object.kind, name: change.object.name }, path: field.path });
  }
  return named;
}

// Bitnami-style resource presets: a key named resourcesPreset that sets CPU and
// memory the user never wrote. One is in force when setting it to "none" changes
// the render, so a preset for a component that is switched off is not reported.
export function presetPaths(defaults, prefix = []) {
  if (!isMap(defaults)) return [];
  return Object.keys(defaults).flatMap((key) => {
    const value = defaults[key];
    if (key === "resourcesPreset" && typeof value === "string" && value && value !== "none") return [{ path: [...prefix, key], preset: value }];
    return isMap(value) ? presetPaths(value, [...prefix, key]) : [];
  });
}

const valueAt = (values, path) => path.reduce((node, key) => (isMap(node) ? node[key] : undefined), values);
function withValue(values, path, value) {
  const out = isMap(values) ? { ...values } : {};
  const [head, ...rest] = path;
  out[head] = rest.length === 0 ? value : withValue(out[head], rest, value);
  return out;
}

// What really changed between two renders, once the moving fields are left out.
export function effect(baseline, candidate, moving) {
  const objects = [];
  for (const change of diffConfigs(candidate, baseline).changes) {
    const fields = change.fields.filter((field) => !moving.has(fieldKey(change.object, field.path)));
    if (fields.length) objects.push({ object: change.object, change: change.change, fields: fields.map((field) => field.path) });
  }
  return objects;
}

// The diagnosis. `render(values)` returns the rendered objects as bytes, so the
// logic can be tested without Helm.
export function diagnose({ values, defaults, schema, render, limit = MAX_RENDERS }) {
  const baseline = render(values);
  const again = render(values);
  const moving = unstableFields(baseline, again);
  const generated = generatedFields(baseline, again);
  const results = [];
  let renders = 0;
  for (const leaf of leafPaths(values)) {
    const found = lookup(defaults ?? {}, leaf.path, schema);
    const entry = { path: show(leaf.path), declared: found.status, ...(found.schemaDeclared ? { schemaDeclared: true } : {}) };
    if (found.status === "unknown") {
      entry.parent = show(found.at) || "(top level)";
      entry.suggestions = suggestions(defaults ?? {}, schema, leaf.path);
      // Keep this field for existing consumers that display one close typo.
      // The fully-qualified candidates above are the actionable advice.
      entry.suggestion = nearest(found.missing, found.siblings);
      if (!entry.suggestions.length && !entry.suggestion) entry.elsewhere = elsewhere(defaults ?? {}, leaf.path);
    }
    if (found.status === "known" && same(found.default, leaf.value)) {
      results.push({ ...entry, verdict: "DEFAULT", objects: [] });
      continue;
    }
    if (renders >= limit) { results.push({ ...entry, verdict: "NOT CHECKED", objects: [] }); continue; }
    renders += 1;
    const objects = effect(baseline, render(without(values, leaf.path)), moving);
    const verdict = objects.length ? "APPLIED" : found.status === "unknown" ? "IGNORED" : "NO EFFECT";
    results.push({ ...entry, verdict, objects });
  }
  const presets = [];
  for (const candidate of presetPaths(defaults ?? {})) {
    const set = valueAt(values, candidate.path);
    const siblings = valueAt(values, [...candidate.path.slice(0, -1), "resources"]);
    if (set !== undefined || (isMap(siblings) && Object.keys(siblings).length > 0)) continue;
    if (renders >= limit) break;
    renders += 1;
    const objects = effect(baseline, render(withValue(values, candidate.path, "none")), moving);
    if (objects.length) presets.push({ path: show(candidate.path), preset: candidate.preset, resources: show([...candidate.path.slice(0, -1), "resources"]), objects: objects.map((entry) => entry.object) });
  }
  const count = (verdict) => results.filter((result) => result.verdict === verdict).length;
  const invalidResources = resourceRequirementsFindings(parseDocs(baseline));
  return {
    apiVersion: "workshop.confighub.com/v1alpha1",
    kind: "ValuesDiagnosis",
    summary: { set: results.length, applied: count("APPLIED"), ignored: count("IGNORED"), noEffect: count("NO EFFECT"), sameAsDefault: count("DEFAULT"), notChecked: count("NOT CHECKED"), invalidResources: invalidResources.length },
    unstableFields: moving.size,
    generated,
    presets,
    rendered: { sha256: `sha256:${sha256(baseline)}` },
    values: results,
    invalidResources,
    resourceValidation: { boundary: resourceValidationBoundary },
    boundary: "Rendered locally with Helm. A value that changes nothing here may still matter under other settings, capabilities or Kubernetes versions. No value is printed.",
  };
}

const helm = (args) => execFileSync("helm", args, { encoding: "buffer", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

// A chart reference becomes a local directory once, so every render after the
// first is offline and quick.
function localChart(chart, { version, repo }, work) {
  if (existsSync(chart) && statSync(chart).isDirectory()) return chart;
  const into = join(work, "chart");
  helm(["pull", chart, "--untar", "--untardir", into, ...(version ? ["--version", version] : []), ...(repo ? ["--repo", repo] : [])]);
  return join(into, readdirSync(into)[0]);
}

export function runValues(args) {
  const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
  const takesValue = new Set(["--values", "-f", "--version", "--repo", "--namespace", "--release", "--out", "--render-out"]);
  const chart = args.find((arg, index) => !arg.startsWith("-") && !takesValue.has(args[index - 1]));
  const valuesPath = flag("--values") ?? flag("-f");
  const usage = "usage: cub config values <chart> --values my-values.yaml [--version X] [--repo URL] [--namespace ns] [--release name] [--json] [--out result.json] [--render-out candidate.yaml] [--exit-code]";
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`${usage}\nRenders the chart with your values, then once more for each value with that value taken out. No account, no cluster. No value is printed.`);
    return 0;
  }
  if (!chart || !valuesPath) {
    console.error(usage);
    return 2;
  }
  const out = flag("--out");
  const renderOut = flag("--render-out");
  if (args.includes("--out") && (!out || out.startsWith("-"))) throw new Error("--out requires a file path");
  if (args.includes("--render-out") && (!renderOut || renderOut.startsWith("-"))) throw new Error("--render-out requires a file path");
  if (out && renderOut && resolve(out) === resolve(renderOut)) throw new Error("--out and --render-out must name different files");
  const valuesBytes = readFileSync(valuesPath);
  const values = parseYaml(valuesBytes) ?? {};
  // Reserve outputs before pulling or rendering the chart. A second run must
  // choose fresh paths rather than overwrite earlier evidence or a candidate.
  let outFile = null;
  let renderFile = null;
  const reserved = [];
  try {
    if (out) { outFile = openSync(out, "wx", 0o600); reserved.push(out); }
    if (renderOut) { renderFile = openSync(renderOut, "wx", 0o600); reserved.push(renderOut); }
  } catch (error) {
    if (outFile !== null) closeSync(outFile);
    if (renderFile !== null) closeSync(renderFile);
    for (const file of reserved) rmSync(file, { force: true });
    throw error;
  }
  let completed = false;
  let work = null;
  try {
    work = mkdtempSync(join(tmpdir(), "cub-config-values-"));
    const source = localChart(chart, { version: flag("--version"), repo: flag("--repo") }, work);
    const defaults = readYamlFile(join(source, "values.yaml")) ?? {};
    const schemaPath = join(source, "values.schema.json");
    const schema = existsSync(schemaPath) ? JSON.parse(readFileSync(schemaPath, "utf8")) : null;
    const templateLookups = templateLookupInventory(source);
    const release = flag("--release") ?? "release";
    const namespace = flag("--namespace") ?? "default";
    let sequence = 0;
    let firstCandidate = null;
    const render = (candidate) => {
      const file = join(work, `values-${sequence += 1}.yaml`);
      writeFileSync(file, toYaml(candidate));
      const rendered = helm(["template", release, source, "--namespace", namespace, "-f", file]);
      if (firstCandidate === null) firstCandidate = rendered;
      return rendered;
    };
    const report = diagnose({ values, defaults, schema, render });
    report.templateLookups = templateLookups;
    report.chart = { reference: chart, version: flag("--version") ?? null, repository: flag("--repo") ?? null, release, namespace };
    report.valuesFile = { sha256: `sha256:${sha256(valuesBytes)}` };
    const serialized = `${JSON.stringify(report, null, 2)}\n`;
    // The report hash names this first render. Rendering again could generate a
    // different Secret, so retain the captured bytes instead.
    if (renderFile !== null) { writeFileSync(renderFile, firstCandidate); closeSync(renderFile); renderFile = null; }
    if (outFile !== null) { writeFileSync(outFile, serialized); closeSync(outFile); outFile = null; }
    completed = true;
    if (args.includes("--json")) process.stdout.write(serialized);
    else print(report, chart);
    if (out && !args.includes("--json")) console.log(`Saved ${out}`);
    if (renderOut && !args.includes("--json")) console.log(`Saved ${renderOut} (may contain Secrets; keep it private)`);
    return args.includes("--exit-code") && report.summary.ignored + report.summary.noEffect + report.summary.invalidResources > 0 ? 1 : 0;
  } finally {
    if (outFile !== null) closeSync(outFile);
    if (renderFile !== null) closeSync(renderFile);
    if (!completed) for (const file of reserved) rmSync(file, { force: true });
    if (work) rmSync(work, { recursive: true, force: true });
  }
}

function print(report, chart) {
  const { summary } = report;
  console.log(`\nValues: ${summary.set} set, checked against ${chart}${report.chart.version ? ` ${report.chart.version}` : ""}\n`);
  const width = Math.max(...report.values.map((value) => value.path.length), 8);
  for (const value of report.values) {
    const name = value.path.padEnd(width);
    if (value.verdict === "IGNORED") {
      const where = value.parent === "(top level)" ? `this chart has no "${value.path.split(".")[0]}" section` : `matched no key under ${value.parent}`;
      const hint = value.suggestions?.length ? ` Consider the chart-declared candidate${value.suggestions.length === 1 ? "" : "s"} ${value.suggestions.join(" or ")}; review before changing your values.` : value.suggestion ? ` Did you mean ${value.suggestion}?` : value.elsewhere?.length ? ` This chart sets that at ${value.elsewhere.join(" or ")}.` : "";
      console.log(`  [IGNORED]    ${name}  ${where}, and it changed nothing.${hint}`);
    } else if (value.verdict === "NO EFFECT") {
      const declared = value.schemaDeclared ? "is a key this chart schema declares" : "is a key this chart reads";
      console.log(`  [NO EFFECT]  ${name}  ${declared}, and it changed nothing here. Another setting may switch it off.`);
    } else if (value.verdict === "DEFAULT") {
      console.log(`  [DEFAULT]    ${name}  is what the chart already uses`);
    } else if (value.verdict === "NOT CHECKED") {
      console.log(`  [NOT CHECKED] ${name}  over the limit of ${MAX_RENDERS} renders`);
    } else {
      const names = value.objects.map((entry) => `${entry.object.kind} ${entry.object.name}`);
      const undeclared = value.declared === "unknown" ? " (not in the chart's documented values)" : "";
      console.log(`  [APPLIED]    ${name}  changed ${names.length} object${names.length === 1 ? "" : "s"}: ${names.slice(0, 4).join(", ")}${names.length > 4 ? `, and ${names.length - 4} more` : ""}${undeclared}`);
    }
  }
  for (const finding of report.invalidResources ?? []) {
    const object = `${finding.object.kind} ${finding.object.name}`;
    const container = `${finding.container.type} ${finding.container.name ?? "(unnamed)"}`;
    console.log(`  [INVALID]    ${object}, ${container}, ${finding.path}: ${finding.reason}${finding.suggestion ? `. Did you mean ${finding.suggestion}?` : ""}`);
  }
  const dead = summary.ignored + summary.noEffect;
  console.log(`\n  ${dead === 0 ? "Every value you set changed the result or matches the default." : `${dead} of ${summary.set} values did nothing.`}`);
  if (report.presets?.length || report.generated?.length || report.templateLookups?.callsites?.length || report.templateLookups?.complete === false) console.log("\nWhat the chart does that you did not write");
  for (const preset of report.presets ?? []) {
    const names = preset.objects.map((object) => `${object.kind} ${object.name}`);
    console.log(`  [NOTE]  ${preset.path} is "${preset.preset}". The chart sets CPU and memory for ${names.slice(0, 3).join(", ")}${names.length > 3 ? `, and ${names.length - 3} more` : ""}. Setting ${preset.resources} replaces the whole preset.`);
  }
  if (report.generated?.length) {
    const names = report.generated.map((field) => `${field.object.kind} ${field.object.name} ${field.path}`);
    console.log(`  [NOTE]  ${names.length} field${names.length === 1 ? "" : "s"} change${names.length === 1 ? "s" : ""} on every render: ${names.slice(0, 3).join(", ")}${names.length > 3 ? `, and ${names.length - 3} more` : ""}.`);
    console.log("          Argo CD and offline helm template render without your target cluster, so a generated value may change every time. A Flux HelmRelease runs Helm against its target cluster, where chart lookups can observe existing values; whether that preserves a generated value depends on the chart.");
  }
  if (report.templateLookups?.callsites?.length) {
    console.log(`  [NOTE]  literal source lookup callsites: ${report.templateLookups.callsites.length}; no target cluster was queried.`);
    for (const callsite of report.templateLookups.callsites) {
      const gvk = callsite.staticGvk ? `${callsite.staticGvk.apiVersion} ${callsite.staticGvk.kind}` : "dynamic API version or kind";
      const unresolved = callsite.unresolvedArguments.length ? `; unresolved ${callsite.unresolvedArguments.join(", ")}` : "";
      const defined = callsite.scope === "named-template-definition" ? ` in named template ${callsite.template}` : "";
      console.log(`          ${callsite.path}:${callsite.line} ${gvk}${unresolved}${defined}; source call not evaluated.`);
    }
  }
  if (report.templateLookups?.complete === false) console.log(`  [NOTE]  literal source lookup inventory incomplete: ${report.templateLookups.notChecked.join("; ")}.`);
  console.log(`\n  ${report.boundary}`);
  console.log("  Checks container resource fields only; other Kubernetes fields and cluster admission are not checked.\n");
}
