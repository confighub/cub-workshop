import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
const yaml = createRequire(import.meta.url)('./yaml.cjs');
const hash = (bytes) => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function check(ok, message) { if (!ok) throw new Error(message); }
function normalize(value, ancestors = new Set()) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') { check(Number.isFinite(value), 'non-finite numbers are not supported'); return value; }
  check(value && typeof value === 'object', 'configuration contains a non-JSON value');
  check(!ancestors.has(value), 'cyclic YAML aliases are not supported');
  ancestors.add(value);
  const normalized = Array.isArray(value) ? value.map((v) => normalize(v, ancestors)) : Object.fromEntries(Object.keys(value).sort().map((k) => [k, normalize(value[k], ancestors)]));
  ancestors.delete(value);
  return normalized;
}
function objects(bytes, label) {
  let docs;
  try { docs = yaml.loadAll(bytes.toString(), { schema: yaml.JSON_SCHEMA }); }
  catch (error) { throw new Error(`${label}: invalid YAML (${error.reason ?? 'parse failed'})`); }
  const map = new Map();
  for (const doc of docs) {
    if (doc === null || doc === undefined) continue; // Empty document separators.
    check(object(doc) && object(doc.metadata), `${label}: every document must be a Kubernetes object with metadata`);
    for (const [field, value] of [['apiVersion',doc.apiVersion],['kind',doc.kind],['metadata.name',doc.metadata.name]]) check(typeof value === 'string' && value.length > 0, `${label}: ${field} must be a nonempty string`);
    check(doc.metadata.namespace === undefined || typeof doc.metadata.namespace === 'string', `${label}: metadata.namespace must be a string when supplied`);
    const identity = { apiVersion: doc.apiVersion, kind: doc.kind, namespace: doc.metadata.namespace ?? null, name: doc.metadata.name };
    const key = JSON.stringify(Object.values(identity));
    check(!map.has(key), `${label}: duplicate object ${key}`);
    map.set(key, { identity, value: normalize(doc) });
  }
  check(map.size > 0, `${label}: no Kubernetes objects found`);
  return map;
}
const escape = (key) => key.replaceAll('~','~0').replaceAll('/','~1');
// Kubernetes keys many lists by name: containers, env, volumes, ports, volumeClaimTemplates.
// When every item of a list on both sides is a map with its own distinct name, the list
// is read as a map from name to item, so one changed field in one container is reported
// as that field and not as the whole list. Any other list is still one value, order included.
// An item is named by its own name, or as an embedded object by metadata.name
// (volumeClaimTemplates).
const nameOf = (item) => !object(item) ? null : typeof item.name === 'string' && item.name ? item.name
  : object(item.metadata) && typeof item.metadata.name === 'string' && item.metadata.name ? item.metadata.name : null;
const named = (list) => Array.isArray(list) && list.length > 0
  && list.every((item) => nameOf(item) !== null)
  && new Set(list.map(nameOf)).size === list.length;
