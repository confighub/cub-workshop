import test from 'node:test';
import { parseBoundedDocuments } from '../lib/local-input.mjs';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (noun, ...args) => spawnSync(process.execPath, [join(root, `bin/cub-${noun}`), ...args], { encoding:'utf8', timeout:5000 });
test('both entry points inspect files outside the installation and preserve exact bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-input-'));
  try {
    const path = join(dir, 'my app.yaml');
    const content = readFileSync(join(root, 'apps/hello-standalone.yaml'));
    writeFileSync(path, content);
    for (const noun of ['config', 'app']) {
      const output = join(dir, `${noun}.yaml`);
      const result = run(noun, 'check', path, '--out', output);
      assert.equal(result.status, 0, result.stderr);
      assert.deepEqual(readFileSync(output), content);
      assert.deepEqual(readFileSync(path), content);
    }
  } finally { rmSync(dir, { recursive:true, force:true }); }
});
test('quoted and block scalar text resembling YAML syntax remains valid', () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-scalars-'));
  try {
    const path = join(dir, 'scalar.yaml');
    const content = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: scalar\ndata:\n  note: "*literal --- text"\n  block: |\n    ---\n    *literal\n';
    writeFileSync(path, content);
    const result = run('config', 'check', path);
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(dir, { recursive:true, force:true }); }
});
test('a single document may contain many child mappings without counting them as documents', () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-child-maps-'));
  try {
    const path = join(dir, 'many.yaml');
    const children = Array.from({ length: 300 }, (_, i) => `    key-${i}: value-${i}`).join('\n');
    writeFileSync(path, `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: many\ndata:\n${children}\n`);
    const result = run('config', 'check', path);
    assert.equal(result.status, 0, result.stderr);
  } finally { rmSync(dir, { recursive:true, force:true }); }
});
test('missing, empty and partially invalid inputs fail before writing an output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-invalid-'));
  try {
    const path = join(dir, 'input.yaml');
    for (const content of ['', 'hello', 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: 123\n', 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: good\n---\nnot-a-resource\n']) {
      writeFileSync(path, content);
      for (const noun of ['config','app']) {
        const result = run(noun, 'check', path);
        assert.equal(result.status, 2);
        assert.match(result.stderr, /named Kubernetes objects/);
      }
    }
    for (const noun of ['config','app']) assert.equal(run(noun, 'check', join(dir, 'missing.yaml')).status, 2);
  } finally { rmSync(dir, {recursive:true, force:true}); }
});
test('malformed secret-bearing YAML returns a sanitized bounded error', () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-malformed-'));
  try {
    const path = join(dir, 'secret.yaml');
    writeFileSync(path, 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: [PRIVATE_TOKEN_123\n');
    const result = run('config', 'check', path);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /not valid bounded YAML or JSON/);
    assert.doesNotMatch(result.stderr, /PRIVATE_TOKEN_123|line|column|snippet/);
  } finally { rmSync(dir, { recursive:true, force:true }); }
});
test('local loader rejects aliases, excessive documents and deeply nested YAML', () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-bounds-'));
  try {
    const path = join(dir, 'bounded.yaml');
    for (const content of [
      'base: &secret PRIVATE_TOKEN_123\napiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: good\n',
      Array.from({ length: 257 }, (_, i) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: item-${i}`).join('\n---\n'),
      `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: deep\n  annotations:\n    x: ${'['.repeat(70)}x${']'.repeat(70)}\n`,
    ]) {
      writeFileSync(path, content);
      const result = run('app', 'check', path);
      assert.equal(result.status, 2);
      assert.doesNotMatch(result.stderr, /PRIVATE_TOKEN_123|YAMLException|snippet/);
    }
  } finally { rmSync(dir, { recursive:true, force:true }); }
});
test('local loader rejects oversized files before parsing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-oversized-'));
  try {
    const path = join(dir, 'oversized.yaml');
    writeFileSync(path, `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: oversized\n  annotations:\n    value: ${'x'.repeat(10 * 1024 * 1024)}\n`);
    const result = run('config', 'check', path);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /exceeds the 10485760 byte limit/);
  } finally { rmSync(dir, { recursive:true, force:true }); }
});
test('local loader refuses a FIFO without blocking', () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-fifo-'));
  try {
    const path = join(dir, 'input.yaml');
    const fifo = spawnSync('mkfifo', [path], { encoding:'utf8' });
    assert.equal(fifo.status, 0, fifo.stderr);
    const result = run('app', 'check', path);
    assert.equal(result.status, 2);
    assert.match(result.stderr, /regular file/);
  } finally { rmSync(dir, { recursive:true, force:true }); }
});

test('document limit counts root documents at the exact boundary', () => {
  const documents = n => Buffer.from(Array.from({ length:n }, (_, i) => `apiVersion: v1\nkind: ConfigMap\nmetadata: {name: item-${i}}`).join('\n---\n'));
  assert.equal(parseBoundedDocuments(documents(256), 'config').length, 256);
  assert.throws(() => parseBoundedDocuments(documents(257), 'config'), /bounded YAML or JSON/);
});

test('invalid UTF-8 is refused before source bytes can be retained', () => {
  const invalid = Buffer.concat([Buffer.from('apiVersion: v1\nkind: ConfigMap\nmetadata: {name: invalid}\ndata: {value: "'), Buffer.from([0xff]), Buffer.from('"}\n')]);
  assert.throws(() => parseBoundedDocuments(invalid, 'config'), /not valid UTF-8/);
  const dir = mkdtempSync(join(tmpdir(), 'local-encoding-'));
  try {
    const input = join(dir, 'invalid.yaml'); writeFileSync(input, invalid);
    for (const noun of ['config', 'app']) {
      const output = join(dir, `${noun}.yaml`);
      const result = run(noun, 'check', input, '--out', output);
      assert.equal(result.status, 2); assert.match(result.stderr, /not valid UTF-8/);
      assert.throws(() => readFileSync(output), { code:'ENOENT' });
    }
  } finally { rmSync(dir, {recursive:true, force:true}); }
});

test('all shipped configurations remain inspectable within the parser bounds', () => {
  for (const file of readdirSync(join(root, 'renders')).filter(name => name.endsWith('.yaml'))) {
    const result = run('config', 'check', file.slice(0, -5));
    assert.equal(result.status, 0, `${file}: ${result.stderr}`);
  }
});
test('a large flat collection stops at the parser event budget', () => {
  assert.throws(() => parseBoundedDocuments(Buffer.from(JSON.stringify({items:Array(300000).fill(1)})), 'config'), /bounded YAML or JSON/);
});
