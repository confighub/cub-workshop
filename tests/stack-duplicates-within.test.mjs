import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));

// kubectl apply keeps the last copy of an object a component carries twice,
// but cub variant upload refuses the whole component. check says so, and
// upload refuses before it writes anything, not after the components before
// the bad one have landed.
test('an object defined twice inside one component is warned in check and refused before upload writes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'stack-dupes-'));
  try {
    const bin = join(dir, 'bin'); mkdirSync(bin);
    const log = join(dir, 'calls.log');
    writeFileSync(join(bin, 'cub'), `#!/bin/sh\necho "$@" >> "${log}"\n`, { mode: 0o755 });
    const map = 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: shared\n  namespace: demo\ndata:\n  a: "1"\n';
    writeFileSync(join(dir, 'first.yaml'), 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: first\n  namespace: demo\n');
    writeFileSync(join(dir, 'twice.yaml'), `${map}---\n${map}`);
    const manifest = join(dir, 'stack.yaml');
    writeFileSync(manifest, 'apiVersion: helm-expt.confighub.com/v1alpha1\nkind: Stack\nmetadata:\n  name: dupes\nspec:\n  components:\n    - name: first\n      authored: first.yaml\n    - name: twice\n      authored: twice.yaml\n');
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    const check = spawnSync(process.execPath, [join(root, 'bin', 'cub-stack'), 'check', manifest], { encoding: 'utf8', env });
    assert.equal(check.status, 0, check.stderr);
    assert.match(check.stdout, /\[WARN\] 1 object\(s\) carried more than once inside one component with identical content; kubectl apply keeps the last, but cub stack upload refuses the component:/);
    for (const extra of [[], ['--run']]) {
      const upload = spawnSync(process.execPath, [join(root, 'bin', 'cub-stack'), 'upload', manifest, ...extra], { encoding: 'utf8', env });
      assert.equal(upload.status, 1);
      assert.match(upload.stdout, /Upload refused: twice defines 1 object\(s\) more than once/);
      assert.match(upload.stdout, /v1\|ConfigMap\|demo\|shared  x2  inside  twice/);
      assert.match(upload.stdout, /Nothing was uploaded/);
    }
    assert.equal(existsSync(log), false, 'cub was never called');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
