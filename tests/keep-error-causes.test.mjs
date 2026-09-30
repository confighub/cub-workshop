import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseBoundedDocuments } from '../lib/local-input.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const common = fileURLToPath(new URL('../lib/common.mjs', import.meta.url));
const sha = (text) => createHash('sha256').update(text).digest('hex');
const tmp = (name) => mkdtempSync(join(tmpdir(), `${name}-`));

test('a rejected input says which bound or syntax rule it broke', () => {
  const refuse = (text) => { try { parseBoundedDocuments(Buffer.from(text), 'config'); } catch (error) { return error.message; } return 'accepted'; };
  assert.match(refuse('a: &x 1\nb: *x\n'), /not valid bounded YAML or JSON: anchors and aliases are not supported$/);
  assert.match(refuse(Array.from({ length: 257 }, (_, i) => `a: ${i}`).join('\n---\n')), /: more than 256 documents$/);
  const syntax = refuse('a: [PRIVATE_TOKEN_123\nb: 3\n');
  assert.match(syntax, /not valid bounded YAML or JSON: YAML syntax error \(the offending text is withheld/);
  assert.doesNotMatch(syntax, /PRIVATE_TOKEN_123/);
});

// A catalog with one entry, enough for compose to reach its write and check steps.
function catalog() {
  const dir = tmp('keep-causes-compose');
  const object = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: one\n';
  writeFileSync(join(dir, 'one.yaml'), object);
  writeFileSync(join(dir, 'one.json'), JSON.stringify({ identity: { id: 'one', url: 'one.json' }, flattened: { verdict: 'safe-to-flatten', objectCount: 1, retainedObjects: { path: 'one.yaml', url: 'one.yaml', sha256: `sha256:${sha(object)}` } }, evidence: { links: [] } }));
  writeFileSync(join(dir, 'index.json'), JSON.stringify({ listings: [{ id: 'one', url: 'one.json' }] }));
  return { dir, index: join(dir, 'index.json'), out: join(dir, 'out') };
}

test('compose keeps the check subprocess stderr, and the path and errno of a failed write', () => {
  const f = catalog();
  try {
    const preload = join(f.dir, 'spawn.mjs');
    writeFileSync(preload, `import childProcess from 'node:child_process'; childProcess.spawnSync = () => ({ status: 3, stdout: 'not json', stderr: 'starting\\nFailed: disk quota exceeded\\n' });\n`);
    const run = (out, env = {}) => spawnSync(process.execPath, [join(root, 'bin/cub-stack'), 'compose', '--entry', 'one', '--name', 'demo', '--out', out, '--catalog-index', f.index, '--json'], { cwd: root, encoding: 'utf8', env: { ...process.env, ...env } });
    const noJson = JSON.parse(run(f.out, { NODE_OPTIONS: `--import ${preload}` }).stdout);
    assert.equal(noJson.code, 'check_failed');
    assert.equal(noJson.message, 'stack check did not return JSON (exit 3): Failed: disk quota exceeded');
    assert.deepEqual(noJson.actions, ['inspect', 'repair']);
    const unwritable = JSON.parse(run('/dev/null/compose').stdout);
    assert.equal(unwritable.code, 'output_write_failed');
    assert.match(unwritable.message, /could not create output directory \/dev\/null\/compose: ENOTDIR/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

function fakeOras(dir, body) {
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'oras'), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, 'oras'), 0o755);
  return bin;
}

test('check --images keeps oras\'s last line when an image could not be checked', () => {
  const dir = tmp('keep-causes-images');
  try {
    const bin = fakeOras(dir, 'echo "Error: Get https://registry.example/v2/: dial tcp: network unreachable" >&2\nexit 1');
    const file = join(dir, 'app.yaml');
    writeFileSync(file, JSON.stringify({ apiVersion: 'v1', kind: 'Pod', metadata: { name: 'p', namespace: 'shop' }, spec: { containers: [{ name: 'c', image: 'registry.example/team/app:1.2.3' }] } }));
    const run = spawnSync(process.execPath, [join(root, 'bin/cub-config'), 'check', file, '--images'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
    assert.match(run.stdout, /could not be checked: registry\.example\/team\/app:1\.2\.3 \(Get https:\/\/registry\.example\/v2\/: dial tcp: network unreachable\)/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a pulled bundle that does not match its receipt names the first path that differs', () => {
  const dir = tmp('keep-causes-receipt');
  try {
    const wanted = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: wanted\n';
    writeFileSync(join(dir, 'other.yaml'), 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: other\n');
    const receipt = join(dir, 'receipt.json');
    writeFileSync(receipt, JSON.stringify({ spec: { bundle: { files: [{ path: 'config.yaml', sha256: sha(wanted) }] } } }));
    // The fake pull packs $FAKE_FILE, saved under the name config.yaml or not.
    const bin = fakeOras(dir, 'out=; prev=\nfor arg in "$@"; do [ "$prev" = "-o" ] && out="$arg"; prev="$arg"; done\nmkdir -p "$out"\ntar -cf "$out/bundle.tar" -C "$FAKE_DIR" "$FAKE_FILE"');
    const attempt = (file, digest) => {
      const component = { name: 'fixture', bundle: `oci://localhost:5001/fixture@sha256:${digest.repeat(64)}`, receipt };
      const code = `import { resolveBundle } from ${JSON.stringify(common)}; try { resolveBundle(${JSON.stringify(component)}); } catch (error) { console.log(error.message); }`;
      return spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: root, encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TMPDIR: dir, FAKE_DIR: dir, FAKE_FILE: file } }).stdout.trim();
    };
    assert.match(attempt('other.yaml', '1'), /pulled files do not match its receipt: config\.yaml is missing from the pulled bundle$/);
    writeFileSync(join(dir, 'config.yaml'), 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: changed\n');
    assert.match(attempt('config.yaml', '2'), new RegExp(`pulled files do not match its receipt: config\\.yaml has sha256 [0-9a-f]{12}, the receipt records ${sha(wanted).slice(0, 12)}$`));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a failure with no message still names its code or error type', () => {
  const dir = tmp('keep-causes-bins');
  try {
    const hooks = `export async function load(url, context, next) { if (/\\/lib\\/(fleet|app|stack|config)\\.mjs$/.test(url)) return { format: 'module', source: 'throw Object.assign(new Error(""), { code: "E_TEST" });', shortCircuit: true }; return next(url, context); }`;
    const preload = join(dir, 'preload.mjs');
    writeFileSync(preload, `import { register } from 'node:module'; register(${JSON.stringify(`data:text/javascript,${encodeURIComponent(hooks)}`)});\n`);
    for (const [bin, verb] of [['cub-config', 'check'], ['cub-app', 'check'], ['cub-stack', 'check'], ['cub-fleet', 'list']]) {
      const run = spawnSync(process.execPath, [join(root, 'bin', bin), verb], { cwd: root, encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: `--import ${preload}` } });
      assert.equal(run.stderr.trim(), 'Failed: unknown error (E_TEST)', bin);
      assert.notEqual(run.status, 0);
    }
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
