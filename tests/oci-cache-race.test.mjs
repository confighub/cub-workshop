import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const common = fileURLToPath(new URL('../lib/common.mjs', import.meta.url));

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'oci-cache-race-'));
  const source = join(dir, 'config.yaml');
  const contents = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: cache-fixture\ndata:\n  value: one\n';
  writeFileSync(source, contents);
  const receipt = join(dir, 'receipt.json');
  const hash = createHash('sha256').update(contents).digest('hex');
  writeFileSync(receipt, JSON.stringify({ spec: { bundle: { files: [{ path: 'config.yaml', sha256: hash }] } } }));
  const fakeBin = join(dir, 'bin');
  const fakeOras = join(fakeBin, 'oras');
  const log = join(dir, 'pull.log');
  mkdirSync(fakeBin);
  const script = [
    '#!/bin/sh', 'set -eu', 'out=', 'prev=',
    'for arg in "$@"; do', '  if [ "$prev" = "-o" ]; then out="$arg"; fi', '  prev="$arg"', 'done',
    'echo "$$" >> "$FAKE_ORAS_LOG"', 'mkdir -p "$out"',
    'if [ "${FAKE_ORAS_MODE:-ok}" = "fail" ]; then', '  echo partial > "$out/partial"', '  sleep 0.1', '  exit 17', 'fi',
    'sleep 0.2', 'tar -cf "$out/bundle.tar" -C "$FAKE_ORAS_SOURCE" config.yaml', '',
  ].join('\n');
  writeFileSync(fakeOras, script);
  chmodSync(fakeOras, 0o755);
  return { dir, source, receipt, fakeBin, log };
}

function component(digest, receipt) {
  return { name: 'fixture', bundle: `oci://localhost:5001/fixture@sha256:${digest}`, receipt };
}

