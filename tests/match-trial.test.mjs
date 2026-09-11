import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, rmSync, symlinkSync, cpSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { verifyMatchTrial } from '../scripts/verify-match-trial.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
function temporary(t) {
  const dir = mkdtempSync(join(tmpdir(), 'match-trial-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
function fixture(t) {
  const dir = temporary(t);
  for (const name of ['model.yaml', 'nodes.yaml']) copyFileSync(join(root, 'examples/match', name), join(dir, name));
  const nodes = readFileSync(join(dir, 'nodes.yaml'), 'utf8');
  writeFileSync(join(dir, 'mismatch-nodes.yaml'), nodes.replace('nvidia.com/gpu: "2"', 'nvidia.com/gpu: "1"'));
  writeFileSync(join(dir, 'unknown-nodes.yaml'), nodes.replace('        nvidia.com/gpu: "2"\n', ''));
  const exits = {};
  for (const [status, input] of [['candidate', 'nodes.yaml'], ['mismatch', 'mismatch-nodes.yaml'], ['unknown', 'unknown-nodes.yaml']]) {
    const run = spawnSync(process.execPath, [join(root, 'bin/cub-app'), 'match', 'model.yaml', '--target', input, '--json', '--out', `${status}.json`], { cwd: dir, encoding: 'utf8' });
    assert.equal(run.error, undefined);
    exits[status] = run.status;
  }
  assert.deepEqual(exits, { candidate: 0, mismatch: 1, unknown: 3 });
  writeFileSync(join(dir, 'exit-codes.json'), JSON.stringify(exits));
  return dir;
}
test('actual command outputs pass bounded artifact review, including after copying', t => {
  const dir = fixture(t);
  const accepted = verifyMatchTrial(dir);
  assert.equal(accepted.accepted, true);
  assert.ok(accepted.notProven.includes('assistant or command execution authenticity'));
  const copy = join(temporary(t), 'copied');
  cpSync(dir, copy, { recursive: true });
  assert.deepEqual(verifyMatchTrial(copy), accepted);
});
test('a report and successful assistant process do not replace required files', t => {
  const dir = fixture(t);
  rmSync(join(dir, 'candidate.json'));
  writeFileSync(join(dir, 'REPORT.md'), 'Everything passed.');
  writeFileSync(join(dir, 'run.exit'), '0');
  const run = spawnSync(process.execPath, [join(root, 'scripts/verify-match-trial.mjs'), dir], { encoding: 'utf8' });
  assert.equal(run.status, 1);
  assert.equal(JSON.parse(run.stderr).accepted, false);
  assert.match(JSON.parse(run.stderr).reason, /candidate.json/);
});
test('unchanged original inputs are pinned independently of submitted results', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'model.yaml'), '# replaced\n' + readFileSync(join(dir, 'model.yaml')));
  assert.throws(() => verifyMatchTrial(dir), /pinned teaching input/);
});
test('unrelated Node changes and duplicate nodes are refused', t => {
  const dir = fixture(t);
  const file = join(dir, 'mismatch-nodes.yaml');
  const original = readFileSync(file, 'utf8');
  writeFileSync(file, original.replace('illustrative-h100', 'other-node'));
  assert.throws(() => verifyMatchTrial(dir), /more than the requested GPU fact/);
  writeFileSync(file, original + '\n---\n' + original);
  assert.throws(() => verifyMatchTrial(dir), /more than the requested GPU fact/);
});
test('nonzero command exits cannot be replaced with the assistant process exit', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'exit-codes.json'), JSON.stringify({ candidate: 0, mismatch: 0, unknown: 0 }));
  assert.throws(() => verifyMatchTrial(dir), /recorded command exits/);
});
test('complete results must agree, including omitted checks and hashes', t => {
  const dir = fixture(t);
  const file = join(dir, 'unknown.json');
  const original = JSON.parse(readFileSync(file));
  for (const mutate of [r => { r.target.liveChecked = true; }, r => { r.notChecked = []; }, r => { r.target.sha256 = 'sha256:wrong'; }, r => { r.nodes[0].status = 'candidate'; }]) {
    const changed = structuredClone(original); mutate(changed);
    writeFileSync(file, JSON.stringify(changed));
    assert.throws(() => verifyMatchTrial(dir), /complete recomputed result/);
  }
});
test('linked results cannot borrow files from another trial', t => {
  const dir = fixture(t);
  const external = join(temporary(t), 'candidate.json');
  copyFileSync(join(dir, 'candidate.json'), external);
  rmSync(join(dir, 'candidate.json'));
  symlinkSync(external, join(dir, 'candidate.json'));
  assert.throws(() => verifyMatchTrial(dir), /linked/);
});
test('malformed and oversized reports fail rather than counting as completion', t => {
  const dir = fixture(t);
  writeFileSync(join(dir, 'candidate.json'), '{');
  assert.throws(() => verifyMatchTrial(dir), /candidate.json/);
  writeFileSync(join(dir, 'candidate.json'), Buffer.alloc(1024 * 1024 + 1));
  assert.throws(() => verifyMatchTrial(dir), /over 1 MiB/);
});
