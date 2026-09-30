import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));

// A fake cub that keeps Spaces, Units and Links between runs, and answers a
// missing entity the way hub.confighub.com does. An upload writes the Units
// named in TRIAL_UNITS for its component; link create and link update read the
// entity JSON from stdin and keep it, so a test can read what was sent.
const FAKE_CUB = `
const fs=require('node:fs'); const args=process.argv.slice(2);
const statePath=process.env.TRIAL_STATE; const state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):{spaces:{},links:{}};
const save=()=>fs.writeFileSync(statePath,JSON.stringify(state));
const stdin=args.includes('--from-stdin')?fs.readFileSync(0,'utf8'):null;
fs.appendFileSync(process.env.TRIAL_CALL_LOG,JSON.stringify({args,stdin})+'\\n');
const space=args.includes('--space')?args[args.indexOf('--space')+1]:null;
const notFound=(kind,slug)=>{ console.error('Failed: '+kind+' "'+slug+'" not found in space 0f3c'); process.exit(1); };
if(args[1]==='get' && process.env.TRIAL_AUTH===args[0]) { console.error('Failed: permission denied'); process.exit(1); }
if(args[0]==='unit' && args[1]==='get') { if((state.spaces[space]??[]).includes(args[2])) { console.log(args[2]); process.exit(0); } notFound('unit',args[2]); }
if(args[0]==='unit' && args[1]==='update') process.exit(0);
if(args[0]==='link' && args[1]==='get') { if(state.links[space+'/'+args[2]]) { console.log(args[2]); process.exit(0); } notFound('link',args[2]); }
if(args[0]==='variant' && args[1]==='upload') { const component=args[args.indexOf('--component')+1]; state.spaces[component+'-base']=JSON.parse(process.env.TRIAL_UNITS)[component]; save(); process.exit(0); }
if(args[0]==='link' && args[1]==='create') { const positional=args.slice(2).filter((arg,i,all)=>!arg.startsWith('--') && !['--space','--update-type'].includes(all[i-1])); state.links[space+'/'+positional[0]]={positional,body:JSON.parse(stdin)}; save(); process.exit(0); }
if(args[0]==='link' && args[1]==='update') { state.links[space+'/'+args[2]].body=JSON.parse(stdin); save(); process.exit(0); }
console.error('unexpected call'); process.exit(3);
`;

const UNITS = { profile: ['settings-platformprofile'], app: ['app-config-configmap', 'web'] };

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'stack-links-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'cub'), `#!${process.execPath}\n${FAKE_CUB}`, { mode: 0o755 });
  writeFileSync(join(dir, 'profile.yaml'), 'apiVersion: example.com/v1\nkind: PlatformProfile\nmetadata:\n  name: settings\nspec:\n  region: us-west-2\n');
  writeFileSync(join(dir, 'app.yaml'), [
    'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app-config\n  namespace: trial\ndata:\n  region: placeholder\n',
    'apiVersion: apps/v1\nkind: Deployment\nmetadata:\n  name: web\n  namespace: trial\nspec:\n  template:\n    spec:\n      containers:\n        - name: main\n          image: web\n          env:\n            - name: REGION\n              value: placeholder\n',
  ].join('---\n'));
  const pathBinding = (field, upstream) => ({ component: 'app', unit: 'app', field, resourceType: 'v1/ConfigMap', resourceName: 'trial/app-config', path: 'data.region', pathEscaped: 'data.region', upstream });
  const manifest = join(dir, 'stack.yaml');
  writeFileSync(manifest, JSON.stringify({ apiVersion: 'helm-expt.confighub.com/v1alpha1', kind: 'Stack', metadata: { name: 'trial' }, spec: {
    components: [{ name: 'profile', plane: 'hub', authored: 'profile.yaml' }, { name: 'app', plane: 'workload', authored: 'app.yaml' }],
    bindings: { pathBindings: [pathBinding('region', 'spec.region'), pathBinding('zone', 'spec.zone')], envBindings: [{ component: 'app', unit: 'web', field: 'region', container: 'main', envVar: 'REGION' }] },
  } }));
  let run = 0;
  const upload = (env = {}, extra = ['--run']) => {
    const log = join(dir, `calls-${run += 1}.jsonl`);
    const result = spawnSync(process.execPath, [join(root, 'bin/cub-stack'), 'upload', manifest, ...extra], { encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRIAL_CALL_LOG: log, TRIAL_STATE: join(dir, 'state.json'), TRIAL_UNITS: JSON.stringify(UNITS), ...env } });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
    return { result, calls };
  };
  return { upload, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const verb = (calls, noun, action) => calls.filter(({ args }) => args[0] === noun && args[1] === action);
const REGION = { Name: 'region', Path: 'spec.region', Resource: { ResourceType: 'example.com/v1/PlatformProfile', ResourceName: '/settings' } };

test('the dry run plans one link per downstream Unit, the resolve after it, and names the rest', () => {
  const trial = workspace();
  try {
    const { result, calls } = trial.upload({}, []);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls, []);
    assert.match(result.stdout, /\| cub link create --space app-base --update-type TransformPaths --auto-update --protect --from-stdin profile-app-config-configmap app-config-configmap settings-platformprofile profile-base\n/);
    assert.match(result.stdout, /\| cub link create --space app-base --update-type TransformPaths --auto-update --protect --from-stdin profile-web web settings-platformprofile profile-base\n/);
    assert.match(result.stdout, /cub unit update --space app-base --patch --resolve Link:\* web\n/);
    assert.match(result.stdout, /\{\{\.Params\.region\}\}/);
    assert.match(result.stdout, /Not linked \(1 binding\(s\)\):\n    app v1\/ConfigMap trial\/app-config data\.region <- zone: 0 objects in profile carry spec\.zone/);
  } finally { trial.cleanup(); }
});

