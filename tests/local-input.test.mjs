import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
const run = (noun, ...args) => spawnSync(process.execPath, [join(root, `bin/cub-${noun}`), ...args], { encoding:'utf8' });
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
test('missing, empty and partially invalid inputs fail before writing an output', () => {
  const dir = mkdtempSync(join(tmpdir(), 'local-invalid-'));
  try {
    const path = join(dir, 'input.yaml');
    for (const content of ['', 'hello', 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: good\n---\nnot-a-resource\n']) {
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
