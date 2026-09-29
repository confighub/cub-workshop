import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
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
// the leftover argo-cd values of a renamed hub. A spoke runs web with its own
// values and no Argo CD.
test('each service renders the way Kubara delivers it', { skip: !hasHelm && 'helm is not installed' }, () => {
  const f = copy();
  try {
    const result = fromKubara(f.platform, '--out', f.out);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readdirSync(join(f.out, 'renders', 'hub')).sort(), ['argo-cd.yaml', 'bootstrap-crds.yaml', 'web.yaml']);
    const web = parseDocs(readFileSync(join(f.out, 'renders', 'hub', 'web.yaml'), 'utf8'));
    const settings = web.find((doc) => doc.kind === 'ConfigMap');
    assert.equal(settings.metadata.name, 'webapp-settings', "the ApplicationSet's release name, not the chart directory");
    assert.equal(settings.metadata.namespace, 'webapp', 'the namespace defaults to the service name');
    assert.equal(settings.data.replicas, '2', 'values.generated.yaml over the chart values');
    assert.equal(settings.data.level, 'last', 'values-*.yaml applies after additional-values.yaml');
    assert.ok(web.some((doc) => doc.kind === 'Widget'), 'the API bootstrap-crds provides is declared to the chart');
    const crds = parseDocs(readFileSync(join(f.out, 'renders', 'hub', 'bootstrap-crds.yaml'), 'utf8'));
    assert.deepEqual(crds.map((doc) => `${doc.kind}/${doc.metadata.name}`), ['CustomResourceDefinition/widgets.example.com']);
    assert.equal(parseDocs(readFileSync(join(f.out, 'renders', 'hub', 'argo-cd.yaml'), 'utf8'))[0].metadata.name, 'argocd-cm');
    assert.doesNotMatch(readFileSync(join(f.out, 'renders', 'hub', 'web.yaml'), 'utf8'), /stale/);
    const check = spawnSync(process.execPath, [join(root, 'bin', 'cub-stack'), 'check', join(f.out, 'stack.yaml'), '--cluster', 'hub', '--json'], { encoding: 'utf8' });
    assert.equal(check.status, 0, check.stderr);
    assert.equal(JSON.parse(check.stdout).checked, true);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('a platform the ApplicationSets or config.yaml do not describe is refused with the reason', { skip: !hasHelm && 'helm is not installed' }, () => {
  const cases = [
    ['no config.yaml', (p) => rmSync(join(p, 'config.yaml')), /has no config\.yaml/],
    ['an unknown cluster', null, /config\.yaml has no cluster edge; it names hub, spoke/, ['--cluster', 'edge']],
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

test('the whole platform is one stack: a component per service, a variant per cluster that runs it', { skip: !hasHelm && 'helm is not installed' }, () => {
  const f = copy();
  try {
    const result = fromKubara(f.platform, '--out', f.out);
    assert.equal(result.status, 0, result.stderr);
    const manifest = readYamlFile(join(f.out, 'stack.yaml'));
    assert.equal(manifest.metadata.name, 'kubara-platform');
    assert.deepEqual(manifest.spec.source.clusters, ['hub', 'spoke']);
    const byName = Object.fromEntries(manifest.spec.components.map((comp) => [comp.name, comp]));
    assert.deepEqual(Object.keys(byName), ['bootstrap-crds', 'web', 'argo-cd']);
    assert.equal(byName.web.render, 'renders/hub/web.yaml', "the base is the hub's render");
    assert.deepEqual(byName.web.variants, [{ cluster: 'hub', stage: 'dev', render: 'renders/hub/web.yaml' }, { cluster: 'spoke', stage: 'prod', render: 'renders/spoke/web.yaml' }]);
    assert.deepEqual(byName['argo-cd'].variants.map((variant) => variant.cluster), ['hub'], 'only a hub runs Argo CD');
    assert.equal(existsSync(join(f.out, 'renders', 'spoke', 'unused.yaml')), false, 'a disabled service does not render');
    const spokeWeb = parseDocs(readFileSync(join(f.out, 'renders', 'spoke', 'web.yaml'), 'utf8')).find((doc) => doc.kind === 'ConfigMap');
    assert.deepEqual([spokeWeb.data.replicas, spokeWeb.data.level], ['5', 'spoke'], "the spoke's own values");
    const stackBin = join(root, 'bin', 'cub-stack');
    const spoke = JSON.parse(spawnSync(process.execPath, [stackBin, 'check', join(f.out, 'stack.yaml'), '--cluster', 'spoke', '--json'], { encoding: 'utf8' }).stdout);
    assert.deepEqual(spoke.components.map((comp) => [comp.name, comp.source]), [['bootstrap-crds', 'renders/spoke/bootstrap-crds.yaml'], ['web', 'renders/spoke/web.yaml']]);
    const unknown = spawnSync(process.execPath, [stackBin, 'check', join(f.out, 'stack.yaml'), '--cluster', 'edge'], { encoding: 'utf8' });
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /no variant for cluster edge; its clusters are hub, spoke/);
    const narrowed = copy();
    try {
      assert.equal(fromKubara(narrowed.platform, '--out', narrowed.out, '--cluster', 'spoke').status, 0);
      const one = readYamlFile(join(narrowed.out, 'stack.yaml'));
      assert.equal(one.metadata.name, 'kubara-platform-spoke');
      assert.deepEqual(one.spec.components.map((comp) => [comp.name, comp.variants.map((variant) => variant.cluster)]), [['bootstrap-crds', ['spoke']], ['web', ['spoke']]]);
    } finally { rmSync(narrowed.dir, { recursive: true, force: true }); }
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('upload makes one base per service and clones each cluster variant from it', { skip: !hasHelm && 'helm is not installed' }, () => {
  const f = copy();
  try {
    assert.equal(fromKubara(f.platform, '--out', f.out).status, 0);
    const bin = join(f.dir, 'bin'); mkdirSync(bin);
    const log = join(f.dir, 'calls.jsonl');
    // A fresh organization: every Space lookup answers not found.
    writeFileSync(join(bin, 'cub'), `#!${process.execPath}\nconst args = process.argv.slice(2); require('node:fs').appendFileSync(process.env.CALL_LOG, JSON.stringify(args) + '\\n');\nif (args[1] === 'get') { console.error('Failed: ' + args[0] + ' ' + args[2] + ' not found'); process.exit(1); }\n`);
    chmodSync(join(bin, 'cub'), 0o755);
    const result = spawnSync(process.execPath, [join(root, 'bin', 'cub-stack'), 'upload', join(f.out, 'stack.yaml'), '--run'], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALL_LOG: log } });
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse).filter((call) => call[1] !== 'get').map((call) => call.map((arg) => arg.startsWith(f.out) ? arg.slice(f.out.length + 1) : arg));
    const web = calls.filter((call) => call.includes('web') || call.includes('web-base'));
    assert.deepEqual(web, [
      ['variant', 'upload', '--component', 'web', '--variant', 'base', '--owner', 'kubara-platform', 'renders/hub/web.yaml'],
      ['variant', 'create', 'hub', 'web-base', '--stage', 'dev'],
      ['variant', 'upload', '--component', 'web', '--variant', 'hub', '--owner', 'kubara-platform', '--stage', 'dev', 'renders/hub/web.yaml'],
      ['variant', 'create', 'spoke', 'web-base', '--stage', 'prod'],
      ['variant', 'upload', '--component', 'web', '--variant', 'spoke', '--owner', 'kubara-platform', '--stage', 'prod', 'renders/spoke/web.yaml'],
    ]);
    assert.equal(calls.filter((call) => call[1] === 'create' && call[3] === 'argo-cd-base').length, 1, 'Argo CD has a hub variant only');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
