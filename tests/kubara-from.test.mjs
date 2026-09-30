import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocs, readYamlFile } from '../lib/common.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const fixture = join(root, 'tests', 'fixtures', 'kubara-platform');
const hasHelm = spawnSync('helm', ['version', '--short'], { encoding: 'utf8' }).status === 0;
const fromKubara = (dir, ...args) => spawnSync(process.execPath, [join(root, 'bin', 'cub-stack'), 'from-kubara', dir, ...args], { encoding: 'utf8', timeout: 60000 });

function copy() {
  const dir = mkdtempSync(join(tmpdir(), 'kubara-from-'));
  cpSync(fixture, join(dir, 'platform'), { recursive: true });
  return { dir, platform: join(dir, 'platform'), out: join(dir, 'out') };
}

// The fixture is a platform shaped like Kubara's output: a hub whose argo-cd
// values name the services its ApplicationSets deliver, a service whose release
// name differs from its chart directory, a bootstrap-crds chart holding a CRD
// and an object kubara bootstrap does not apply, a chart no cluster enables, and
// the leftover argo-cd values of a renamed hub.
test('each service renders the way Kubara delivers it', { skip: !hasHelm && 'helm is not installed' }, () => {
  const f = copy();
  try {
    const result = fromKubara(f.platform, '--out', f.out);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(join(f.out, 'renders')).sort(), ['argo-cd.yaml', 'bootstrap-crds.yaml', 'web.yaml']);
    const web = parseDocs(readFileSync(join(f.out, 'renders', 'web.yaml'), 'utf8'));
    const settings = web.find((doc) => doc.kind === 'ConfigMap');
    assert.equal(settings.metadata.name, 'webapp-settings', "the ApplicationSet's release name, not the chart directory");
    assert.equal(settings.metadata.namespace, 'webapp', 'the namespace defaults to the service name');
    assert.equal(settings.data.replicas, '2', 'values.generated.yaml over the chart values');
    assert.equal(settings.data.level, 'last', 'values-*.yaml applies after additional-values.yaml');
    assert.ok(web.some((doc) => doc.kind === 'Widget'), 'the API bootstrap-crds provides is declared to the chart');
    const crds = parseDocs(readFileSync(join(f.out, 'renders', 'bootstrap-crds.yaml'), 'utf8'));
    assert.deepEqual(crds.map((doc) => `${doc.kind}/${doc.metadata.name}`), ['CustomResourceDefinition/widgets.example.com']);
    assert.equal(parseDocs(readFileSync(join(f.out, 'renders', 'argo-cd.yaml'), 'utf8'))[0].metadata.name, 'argocd-cm');
    assert.doesNotMatch(readFileSync(join(f.out, 'renders', 'web.yaml'), 'utf8'), /stale/);
    const manifest = readYamlFile(join(f.out, 'stack.yaml'));
    assert.deepEqual(manifest.spec.components.map((comp) => comp.render), ['renders/bootstrap-crds.yaml', 'renders/web.yaml', 'renders/argo-cd.yaml']);
    const check = spawnSync(process.execPath, [join(root, 'bin', 'cub-stack'), 'check', join(f.out, 'stack.yaml'), '--json'], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    assert.equal(JSON.parse(check.stdout).checked, true);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('a platform the ApplicationSets or config.yaml do not describe is refused with the reason', { skip: !hasHelm && 'helm is not installed' }, () => {
  const cases = [
    ['no config.yaml', (p) => rmSync(join(p, 'config.yaml')), /has no config\.yaml/],
    ['an unknown cluster', null, /config\.yaml has no cluster spoke; it names hub/, ['--cluster', 'spoke']],
    ['an enabled service no ApplicationSet delivers', (p) => writeFileSync(join(p, 'config.yaml'), readFileSync(join(p, 'config.yaml'), 'utf8').replace('{web: {status: enabled}}', '{web: {status: enabled}, unused: {status: enabled}}')), /ApplicationSets name no service for unused/],
    ['a service with its own sources', (p) => writeFileSync(join(p, 'platform-configs', 'hub', 'helm', 'argo-cd', 'values.generated.yaml'), readFileSync(join(p, 'platform-configs', 'hub', 'helm', 'argo-cd', 'values.generated.yaml'), 'utf8').replace('web: {name: webapp, path: web}', 'web: {name: webapp, path: web, sources: [{repoURL: x}]}')), /service webapp sets its own sources/],
  ];
  for (const [label, edit, pattern, extra = []] of cases) {
    const f = copy();
    try {
      if (edit) edit(f.platform);
      const result = fromKubara(f.platform, '--out', f.out, ...extra);
      assert.notEqual(result.status, 0, label);
      assert.match(result.stderr, pattern, label);
      assert.equal(existsSync(join(f.out, 'stack.yaml')), false, label);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});
