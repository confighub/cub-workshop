import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root = new URL('../proofs/match-local-2026-09-09/', import.meta.url);
const bytes = (p) => readFileSync(new URL(p, root));
const json = (p) => JSON.parse(bytes(p));
const sha = (b) => createHash('sha256').update(b).digest('hex');

test('direct and both assistant Match trials retain the same three bounded outcomes', () => {
  const meta = json('execution.json');
  assert.equal(meta.sourceCommit, '31202099f41dbd8db51c2f9bd9d87a2be714091d');
  assert.equal(meta.taskSha256, sha(bytes('task.txt')));
  assert.equal(meta.modelSha256, sha(bytes('model.yaml')));
  assert.equal(meta.targetSha256, sha(bytes('nodes.yaml')));
  const model = bytes('model.yaml');
  const target = bytes('nodes.yaml').toString();
  const expectedInputs = {
    candidate: target,
    mismatch: target.replace('nvidia.com/gpu: "2"', 'nvidia.com/gpu: "1"'),
    unknown: target.replace('        nvidia.com/gpu: "2"\n', ''),
  };
  assert.notEqual(expectedInputs.mismatch, target);
  assert.notEqual(expectedInputs.unknown, target);
  for (const agent of ['direct', 'claude', 'codex']) {
    assert.deepEqual(json(`${agent}/exit-codes.json`), { candidate: 0, mismatch: 1, unknown: 3 });
    assert.equal(bytes(`${agent}/mismatch-nodes.yaml`).toString(), expectedInputs.mismatch);
    assert.equal(bytes(`${agent}/unknown-nodes.yaml`).toString(), expectedInputs.unknown);
    for (const state of ['candidate', 'mismatch', 'unknown']) {
      const result = json(`${agent}/${state}.json`);
      assert.deepEqual(result, json(`direct/${state}.json`));
      if (agent === 'codex') {
        assert.deepEqual(result, json(`codex/${state}.stdout.json`));
        assert.equal(bytes(`codex/${state}.stderr.log`).length, 0);
      }
      assert.equal(result.status, state);
      assert.equal(result.scope, 'supplied-node-snapshot');
      assert.equal(result.execution, 'not-run');
      assert.equal(result.target.liveChecked, false);
      assert.equal(result.workload.sha256, `sha256:${sha(model)}`);
      assert.equal(result.target.sha256, `sha256:${sha(expectedInputs[state])}`);
      assert.equal(result.requirement.gpuPerReplica, 2);
      assert.equal(result.nodes.length, 1);
      const gpu = result.nodes[0].checks.find((c) => c.field === 'status.allocatable[nvidia.com/gpu]');
      assert.deepEqual(gpu, { field: 'status.allocatable[nvidia.com/gpu]', required: 2, supplied: {candidate:2,mismatch:1,unknown:null}[state], status: {candidate:'pass',mismatch:'mismatch',unknown:'unknown'}[state] });
      for (const omitted of ['free GPUs and concurrent workloads', 'registry credentials and model entitlement', 'application or inference response']) assert.ok(result.notChecked.includes(omitted));
    }
    if (agent !== 'direct') {
      assert.equal(meta.agents[agent].exitCode, 0);
      assert.ok(meta.agents[agent].elapsedSeconds > 0);
      assert.ok(bytes(`${agent}/REPORT.md`).length > 0);
    }
  }
});
