// cub config values — did the values I set actually do anything?
//
//   cub config values <chart> --values my-values.yaml [--version X] [--repo URL]
//                     [--namespace ns] [--release name] [--json] [--exit-code]
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
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readYamlFile, toYaml } from "./common.mjs";
import { diffConfigs } from "./config-diff.mjs";

const MAX_RENDERS = 60;
const isMap = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const show = (path) => path.join(".");

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
export function lookup(defaults, path) {
  let node = defaults;
  for (let index = 0; index < path.length; index += 1) {
    if (!isMap(node)) return { status: "open", at: path.slice(0, index) };
    const keys = Object.keys(node);
    if (keys.length === 0) return { status: "open", at: path.slice(0, index) };
    if (!(path[index] in node)) return { status: "unknown", at: path.slice(0, index), missing: path[index], siblings: keys };
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
export function diagnose({ values, defaults, render, limit = MAX_RENDERS }) {
  const baseline = render(values);
  const again = render(values);
  const moving = unstableFields(baseline, again);
  const generated = generatedFields(baseline, again);
  const results = [];
  let renders = 0;
  for (const leaf of leafPaths(values)) {
    const found = lookup(defaults ?? {}, leaf.path);
    const entry = { path: show(leaf.path), declared: found.status };
    if (found.status === "unknown") {
      entry.parent = show(found.at) || "(top level)";
      entry.suggestion = nearest(found.missing, found.siblings);
      if (!entry.suggestion) entry.elsewhere = elsewhere(defaults ?? {}, leaf.path);
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
  return {
    apiVersion: "workshop.confighub.com/v1alpha1",
    kind: "ValuesDiagnosis",
    summary: { set: results.length, applied: count("APPLIED"), ignored: count("IGNORED"), noEffect: count("NO EFFECT"), sameAsDefault: count("DEFAULT"), notChecked: count("NOT CHECKED") },
    unstableFields: moving.size,
    generated,
    presets,
    values: results,
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
  const takesValue = new Set(["--values", "-f", "--version", "--repo", "--namespace", "--release"]);
  const chart = args.find((arg, index) => !arg.startsWith("-") && !takesValue.has(args[index - 1]));
  const valuesPath = flag("--values") ?? flag("-f");
  const usage = "usage: cub config values <chart> --values my-values.yaml [--version X] [--repo URL] [--namespace ns] [--release name] [--json] [--exit-code]";
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`${usage}\nRenders the chart with your values, then once more for each value with that value taken out. No account, no cluster. No value is printed.`);
    return 0;
  }
  if (!chart || !valuesPath) {
    console.error(usage);
    return 2;
  }
  const work = mkdtempSync(join(tmpdir(), "cub-config-values-"));
  try {
    const source = localChart(chart, { version: flag("--version"), repo: flag("--repo") }, work);
    const defaults = readYamlFile(join(source, "values.yaml")) ?? {};
    const values = readYamlFile(valuesPath) ?? {};
    const release = flag("--release") ?? "release";
    const namespace = flag("--namespace") ?? "default";
    let sequence = 0;
    const render = (candidate) => {
      const file = join(work, `values-${sequence += 1}.yaml`);
      writeFileSync(file, toYaml(candidate));
      return helm(["template", release, source, "--namespace", namespace, "-f", file]);
    };
    const report = diagnose({ values, defaults, render });
    report.chart = { reference: chart, version: flag("--version") ?? null };
    if (args.includes("--json")) console.log(JSON.stringify(report, null, 2));
    else print(report, chart);
    return args.includes("--exit-code") && report.summary.ignored + report.summary.noEffect > 0 ? 1 : 0;
  } finally {
    rmSync(work, { recursive: true, force: true });
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
      const hint = value.suggestion ? ` Did you mean ${value.suggestion}?` : value.elsewhere?.length ? ` This chart sets that at ${value.elsewhere.join(" or ")}.` : "";
      console.log(`  [IGNORED]    ${name}  ${where}, and it changed nothing.${hint}`);
    } else if (value.verdict === "NO EFFECT") {
      console.log(`  [NO EFFECT]  ${name}  is a key this chart reads, and it changed nothing here. Another setting may switch it off.`);
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
  const dead = summary.ignored + summary.noEffect;
  console.log(`\n  ${dead === 0 ? "Every value you set changed the result or matches the default." : `${dead} of ${summary.set} values did nothing.`}`);
  if (report.presets?.length || report.generated?.length) console.log("\nWhat the chart does that you did not write");
  for (const preset of report.presets ?? []) {
    const names = preset.objects.map((object) => `${object.kind} ${object.name}`);
    console.log(`  [NOTE]  ${preset.path} is "${preset.preset}". The chart sets CPU and memory for ${names.slice(0, 3).join(", ")}${names.length > 3 ? `, and ${names.length - 3} more` : ""}. Setting ${preset.resources} replaces the whole preset.`);
  }
  if (report.generated?.length) {
    const names = report.generated.map((field) => `${field.object.kind} ${field.object.name} ${field.path}`);
    console.log(`  [NOTE]  ${names.length} field${names.length === 1 ? "" : "s"} change${names.length === 1 ? "s" : ""} on every render: ${names.slice(0, 3).join(", ")}${names.length > 3 ? `, and ${names.length - 3} more` : ""}.`);
    console.log("          Argo CD, Flux and helm template render without your cluster, so they get a new value every time. helm upgrade keeps a value only if the chart reads it back from the cluster.");
  }
  console.log(`\n  ${report.boundary}\n`);
}
