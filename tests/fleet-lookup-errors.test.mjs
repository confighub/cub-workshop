import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
const root = fileURLToPath(new URL('../', import.meta.url));
function exercise(mode) {
  const dir = mkdtempSync(join(tmpdir(), 'fleet-lookup-'));
  try {
    const bin = join(dir,'bin');mkdirSync(bin);
    const log = join(dir,'calls.jsonl');
    writeFileSync(join(bin,'cub'), `#!${process.execPath}\n` + `
const fs=require('node:fs'); const args=process.argv.slice(2);
fs.appendFileSync(process.env.TRIAL_CALL_LOG,JSON.stringify(args)+'\\n');
if(args[0]==='space' && args[1]==='get') {
 const mode=process.env.TRIAL_MODE;
 if(mode==='existing') { console.log(args[2]); process.exit(0); }
 console.error(mode==='missing' ? 'Failed: space '+args[2]+' not found' : mode==='auth' ? 'Failed: authentication problem. Try logging in (again).\\nDetailed message: token is expired\\n.' : 'Failed: permission denied');
 process.exit(1);
}
`, {mode:0o755});
    const manifest=join(dir,'fleet.yaml');
    writeFileSync(manifest, JSON.stringify({metadata:{name:'trial'},spec:{clusters:[{name:'trial-cluster'}],placements:[]}}));
    const result=spawnSync(process.execPath,[join(root,'bin/cub-fleet'),'up',manifest],{encoding:'utf8',env:{...process.env,PATH:bin+':'+process.env.PATH,TRIAL_MODE:mode,TRIAL_CALL_LOG:log}});
    const calls=readFileSync(log,'utf8').trim().split('\n').map(JSON.parse);
    return {result,calls};
  } finally {rmSync(dir,{recursive:true,force:true});}
}
test('authentication and permission errors stop after the read, before creation',()=>{
  for (const mode of ['auth','permission']) {
    const {result,calls}=exercise(mode);
    assert.equal(result.status,1);
    assert.deepEqual(calls,[['space','get','trial-cluster','-o','name']]);
    assert.match(result.stderr,mode==='auth'?/authentication problem/:/permission denied/);
    assert.doesNotMatch(result.stderr,/Failed: \.\s*$/);
  }
});
test('only an explicit not-found result permits scaffolding, and existing Spaces are left alone',()=>{
  const missing=exercise('missing');
  assert.equal(missing.result.status,0,missing.result.stderr);
  assert.deepEqual(missing.calls.map(args=>args.slice(0,2)),[['space','get'],['space','create'],['worker','create'],['target','create']]);
  const existing=exercise('existing');
  assert.equal(existing.result.status,0,existing.result.stderr);
  assert.equal(existing.calls.length,1);
});