const byName = (list) => Object.fromEntries(list.map((item) => [nameOf(item), item]));
function fields(before, after, path = '') {
  if (JSON.stringify(before) === JSON.stringify(after)) return [];
  if (named(before) && named(after)) return fields(byName(before), byName(after), path);
  if (!object(before) || !object(after)) return [{ path, operation: 'replace', before, after }];
  return [...new Set([...Object.keys(before), ...Object.keys(after)])].sort().flatMap((key) => {
    const next = `${path}/${escape(key)}`;
    if (!Object.hasOwn(before,key)) return [{ path: next, operation: 'add', after: after[key] }];
    if (!Object.hasOwn(after,key)) return [{ path: next, operation: 'remove', before: before[key] }];
    return fields(before[key], after[key], next);
  });
}
// A Secret's values never leave this command. Each one is replaced by a short hash of
// itself, so a review still shows that a value changed, and whether two values match.
const SECRET_FIELDS = ['data', 'stringData'];
const sealed = (value) => `<redacted ${hash(Buffer.from(JSON.stringify(value))).slice(0, 19)}>`;
function sealSecret(value) {
  if (!object(value)) return value;
  const out = { ...value };
  for (const key of SECRET_FIELDS) {
    if (object(value[key])) out[key] = Object.fromEntries(Object.entries(value[key]).map(([k, v]) => [k, sealed(v)]));
  }
  return out;
}
function sealField(field) {
  const [top, key] = field.path.split('/').slice(1);
  const seal = (v) => field.path === '' ? sealSecret(v)
    : !SECRET_FIELDS.includes(top) ? v
    : key === undefined ? (object(v) ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, sealed(x)])) : sealed(v))
    : sealed(v);
  const out = { ...field };
  if (Object.hasOwn(field, 'before')) out.before = seal(field.before);
  if (Object.hasOwn(field, 'after')) out.after = seal(field.after);
  return out;
}
function kindSummary(before, after) {
  const counts = new Map();
  for (const { identity } of before.values()) {
    const key = `${identity.apiVersion}\u0000${identity.kind}`;
    const entry = counts.get(key) ?? { apiVersion: identity.apiVersion, kind: identity.kind, before: 0, after: 0 };
    entry.before++;
    counts.set(key, entry);
  }
  for (const { identity } of after.values()) {
    const key = `${identity.apiVersion}\u0000${identity.kind}`;
    const entry = counts.get(key) ?? { apiVersion: identity.apiVersion, kind: identity.kind, before: 0, after: 0 };
    entry.after++;
    counts.set(key, entry);
  }
  return [...counts.values()]
    .map((entry) => ({ ...entry, delta: entry.after - entry.before }))
    .sort((left, right) => left.apiVersion < right.apiVersion ? -1 : left.apiVersion > right.apiVersion ? 1
      : left.kind < right.kind ? -1 : left.kind > right.kind ? 1 : 0);
}
export function diffConfigs(beforeBytes, afterBytes, includeKindSummary = false) {
  const before = objects(beforeBytes, 'before'); const after = objects(afterBytes, 'after');
  let unchanged = 0;
  const changes = [];
  for (const key of [...new Set([...before.keys(), ...after.keys()])].sort()) {
    const old = before.get(key); const next = after.get(key);
    if (!old) changes.push({ object: next.identity, change: 'added', fields: [{ path: '', operation: 'add', after: next.value }] });
    else if (!next) changes.push({ object: old.identity, change: 'removed', fields: [{ path: '', operation: 'remove', before: old.value }] });
    else {
      const edits = fields(old.value,next.value);
      if (edits.length) changes.push({ object: old.identity, change: 'changed', fields: edits });
      else unchanged++;
    }
  }
  for (const c of changes) if (c.object.kind === 'Secret') c.fields = c.fields.map(sealField);
  const result = {
    schemaVersion: 1, scope: 'local-configuration-diff',
    before: { sha256: hash(beforeBytes), objectCount: before.size },
    after: { sha256: hash(afterBytes), objectCount: after.size },
    equal: changes.length === 0,
    summary: { added: changes.filter((c)=>c.change==='added').length, removed: changes.filter((c)=>c.change==='removed').length, changed: changes.filter((c)=>c.change==='changed').length, unchanged },
    changes, comparison: 'Object identity includes API version and explicit namespace; mapping and document order ignored, lists of uniquely named items compared item by item by name, every other list compared as a whole value, missing and null distinct. No Kubernetes defaulting or schema interpretation. Secret data and stringData values are replaced by a short hash of each value.',
    notChecked: ['Kubernetes schema or admission validity', 'upstream merge and protected-field preservation', 'target readiness or live drift', 'application availability'],
  };
  if (includeKindSummary) result.kindSummary = kindSummary(before, after);
  return result;
}
export function runDiff(args) {
  const usage = 'cub config diff <before.yaml> <after.yaml> [--summary] [--json] [--out result.json] [--exit-code]';
  if (args.includes('--help')) { console.log(`${usage}\nCompare local Kubernetes YAML without an account or target. Arrays are whole values; no merge or deployment is performed.`); return 0; }
  const before = args.shift(); const after = args.shift(); let out; let json = false; let exitCode = false; let summary = false;
  check(before && after && !before.startsWith('--') && !after.startsWith('--'), usage);
  while (args.length) {
    const flag = args.shift();
    if (flag === '--json' && !json) json = true;
    else if (flag === '--summary' && !summary) summary = true;
    else if (flag === '--exit-code' && !exitCode) exitCode = true;
    else if (flag === '--out' && !out) { out = args.shift(); check(out && !out.startsWith('--'), '--out requires a file path'); }
    else throw new Error(`unknown or repeated option: ${flag}; ${usage}`);
  }
  const beforeBytes = readFileSync(before); const afterBytes = readFileSync(after);
  const result = diffConfigs(beforeBytes, afterBytes, summary);
  const serialized = `${JSON.stringify(result,null,2)}\n`;
  if (out) writeFileSync(out,serialized,{flag:'wx'});
  if (json) process.stdout.write(serialized);
  else {
    const s = result.summary;
    console.log(`Configuration diff: ${s.added} added, ${s.removed} removed, ${s.changed} changed, ${s.unchanged} unchanged`);
    if (summary) {
      console.log('Kind summary (inventory only):');
      for (const entry of result.kindSummary) console.log(`  ${entry.apiVersion} ${entry.kind}: ${entry.before} -> ${entry.after} (${entry.delta >= 0 ? '+' : ''}${entry.delta})`);
    } else {
      for (const c of result.changes) {
        const o=c.object; console.log(`  ${c.change}: ${o.apiVersion} ${o.kind} ${o.namespace ?? '(namespace unspecified)'}/${o.name}`);
        // An added field has no before and a removed one no after, so say only the side that exists.
        const told = (f) => f.operation === 'add' ? JSON.stringify(f.after) : f.operation === 'remove' ? JSON.stringify(f.before) : `${JSON.stringify(f.before)} -> ${JSON.stringify(f.after)}`;
        for (const f of c.fields) console.log(`    ${f.path || '(whole object)'} ${f.operation}: ${told(f)}`);
      }
    }
    console.log(summary
      ? 'Local inventory comparison only. Matching kind counts do not establish object or behavior equivalence; this does not merge, protect edits or inspect a live target.'
      : 'Local comparison only. This does not merge, protect edits or inspect a live target.');
    if (out) console.log(`Saved ${out}`);
  }
  return exitCode && !result.equal ? 1 : 0;
}
