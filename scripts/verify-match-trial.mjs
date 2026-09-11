#!/usr/bin/env node
// Review retained local Match artifacts. This never launches an assistant or cub.
import assert from 'node:assert/strict';
import { lstatSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { readBoundedBytes, parseBoundedDocuments } from '../lib/local-input.mjs';
import { matchWorkload } from '../lib/app-match.mjs';

const pins = {
  model: 'a87b0aec9b6d8b3d34bb645fa6bd3ef1957160aa5cd3104e9004b050b2f984e6',
  nodes: '8c5540977b4d9f0492f24493aef521e82a78d9425a10ad36737d6c073124eae5',
};
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const expectedExits = { candidate: 0, mismatch: 1, unknown: 3 };

export function verifyMatchTrial(directory) {
  const root = resolve(directory);
  if (!lstatSync(root).isDirectory()) throw new Error('trial must be a directory, not a symbolic link');
  function bytes(name) {
    const file = join(root, name);
    try {
      if (!lstatSync(file).isFile()) throw new Error('not a regular file');
      return readBoundedBytes(file, 1024 * 1024);
    } catch { throw new Error(`${name}: required regular file is missing, unreadable, linked or over 1 MiB`); }
  }
  function json(name) {
    try { return JSON.parse(bytes(name).toString('utf8')); }
    catch (error) { throw new Error(`${name}: ${error.message}`); }
  }
  function equal(actual, expected, message) {
    try { assert.deepEqual(actual, expected); }
    catch { throw new Error(message); }
  }
  const model = bytes('model.yaml');
  const original = bytes('nodes.yaml');
  equal(sha(model), pins.model, 'model.yaml does not match the pinned teaching input');
  equal(sha(original), pins.nodes, 'nodes.yaml does not match the pinned teaching input');
  const baseline = parseBoundedDocuments(original, 'nodes.yaml');
  const targets = { candidate: original, mismatch: bytes('mismatch-nodes.yaml'), unknown: bytes('unknown-nodes.yaml') };
  for (const status of ['mismatch', 'unknown']) {
    const expected = structuredClone(baseline);
    const actual = parseBoundedDocuments(targets[status], `${status}-nodes.yaml`);
    if (status === 'mismatch') {
      expected[0].items[0].status.allocatable['nvidia.com/gpu'] = '1';
      const quantity = actual[0]?.items?.[0]?.status?.allocatable?.['nvidia.com/gpu'];
      if (quantity === 1) actual[0].items[0].status.allocatable['nvidia.com/gpu'] = '1';
    } else {
      expected[0].items[0].status.allocatable = null;
      const allocation = actual[0]?.items?.[0]?.status?.allocatable;
      if (allocation && typeof allocation === 'object' && !Array.isArray(allocation) && Object.keys(allocation).length === 0) {
        actual[0].items[0].status.allocatable = null;
      }
    }
    equal(actual, expected, `${status}-nodes.yaml changes more than the requested GPU fact`);
  }
  equal(json('exit-codes.json'), expectedExits, 'recorded command exits must be candidate=0, mismatch=1, unknown=3');
  const results = {};
  for (const status of Object.keys(expectedExits)) {
    const actual = json(`${status}.json`);
    const expected = matchWorkload(model, targets[status]);
    equal(expected.status, status, `${status} input does not produce the expected decision`);
    equal(actual, expected, `${status}.json does not match the complete recomputed result and input hashes`);
    results[status] = { status, workloadSha256: actual.workload.sha256, targetSha256: actual.target.sha256 };
  }
  return {
    accepted: true, scope: 'retained-match-artifact-consistency', results,
    notProven: ['assistant or command execution authenticity', 'freshness or working directory of an assistant session', 'live-chat API acceptance', 'live target or inference health'],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    if (process.argv.length !== 3) throw new Error('usage: node scripts/verify-match-trial.mjs <trial-directory>');
    console.log(JSON.stringify(verifyMatchTrial(process.argv[2]), null, 2));
  } catch (error) {
    console.error(JSON.stringify({ accepted: false, scope: 'retained-match-artifact-consistency', reason: error.message }));
    process.exitCode = 1;
  }
}
