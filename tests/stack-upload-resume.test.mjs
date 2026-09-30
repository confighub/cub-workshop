import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { saysNotFound, spaceExists } from '../lib/cub-lookup.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));

// A fake cub that logs its argv. An upload named in TRIAL_FAIL fails the way a
// quota stop does; TRIAL_MODE=auth fails every call with cub's login message.
const FAKE_CUB = `
const fs=require('node:fs'); const args=process.argv.slice(2);
fs.appendFileSync(process.env.TRIAL_CALL_LOG,JSON.stringify(args)+'\\n');
if(process.env.TRIAL_MODE==='auth') { console.error('Failed: authentication problem. Try logging in (again).\\nDetailed message: token is expired\\n.'); process.exit(1); }
if(args[0]==='space' && args[1]==='get') {
 if(args[2]==='present') { console.log(args[2]); process.exit(0); }
 console.error(process.env.TRIAL_MODE==='permission' ? 'Failed: permission denied' : 'Failed: space '+args[2]+' not found'); process.exit(1);
}
if(args[0]==='variant' && args[1]==='upload') {
 if(process.env.TRIAL_FAIL===args[args.indexOf('--component')+1]) { console.error('Failed: quota exceeded for Units'); process.exit(1); }
 process.exit(0);
}
console.error('unexpected call'); process.exit(3);
`;

function workspace() {
  const dir = mkdtempSync(join(tmpdir(), 'stack-upload-'));
  const bin = join(dir, 'bin'); mkdirSync(bin);
  writeFileSync(join(bin, 'cub'), `#!${process.execPath}\n${FAKE_CUB}`, { mode: 0o755 });
  const components = ['alpha', 'beta', 'gamma'];
  for (const component of components) writeFileSync(join(dir, `${component}.yaml`), `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: ${component}-config\n  namespace: trial\ndata:\n  key: value\n`);
  const manifest = join(dir, 'stack.yaml');
  writeFileSync(manifest, JSON.stringify({ apiVersion: 'helm-expt.confighub.com/v1alpha1', kind: 'Stack', metadata: { name: 'trial' }, spec: { components: components.map((component) => ({ name: component, authored: `${component}.yaml` })) } }));
  let run = 0;
  const env = (extra) => ({ ...process.env, PATH: `${bin}:${process.env.PATH}`, TRIAL_CALL_LOG: join(dir, `calls-${run += 1}.jsonl`), ...extra });
  const calls = (log) => existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map(JSON.parse) : [];
  const upload = (extraEnv = {}, extra = ['--run']) => {
    const runEnv = env(extraEnv);
    const result = spawnSync(process.execPath, [join(root, 'bin/cub-stack'), 'upload', manifest, ...extra], { encoding: 'utf8', env: runEnv });
    return { result, calls: calls(runEnv.TRIAL_CALL_LOG) };
  };
  return { upload, env, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const uploads = (calls) => calls.filter((args) => args[0] === 'variant').map((args) => args[args.indexOf('--component') + 1]);

test('a stop names what landed and what did not, and a rerun re-issues every upload', () => {
  const trial = workspace();
  try {
    const first = trial.upload({ TRIAL_FAIL: 'beta' });
    assert.equal(first.result.status, 1);
    assert.deepEqual(uploads(first.calls), ['alpha', 'beta']);
    assert.match(first.result.stderr, /Stopped: the upload of beta failed/);
    assert.match(first.result.stderr, /quota exceeded/);
    assert.match(first.result.stderr, /Uploaded: alpha\. Not uploaded: beta, gamma\./);
    assert.match(first.result.stderr, /then run cub stack upload \S+ --run\. Rerunning is safe: every upload is create-or-update/);

    // create-or-update is the resume: nothing is looked up or skipped.
    const second = trial.upload();
    assert.equal(second.result.status, 0, second.result.stderr);
    assert.deepEqual(second.calls.map((args) => args.slice(0, 2)), [['variant', 'upload'], ['variant', 'upload'], ['variant', 'upload']]);
    assert.deepEqual(uploads(second.calls), ['alpha', 'beta', 'gamma']);
  } finally { trial.cleanup(); }
});

test('an authentication error on the first upload stops with cub\'s own message', () => {
  const trial = workspace();
  try {
    const { result, calls } = trial.upload({ TRIAL_MODE: 'auth' });
    assert.equal(result.status, 1);
    assert.deepEqual(uploads(calls), ['alpha']);
    assert.match(result.stderr, /Stopped: the upload of alpha failed\.\n\s+Failed: authentication problem\. Try logging in \(again\)\.\n\s+Detailed message: token is expired\n/);
    assert.match(result.stderr, /Uploaded: none\. Not uploaded: alpha, beta, gamma\./);
  } finally { trial.cleanup(); }
});

test('the dry run asks the server nothing', () => {
  const trial = workspace();
  try {
    const { result, calls } = trial.upload({ TRIAL_MODE: 'auth' }, []);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(calls, []);
    assert.match(result.stdout, /Dry run\. Add --run to execute\./);
  } finally { trial.cleanup(); }
});

test('spaceExists treats only an explicit not-found as absence', () => {
  const trial = workspace();
  const saved = { ...process.env };
  try {
    for (const [mode, slug, expected] of [['', 'present', true], ['', 'absent', false], ['permission', 'absent', /permission denied/], ['auth', 'absent', /authentication problem/]]) {
      Object.assign(process.env, trial.env({ TRIAL_MODE: mode }));
      if (expected instanceof RegExp) assert.throws(() => spaceExists(slug), (error) => expected.test(error.stderr));
      else assert.equal(spaceExists(slug), expected);
    }
  } finally { process.env = saved; trial.cleanup(); }
});

// The lines a current hub prints, and the older form, both read as absence.
test('saysNotFound reads both of cub not-found wordings and nothing else', () => {
  for (const [text, kind, slug, expected] of [
    ['Failed: space "pr74-karpenter" not found in any space', 'space', 'pr74-karpenter', true],
    ['Failed: unit "nosuch-unit" not found in space c34c54b9-e72f-4684-b489-0d0ef868ed1d', 'unit', 'nosuch-unit', true],
    ['Failed: link "nosuch-link" not found in space c34c54b9-e72f-4684-b489-0d0ef868ed1d', 'link', 'nosuch-link', true],
    ['Failed: space absent not found', 'space', 'absent', true],
    ['Failed: space "absent-2" not found in any space', 'space', 'absent', false],
    ['Failed: permission denied', 'space', 'absent', false],
    ['Failed: authentication problem. Try logging in (again).', 'space', 'absent', false],
  ]) assert.equal(saysNotFound(text, kind, slug), expected, text);
});

// A live hub renders a new Space's slug before it carries a Component label, so
// the prefix pattern must read .Component.Slug; .Labels.Component is a 400.
test('--space-prefix names Spaces by the Component slug the hub can render', () => {
  const result = spawnSync(process.execPath, [join(root, 'bin', 'cub-stack'), 'upload', 'web-tiny', '--space-prefix', 'lab'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /--component lab-frontend --variant base --owner web-tiny --space-pattern template:\{\{\.Component\.Slug\}\} /);
  assert.doesNotMatch(result.stdout, /Labels\.Component/);
  // The prefix is on the Component too, so a shared organization gets no bare
  // Components (#88), and the Space name is the same <prefix>-<component>.
  assert.doesNotMatch(result.stdout, /--component frontend /);
});
