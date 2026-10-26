// Schema validation for a checked stack, by the Flux schema plugin when it is
// installed. The composition checks read how components fit together; this one
// reads every delivered object against its API schema and CEL rules with
// API-server semantics, which catches a wrong field type or an unknown field
// long before an apply would.
//
// It is one more check line and never a flaky one: a missing flux, a missing
// plugin, a crash or unreadable output is a WARN; a catalog that cannot be
// reached is a NOTE; only a violation the plugin reports is a FAIL.
//
// The report shape parsed here is the documented schema.plugin.fluxcd.io/v1beta1
// Report of `flux schema validate -o json` (fluxcd/flux-schema docs/report.md):
// report.reporter, report.summary {total, valid, invalid, skipped} and
// report.results[] of {resource, status, reason, violations[{path?, message}]}.
// Fields are still read defensively, so a later report version that adds or
// drops a field degrades to a WARN rather than a wrong verdict.
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { pluginRoot, readYamlFile, toYaml } from "./common.mjs";

const PASS = "PASS"; const WARN = "WARN"; const FAIL = "FAIL"; const NOTE = "NOTE";
export const INSTALL_PLUGIN = "flux plugin install schema";
// default is the plugin's built-in catalog (latest stable Kubernetes, Gateway
// API and Flux); ecosystem is schemas.fluxoperator.dev, hundreds of CNCF CRDs.
// Both are fetched over HTTPS. The plugin has no flag that pins a Kubernetes or
// Flux release: -s names where schemas come from, and both catalogs track the
// latest stable APIs, so the versions receipts name are recorded beside the
// result instead of silently implied by it.
export const SCHEMA_LOCATIONS = ["default", "ecosystem"];
const TIMEOUT_MS = 180000;
// Violations are what the plugin found wrong with an object. Every other
// invalid reason is the tool failing to read or fetch something, not the stack.
const VIOLATIONS = new Set(["schema-violation", "cel-violation"]);
const OFFLINE = /dial tcp|no such host|network is unreachable|connection refused|connection reset|i\/o timeout|tls handshake|client\.timeout|context deadline exceeded|temporary failure in name resolution|server misbehaving/i;
const SHOWN = 8;

// The default catalog is extracted from the Kubernetes OpenAPI v2 document,
// which types resource.Quantity as a bare string. The API server also accepts a
// JSON number there (apimachinery's Quantity declares string and number for
// OpenAPI v3), and charts write `cpu: 1` and `pods: 100` (fluxcd/flux-schema#102).
// So a number reported where a string is wanted is accepted, but only at a
// Quantity field of a built-in kind, and only when the object really holds a
// number. The same message anywhere else, such as an env value or a label,
// still fails: the API server refuses those. The fields are those that
// reference Quantity in the v1.35 swagger, leaving out status, which nobody
// writes, and dynamic resource allocation. A kind of null applies anywhere.
const NUMBER_FOR_STRING = /^got number, want (null or )?string$/;
const NESTED = "validation failed";
const QUANTITY_FIELDS = [
  [null, /\/resources\/(limits|requests)\/[^/]+$/],
  [null, /\/overhead\/[^/]+$/],
  [null, /\/emptyDir\/sizeLimit$/],
  [null, /\/resourceFieldRef\/divisor$/],
  ["ResourceQuota", /^\/spec\/hard\/[^/]+$/],
  ["LimitRange", /^\/spec\/limits\/\d+\/(default|defaultRequest|max|min|maxLimitRequestRatio)\/[^/]+$/],
  ["PersistentVolume", /^\/spec\/capacity\/[^/]+$/],
  ["RuntimeClass", /^\/overhead\/podFixed\/[^/]+$/],
  ["HorizontalPodAutoscaler", /^\/spec\/metrics\/\d+\/[^/]+\/target\/(value|averageValue)$/],
  ["HorizontalPodAutoscaler", /^\/spec\/behavior\/scale(Up|Down)\/tolerance$/],
  ["CSIStorageCapacity", /^\/(capacity|maximumVolumeSize)$/],
];

