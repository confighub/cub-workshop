import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));

// A fake cub that keeps Spaces, Units and Links between runs. An upload
// writes the Units named in TRIAL_UNITS for its component; link create reads
// the entity JSON from stdin and keeps it, so a test can read what was sent.
const FAKE_CUB = `
const fs=require('node:fs'); const args=process.argv.slice(2);
const statePath=process.env.TRIAL_STATE; const state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):{spaces:{},links:{}};
const save=()=>fs.writeFileSync(statePath,JSON.stringify(state));
const stdin=args.includes('--from-stdin')?fs.readFileSync(0,'utf8'):null;
fs.appendFileSync(process.env.TRIAL_CALL_LOG,JSON.stringify({args,stdin})+'\\n');
const space=args.includes('--space')?args[args.indexOf('--space')+1]:null;
const notFound=(kind,slug)=>{ console.error('Failed: '+kind+' '+slug+' not found'); process.exit(1); };
if(args[1]==='get' && process.env.TRIAL_AUTH===args[0]) { console.error('Failed: permission denied'); process.exit(1); }
if(args[0]==='space' && args[1]==='get') { if(state.spaces[args[2]]) { console.log(args[2]); process.exit(0); } notFound('space',args[2]); }
if(args[0]==='unit' && args[1]==='list') { console.log((state.spaces[space]??[]).join('\\n')); process.exit(0); }
if(args[0]==='unit' && args[1]==='get') { if((state.spaces[space]??[]).includes(args[2])) { console.log(args[2]); process.exit(0); } notFound('unit',args[2]); }
if(args[0]==='link' && args[1]==='get') { if(state.links[space+'/'+args[2]]) { console.log(args[2]); process.exit(0); } notFound('link',args[2]); }
if(args[0]==='variant' && args[1]==='upload') { const component=args[args.indexOf('--component')+1]; state.spaces[component+'-base']=JSON.parse(process.env.TRIAL_UNITS)[component]; save(); process.exit(0); }
if(args[0]==='link' && args[1]==='create') { const positional=args.slice(2).filter((arg,i,all)=>!arg.startsWith('--') && !['--space','--update-type'].includes(all[i-1])); state.links[space+'/'+positional[0]]={positional,body:JSON.parse(stdin)}; save(); process.exit(0); }
console.error('unexpected call'); process.exit(3);
`;

const UNITS = { profile: ['settings-platformprofile'], app: ['app-config-configmap'] };

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'stack-links-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'cub'), `#!${process.execPath}\n${FAKE_CUB}`, { mode: 0o755 });
  writeFileSync(join(dir, 'profile.yaml'), 'apiVersion: example.com/v1\nkind: PlatformProfile\nmetadata:\n  name: settings\nspec:\n  region: us-west-2\n');
  writeFileSync(join(dir, 'app.yaml'), 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: app-config\n  namespace: trial\ndata:\n  region: placeholder\n');
  const pathBinding = (field, upstream) => ({ component: 'app', unit: 'app', field, resourceType: 'v1/ConfigMap', resourceName: 'trial/app-config', path: 'data.region', pathEscaped: 'data.region', upstream });
  const manifest = join(dir, 'stack.yaml');
  writeFileSync(manifest, JSON.stringify({ apiVersion: 'helm-expt.confighub.com/v1alpha1', kind: 'Stack', metadata: { name: 'trial' }, spec: {
    components: [{ name: 'profile', plane: 'hub', authored: 'profile.yaml' }, { name: 'app', plane: 'workload', authored: 'app.yaml' }],
    bindings: { pathBindings: [pathBinding('region', 'spec.region'), pathBinding('zone', 'spec.zone')], envBindings: [{ component: 'app', unit: 'app', field: 'region', container: 'main', envVar: 'REGION' }] },
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

const creates = (calls) => calls.filter(({ args }) => args[0] === 'link' && args[1] === 'create');

test('the dry run plans one TransformPaths link per linkable binding and names the rest', () => {
  const trial = workspace();
  try {
    const { result, calls } = trial.upload({}, []);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls, []);
    assert.match(result.stdout, /\| cub link create --space app-base --update-type TransformPaths --from-stdin bind-region-[0-9a-f]{10} app-config-configmap settings-platformprofile profile-base\n/);
    assert.equal(result.stdout.match(/cub link create/g).length, 1);
    assert.match(result.stdout, /Not linked \(2 binding\(s\)\):/);
    assert.match(result.stdout, /app v1\/ConfigMap trial\/app-config data\.region <- zone: 0 objects in profile carry spec\.zone/);
    assert.match(result.stdout, /app\/app main env REGION <- region: an env binding names no resource and no profile path/);
    assert.doesNotMatch(result.stdout, /as links/);
  } finally { trial.cleanup(); }
});

test('--run links the binding after the bases, and a rerun leaves the link as is', () => {
  const trial = workspace();
  try {
    const first = trial.upload();
    assert.equal(first.result.status, 0, first.result.stderr);
    const made = creates(first.calls);
    assert.equal(made.length, 1);
    const kinds = first.calls.map(({ args }) => args.slice(0, 2).join(' '));
    assert.ok(kinds.lastIndexOf('variant upload') < kinds.indexOf('link create'), 'links wait for every base');
    const body = JSON.parse(made[0].stdin);
    assert.deepEqual(body.UpstreamPaths, [{ Name: 'region', Path: 'spec.region', Resource: { ResourceType: 'example.com/v1/PlatformProfile', ResourceName: '/settings' } }]);
    assert.deepEqual(body.DownstreamPaths, [{ Path: 'data.region', Resource: { ResourceType: 'v1/ConfigMap', ResourceName: 'trial/app-config' }, Evaluator: 'template', Expression: '{{ .region }}', Parameters: ['region'], DataType: 'string' }]);
    assert.match(first.result.stdout, /Links: 1 created, 0 already in place, for 1 path binding\(s\)\./);
    assert.match(first.result.stdout, /Not linked \(2 binding\(s\)\):/);

    const second = trial.upload();
    assert.equal(second.result.status, 0, second.result.stderr);
    assert.deepEqual(creates(second.calls), []);
    assert.match(second.result.stdout, /link bind-region-[0-9a-f]{10}\.\.\. exists, left as is/);
    assert.match(second.result.stdout, /Links: 0 created, 1 already in place/);
  } finally { trial.cleanup(); }
});

test('a Unit that is not where the binding expects leaves that binding unlinked, not faked', () => {
  const trial = workspace();
  try {
    const { result, calls } = trial.upload({ TRIAL_UNITS: JSON.stringify({ ...UNITS, app: ['app-config'] }) });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(creates(calls), []);
    assert.match(result.stdout, /app v1\/ConfigMap trial\/app-config data\.region <- region: app-base has no Unit app-config-configmap to link/);
    assert.match(result.stdout, /Not linked \(3 binding\(s\)\):/);
  } finally { trial.cleanup(); }
});

test('a permission error on the link lookup stops before any link is created', () => {
  const trial = workspace();
  try {
    const { result, calls } = trial.upload({ TRIAL_AUTH: 'link' });
    assert.equal(result.status, 1);
    assert.deepEqual(creates(calls), []);
    assert.equal(calls.at(-1).args.slice(0, 2).join(' '), 'link get');
    assert.match(result.stderr, /could not tell whether link bind-region-[0-9a-f]{10} or its Units exist in app-base, so no more links were created/);
    assert.match(result.stderr, /permission denied/);
  } finally { trial.cleanup(); }
});
