import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDocs, readYamlFile } from '../lib/common.mjs';
import { goldenPlatform, goldenRender, installFakeCub, root } from './kubara-fake-cub.mjs';

// from-kubara renders nothing itself: `cub kubara render` does, and a fake cub
// stands in for it here, writing the golden render kubara-confighub publishes
// (tests/fixtures/kubara-render) for the work directory it was rendered from
// (tests/fixtures/kubara-platform). A hub and a spoke both run web, whose chart
// ships the CRD bootstrap-crds also holds, and a Secret the render empties.
const stackBin = join(root, 'bin', 'cub-stack');
const expected = join(root, 'tests', 'fixtures', 'kubara-render-stack');

function scratch() {
  const dir = mkdtempSync(join(tmpdir(), 'kubara-from-'));
  cpSync(goldenPlatform, join(dir, 'platform'), { recursive: true });
  const bin = installFakeCub(join(dir, 'bin'));
  const log = join(dir, 'calls.jsonl');
  const run = (args, env = {}) => spawnSync(process.execPath, [stackBin, ...args], { encoding: 'utf8', timeout: 60000, env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_CUB_LOG: log, ...env } });
  const calls = () => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  return { dir, platform: join(dir, 'platform'), out: join(dir, 'out'), run, calls, fromKubara: (...args) => run(['from-kubara', join(dir, 'platform'), '--out', join(dir, 'out'), ...args]) };
}

const files = (dir) => readdirSync(dir, { recursive: true }).filter((entry) => !entry.startsWith('kubara-render')).map(String).sort();

