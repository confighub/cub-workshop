import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const bin = fileURLToPath(new URL('../bin/cub-stack', import.meta.url));
const run = (...args) => spawnSync(process.execPath, [bin, ...args], { encoding: 'utf8', timeout: 15000 });

test('JSON has no prose prefix, matches the retained sandbox bytes and preserves not-checked scope', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stack-json-'));
  try {
    const result = run('certify', 'web-tiny', '--json');
    assert.equal(result.status, 0, result.stderr);
    const body = JSON.parse(result.stdout);
    assert.equal(body.kind, 'StackCertificationResult');
    assert.equal(body.certified, true);
    assert.equal(body.scope.targetAvailability, 'not-checked');
    assert.equal(body.scope.applicationHealth, 'not-checked');
    assert.ok(body.checks.some(check => check.result === 'PASS'));
    const out = join(dir, 'rendered.yaml');
    assert.equal(run('sandbox', 'web-tiny', '--out', out).status, 0);
    const bytes = readFileSync(out);
    assert.equal(body.renderedFile.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(body.renderedFile.bytes, bytes.length);
    assert.equal(body.objectCount, body.components.reduce((sum, component) => sum + component.objects, 0));
    assert.equal(result.stdout, run('certify', '--json', 'web-tiny').stdout);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a refused composition is valid JSON with nonzero exit and the actual findings', () => {
  const result = run('certify', 'conflict-demo', '--json');
  assert.equal(result.status, 1);
  const body = JSON.parse(result.stdout);
  assert.equal(body.certified, false);
  assert.ok(body.checks.some(check => check.result === 'FAIL'));
  assert.ok(body.checks.some(check => check.result === 'detail'));
});

test('unsupported JSON invocations fail without pretending to return a verdict', () => {
  for (const args of [['list', '--json'], ['certify', '--json'], ['certify', 'web-tiny', '--json', '--bogus']]) {
    const result = run(...args);
    assert.equal(result.status, 2);
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /usage:/);
  }
});

test('ordinary human output is preserved', () => {
  const result = run('certify', 'web-tiny');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Certify/);
  assert.match(result.stdout, /=> CERTIFIED/);
});
