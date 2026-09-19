import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pluginRoot } from "./common.mjs";

// Small dependency-free implementation of the JSON Schema keywords used by the
// shipped contract. Runtime and external consumers therefore evaluate one schema.
const schema = JSON.parse(readFileSync(join(pluginRoot, "schemas", "stack-manifest.schema.json"), "utf8"));
const SUPPORTED = new Set(["$schema", "$id", "$defs", "title", "description", "type", "additionalProperties", "required", "properties", "items", "$ref", "const", "enum", "minLength", "minimum", "pattern", "oneOf", "not", "anyOf"]);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = (path, message) => { throw new Error(`invalid Stack manifest: ${path} ${message}`); };
const resolveRef = (root, ref) => ref.split("/").slice(1).reduce((value, key) => value[key.replaceAll("~1", "/").replaceAll("~0", "~")], root);

function checkSchemaKeywords(rule, path) {
  for (const key of Object.keys(rule)) if (!SUPPORTED.has(key)) throw new Error(`unsupported Stack schema keyword ${path}.${key}`);
  if (rule.type && !["object", "array", "string", "integer", "number", "boolean"].includes(rule.type)) throw new Error(`unsupported Stack schema type ${path}.type`);
  if (rule.properties) for (const [key, child] of Object.entries(rule.properties)) checkSchemaKeywords(child, `${path}.properties.${key}`);
  if (rule.items) checkSchemaKeywords(rule.items, `${path}.items`);
  for (const keyword of ["oneOf", "anyOf"]) for (const [index, child] of (rule[keyword] ?? []).entries()) checkSchemaKeywords(child, `${path}.${keyword}[${index}]`);
  if (rule.not) checkSchemaKeywords(rule.not, `${path}.not`);
  if (rule.$defs) for (const [key, child] of Object.entries(rule.$defs)) checkSchemaKeywords(child, `${path}.$defs.${key}`);
}

function matchesType(value, type) {
  if (type === "object") return isObject(value);
  if (type === "array") return Array.isArray(value);
  if (type === "string") return typeof value === "string";
  if (type === "integer") return Number.isInteger(value);
  if (type === "number") return typeof value === "number";
  if (type === "boolean") return typeof value === "boolean";
  throw new Error(`unsupported Stack schema type ${type}`);
}

function validate(value, rule, root, path) {
  if (rule.$ref) return validate(value, resolveRef(root, rule.$ref), root, path);
  if (rule.const !== undefined && value !== rule.const) fail(path, `must equal ${JSON.stringify(rule.const)}`);
  if (rule.enum && !rule.enum.includes(value)) fail(path, `must be one of ${rule.enum.join(", ")}`);
  if (rule.type && !matchesType(value, rule.type)) fail(path, `must be ${rule.type}`);
  if (rule.minLength !== undefined && value.length < rule.minLength) fail(path, `must have at least ${rule.minLength} characters`);
  if (rule.pattern && !new RegExp(rule.pattern).test(value)) fail(path, "has an invalid format");
  if (rule.minimum !== undefined && value < rule.minimum) fail(path, `must be at least ${rule.minimum}`);
  if (rule.required) for (const key of rule.required) if (!Object.prototype.hasOwnProperty.call(value, key)) fail(path, `is missing required field ${key}`);
  if (rule.additionalProperties === false && isObject(value)) for (const key of Object.keys(value)) if (!rule.properties || !Object.prototype.hasOwnProperty.call(rule.properties, key)) fail(`${path}.${key}`, "is not a supported field");
  if (rule.properties && isObject(value)) for (const [key, child] of Object.entries(rule.properties)) if (value[key] !== undefined) validate(value[key], child, root, `${path}.${key}`);
  if (rule.items && Array.isArray(value)) value.forEach((item, index) => validate(item, rule.items, root, `${path}[${index}]`));
  if (rule.anyOf && !rule.anyOf.some((candidate) => { try { validate(value, candidate, root, path); return true; } catch { return false; } })) fail(path, "does not match any allowed form");
  if (rule.not) {
    let forbidden = true;
    try { validate(value, rule.not, root, path); } catch { forbidden = false; }
    if (forbidden) fail(path, "matches a forbidden form");
  }
  if (rule.oneOf) {
    const matches = rule.oneOf.filter((candidate) => { try { validate(value, candidate, root, path); return true; } catch { return false; } });
    if (matches.length !== 1) fail(path, `must match exactly one allowed form (matched ${matches.length})`);
  }
}

checkSchemaKeywords(schema, "schema");

export function validateStackManifest(manifest) {
  validate(manifest, schema, schema, "document");
  const names = new Set();
  for (const component of manifest.spec.components) {
    if (names.has(component.name)) fail("spec.components", `contains duplicate component name ${component.name}`);
    names.add(component.name);
  }
  return manifest;
}
