import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recordError } from '../dist/server/errors.js';
import { launch,eventually,uuid } from './support.mjs';

test('client errors are generated and logging gates select individual error sinks',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'wui-error-sinks-')),path=join(directory,'api.jsonl');
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const {app,runtime,incoming,seed,signIn}=await launch({logging:{
    sinks:{console:{enabled:false},file:{enabled:true,format:'json',path}},
    gates:{ACCESS_DENIED:{file:true},BAD_INPUT:{file:false},BRIDGE_WS_TEST_FAILED:{file:false},OPERATION_UNVERIFIED:{file:false}}
  }});
  t.after(()=>app.close());
  await seed({username:'logging-viewer'});
  const headers=await signIn('logging-viewer');
  const rejected=await incoming({path:'/admin',headers});
  assert.equal(rejected.statusCode,403);
  const hidden=await incoming({path:'/no-such-route',headers});
  assert.equal(hidden.statusCode,404);
  const actor=await seed({username:'logging-admin',admin:true}),admin=await signIn('logging-admin');
  const tested=await incoming({path:'/admin/bridges/test',method:'POST',headers:admin,payload:{
    configuration:{id:'logging-test',label:'Fixture',cameraIds:[],http:{url:'http://127.0.0.1:1',token:'fixture-private-secret-should-not-be-logged'}}
  }});
  assert.equal(tested.statusCode,200);
  assert.equal(tested.json().results.find(item=>item.source==='http').status,'failed');
  for(const outcome of ['rejected','unknown','unverified']) {
    const result=await runtime.ops.run({id:uuid(),actor,resource:'fixture-camera',action:'fixture-operation',correlation:uuid(),input:{password:'fixture-private-secret-should-not-be-logged'},
      execute:async()=>{
        if(outcome==='unknown') throw new Error('fixture-private-secret-should-not-be-logged');
        return {outcome};
      }});
    assert.equal(result.outcome,outcome);
  }
  recordError({key:'EVENT_HISTORY_BACKLOG',caller:'fixture::background'});
  let contents='';
  await eventually(async()=>{contents=await readFile(path,'utf8').catch(()=>'');return contents.includes(rejected.json().correlationId) && contents.includes('OPERATION_UNKNOWN') && contents.includes('BRIDGE_HTTP_TEST_FAILED') && contents.includes('EVENT_HISTORY_BACKLOG');});
  await new Promise(resolve=>setTimeout(resolve,50));
  contents=await readFile(path,'utf8');
  assert.match(contents,/ACCESS_DENIED/);
  const background=contents.trim().split('\n').map(line=>JSON.parse(line)).find(entry=>entry.errorKey==='EVENT_HISTORY_BACKLOG'||entry.error?.errorKey==='EVENT_HISTORY_BACKLOG');
  assert.match(background.correlationId ?? background.error.correlationId,/^[a-f0-9-]{36}$/);
  assert.match(contents,/OPERATION_REJECTED/);
  assert.ok(!contents.includes('OPERATION_UNVERIFIED'));
  assert.ok(!contents.includes('BRIDGE_WS_TEST_FAILED'));
  assert.ok(!contents.includes('fixture-private-secret-should-not-be-logged'));
  assert.ok(!contents.includes(hidden.json().correlationId));
  assert.ok(!contents.includes(headers.cookie));
});