// The catalogs type a custom resource field as its CRD does, so a null there
// reads as "got null, want string". The API server prunes a null from a CRD
// field that is not nullable before it defaults and validates, so the object
// is accepted and the field takes its default or is left out: gpu-operator
// v25.10.1 renders a ClusterPolicy with `migManager.config.name: null`. A null
// is accepted only in a custom resource, only where the object holds a null
// under an object key, and only where the CRD among the checked objects
// declares that key as not required, or required with a default. A null as an
// array item, or in a required field with no default, is refused by the API
// server, and so is one in a built-in kind, so those still fail; so does any
// null whose CRD is not among the objects, as nothing says it is safe. The
// API server validates the pruned object, so a null also fails here where
// removing the key could break a rule above it: a CEL rule or a oneOf, anyOf, allOf or not
// anywhere from the root to the key's object, or a minProperties that the
// keys left after pruning no longer meet.
const NULL_FOR_TYPE = /^got null, want [a-z]+( or [a-z]+)*$/;

// A built-in group has no dot, or ends in .k8s.io. CRD schemas mark their
// quantities int-or-string already, so they never need this.
const builtIn = (apiVersion) => {
  const text = String(apiVersion ?? "");
  const group = text.includes("/") ? text.split("/")[0] : "";
  return !group.includes(".") || group.endsWith(".k8s.io");
};

const segments = (pointer) => String(pointer).split("/").slice(1).map((segment) => segment.replace(/~1/g, "/").replace(/~0/g, "~"));
const valueAt = (object, pointer) => segments(pointer)
  .reduce((node, key) => (node !== null && typeof node === "object" ? node[key] : undefined), object);
const isMap = (node) => node !== null && typeof node === "object" && !Array.isArray(node);

// The openAPIV3Schema of every CRD version among the objects, by
// group/version/kind.
function crdSchemas(objects) {
  const schemas = new Map();
  for (const object of objects) {
    if (object?.kind !== "CustomResourceDefinition" || !String(object.apiVersion ?? "").startsWith("apiextensions.k8s.io/")) continue;
    for (const version of Array.isArray(object.spec?.versions) ? object.spec.versions : []) {
      const schema = version?.schema?.openAPIV3Schema;
      if (isMap(schema)) schemas.set(`${object.spec.group}/${version.name}/${object.spec.names?.kind}`, schema);
    }
  }
  return schemas;
}

const PRESENCE_RULES = ["x-kubernetes-validations", "oneOf", "anyOf", "allOf", "not"];

// Whether the API server prunes the null at this path and still accepts the
// object: the object holds a null under an object key, the CRD schema declares
// that key, not required or required with a default, and no rule on the way
// down depends on which keys are present. Anything the walk cannot follow is
// not accepted.
function prunedNull(object, schemas, violation) {
  if (!object || builtIn(object.apiVersion) || !NULL_FOR_TYPE.test(String(violation?.message ?? ""))) return false;
  const keys = segments(violation.path ?? "");
  const key = keys.pop();
  const holder = keys.reduce((node, segment) => (node !== null && typeof node === "object" ? node[segment] : undefined), object);
  if (key === undefined || !isMap(holder) || !Object.hasOwn(holder, key) || holder[key] !== null) return false;
  let schema = schemas.get(`${object.apiVersion}/${object.kind}`);
  const presenceRule = (node) => PRESENCE_RULES.some((rule) => Object.hasOwn(node, rule));
  for (const segment of keys) {
    if (!isMap(schema) || presenceRule(schema)) return false;
    schema = schema.type === "array" ? (/^\d+$/.test(segment) ? schema.items : undefined)
      : schema.properties?.[segment] ?? (isMap(schema.additionalProperties) ? schema.additionalProperties : undefined);
  }
  if (!isMap(schema) || schema.type === "array" || presenceRule(schema)) return false;
  if (Number(schema.minProperties ?? 0) > Object.values(holder).filter((value) => value !== null).length) return false;
  const field = schema.properties?.[key] ?? (isMap(schema.additionalProperties) ? schema.additionalProperties : undefined);
  if (!isMap(field)) return false;
  return !(Array.isArray(schema.required) && schema.required.includes(key)) || Object.hasOwn(field, "default");
}

