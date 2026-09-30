import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const configMap = (name, value) => `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${name}\n  namespace: default\ndata:\n  value: "${value}"\n`;

// Two components whose bases compose cleanly. On the spoke, each variant also
// carries the same ConfigMap, so the spoke's composition conflicts where the
// bases, and the hub, do not.
function platform({ spokeConflicts }) {
  const dir = mkdtempSync(join(tmpdir(), 'publish-clusters-'));
  mkdirSync(join(dir, 'renders'));
  writeFileSync(join(dir, 'renders', 'a-hub.yaml'), configMap('a', 'hub'));
  writeFileSync(join(dir, 'renders', 'b-hub.yaml'), configMap('b', 'hub'));
  writeFileSync(join(dir, 'renders', 'a-spoke.yaml'), configMap('a', 'spoke') + (spokeConflicts ? `---\n${configMap('shared', 'from-a')}` : ''));
  writeFileSync(join(dir, 'renders', 'b-spoke.yaml'), configMap('b', 'spoke') + (spokeConflicts ? `---\n${configMap('shared', 'from-b')}` : ''));
  const component = (name) => `  - name: ${name}\n    render: renders/${name}-hub.yaml\n    variants:\n      - {cluster: hub, render: renders/${name}-hub.yaml}\n      - {cluster: spoke, render: renders/${name}-spoke.yaml}\n`;
  writeFileSync(join(dir, 'stack.yaml'), `apiVersion: helm-expt.confighub.com/v1alpha1\nkind: Stack\nmetadata:\n  name: two-clusters\nspec:\n  description: two components on a hub and a spoke\n  components:\n${component('a')}${component('b')}`);
  return dir;
}

// The registry is never reached: nothing listens on port 9, and a refused
// publish stops before it would push.
const publish = (dir) => spawnSync(process.execPath, [join(root, 'bin', 'cub-stack'), 'publish', join(dir, 'stack.yaml'), '--out', 'oci://127.0.0.1:9/two-clusters:t'], { encoding: 'utf8', timeout: 60000, env: { ...process.env, TMPDIR: dir } });

test('publish refuses a platform whose bases check but one cluster does not, before it pushes anything', () => {
  const dir = platform({ spokeConflicts: true });
  try {
    const result = publish(dir);
    assert.equal(result.status, 1, result.stdout + result.stderr);
    assert.match(result.stdout, /=> CHECKED/, 'the bases check');
    assert.match(result.stdout, /\[PASS\] cluster hub: CHECKED, 2 objects/);
    assert.match(result.stdout, /\[FAIL\] cluster spoke: REFUSED, 4 objects, 1 WARN\n\s+\[FAIL\] 1 resource conflict\(s\)[^\n]*\n\s+v1\|ConfigMap\|default\|shared {2}<= {2}a \+ b/);
    assert.match(result.stdout, /Publish refused: the composition of cluster spoke did not check out\. cub stack check \S+ --cluster spoke shows it in full\./);
    assert.doesNotMatch(result.stdout, /Publishing components/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('publish checks every cluster and goes on to publish when each one checks', () => {
  const dir = platform({ spokeConflicts: false });
  try {
    const result = publish(dir);
    assert.match(result.stdout, /Check, each cluster as its variants compose\n\s+\[PASS\] cluster hub: CHECKED, 2 objects, 1 WARN\n\s+\[PASS\] cluster spoke: CHECKED, 2 objects, 1 WARN/);
    assert.match(result.stdout, /Publishing components into the index repository/, 'the gate passed; the push itself fails, since no registry listens');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
