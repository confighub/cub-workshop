// Compare two from-kubara outputs object by object: each cluster's render of
// each component, keyed by apiVersion|kind|namespace|name. A Secret compares by
// its keys, since cub kubara render empties the values and the old renderer
// kept them.
//
//   node proofs/from-kubara-live-2026-09-30/parity.mjs <new out> <old out>
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { canonicalMap, parseDocs, readYamlFile } from '../../lib/common.mjs';

const [fresh, old] = process.argv.slice(2);
const keysOnly = (doc) => {
  if (doc.kind !== 'Secret') return doc;
  const blank = (map) => map && Object.fromEntries(Object.keys(map).map((key) => [key, '']));
  return { ...doc, data: blank(doc.data), stringData: blank(doc.stringData) };
};
const renders = (dir) => {
  const out = new Map();
  for (const comp of readYamlFile(join(dir, 'stack.yaml')).spec.components) {
    for (const variant of comp.variants ?? []) {
      out.set(`${variant.cluster}/${comp.name}`, canonicalMap(parseDocs(readFileSync(join(dir, variant.render), 'utf8')).map(keysOnly)));
    }
  }
  return out;
};
const [a, b] = [renders(fresh), renders(old)];
let objects = 0; let differ = 0;
const names = [...new Set([...a.keys(), ...b.keys()])].sort();
for (const name of names) {
  const [x, y] = [a.get(name) ?? {}, b.get(name) ?? {}];
  const ids = [...new Set([...Object.keys(x), ...Object.keys(y)])];
  const bad = ids.filter((id) => x[id] !== y[id]);
  objects += ids.length; differ += bad.length;
  console.log(`  ${name}: ${Object.keys(x).length} objects, ${bad.length ? `${bad.length} differ: ${bad.slice(0, 3).join(', ')}` : 'identical'}`);
}
const secrets = [...a.values()].flatMap((map) => Object.keys(map)).filter((id) => id.startsWith('v1|Secret|')).length;
console.log(`${names.length} cluster renders, ${objects} objects: ${differ === 0 ? 'all identical' : `${differ} differ`} (${secrets} Secret(s) compared by keys)`);
process.exit(differ === 0 ? 0 : 1);