// The object a result is about: results count the stdin documents from 1, and
// each object is one document. Without a match nothing is accepted.
function objectFor(objects, entry) {
  const object = objects[Number(entry.idx) - 1];
  const resource = entry.resource ?? {};
  return object && object.kind === resource.kind && object.metadata?.name === resource.name && object.apiVersion === resource.apiVersion ? object : null;
}

function numericQuantity(object, violation) {
  if (!object || !builtIn(object.apiVersion) || !NUMBER_FOR_STRING.test(String(violation?.message ?? ""))) return false;
  const path = String(violation.path ?? "");
  return QUANTITY_FIELDS.some(([kind, field]) => (kind === null || kind === object.kind) && field.test(path))
    && Number.isFinite(valueAt(object, path));
}

// Drops what the API server accepts from one result, the numeric quantities
// and the pruned nulls, and with them a "validation failed" line whose only
// causes they were. A result left with nothing is valid.
function withoutAccepted(objects, schemas, entry, accepted) {
  if (entry.status !== "invalid" || entry.reason !== "schema-violation" || !Array.isArray(entry.violations)) return entry;
  const object = objectFor(objects, entry);
  const quantities = entry.violations.filter((violation) => numericQuantity(object, violation));
  const nulls = entry.violations.filter((violation) => !quantities.includes(violation) && prunedNull(object, schemas, violation));
  const dropped = [...quantities, ...nulls];
  if (!dropped.length) return entry;
  const under = (parent, violation) => violation.path === parent || String(violation.path ?? "").startsWith(`${parent}/`);
  const rest = entry.violations.filter((violation) => !dropped.includes(violation));
  const causes = rest.filter((violation) => violation.message !== NESTED);
  const kept = rest.filter((violation) => violation.message !== NESTED || violation.path == null
    || causes.some((cause) => under(violation.path, cause)) || !dropped.some((done) => under(violation.path, done)));
  accepted.numericQuantities.push(...quantities.map((violation) => ({ object: objectName(entry.resource), path: violation.path, value: valueAt(object, violation.path) })));
  accepted.prunedNulls.push(...nulls.map((violation) => ({ object: objectName(entry.resource), path: violation.path, message: violation.message })));
  return kept.length ? { ...entry, violations: kept } : { ...entry, status: "valid", reason: undefined, violations: [] };
}

const lastLine = (text) => String(text ?? "").trim().split("\n").map((line) => line.trim()).filter(Boolean).pop() ?? "";
const objectName = (resource) => resource
  ? [resource.kind ?? "?", resource.namespace, resource.name ?? "?"].filter(Boolean).join("/")
  : "(no object identity)";

// The Kubernetes versions the component receipts rendered for, when a receipt
// names one (renderInputs.kubeVersion). Receipts name no Flux version today.
function targetVersions(stack) {
  const kubernetes = new Set();
  const base = isAbsolute(String(stack.path ?? "")) ? dirname(stack.path) : null;
  for (const comp of stack.components) {
    if (!comp.receipt) continue;
    const path = isAbsolute(comp.receipt) ? comp.receipt
      : [base && join(base, comp.receipt), join(pluginRoot, comp.receipt)].filter(Boolean).find((candidate) => existsSync(candidate));
    if (!path || !existsSync(path)) continue;
    try {
      const version = readYamlFile(path)?.spec?.renderInputs?.kubeVersion;
      if (version) kubernetes.add(String(version));
    } catch { /* an unreadable receipt already fails loading; nothing to add here */ }
  }
  return { kubernetes: [...kubernetes].sort() };
}

