import { readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
const yaml = createRequire(import.meta.url)("./yaml.cjs");
const hash = (bytes) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const record = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
function requireFact(ok, message) { if (!ok) throw new Error(message); }
function quantity(v, label, allowZero = false) {
  requireFact((typeof v === "string" || typeof v === "number") && /^(0|[1-9][0-9]*)$/.test(String(v)), `${label} must be a whole-number GPU quantity`);
  const n = Number(v);
  requireFact(Number.isSafeInteger(n) && n >= (allowZero ? 0 : 1), `${label} is outside the supported GPU quantity range`);
  return n;
}
function documents(bytes, label) {
  let parsed;
  try { parsed = yaml.loadAll(bytes.toString()); }
  catch (error) { throw new Error(`${label}: invalid YAML (${error.reason ?? "parse failed"})`); }
  const docs = parsed.filter((d) => d !== null && d !== undefined);
  requireFact(docs.length > 0 && docs.every(record), `${label} must contain YAML objects`);
  return docs;
}

export function matchWorkload(workloadBytes, targetBytes) {
  const workloads = documents(workloadBytes, "workload");
  requireFact(workloads.length === 1, "supply exactly one KServe InferenceService");
  const app = workloads[0];
  requireFact(app.apiVersion === "serving.kserve.io/v1beta1" && app.kind === "InferenceService", "supported workload: serving.kserve.io/v1beta1 InferenceService only");
  requireFact(typeof app.metadata?.name === "string" && app.metadata.name.length > 0, "workload metadata.name is required");
  const predictor = app.spec?.predictor;
  requireFact(record(predictor?.model), "workload spec.predictor.model is required");
  const resources = predictor.model.resources;
  const count = quantity(resources?.limits?.["nvidia.com/gpu"], "workload GPU limit");
  if (resources.requests?.["nvidia.com/gpu"] !== undefined) {
    requireFact(quantity(resources.requests["nvidia.com/gpu"], "workload GPU request") === count, "GPU request and limit must agree");
  }
  const selectors = predictor.nodeSelector;
  requireFact(selectors === undefined || (record(selectors) && Object.values(selectors).every((v) => typeof v === "string")), "nodeSelector must map labels to strings");
  const hasSelectors = selectors && Object.keys(selectors).length > 0;
  const docs = documents(targetBytes, "target snapshot");
  const nodes = docs.flatMap((d) => {
    if (d.apiVersion === "v1" && (d.kind === "List" || d.kind === "NodeList")) {
      requireFact(Array.isArray(d.items), "Node list items must be an array");
      return d.items;
    }
    return [d];
  });
  requireFact(nodes.length > 0, "target snapshot contains no Nodes");
  const seen = new Set();
  const findings = nodes.map((node) => {
    requireFact(node?.apiVersion === "v1" && node.kind === "Node" && typeof node.metadata?.name === "string" && node.metadata.name.length > 0, "target snapshot must contain named v1 Nodes only");
    const name = node.metadata.name;
    requireFact(!seen.has(name), `duplicate Node: ${name}`); seen.add(name);
    requireFact(node.metadata.labels === undefined || (record(node.metadata.labels) && Object.values(node.metadata.labels).every((v) => typeof v === "string")), `Node ${name} labels must map strings to strings`);
    const checks = [];
    for (const [key, value] of Object.entries(selectors ?? {})) {
      const observed = node.metadata.labels?.[key];
      checks.push({ field: `metadata.labels[${key}]`, required: value, supplied: observed ?? null,
        status: node.metadata.labels === undefined ? "unknown" : observed === value ? "pass" : "mismatch" });
    }
    if (!hasSelectors) checks.push({ field: "spec.predictor.nodeSelector", status: "unknown", reason: "workload does not declare a hardware selector" });
    const raw = node.status?.allocatable?.["nvidia.com/gpu"];
    const available = raw === undefined ? null : quantity(raw, `Node ${name} allocatable GPU`, true);
    checks.push({ field: "status.allocatable[nvidia.com/gpu]", required: count, supplied: available,
      status: available === null ? "unknown" : available >= count ? "pass" : "mismatch" });
    const status = checks.some((c) => c.status === "mismatch") ? "mismatch" : checks.some((c) => c.status === "unknown") ? "unknown" : "candidate";
    return { node: name, status, checks };
  });
  const status = findings.some((n) => n.status === "candidate") ? "candidate" : findings.some((n) => n.status === "unknown") ? "unknown" : "mismatch";
  return {
    schemaVersion: 1, scope: "supplied-node-snapshot", status,
    workload: { apiVersion: app.apiVersion, kind: app.kind, name: app.metadata.name, namespace: app.metadata.namespace ?? null, sha256: hash(workloadBytes) },
    target: { sha256: hash(targetBytes), nodeCount: nodes.length, liveChecked: false },
    requirement: { gpuPerReplica: count, nodeSelector: selectors ?? {}, runtime: predictor.model.runtime ?? null },
    nodes: findings, execution: "not-run",
    notChecked: ["snapshot authenticity or freshness", "free GPUs and concurrent workloads", "GPU memory, partitioning and runtime compatibility", "CPU, memory, storage and network", "affinity, taints, readiness, quotas and scheduling", "replica placement and autoscaling", "serving runtime, controllers and API availability", "registry credentials and model entitlement", "application or inference response"],
    nextAction: status === "candidate" ? "Review omitted checks and qualify the exact workload on an authorized target before deployment." : status === "unknown" ? "Supply the missing workload selectors or Node facts, then rerun." : "Choose a node with the requested labels and sufficient per-node GPU count, or select another retained workload configuration.",
  };
}

export function runMatch(args) {
  const usage = "cub app match <workload.yaml> --target <nodes.yaml> [--json] [--out <result.json>]";
  if (args.includes("--help")) { console.log(`${usage}\nOffline comparison of declared selectors and GPU count. No cluster access. A candidate is not readiness or execution proof.`); return 0; }
  const input = args.shift(); let target; let out; let json = false;
  requireFact(input && !input.startsWith("--"), usage);
  while (args.length) {
    const flag = args.shift();
    if (flag === "--json" && !json) json = true;
    else if ((flag === "--target" && !target) || (flag === "--out" && !out)) {
      const value = args.shift(); requireFact(value && !value.startsWith("--"), `${flag} requires a file path`);
      if (flag === "--target") target = value; else out = value;
    } else throw new Error(`unknown or repeated option: ${flag}; ${usage}`);
  }
  requireFact(target, usage);
  const result = matchWorkload(readFileSync(input), readFileSync(target));
  const serialized = `${JSON.stringify(result, null, 2)}\n`;
  if (out) writeFileSync(out, serialized, { flag: "wx" });
  if (json) process.stdout.write(serialized);
  else {
    console.log(`Match: ${result.status.toUpperCase()} (supplied snapshot, no live checks)`);
    console.log(`Workload: ${result.workload.name}; ${result.requirement.gpuPerReplica} GPUs per replica`);
    for (const n of result.nodes) {
      console.log(`  ${n.node}: ${n.status}`);
      for (const c of n.checks.filter((c) => c.status !== "pass")) console.log(`    ${c.field}: ${c.status}; requires ${JSON.stringify(c.required ?? null)}, supplied ${JSON.stringify(c.supplied ?? null)}`);
    }
    console.log("Allocatable GPUs are not free GPUs. GPU/runtime compatibility, scheduling, entitlement and inference are not checked.");
    console.log(result.nextAction);
    if (out) console.log(`Saved ${out}`);
  }
  return result.status === "candidate" ? 0 : result.status === "mismatch" ? 1 : 3;
}
