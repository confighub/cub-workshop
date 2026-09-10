import { closeSync, existsSync, fstatSync, openSync, readSync } from 'node:fs';
import { O_NONBLOCK, O_RDONLY } from 'node:constants';
import { basename, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const yaml = createRequire(import.meta.url)('./yaml.cjs');

const MAX_INPUT_BYTES = 10 * 1024 * 1024;
const MAX_DOCUMENTS = 256;
const MAX_NESTING = 64;
// The shipped 5 MiB kube-prometheus-stack render uses 105,211 parser events.
const MAX_NODES = 250_000;

export function readBoundedBytes(path, maxBytes = MAX_INPUT_BYTES) {
  let fd;
  try {
    fd = openSync(path, O_RDONLY | O_NONBLOCK);
    const stats = fstatSync(fd);
    if (!stats.isFile()) throw new Error('input must be a regular file');
    const buffer = Buffer.allocUnsafe(maxBytes + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, null);
      if (!count) break;
      offset += count;
    }
    if (offset > maxBytes) throw new Error(`input exceeds the ${maxBytes} byte limit`);
    return buffer.subarray(0, offset);
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

export function parseBoundedDocuments(bytes, noun) {
  if (!Buffer.isBuffer(bytes)) throw new Error(`${noun} input must be supplied as bytes`);
  if (bytes.length > MAX_INPUT_BYTES) {
    throw new Error(`${noun} input exceeds the ${MAX_INPUT_BYTES} byte limit`);
  }
  let text;
  try { text = new TextDecoder('utf-8', { fatal:true }).decode(bytes); }
  catch { throw new Error(`${noun} input is not valid UTF-8`); }
  let depth = 0;
  let documents = 0;
  let events = 0;
  try {
    const docs = yaml.loadAll(text, {
      schema: yaml.JSON_SCHEMA,
      listener: (event, state) => {
        if (event === 'open') {
          if (depth === 0 && ++documents > MAX_DOCUMENTS) throw new Error('document limit');
          if (++depth > MAX_NESTING || ++events > MAX_NODES) throw new Error('input bounds');
          if (state.anchor) throw new Error('anchors and aliases are not supported');
          if (state.kind === null && state.result !== null) throw new Error('anchors and aliases are not supported');
        }
        if (event === 'close') {
          if (state.anchor) throw new Error('anchors and aliases are not supported');
          if (state.kind === null && state.result !== null && depth > 1) throw new Error('anchors and aliases are not supported');
          depth -= 1;
        }
      },
    });
    if (docs.length > MAX_DOCUMENTS) throw new Error('document limit');
    let nodes = 0;
    const seen = new WeakSet();
    const visit = value => {
      if (value === null || typeof value !== 'object') return;
      if (++nodes > MAX_NODES) throw new Error('node limit');
      if (seen.has(value)) throw new Error('cyclic input');
      seen.add(value);
      if (!Array.isArray(value)) {
        const prototype = Object.getPrototypeOf(value);
        if (prototype !== Object.prototype && prototype !== null) throw new Error('non-plain input');
      }
      for (const child of Array.isArray(value) ? value : Object.values(value)) visit(child);
    };
    for (const doc of docs) visit(doc);
    return docs;
  } catch {
    throw new Error(`${noun} input is not valid bounded YAML or JSON`);
  }
}

export function readBoundedText(path, maxBytes = MAX_INPUT_BYTES) {
  return readBoundedBytes(path, maxBytes).toString('utf8');
}

export function loadInput(input, directory, noun) {
  const local = existsSync(input) || /[\\/]|\.ya?ml$|\.json$/i.test(input);
  const path = local ? resolve(input) : join(directory, `${input}.yaml`);
  if (!existsSync(path)) throw new Error(`no such ${noun} file: ${input}; pass a local YAML file or try cub ${noun} list`);
  let docs;
  let inputBytes;
  try {
    const bytes = readBoundedBytes(path);
    docs = parseBoundedDocuments(bytes, noun).filter(doc => doc != null);
    inputBytes = bytes;
  } catch (error) {
    if (error.message === 'input must be a regular file') throw new Error(`${noun} input must be a regular file`);
    if (error.message === `input exceeds the ${MAX_INPUT_BYTES} byte limit`) throw new Error(`${noun} input exceeds the ${MAX_INPUT_BYTES} byte limit`);
    throw error;
  }
  if (!docs.length || docs.some(doc => typeof doc !== 'object' || Array.isArray(doc) || [doc.apiVersion, doc.kind, doc.metadata?.name].some(value => typeof value !== 'string' || !value.trim()))) {
    throw new Error(`${noun} input must contain named Kubernetes objects with apiVersion, kind and metadata.name`);
  }
  const name = local ? basename(path).replace(/\.(ya?ml|json)$/i, '').toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '') : input;
  if (!name) throw new Error(`${noun} filename needs a usable name`);
  return { name, path, objects: docs, local, bytes: inputBytes };
}
