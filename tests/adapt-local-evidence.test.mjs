import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
const root=new URL('../proofs/adapt-local-2026-09-09/',import.meta.url);
const bytes=(p)=>readFileSync(new URL(p,root));
const json=(p)=>JSON.parse(bytes(p));
const hash=(b)=>createHash('sha256').update(b).digest('hex');

test('both assistants retain the requested edit and report the extra change without repairing it',()=>{
 const meta=json('execution.json');
 assert.equal(meta.sourceCommit,'1816d573b832efd78fc53790e8a53f5bcb8a4006');
 assert.equal(meta.taskSha256,hash(bytes('task.txt')));
 const before=bytes('before.yaml').toString();
 assert.equal(hash(before),'556cbf4cc1e0412d5bc0b10591b7db522e994287063cb79cd45fd375a9944ea8');
 const a=before.replace('  replicas: 1\n','  replicas: 2\n');
 const b=a.replace('  revisionHistoryLimit: 10\n','  revisionHistoryLimit: 5\n');
 assert.notEqual(before,a);assert.notEqual(a,b);
 assert.equal(bytes('candidate-a.yaml').toString(),a);assert.equal(bytes('candidate-b.yaml').toString(),b);
 const expectedHashes=Object.fromEntries(['before.yaml','candidate-a.yaml','candidate-b.yaml'].map((name)=>[name,hash(bytes(name))]));
 for(const agent of ['direct','claude','codex']) {
  assert.deepEqual(json(`${agent}/exit-codes.json`),{'candidate-a':1,'candidate-b':1});
  assert.deepEqual(json(`${agent}/moved/exit-codes.json`),{'candidate-a':1,'candidate-b':1});
  assert.deepEqual(meta.finalInputHashes[agent],expectedHashes);
  if(agent==='codex') {
   assert.deepEqual(json('codex/input-hashes.json'),expectedHashes);
   assert.deepEqual(json('codex/moved/input-hashes.json'),expectedHashes);
  }
  for(const candidate of ['candidate-a','candidate-b']) {
   const result=json(`${agent}/${candidate}.json`);
   assert.deepEqual(result,json(`direct/${candidate}.json`));
   assert.deepEqual(result,json(`${agent}/moved/${candidate}.json`));
   assert.equal(result.scope,'local-configuration-diff');
   assert.equal(result.equal,false);
   assert.equal(result.before.sha256,`sha256:${expectedHashes['before.yaml']}`);
   assert.equal(result.after.sha256,`sha256:${expectedHashes[candidate+'.yaml']}`);
   assert.deepEqual(result.summary,{added:0,removed:0,changed:1,unchanged:0});
   assert.deepEqual(result.changes[0].object,{apiVersion:'apps/v1',kind:'Deployment',namespace:'monitoring',name:'prometheus-server'});
   const fields=[{path:'/spec/replicas',operation:'replace',before:1,after:2}];
   if(candidate==='candidate-b')fields.push({path:'/spec/revisionHistoryLimit',operation:'replace',before:10,after:5});
   assert.deepEqual(result.changes[0].fields,fields);
   for(const omitted of ['upstream merge and protected-field preservation','target readiness or live drift','application availability'])assert.ok(result.notChecked.includes(omitted));
  }
  if(agent!=='direct') {
   assert.equal(meta.agents[agent].exitCode,0);assert.ok(meta.agents[agent].elapsedSeconds>0);
   assert.deepEqual(json(`${agent}/review.json`),{'candidate-a':{withinRequestedEdit:true,unexpectedPaths:[]},'candidate-b':{withinRequestedEdit:false,unexpectedPaths:['/spec/revisionHistoryLimit']}});
   assert.ok(bytes(`${agent}/REPORT.md`).length>0);
  }
 }
});
