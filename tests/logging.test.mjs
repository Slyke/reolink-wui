import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp,readFile,rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch,eventually } from './support.mjs';

test('client errors are generated and logging gates select individual error sinks',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'wui-error-sinks-')),path=join(directory,'api.jsonl');
  t.after(()=>rm(directory,{recursive:true,force:true}));
  const {app,incoming,seed,signIn}=await launch({logging:{
    sinks:{console:{enabled:false},file:{enabled:true,format:'json',path}},
    gates:{ACCESS_DENIED:{file:true},BAD_INPUT:{file:false}}
  }});
  t.after(()=>app.close());
  await seed({username:'logging-viewer'});
  const headers=await signIn('logging-viewer');
  const rejected=await incoming({path:'/admin',headers});
  assert.equal(rejected.statusCode,403);
  const hidden=await incoming({path:'/no-such-route',headers});
  assert.equal(hidden.statusCode,404);
  let contents='';
  await eventually(async()=>{contents=await readFile(path,'utf8').catch(()=>'');return contents.includes(rejected.json().correlationId);});
  await new Promise(resolve=>setTimeout(resolve,50));
  contents=await readFile(path,'utf8');
  assert.match(contents,/ACCESS_DENIED/);
  assert.ok(!contents.includes(hidden.json().correlationId));
  assert.ok(!contents.includes(headers.cookie));
});