function parseReport(stdout) {
  let body;
  try { body = JSON.parse(stdout); } catch { return null; }
  if (body?.kind !== "Report" || !Array.isArray(body?.report?.results)) return null;
  return body.report;
}

// Runs the plugin over the objects a cluster would receive and returns the
// check lines and the schemaValidation record. Hub-plane components are held
// in ConfigHub and never applied, so API-server semantics do not apply to them.
export function validateStackSchemas(stack, { run = spawnSync } = {}) {
  const objects = stack.components.filter((comp) => comp.plane !== "hub").flatMap((comp) => comp.objects);
  return validateObjectSchemas(objects, {
    run,
    versions: targetVersions(stack),
    fix: "fix the fields in their component and check again",
    more: "see schemaValidation in cub stack check --json",
  });
}

// The same check for any list of objects. `fix` says what to do about a
// violation, and `more` where the full list is when it is cut short.
export function validateObjectSchemas(objects, { run = spawnSync, versions = { kubernetes: [] }, fix = "fix the fields and check again", more = "and fix those too" } = {}) {
  const args = ["schema", "validate", ...SCHEMA_LOCATIONS.flatMap((location) => ["-s", location]), "--skip-missing-schemas", "-o", "json"];
  const record = { tool: `flux ${args.join(" ")}`, schemaLocations: SCHEMA_LOCATIONS, targetVersions: versions, objectCount: objects.length };
  const pinNote = versions.kubernetes.length
    ? `; receipts render for Kubernetes ${versions.kubernetes.join(", ")}, the catalogs hold the latest stable APIs`
    : "";
  const done = (status, mark, text, details = [], extra = {}) => ({ findings: [[mark, text], ...details.map((line) => ["    ", line])], record: { status, ...record, ...extra } });

  if (objects.length === 0) return done("not-run", PASS, "schema validation: no delivered objects to validate");
  const proc = run("flux", args, { input: objects.map(toYaml).join("---\n"), encoding: "utf8", timeout: TIMEOUT_MS, maxBuffer: 256 * 1024 * 1024 });
  if (proc.error?.code === "ENOENT") {
    return done("unavailable", WARN, `schema validation not run: flux is not on PATH; install the Flux CLI, then \`${INSTALL_PLUGIN}\``, [], { next: INSTALL_PLUGIN });
  }
  if (proc.error?.code === "ETIMEDOUT" || proc.signal === "SIGTERM") {
    return done("errored", WARN, `schema validation did not finish within ${TIMEOUT_MS / 1000}s; the verdict does not include it`, [], { error: "timeout" });
  }
  const report = parseReport(proc.stdout);
  if (!report) {
    const stderr = String(proc.stderr ?? "");
    // Flux prints this for a plugin it cannot find. The plugin command itself
    // arrived in Flux 2.9, so an older flux needs upgrading first.
    if (/unknown command "schema"/i.test(stderr)) {
      return done("unavailable", WARN, `schema validation not run: the flux schema plugin is not installed; next: \`${INSTALL_PLUGIN}\` (Flux 2.9 or later)`, [], { next: INSTALL_PLUGIN });
    }
    const reason = lastLine(stderr) || proc.error?.message || `exit ${proc.status}`;
    if (OFFLINE.test(stderr)) {
      return done("unreachable", NOTE, `schema validation not run: the schema catalog could not be reached (${reason}); run again with network access`, [], { error: reason });
    }
    return done("errored", WARN, `schema validation did not complete: flux schema validate ${proc.status === null ? "was stopped" : `exited ${proc.status}`} without a report: ${reason}; the verdict does not include it`, [], { error: reason });
  }

  const reported = report.results.filter((entry) => entry && typeof entry === "object");
  const accepted = { numericQuantities: [], prunedNulls: [] };
  const schemas = crdSchemas(objects);
  const results = reported.map((entry) => withoutAccepted(objects, schemas, entry, accepted));
  const { numericQuantities, prunedNulls } = accepted;
  const cleared = results.filter((entry, index) => entry.status === "valid" && reported[index].status === "invalid").length;
  const reporter = typeof report.reporter === "string" ? report.reporter : "flux-schema";
  const summary = {
    total: Number(report.summary?.total ?? reported.length),
    valid: Number(report.summary?.valid ?? reported.filter((entry) => entry.status === "valid").length) + cleared,
    invalid: Number(report.summary?.invalid ?? reported.filter((entry) => entry.status === "invalid").length) - cleared,
    skipped: Number(report.summary?.skipped ?? reported.filter((entry) => entry.status === "skipped").length),
  };
  const invalid = results.filter((entry) => entry.status === "invalid");
  const violations = invalid.filter((entry) => VIOLATIONS.has(entry.reason)).flatMap((entry) => {
    const found = Array.isArray(entry.violations) && entry.violations.length ? entry.violations : [{ message: entry.reason }];
    return found.map((violation) => ({ object: objectName(entry.resource), path: violation?.path ?? null, message: String(violation?.message ?? entry.reason), reason: entry.reason }));
  });
  const unreachable = invalid.filter((entry) => entry.reason === "schema-load-error" && (entry.violations ?? []).some((violation) => OFFLINE.test(String(violation?.message ?? ""))));
  const unreadable = invalid.filter((entry) => !VIOLATIONS.has(entry.reason) && !unreachable.includes(entry));
  const against = `the ${SCHEMA_LOCATIONS.join(" and ")} catalogs (${reporter})`;
  const skippedNote = summary.skipped ? `; ${summary.skipped} without a catalog schema skipped` : "";
  const quantityNote = numericQuantities.length
    ? `; ${numericQuantities.length} quantit${numericQuantities.length === 1 ? "y" : "ies"} written as a number, which the API server accepts`
    : "";
  const nullNote = prunedNulls.length
    ? `; ${prunedNulls.length} null${prunedNulls.length === 1 ? "" : "s"} in a custom resource field, which the API server drops before defaulting`
    : "";
  const extra = { reporter, summary, violations, numericQuantities, prunedNulls,
    unchecked: [...unreachable, ...unreadable].map((entry) => ({ object: objectName(entry.resource), reason: entry.reason ?? "unknown", message: lastLine((entry.violations ?? [])[0]?.message) })) };

  if (violations.length) {
    const objectsHit = new Set(violations.map((violation) => violation.object)).size;
    const details = violations.slice(0, SHOWN).map((violation) => `${violation.object}  ${violation.path ?? "(document)"}: ${violation.message}`);
    if (violations.length > SHOWN) details.push(`and ${violations.length - SHOWN} more; ${more}`);
    return done("failed", FAIL, `schema validation: ${violations.length} violation(s) in ${objectsHit} object(s) against ${against}; ${fix}:`, details, extra);
  }
  if (unreadable.length) {
    const reasons = [...new Set(unreadable.map((entry) => entry.reason ?? "unknown"))].join(", ");
    return done("errored", WARN, `schema validation: ${unreadable.length} object(s) could not be validated (${reasons}): ${lastLine((unreadable[0].violations ?? [])[0]?.message) || "no message"}; no violations in the rest`, [], extra);
  }
  if (unreachable.length) {
    return done("unreachable", NOTE, `schema validation: the schema catalog could not be reached for ${unreachable.length} of ${summary.total} object(s); no violations in the rest; run again with network access`, [], extra);
  }
  return done("passed", PASS, `schema validation: ${summary.valid} object(s) valid against ${against}${skippedNote}${quantityNote}${nullNote}${pinNote}`, [], extra);
}

// Adds the line to a check result. A FAIL refuses the verdict like any other
// FAIL; every other outcome leaves it as it was.
export function addSchemaValidation(stack, result, options) {
  const { findings, record } = validateStackSchemas(stack, options);
  result.findings.push(...findings);
  result.schemaValidation = record;
  if (record.status === "failed") result.certified = false;
  return result;
}
