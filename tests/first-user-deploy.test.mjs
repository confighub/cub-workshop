import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = fileURLToPath(new URL('../', import.meta.url));

const FAKE_CUB = `
const fs=require('node:fs'); const args=process.argv.slice(2);
fs.appendFileSync(process.env.TRIAL_LOG,JSON.stringify(args)+'\\n');
const statePath=process.env.TRIAL_STATE; const state=fs.existsSync(statePath)?JSON.parse(fs.readFileSync(statePath,'utf8')):{spaces:[]};
const save=()=>fs.writeFileSync(statePath,JSON.stringify(state));
if(args[0]==='variant' && args[1]==='upload') process.exit(0);
if(args[0]==='space' && args[1]==='get') {
  if(state.spaces.includes(args[2])) { console.log(args[2]); process.exit(0); }
  console.error('Failed: space "'+args[2]+'" not found in any space'); process.exit(1);
}
if(args[0]==='variant' && args[1]==='create') {
  const pattern=args.includes('--space-pattern');
  const component=args[3]; const variant=args[2]; const slug=component+'-'+variant;
  if(!pattern) { console.error('expected an explicit deployment space pattern'); process.exit(3); }
  state.spaces.push(slug); save(); process.exit(0);
}
if(args[0]==='variant' && args[1]==='promote') process.exit(0);
if(args[0]==='release' && args[1]==='publish') process.exit(0);
console.error('unexpected cub call: '+args.join(' ')); process.exit(3);
`;

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'first-user-deploy-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'cub'), `#!${process.execPath}\n${FAKE_CUB}`, { mode: 0o755 });
  let runNumber = 0;
  const run = (noun, ...args) => {
    const log = join(dir, `calls-${runNumber += 1}.jsonl`);
    const result = spawnSync(process.execPath, [join(root, 'bin', `cub-${noun}`), ...args], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, TRIAL_LOG: log, TRIAL_STATE: join(dir, 'state.json') },
    });
    const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse) : [];
    return { result, calls };
  };
  return { run, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('app upload imports one base through the current variant upload contract', () => {
  const trial = fixture();
  try {
    const dry = trial.run('app', 'upload', 'hello-standalone');
    assert.equal(dry.result.status, 0, dry.result.stderr);
    assert.deepEqual(dry.calls, []);
    assert.match(dry.result.stdout, /variant upload --component hello-standalone --variant base/);
    assert.match(dry.result.stdout, /create hello-standalone-base\. Nothing is deployed/);
    assert.doesNotMatch(dry.result.stdout, /hello-standalone-app|unit create|require-approval/);

    const live = trial.run('app', 'upload', 'hello-standalone', '--run');
    assert.equal(live.result.status, 0, live.result.stderr);
    assert.equal(live.calls.length, 1);
    assert.deepEqual(live.calls[0].slice(0, 8), ['variant', 'upload', '--component', 'hello-standalone', '--variant', 'base', '--owner', 'hello-standalone']);
    assert.match(live.result.stdout, /cub component open hello-standalone/);
    assert.match(live.result.stdout, /cub variant create dev hello-standalone-base --target demo\/target --namespace hello/);
    assert.match(live.result.stdout, /cub release publish hello-standalone-dev/);
  } finally { trial.cleanup(); }
});

test('bounded first stack dry-runs exact target-bound Spaces and makes no calls', () => {
  const trial = fixture();
  try {
    const { result, calls } = trial.run('stack', 'deploy', 'web-tiny', '--target', 'demo/target');
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls, []);
    for (const slug of ['first-stack-frontend-dev', 'first-stack-backend-dev']) {
      assert.match(result.stdout, new RegExp(`release publish ${slug}`));
    }
    assert.match(result.stdout, /--component first-stack-frontend .*--namespace web --create-namespace/);
    assert.match(result.stdout, /--component first-stack-backend .*--namespace web/);
    assert.match(result.stdout, /does not create the cluster or target/);
  } finally { trial.cleanup(); }
});

test('bounded first stack uploads, places and publishes; rerun promotes before republishing', () => {
  const trial = fixture();
  try {
    const first = trial.run('stack', 'deploy', 'web-tiny', '--target', 'demo/target', '--run');
    assert.equal(first.result.status, 0, first.result.stderr);
    assert.deepEqual(first.calls.map((args) => args.slice(0, 2)), [
      ['variant', 'upload'], ['variant', 'upload'],
      ['space', 'get'], ['variant', 'create'], ['release', 'publish'],
      ['space', 'get'], ['variant', 'create'], ['release', 'publish'],
    ]);
    assert.deepEqual(first.calls.filter((args) => args[0] === 'release').map((args) => args[2]), ['first-stack-frontend-dev', 'first-stack-backend-dev']);
    assert.match(first.result.stdout, /requested delivery; it did not inspect the cluster or claim health/);
    assert.match(first.result.stdout, /kubectl get applications -n argocd first-stack-frontend-dev first-stack-backend-dev/);
    assert.match(first.result.stdout, /kubectl get configmap -n web frontend-config backend-config/);

    const second = trial.run('stack', 'deploy', 'web-tiny', '--target', 'demo/target', '--run');
    assert.equal(second.result.status, 0, second.result.stderr);
    assert.deepEqual(second.calls.filter((args) => args[0] === 'variant' && ['create', 'promote'].includes(args[1])).map((args) => args.slice(0, 3)), [
      ['variant', 'promote', 'first-stack-frontend-dev'],
      ['variant', 'promote', 'first-stack-backend-dev'],
    ]);
  } finally { trial.cleanup(); }
});

test('stack deploy refuses to generalize the teaching path to arbitrary stacks', () => {
  const trial = fixture();
  try {
    const { result, calls } = trial.run('stack', 'deploy', 'shop-platform', '--target', 'demo/target', '--run');
    assert.equal(result.status, 2);
    assert.deepEqual(calls, []);
    assert.match(result.stderr, /supports only the shipped web-tiny stack/);
  } finally { trial.cleanup(); }
});
