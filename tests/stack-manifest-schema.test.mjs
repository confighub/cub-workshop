import { execFileSync } from "node:child_process";
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { readYamlFile, toYaml } from '../lib/common.mjs';
import { validateStackManifest } from '../lib/stack-manifest.mjs';

const validManifests = readdirSync('stacks').filter((file) => file.endsWith('.yaml')).sort();

test('all shipped stack manifests satisfy the runtime contract', () => {
  for (const file of validManifests) assert.doesNotThrow(() => validateStackManifest(readYamlFile(join('stacks', file))), file);
});

test('from-kubara output shape is accepted', () => {
  const manifest = readYamlFile('stacks/kubara-platform.yaml');
  manifest.spec.source = { kubara: '/tmp/kubara-work', cluster: 'demo' };
  assert.doesNotThrow(() => validateStackManifest(manifest));
});

test('unknown fields and mixed component sources are rejected before loading', () => {
  const manifest = readYamlFile('stacks/web-tiny.yaml');
  manifest.spec.components[0].authoredTypo = manifest.spec.components[0].authored;
  assert.throws(() => validateStackManifest(manifest), /not a supported field/);
  delete manifest.spec.components[0].authoredTypo;
  manifest.spec.components[0].bundle = 'oci://example.test/repo@sha256:' + 'a'.repeat(64);
  assert.throws(() => validateStackManifest(manifest), /exactly one/);
});

test('bundle receipts remain discoverable and are not required in the manifest', () => {
  const manifest = readYamlFile('stacks/app-platform.yaml');
  delete manifest.spec.components[0].receipt;
  assert.doesNotThrow(() => validateStackManifest(manifest));
});

test('fullVerdict remains accepted as metadata only', () => {
  const manifest = readYamlFile('stacks/web-tiny.yaml');
  manifest.spec.fullVerdict = 'data/verdict.yaml';
  assert.doesNotThrow(() => validateStackManifest(manifest));
});

test('schema source is valid JSON and documents the historical fullVerdict behavior', () => {
  const schema = JSON.parse(readFileSync('schemas/stack-manifest.schema.json', 'utf8'));
  assert.equal(schema.$id, 'https://confighub.github.io/helm-expt/site/stack-manifest.schema.json');
  assert.match(schema.description, /fullVerdict/);
});

test('duplicate component names are rejected', () => {
  const manifest = readYamlFile('stacks/web-tiny.yaml');
  manifest.spec.components.push({ ...manifest.spec.components[0], authored: 'apps/other.yaml' });
  assert.throws(() => validateStackManifest(manifest), /duplicate component name/);
});

test('malformed envelope, source, and binding forms are rejected', () => {
  const base = readYamlFile('stacks/web-tiny.yaml');
  const cases = [
    ['wrong apiVersion', (m) => { m.apiVersion = 'v1'; }],
    ['wrong kind', (m) => { m.kind = 'ConfigMap'; }],
    ['missing metadata name', (m) => { delete m.metadata.name; }],
    ['missing components', (m) => { delete m.spec.components; }],
    ['missing source', (m) => { delete m.spec.components[0].authored; }],
    ['invalid bundle digest', (m) => { m.spec.components[0] = { name: 'x', bundle: 'oci://example/x:latest' }; }],
    ['receipt on authored', (m) => { m.spec.components[0].receipt = 'receipt.yaml'; }],
    ['invalid plane', (m) => { m.spec.components[0].plane = 'edge'; }],
    ['invalid order', (m) => { m.spec.components[0].order = 1.5; }],
    ['malformed bindings', (m) => { m.spec.bindings = { pathBindings: [{ component: 'x' }] }; }],
    ['malformed source metadata', (m) => { m.spec.source = { kubara: '/tmp/work' }; }],
    ['null document', () => null],
  ];
  for (const [label, mutate] of cases) {
    const candidate = structuredClone(base);
    if (label === 'null document') assert.throws(() => validateStackManifest(null), label);
    else mutate(candidate);
    if (label === 'null document') continue;
    assert.throws(() => validateStackManifest(candidate), label);
  }
});

test('CLI validates mixed source fields before touching a missing source or network', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stack-schema-cli-'));
  try {
    const manifest = readYamlFile('stacks/web-tiny.yaml');
    manifest.spec.components[0].bundle = 'oci://registry.invalid/no-pull@sha256:' + 'a'.repeat(64);
    manifest.spec.components[0].authored = 'missing-local-source.yaml';
    const path = join(dir, 'invalid.yaml');
    writeFileSync(path, toYaml(manifest));
    const result = spawnSync(process.execPath, ['bin/cub-stack', 'check', path], { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /exactly one allowed form|exactly one/);
    assert.doesNotMatch(result.stderr, /missing-local-source|oras|pull/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('schema command returns the installed runtime contract without a network', () => {
  assert.equal(execFileSync(process.execPath, ['bin/cub-stack', 'schema'], { encoding: 'utf8' }), readFileSync('schemas/stack-manifest.schema.json', 'utf8'));
});