function child(componentValue, env) {
  const code = `import { resolveBundle } from ${JSON.stringify(common)}; const result = resolveBundle(${JSON.stringify(componentValue)}); console.log(JSON.stringify(result.map((object) => object.metadata?.name)));`;
  return spawn(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
}

function collect(process) {
  return new Promise((resolve) => {
    let stdout = ''; let stderr = '';
    process.stdout.on('data', (chunk) => { stdout += chunk; });
    process.stderr.on('data', (chunk) => { stderr += chunk; });
    process.on('close', (status, signal) => resolve({ status, signal, stdout, stderr }));
  });
}

test('two pulls of one uncached digest publish one complete verified winner', async () => {
  const f = fixture();
  try {
    const digest = 'a'.repeat(64);
    const env = { ...process.env, PATH: `${f.fakeBin}:${process.env.PATH}`, TMPDIR: f.dir, FAKE_ORAS_SOURCE: f.dir, FAKE_ORAS_LOG: f.log };
    const results = await Promise.all([collect(child(component(digest, f.receipt), env)), collect(child(component(digest, f.receipt), env))]);
    assert.deepEqual(results.map((result) => result.status), [0, 0]);
    assert.deepEqual(results.map((result) => JSON.parse(result.stdout.trim())), [['cache-fixture'], ['cache-fixture']]);
    assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 2);
    assert.deepEqual(readdirSync(join(f.dir, 'cub-stack-bundles')), [digest]);
    assert.deepEqual(readdirSync(join(f.dir, 'cub-stack-bundles', digest)).sort(), ['.ok', 'config.yaml']);
    assert.deepEqual(readdirSync(f.dir).filter((name) => name.startsWith('cub-stack-')), ['cub-stack-bundles']);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('failed pull leaves no published cache or staging directory', () => {
  const f = fixture();
  try {
    const digest = 'b'.repeat(64);
    const env = { ...process.env, PATH: `${f.fakeBin}:${process.env.PATH}`, TMPDIR: f.dir, FAKE_ORAS_SOURCE: f.dir, FAKE_ORAS_LOG: f.log, FAKE_ORAS_MODE: 'fail' };
    const code = `import { resolveBundle } from ${JSON.stringify(common)}; resolveBundle(${JSON.stringify(component(digest, f.receipt))});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.equal(readdirSync(f.dir).some((name) => name === 'cub-stack-bundles' || name.startsWith('cub-stack-bundle-') || name.startsWith('cub-stack-pull-')), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('digests sharing the old prefix receive isolated full-digest caches', () => {
  const f = fixture();
  try {
    const first = 'c'.repeat(64);
    const second = 'c'.repeat(16) + 'd'.repeat(48);
    const env = { ...process.env, PATH: `${f.fakeBin}:${process.env.PATH}`, TMPDIR: f.dir, FAKE_ORAS_SOURCE: f.dir, FAKE_ORAS_LOG: f.log };
    for (const digest of [first, second]) {
      const code = `import { resolveBundle } from ${JSON.stringify(common)}; console.log(resolveBundle(${JSON.stringify(component(digest, f.receipt))}).length);`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    assert.deepEqual(readdirSync(join(f.dir, 'cub-stack-bundles')).sort(), [first, second].sort());
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('a seeded prefix without full receipt identity cannot serve silently', () => {
  const f = fixture();
  try {
    const digest = '76314143ef5017951d1351732eb0796707e73797c2a67ace5fb4202a62bbad70';
    const seededReceipt = JSON.parse(readFileSync(join(root, 'receipts', 'workshop', 'cert-manager.json'), 'utf8'));
    delete seededReceipt.spec.bundle.digest;
    delete seededReceipt.spec.bundle.manifestDigest;
    delete seededReceipt.spec.bundle.reference;
    seededReceipt.spec.bundle.files = [{ path: 'cert-manager.yaml', sha256: createHash('sha256').update(readFileSync(join(root, 'cache', digest.slice(0, 16), 'cert-manager.yaml'))).digest('hex') }];
    const receipt = join(f.dir, 'missing-digest-receipt.json');
    writeFileSync(receipt, JSON.stringify(seededReceipt));
    const env = { ...process.env, PATH: `${f.fakeBin}:${process.env.PATH}`, TMPDIR: f.dir, FAKE_ORAS_SOURCE: f.dir, FAKE_ORAS_LOG: f.log, FAKE_ORAS_MODE: 'fail' };
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `import { resolveBundle } from ${JSON.stringify(common)}; resolveBundle(${JSON.stringify(component(digest, receipt))});`], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

function plant(f, digest, files) {
  const entry = join(f.dir, 'cub-stack-bundles', digest);
  mkdirSync(entry, { recursive: true });
  for (const [name, contents] of Object.entries(files)) writeFileSync(join(entry, name), contents);
  return entry;
}

function assertRecovered(f, digest, result) {
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, new RegExp(`cache ${join(f.dir, 'cub-stack-bundles', digest).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} is`));
  assert.equal(readFileSync(f.log, 'utf8').trim().split('\n').length, 1);
  assert.deepEqual(readdirSync(join(f.dir, 'cub-stack-bundles')), [digest]);
  assert.deepEqual(readdirSync(join(f.dir, 'cub-stack-bundles', digest)).sort(), ['.ok', 'config.yaml']);
  assert.equal(readFileSync(join(f.dir, 'cub-stack-bundles', digest, 'config.yaml'), 'utf8'), readFileSync(f.source, 'utf8'));
  assert.deepEqual(readdirSync(f.dir).filter((name) => name.startsWith('cub-stack-')), ['cub-stack-bundles']);
}

for (const [label, files] of [
  ['an unmarked partial entry', { 'config.yaml': 'apiVersion: v1\nkind: Conf' }],
  ['a marked entry whose bytes no longer verify', { '.ok': 'complete\n', 'config.yaml': 'apiVersion: v1\nkind: Conf' }],
  ['a marked entry whose files were pruned', { '.ok': 'complete\n' }],
]) {
  test(`${label} is discarded and pulled again`, () => {
    const f = fixture();
    try {
      const digest = 'e'.repeat(64);
      plant(f, digest, files);
      const env = { ...process.env, PATH: `${f.fakeBin}:${process.env.PATH}`, TMPDIR: f.dir, FAKE_ORAS_SOURCE: f.dir, FAKE_ORAS_LOG: f.log };
      const code = `import { resolveBundle } from ${JSON.stringify(common)}; console.log(JSON.stringify(resolveBundle(${JSON.stringify(component(digest, f.receipt))}).map((object) => object.metadata?.name)));`;
      const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env, encoding: 'utf8' });
      assertRecovered(f, digest, result);
      assert.deepEqual(JSON.parse(result.stdout.trim()), ['cache-fixture']);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  });
}

test('cub stack check recovers from an incomplete cached component bundle', () => {
  const f = fixture();
  try {
    const digest = 'f'.repeat(64);
    plant(f, digest, { 'config.yaml': 'apiVersion: v1\n' });
    const manifest = join(f.dir, 'platform.yaml');
    writeFileSync(manifest, [
      'apiVersion: helm-expt.confighub.com/v1alpha1', 'kind: Stack', 'metadata:', '  name: cache-recovery', 'spec:', '  components:',
      '    - name: cert-manager', `      bundle: "oci://localhost:5001/fixture@sha256:${digest}"`, '      receipt: receipt.json', '',
    ].join('\n'));
    const env = { ...process.env, PATH: `${f.fakeBin}:${process.env.PATH}`, TMPDIR: f.dir, FAKE_ORAS_SOURCE: f.dir, FAKE_ORAS_LOG: f.log };
    const result = spawnSync(process.execPath, [join(root, 'bin', 'cub-stack'), 'check', manifest, '--json'], { cwd: f.dir, env, encoding: 'utf8', timeout: 30000 });
    assert.doesNotMatch(result.stderr, /cache publication was incomplete/);
    assertRecovered(f, digest, result);
    assert.equal(JSON.parse(result.stdout).certified, true);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('a stale entry that cannot be removed names its path and says to delete it', { skip: process.getuid?.() === 0 && 'root ignores directory permissions' }, () => {
  const f = fixture();
  const cacheRoot = join(f.dir, 'cub-stack-bundles');
  try {
    const digest = '9'.repeat(64);
    const entry = plant(f, digest, { 'config.yaml': 'apiVersion: v1\n' });
    chmodSync(cacheRoot, 0o555);
    const env = { ...process.env, PATH: `${f.fakeBin}:${process.env.PATH}`, TMPDIR: f.dir, FAKE_ORAS_SOURCE: f.dir, FAKE_ORAS_LOG: f.log };
    const code = `import { resolveBundle } from ${JSON.stringify(common)}; resolveBundle(${JSON.stringify(component(digest, f.receipt))});`;
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, env, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes(`cache ${entry} is incomplete and could not be removed`), result.stderr);
    assert.match(result.stderr, /delete that directory and run the command again/);
  } finally { chmodSync(cacheRoot, 0o755); rmSync(f.dir, { recursive: true, force: true }); }
});

test('processes recovering one stale entry together all succeed with one complete winner', async () => {
  const f = fixture();
  try {
    const digest = '8'.repeat(64);
    plant(f, digest, { 'config.yaml': 'apiVersion: v1\n' });
    const env = { ...process.env, PATH: `${f.fakeBin}:${process.env.PATH}`, TMPDIR: f.dir, FAKE_ORAS_SOURCE: f.dir, FAKE_ORAS_LOG: f.log };
    const results = await Promise.all(Array.from({ length: 4 }, () => collect(child(component(digest, f.receipt), env))));
    assert.deepEqual(results.map((result) => result.status), [0, 0, 0, 0], results.map((result) => result.stderr).join('\n'));
    assert.deepEqual(results.map((result) => JSON.parse(result.stdout.trim())), Array.from({ length: 4 }, () => ['cache-fixture']));
    assert.deepEqual(readdirSync(join(f.dir, 'cub-stack-bundles')), [digest]);
    assert.deepEqual(readdirSync(join(f.dir, 'cub-stack-bundles', digest)).sort(), ['.ok', 'config.yaml']);
    assert.deepEqual(readdirSync(f.dir).filter((name) => name.startsWith('cub-stack-')), ['cub-stack-bundles']);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