// Parity: the stack from the golden render equals, byte for byte, the stack the
// JavaScript renderer this replaces wrote for the same platform (cub-workshop
// 95b6242), with the one difference the render makes on purpose: a Secret keeps
// its keys and loses its values.
test('the stack built from the golden render is the stack the JavaScript renderer wrote', () => {
  const f = scratch();
  try {
    const result = f.fromKubara();
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(files(f.out).filter((entry) => entry.endsWith('.yaml')), files(expected).filter((entry) => entry.endsWith('.yaml')));
    for (const file of files(expected).filter((entry) => entry.startsWith('renders/') && entry.endsWith('.yaml'))) {
      assert.equal(readFileSync(join(f.out, file), 'utf8'), readFileSync(join(expected, file), 'utf8'), file);
    }
    const manifest = readYamlFile(join(f.out, 'stack.yaml'));
    assert.equal(manifest.spec.source.kubara, f.platform);
    manifest.spec.source.kubara = '<work-dir>';
    assert.deepEqual(manifest, readYamlFile(join(expected, 'stack.yaml')));
    assert.deepEqual(f.calls(), [['kubara', 'version'], ['kubara', 'render', f.platform, '--out', join(f.out, 'kubara-render'), '--json']], 'no --keep-secret-values');
    assert.equal(JSON.parse(readFileSync(join(f.out, 'kubara-render', 'render.json'), 'utf8')).kind, 'KubaraRender', 'the render stays beside the stack');
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('each shared object stays with its owner only, and each cluster checks', () => {
  const f = scratch();
  try {
    const result = f.fromKubara();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /dropped 1 copy\(ies\) of object\(s\) another service owns \(bootstrap-crds keeps them\)/);
    for (const cluster of ['hub', 'spoke']) {
      const web = parseDocs(readFileSync(join(f.out, 'renders', cluster, 'web.yaml'), 'utf8'));
      assert.equal(web.some((doc) => doc.kind === 'CustomResourceDefinition'), false, `${cluster}: web leaves the CRD to bootstrap-crds`);
      assert.ok(web.some((doc) => doc.kind === 'Widget'), `${cluster}: web keeps its custom resource`);
      const crds = parseDocs(readFileSync(join(f.out, 'renders', cluster, 'bootstrap-crds.yaml'), 'utf8'));
      assert.deepEqual(crds.map((doc) => `${doc.kind}/${doc.metadata.name}`), ['CustomResourceDefinition/widgets.example.com']);
      const check = spawnSync(process.execPath, [stackBin, 'check', join(f.out, 'stack.yaml'), '--cluster', cluster, '--json'], { encoding: 'utf8' });
      assert.equal(check.status, 0, check.stderr);
      assert.equal(JSON.parse(check.stdout).checked, true);
    }
    const whole = spawnSync(process.execPath, [stackBin, 'check', join(f.out, 'stack.yaml')], { encoding: 'utf8' });
    assert.equal(whole.status, 0, whole.stdout);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

// Secret values stay out of the stack: a stack is published and uploaded, and a
// chart can make up a credential when it renders.
test('a Secret reaches the stack with its keys and without its values', () => {
  const f = scratch();
  try {
    const result = f.fromKubara();
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /These Secrets carry their keys and not their values[^\n]*\n\s+hub\/web: Secret webapp\/webapp-admin \(1 value\)/);
    const secret = parseDocs(readFileSync(join(f.out, 'renders', 'hub', 'web.yaml'), 'utf8')).find((doc) => doc.kind === 'Secret');
    assert.deepEqual(secret.stringData, { password: '' });
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('an object two services render with no owner stays in both, and check names the conflict', () => {
  const f = scratch();
  try {
    const golden = join(f.dir, 'golden');
    cpSync(goldenRender, golden, { recursive: true });
    const render = JSON.parse(readFileSync(join(golden, 'render.json'), 'utf8'));
    for (const cluster of render.clusters) for (const entry of cluster.shared) entry.owner = '';
    writeFileSync(join(golden, 'render.json'), JSON.stringify(render));
    const rendered = f.run(['from-kubara', f.platform, '--out', f.out, '--cluster', 'hub'], { FAKE_KUBARA_RENDER: golden });
    assert.equal(rendered.status, 0, rendered.stderr);
    assert.match(rendered.stdout, /1 object\(s\) rendered by more than one service with no owner/);
    const check = spawnSync(process.execPath, [stackBin, 'check', join(f.out, 'stack.yaml')], { encoding: 'utf8' });
    assert.equal(check.status, 1);
    assert.match(check.stdout, /CustomResourceDefinition\|\|widgets\.example\.com {2}<= {2}bootstrap-crds \+ web/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('the whole platform is one stack: a component per service, a variant per cluster that runs it', () => {
  const f = scratch();
  try {
    assert.equal(f.fromKubara().status, 0);
    const manifest = readYamlFile(join(f.out, 'stack.yaml'));
    assert.equal(manifest.metadata.name, 'kubara-platform');
    const byName = Object.fromEntries(manifest.spec.components.map((comp) => [comp.name, comp]));
    assert.deepEqual(Object.keys(byName), ['bootstrap-crds', 'web', 'argo-cd']);
    assert.equal(byName.web.render, 'renders/hub/web.yaml', "the base is the hub's render");
    assert.deepEqual(byName.web.variants, [{ cluster: 'hub', stage: 'dev', render: 'renders/hub/web.yaml' }, { cluster: 'spoke', stage: 'prod', render: 'renders/spoke/web.yaml' }]);
    assert.deepEqual(byName['argo-cd'].variants.map((variant) => variant.cluster), ['hub'], 'only a hub runs Argo CD');
    const spoke = JSON.parse(spawnSync(process.execPath, [stackBin, 'check', join(f.out, 'stack.yaml'), '--cluster', 'spoke', '--json'], { encoding: 'utf8' }).stdout);
    assert.deepEqual(spoke.components.map((comp) => [comp.name, comp.source]), [['bootstrap-crds', 'renders/spoke/bootstrap-crds.yaml'], ['web', 'renders/spoke/web.yaml']]);
    const spokeWeb = parseDocs(readFileSync(join(f.out, 'renders', 'spoke', 'web.yaml'), 'utf8')).find((doc) => doc.metadata.name === 'webapp-settings');
    assert.deepEqual([spokeWeb.data.replicas, spokeWeb.data.level], ['5', 'spoke'], "the spoke's own values");
    const unknown = spawnSync(process.execPath, [stackBin, 'check', join(f.out, 'stack.yaml'), '--cluster', 'edge'], { encoding: 'utf8' });
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /no variant for cluster edge; its clusters are hub, spoke/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('--cluster narrows the render and the stack to one cluster', () => {
  const f = scratch();
  try {
    const result = f.fromKubara('--cluster', 'spoke');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(f.calls()[1], ['kubara', 'render', f.platform, '--out', join(f.out, 'kubara-render'), '--cluster', 'spoke', '--json']);
    const one = readYamlFile(join(f.out, 'stack.yaml'));
    assert.equal(one.metadata.name, 'kubara-platform-spoke');
    assert.deepEqual(one.spec.source.clusters, ['spoke']);
    assert.deepEqual(one.spec.components.map((comp) => [comp.name, comp.variants.map((variant) => variant.cluster)]), [['bootstrap-crds', ['spoke']], ['web', ['spoke']]]);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('without cub kubara v0.2.3, or with a platform it cannot read, from-kubara says what to do and writes no stack', () => {
  const install = /cub plugin install confighub\/kubara-confighub/;
  const cases = [
    ['cub kubara is not installed', { FAKE_KUBARA_VERSION: 'missing' }, {}, /cub kubara is not installed; from-kubara needs cub kubara v0\.2\.3 or later/, install],
    ['cub kubara 0.2.2', { FAKE_KUBARA_VERSION: '0.2.2' }, {}, /cub kubara 0\.2\.2 is installed; from-kubara needs cub kubara v0\.2\.3 or later/, install],
    ['a build without render', { FAKE_KUBARA_VERSION: 'no-render' }, {}, /the installed cub kubara has no render command/, install],
    ['render fails', { FAKE_KUBARA_RENDER_ERROR: 'Error: helm template failed for web on cluster hub: boom' }, {}, /cub kubara render .* failed:\n\s+Error: helm template failed for web on cluster hub: boom/, null],
    ['no config.yaml', {}, { edit: (p) => rmSync(join(p, 'config.yaml')) }, /has no config\.yaml/, null],
    ['an unknown cluster', {}, { args: ['--cluster', 'edge'] }, /config\.yaml has no cluster edge; it names hub, spoke/, null],
    ['not generated', {}, { edit: (p) => rmSync(join(p, 'platform-components'), { recursive: true }) }, /has no platform-components\/helm; run kubara \.\.\. generate --helm first/, null],
  ];
  for (const [label, env, { edit, args = [] }, pattern, also] of cases) {
    const f = scratch();
    try {
      if (edit) edit(f.platform);
      const result = f.run(['from-kubara', f.platform, '--out', f.out, ...args], env);
      assert.equal(result.status, 2, `${label}: ${result.stdout}${result.stderr}`);
      assert.match(result.stderr, pattern, label);
      if (also) assert.match(result.stderr, also, label);
      assert.equal(existsSync(join(f.out, 'stack.yaml')), false, label);
    } finally { rmSync(f.dir, { recursive: true, force: true }); }
  }
});

test('a render whose file does not match its digest is refused', () => {
  const f = scratch();
  try {
    const golden = join(f.dir, 'golden');
    cpSync(goldenRender, golden, { recursive: true });
    writeFileSync(join(golden, 'hub', 'web', 'objects.yaml'), readFileSync(join(golden, 'hub', 'web', 'objects.yaml'), 'utf8').replace('replicas: "2"', 'replicas: "9"'));
    const result = f.run(['from-kubara', f.platform, '--out', f.out], { FAKE_KUBARA_RENDER: golden });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /hub\/web\/objects\.yaml does not match the digest render\.json records for it/);
    assert.equal(existsSync(join(f.out, 'stack.yaml')), false);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});

test('upload makes one base per service and clones each cluster variant from it', () => {
  const f = scratch();
  try {
    assert.equal(f.fromKubara().status, 0);
    const before = f.calls().length;
    const result = f.run(['upload', join(f.out, 'stack.yaml'), '--run']);
    assert.equal(result.status, 0, result.stderr);
    const calls = f.calls().slice(before).filter((call) => call[1] !== 'get').map((call) => call.map((arg) => arg.startsWith(f.out) ? arg.slice(f.out.length + 1) : arg));
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

// A live hub renders a new Space's slug before it carries a Component label, so
// a prefixed variant is named from .Component.Slug; .Labels.Component is a 400.
test('a prefixed upload names each variant Space by the Component slug', () => {
  const f = scratch();
  try {
    assert.equal(f.fromKubara().status, 0);
    const plan = f.run(['upload', join(f.out, 'stack.yaml'), '--space-prefix', 'lab']).stdout;
    assert.match(plan, /variant create spoke lab-web --stage prod --space-pattern template:\{\{\.Component\.Slug\}\}-\{\{\.Labels\.Variant\}\}/);
    assert.match(plan, /variant upload --component lab-web --variant spoke /);
    assert.doesNotMatch(plan, /Labels\.Component\}\}-/);
  } finally { rmSync(f.dir, { recursive: true, force: true }); }
});
