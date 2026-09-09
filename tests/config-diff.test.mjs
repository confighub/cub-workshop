import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { diffConfigs } from '../lib/config-diff.mjs';
const root=fileURLToPath(new URL('../',import.meta.url));
const encode=(v)=>Buffer.from(JSON.stringify(v));
const deployment={apiVersion:'apps/v1',kind:'Deployment',metadata:{name:'demo',namespace:'monitoring'},spec:{replicas:1}};
const doc=(spec)=>encode({...deployment,spec});

test('one local replica edit is one exact field change with immutable input hashes',()=>{
 const before=doc({replicas:1});const after=doc({replicas:2});const r=diffConfigs(before,after);
 assert.deepEqual(r.summary,{added:0,removed:0,changed:1,unchanged:0});
 assert.deepEqual(r.changes[0].fields,[{path:'/spec/replicas',operation:'replace',before:1,after:2}]);
 assert.notEqual(r.before.sha256,r.after.sha256);
 assert.deepEqual(r,diffConfigs(before,after));
 assert.ok(r.notChecked.includes('upstream merge and protected-field preservation'));
});
test('mapping and document order are irrelevant; array order remains a change',()=>{
 const cm={apiVersion:'v1',kind:'ConfigMap',metadata:{name:'settings'},data:{x:'y'}};
 const yamlA=Buffer.from(`${JSON.stringify(deployment)}\n---\n${JSON.stringify(cm)}\n`);
 const yamlB=Buffer.from(`${JSON.stringify(cm)}\n---\n${JSON.stringify({spec:deployment.spec,metadata:deployment.metadata,kind:deployment.kind,apiVersion:deployment.apiVersion})}\n`);
 const r=diffConfigs(yamlA,yamlB);assert.equal(r.equal,true);assert.equal(r.summary.unchanged,2);assert.notEqual(r.before.sha256,r.after.sha256);
 assert.deepEqual(diffConfigs(doc({args:['a','b']}),doc({args:['b','a']})).changes[0].fields,[{path:'/spec/args',operation:'replace',before:['a','b'],after:['b','a']}]);
});
test('null, absent, false, zero and empty strings are not silently erased',()=>{
 for (const value of [null,false,0,'']) {
  assert.deepEqual(diffConfigs(doc({}),doc({value})).changes[0].fields,[{path:'/spec/value',operation:'add',after:value}]);
  assert.deepEqual(diffConfigs(doc({value}),doc({})).changes[0].fields,[{path:'/spec/value',operation:'remove',before:value}]);
 }
});
test('JSON pointers escape label keys and changed identity is removal plus addition',()=>{
 const a={...deployment,metadata:{...deployment.metadata,annotations:{'a/b~c':'old'}}};
 const b=structuredClone(a);b.metadata.annotations['a/b~c']='new';
 assert.equal(diffConfigs(encode(a),encode(b)).changes[0].fields[0].path,'/metadata/annotations/a~1b~0c');
 b.metadata.namespace='other';const r=diffConfigs(encode(a),encode(b));
 assert.deepEqual(r.summary,{added:1,removed:1,changed:0,unchanged:0});
 const absent=structuredClone(deployment);delete absent.metadata.namespace;
 assert.equal(diffConfigs(encode(absent),encode(deployment)).summary.changed,0);
 assert.equal(diffConfigs(encode(absent),encode(deployment)).summary.added,1);
});
test('duplicates, partial scalar documents, invalid identities and empty files refuse',()=>{
 const before=encode(deployment);
 for (const bad of ['', '# empty', 'hello', `${before}\n---\n42`, `${before}\n---\n${before}`, JSON.stringify({...deployment,metadata:{name:2}})]) assert.throws(()=>diffConfigs(before,Buffer.from(bad)));
});
test('cyclic aliases and non-finite numbers refuse; timestamp text stays text',()=>{
 const prefix='apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: settings\n';
 assert.throws(()=>diffConfigs(encode(deployment),Buffer.from(prefix+'data: &loop\n  value: *loop\n')),/cyclic/);
 assert.throws(()=>diffConfigs(encode(deployment),Buffer.from(prefix+'data:\n  value: .inf\n')),/non-finite/);
 const r=diffConfigs(Buffer.from(prefix+'data:\n  day: 2026-09-09\n'),Buffer.from(prefix+'data:\n  day: 2026-09-10\n'));
 assert.deepEqual(r.changes[0].fields,[{path:'/data/day',operation:'replace',before:'2026-09-09',after:'2026-09-10'}]);
});
test('CLI saves JSON outside installation, never overwrites, and distinguishes differences from errors',()=>{
 const d=mkdtempSync(join(tmpdir(),'workshop-diff-'));
 const run=(...args)=>spawnSync(process.execPath,[join(root,'bin/cub-config'),'diff',...args],{cwd:d,encoding:'utf8'});
 try {
  writeFileSync(join(d,'before.yaml'),doc({replicas:1}));writeFileSync(join(d,'after.yaml'),doc({replicas:2}));
  const r=run('before.yaml','after.yaml','--json','--out','result.json');assert.equal(r.status,0,r.stderr);assert.deepEqual(JSON.parse(r.stdout),JSON.parse(readFileSync(join(d,'result.json'))));
  const original=readFileSync(join(d,'result.json'));
  assert.equal(run('before.yaml','after.yaml','--out','result.json').status,2);assert.deepEqual(readFileSync(join(d,'result.json')),original);
  assert.equal(run('before.yaml','after.yaml','--exit-code').status,1);
  assert.equal(run('before.yaml','before.yaml','--exit-code').status,0);
  assert.equal(run('missing','after.yaml').status,2);
  assert.equal(run('before.yaml','after.yaml','--run').status,2);
  assert.equal(run('before.yaml','after.yaml','--out').status,2);
  assert.equal(run('--help').status,0);
  assert.deepEqual(readFileSync(join(d,'before.yaml')),doc({replicas:1}));
 }finally{rmSync(d,{recursive:true,force:true});}
});

test('retained Prometheus excerpt produces only the demonstrated replica edit',async()=>{
 const { createHash }=await import('node:crypto');
 const before=readFileSync(join(root,'examples/adapt/prometheus-before.yaml'));
 const source=JSON.parse(readFileSync(join(root,'examples/adapt/source.json')));
 assert.equal(createHash('sha256').update(before).digest('hex'),source.excerptSha256);
 assert.equal(source.revision,'dd9d7f7c54b24e480e887c18447e1cee611192fc');
 assert.equal(before.toString().split('  replicas: 1\n').length,2);
 const after=Buffer.from(before.toString().replace('  replicas: 1\n','  replicas: 2\n'));
 const result=diffConfigs(before,after);
 assert.deepEqual(result.summary,{added:0,removed:0,changed:1,unchanged:0});
 assert.deepEqual(result.changes[0].object,{apiVersion:'apps/v1',kind:'Deployment',namespace:'monitoring',name:'prometheus-server'});
 assert.deepEqual(result.changes[0].fields,[{path:'/spec/replicas',operation:'replace',before:1,after:2}]);
});