test('--run links after the bases, resolves each Unit, and a rerun reconciles instead of duplicating', () => {
  const trial = workspace();
  try {
    const first = trial.upload();
    assert.equal(first.result.status, 0, first.result.stderr);
    const made = verb(first.calls, 'link', 'create');
    assert.equal(made.length, 2);
    const kinds = first.calls.map(({ args }) => args.slice(0, 2).join(' '));
    assert.ok(kinds.lastIndexOf('variant upload') < kinds.indexOf('link create'), 'links wait for every base');
    assert.ok(kinds.lastIndexOf('link create') < kinds.indexOf('unit update'), 'resolves follow the links');
    const bodies = Object.fromEntries(made.map(({ args, stdin }) => [args[args.indexOf('--from-stdin') + 1], JSON.parse(stdin)]));
    assert.deepEqual(bodies['profile-app-config-configmap'], { UpstreamPaths: [REGION], DownstreamPaths: [{ Path: 'data.region', Resource: { ResourceType: 'v1/ConfigMap', ResourceName: 'trial/app-config' }, Expression: '{{.Params.region}}', Evaluator: 'template', Parameters: ['region'], DataType: 'string' }] });
    assert.deepEqual(bodies['profile-web'], { UpstreamPaths: [REGION], DownstreamSetters: [{ Parameters: ['region'], FunctionInvocation: { FunctionName: 'set-env-var', WhereResource: "ConfigHub.ResourceType = 'apps/v1/Deployment'", Arguments: [{ Value: 'main' }, { Value: 'REGION' }, { Value: '{{.Params.region}}', Evaluator: 'template' }] } }] });
    assert.deepEqual(verb(first.calls, 'unit', 'update').map(({ args }) => args.at(-1)).sort(), ['app-config-configmap', 'web']);
    assert.match(first.result.stdout, /Links: 2 created, 0 reconciled, carrying 2 binding\(s\); each linked Unit resolved\./);

    const second = trial.upload();
    assert.equal(second.result.status, 0, second.result.stderr);
    assert.deepEqual(verb(second.calls, 'link', 'create'), []);
    assert.deepEqual(verb(second.calls, 'link', 'update').map(({ args }) => args.slice(2, 5)), [['profile-app-config-configmap', '--space', 'app-base'], ['profile-web', '--space', 'app-base']]);
    assert.match(second.result.stdout, /Links: 0 created, 2 reconciled/);
  } finally { trial.cleanup(); }
});

test('a Unit that is not where the binding expects leaves its bindings unlinked, not faked', () => {
  const trial = workspace();
  try {
    const { result, calls } = trial.upload({ TRIAL_UNITS: JSON.stringify({ ...UNITS, app: ['app-config', 'web'] }) });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(verb(calls, 'link', 'create').map(({ args }) => args[args.indexOf('--from-stdin') + 1]), ['profile-web']);
    assert.match(result.stdout, /app v1\/ConfigMap trial\/app-config data\.region <- region: app-base has no Unit app-config-configmap to link/);
    assert.match(result.stdout, /Not linked \(2 binding\(s\)\):/);
  } finally { trial.cleanup(); }
});

test('a permission error on the link lookup stops before any link is written', () => {
  const trial = workspace();
  try {
    const { result, calls } = trial.upload({ TRIAL_AUTH: 'link' });
    assert.equal(result.status, 1);
    assert.deepEqual(verb(calls, 'link', 'create'), []);
    assert.equal(calls.at(-1).args.slice(0, 2).join(' '), 'link get');
    assert.match(result.stderr, /could not tell whether link profile-app-config-configmap or its Units exist in app-base, so no more links were written/);
    assert.match(result.stderr, /permission denied/);
  } finally { trial.cleanup(); }
});
