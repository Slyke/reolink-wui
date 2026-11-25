import assert from 'node:assert/strict';
import test from 'node:test';
import { groupRecordings, recordingTime } from '../dist/shared/recording-groups.js';
import { accumulateChange, sampleDates, sampleWindows } from '../dist/shared/hotspots.js';
import { launch, fixtureBridge, eventually, uuid } from './support.mjs';

test('hotspot frame pairs stay inside the requested period and never double-count short clips',()=>{
  const start='2026-11-24T22:00:00';
  const groups=groupRecordings({recordings:[
    {id:'low',stream:'sub',start,end:'2026-11-24T22:00:05'},
    {id:'high',stream:'main',start,end:'2026-11-24T22:00:05'}
  ]});
  const from=recordingTime(start);
  const picks=sampleWindows(groups,{from:from+100,to:from+4900});
  assert.equal(picks.length,2);
  const offsets=picks.flatMap(p=>p.offsets);
  assert.deepEqual(offsets,[...new Set(offsets)].sort((a,b)=>a-b));
  assert.ok(picks.every(p=>p.recording.id==='low'));
  assert.ok(offsets[0]>=100 && offsets.at(-1)<4900);
  assert.deepEqual(sampleWindows(groups,{from:from+6000,to:from+9000}),[]);
  const dates=sampleDates({from,to:from+16*86400000});
  assert.equal(dates.length,6);assert.equal(dates[0],'2026-11-24');assert.equal(dates.at(-1),'2026-12-10');
  const before=new Uint8ClampedArray([20,20,20,255,80,80,80,255]);
  const after=new Uint8ClampedArray([40,40,40,255,80,80,80,255]);
  const sum=new Float32Array(2);accumulateChange(before,after,sum);assert.deepEqual([...sum],[20,0]);
});

test('firmware packages require a camera grant and CSRF, and replay cannot transfer the package twice',async t=>{
  const fixture=await fixtureBridge({websocket:true});
  t.after(()=>fixture.close());
  const {app,runtime,seed,signIn,incoming}=await launch({bridges:[fixture.config]});
  t.after(()=>app.close());
  await seed({username:'firmware-admin',admin:true});
  await seed({username:'ordinary-user'});
  const admin=await signIn('firmware-admin'), viewer=await signIn('ordinary-user');
  const bridge=runtime.bridges.get('lab');
  const camera=await eventually(async()=>(await incoming({path:'/cameras',headers:admin})).json().cameras[0]);
  const path='/cameras/'+camera.id+'/firmware', source='a'.repeat(64);
  const view={model:'Fixture',hardware:'IPC_FIXTURE',installed:'1',source,canInstall:true,updateAvailable:false,progress:null};
  const original=bridge.api.bind(bridge);
  let writes=0;
  bridge.hasFirmware=()=>true;
  bridge.api=async options=>{
    if(!options.path.endsWith('/firmware'))return original(options);
    if(options.method!=='POST')return Response.json(view);
    writes++;
    if(options.data===undefined)return Response.json({errorKey:'API_FIRMWARE_NO_OFFER'},{status:409});
    assert.deepEqual([...new Uint8Array(options.data)],[10,20,30]);
    return Response.json({outcome:'acknowledged',correlation_id:options.correlation},{status:202});
  };
  assert.deepEqual((await incoming({path:path+'?check=true',headers:admin})).json(),view);
  const query='?source='+source+'&confirm=true&operationId='+uuid();
  const send=(headers,bytes)=>incoming({method:'POST',path:path+query+'&file=Fixture.pak',
    headers:{...headers,'content-type':'application/octet-stream'},payload:Buffer.from(bytes)});
  assert.ok((await send(viewer,[10,20,30])).statusCode>=400);
  assert.ok((await send({cookie:admin.cookie},[10,20,30])).statusCode>=400);
  assert.equal(writes,0);
  assert.equal((await send(admin,[10,20,30])).json().outcome,'unverified');
  assert.equal((await send(admin,[10,20,30])).json().outcome,'unverified');
  assert.ok((await send(admin,[1])).statusCode>=400);
  assert.equal(writes,1);
  const none=await incoming({method:'POST',path:path+'?source='+source+'&confirm=true&operationId='+uuid(),headers:admin});
  assert.equal(none.json().reason,'FIRMWARE_NO_OFFER');
});
