import { existsSync, readFileSync, statSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const yaml = createRequire(import.meta.url)('./yaml.cjs');

export function loadInput(input, directory, noun) {
  const local = existsSync(input) || /[\\/]|\.ya?ml$|\.json$/i.test(input);
  const path = local ? resolve(input) : join(directory, `${input}.yaml`);
  if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`no such ${noun} file: ${input}; pass a local YAML file or try cub ${noun} list`);
  const docs = yaml.loadAll(readFileSync(path, 'utf8')).filter(doc => doc != null);
  if (!docs.length || docs.some(doc => typeof doc !== 'object' || Array.isArray(doc) || !doc.apiVersion || !doc.kind || !doc.metadata?.name)) {
    throw new Error(`${noun} input must contain named Kubernetes objects with apiVersion, kind and metadata.name`);
  }
  const name = local ? basename(path).replace(/\.(ya?ml|json)$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') : input;
  if (!name) throw new Error(`${noun} filename needs a usable name`);
  return { name, path, objects: docs, local };
}
