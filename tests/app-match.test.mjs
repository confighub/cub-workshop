import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { matchWorkload } from '../lib/app-match.mjs';
const yaml = createRequire(import.meta.url)('../lib/yaml.cjs');
const root = fileURLToPath(new URL('../', import.meta.url));
const model = readFileSync(join(root, 'examples/match/model.yaml'));
const target = readFileSync(join(root, 'examples/match/nodes.yaml'));
const mutate = (bytes, fn) => { const d = yaml.load(bytes.toString()); fn(d); return Buffer.from(yaml.dump(d)); };
const hash = (b) => `sha256:${createHash('sha256').update(b).digest('hex')}`;

test('retained workload and illustrative snapshot produce bounded deterministic candidate', () => {
  assert.equal(hash(model), 'sha256:a87b0aec9b6d8b3d34bb645fa6bd3ef1957160aa5cd3104e9004b050b2f984e6');
  const r = matchWorkload(model, target);
  assert.deepEqual(r, matchWorkload(model, target));
  assert.equal(r.status, 'candidate');
  assert.equal(r.requirement.gpuPerReplica, 2);
  assert.equal(r.workload.sha256, hash(model));
  assert.equal(r.target.sha256, hash(target));
  assert.equal(r.target.liveChecked, false);
  assert.equal(r.execution, 'not-run');
  assert.ok(r.notChecked.includes('free GPUs and concurrent workloads'));
});
test('GPU counts cannot be pooled across nodes', () => {
  const split = mutate(target, (d) => {
    d.items[0].status.allocatable['nvidia.com/gpu'] = '1';
    d.items.push(structuredClone(d.items[0])); d.items[1].metadata.name = 'second-node';
  });
  assert.equal(matchWorkload(model, split).status, 'mismatch');
});
test('product label mismatch survives abundant GPU count', () => {
  const wrong = mutate(target, (d) => { d.items[0].metadata.labels['nvidia.com/gpu.product'] = 'NVIDIA-A100-SXM4-80GB'; d.items[0].status.allocatable['nvidia.com/gpu'] = '8'; });
  assert.equal(matchWorkload(model, wrong).status, 'mismatch');
});
test('unknown facts stay unknown; explicit zero or absent requested label is a mismatch', () => {
  assert.equal(matchWorkload(model, mutate(target, (d) => { delete d.items[0].status; })).status, 'unknown');
  assert.equal(matchWorkload(model, mutate(target, (d) => { delete d.items[0].metadata.labels; })).status, 'unknown');
  assert.equal(matchWorkload(mutate(model, (d) => { delete d.spec.predictor.nodeSelector; }), target).status, 'unknown');
  assert.equal(matchWorkload(model, mutate(target, (d) => { d.items[0].metadata.labels = {}; })).status, 'mismatch');
  assert.equal(matchWorkload(model, mutate(target, (d) => { d.items[0].status.allocatable['nvidia.com/gpu'] = '0'; })).status, 'mismatch');
});
test('unknown node prevents blanket mismatch but does not hide an explicit candidate', () => {
  const mixed = mutate(target, (d) => { d.items.push(structuredClone(d.items[0])); d.items[1].metadata.name = 'unknown-node'; delete d.items[1].status; });
  assert.equal(matchWorkload(model, mixed).status, 'candidate');
  assert.equal(matchWorkload(model, mutate(mixed, (d) => { d.items[0].status.allocatable['nvidia.com/gpu'] = '0'; })).status, 'unknown');
});
test('malformed quantities, inconsistent requests and duplicate nodes refuse', () => {
  for (const q of ['1.5', '2gpu', -1, true, '9007199254740993']) {
    assert.throws(() => matchWorkload(mutate(model, (d) => { d.spec.predictor.model.resources.limits['nvidia.com/gpu'] = q; }), target), /GPU/);
    assert.throws(() => matchWorkload(model, mutate(target, (d) => { d.items[0].status.allocatable['nvidia.com/gpu'] = q; })), /GPU/);
  }
  assert.throws(() => matchWorkload(mutate(model, (d) => { d.spec.predictor.model.resources.requests['nvidia.com/gpu'] = '1'; }), target), /must agree/);
  assert.throws(() => matchWorkload(model, mutate(target, (d) => { d.items.push(d.items[0]); })), /duplicate Node/);
});
test('unsupported and partially malformed documents do not disappear', () => {
  assert.throws(() => matchWorkload(Buffer.from('hello'), target), /YAML objects/);
  assert.throws(() => matchWorkload(Buffer.concat([model, Buffer.from('\n---\nhello\n')]), target), /YAML objects/);
  assert.throws(() => matchWorkload(model, Buffer.from('apiVersion: v1\nkind: Pod\nmetadata:\n  name: pod\n')), /Nodes only/);
  assert.throws(() => matchWorkload(model, mutate(target, (d) => { d.items = []; })), /no Nodes/);
  assert.throws(() => matchWorkload(mutate(model, (d) => { d.spec.predictor.nodeSelector = { gpu: 2 }; }), target), /nodeSelector/);
});
test('CLI works outside plugin directory, preserves bytes, saves JSON and refuses overwrite', () => {
  const dir = mkdtempSync(join(tmpdir(), 'workshop-match-'));
  const run = (args) => spawnSync(process.execPath, [join(root, 'bin/cub-app'), 'match', ...args], { cwd: dir, encoding: 'utf8' });
  try {
    writeFileSync(join(dir, 'model.yaml'), model); writeFileSync(join(dir, 'nodes.yaml'), target);
    const args = ['model.yaml', '--target', 'nodes.yaml', '--json', '--out', 'result.json'];
    const first = run(args); assert.equal(first.status, 0, first.stderr);
    assert.deepEqual(JSON.parse(first.stdout), JSON.parse(readFileSync(join(dir, 'result.json'))));
    assert.equal(run(args).status, 1);
    assert.deepEqual(readFileSync(join(dir, 'model.yaml')), model);
    assert.deepEqual(readFileSync(join(dir, 'nodes.yaml')), target);
    writeFileSync(join(dir, 'nodes.yaml'), mutate(target, (d) => { delete d.items[0].status; }));
    const unknown = run(['model.yaml', '--target', 'nodes.yaml', '--json']);
    assert.equal(unknown.status, 3); assert.equal(JSON.parse(unknown.stdout).status, 'unknown');
    writeFileSync(join(dir, 'nodes.yaml'), mutate(target, (d) => { d.items[0].status.allocatable['nvidia.com/gpu'] = '1'; }));
    const mismatch = run(['model.yaml', '--target', 'nodes.yaml', '--json']);
    assert.equal(mismatch.status, 1); assert.equal(JSON.parse(mismatch.stdout).status, 'mismatch');
    assert.equal(run(['model.yaml', '--target']).status, 1);
    assert.equal(run(['model.yaml', '--target', 'nodes.yaml', '--run']).status, 1);
    assert.equal(run(['--help']).status, 0);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
