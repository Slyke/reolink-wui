import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupRecordings,recordingVariant } from '../dist/shared/recording-groups.js';
import { launch,fixtureBridge,eventually } from './support.mjs';

const clip = (id,stream,start,end) => ({id,stream,start:'2026-11-18T12:'+start,end:'2026-11-18T12:'+end,sizeBytes:null,kind:'md'});
test('recordings pair qualities with clock drift without merging adjacent or unmatched clips',()=>{
  const list = [
    clip('a','sub','00:00','01:00'),clip('b','sub','01:02','02:00'),
    clip('c','main','00:02','01:02'),clip('d','main','01:04','02:02'),clip('e','main','03:00','04:00')
  ];
  const grouped=groupRecordings({recordings:list.reverse()});
  assert.equal(grouped.length,3);
  assert.deepEqual(grouped.map(item=>item.variants.map(variant=>variant.id)),[['a','c'],['b','d'],['e']]);
  assert.equal(recordingVariant({group:grouped[0],stream:'main'}).id,'c');
  assert.equal(recordingVariant({group:grouped[2],stream:'sub'}).id,'e');
  assert.equal(groupRecordings({recordings:[clip('1','main','00:00','01:00'),clip('2','sub','00:00','00:10')]}).length,2);
});

test('preview notifications deduplicate WS and MQTT, and API-only connections retain polling',async t=>{
  const fixture=await fixtureBridge({websocket:true,apiEvents:true,previewNotifications:true,previewCameras:['alpha']});
  t.after(()=>fixture.close());
  const {app,runtime,seed,signIn,incoming}=await launch({bridges:[{...fixture.config,events:['ws','mqtt','api']}]});
  t.after(()=>app.close());
  await seed({username:'preview-notification-admin',admin:true});
  const headers=await signIn('preview-notification-admin'),bridge=runtime.bridges.get('lab');
  await eventually(()=>bridge.feedReady);
  await eventually(()=>bridge.previewPush('alpha'));
  const notifications=[];
  t.after(bridge.observe(update=>{if(update.kind==='preview') notifications.push(update);}));
  fixture.announcePreview();
  await eventually(()=>notifications.length===1);
  fixture.announcePreview();
  await new Promise(resolve=>setTimeout(resolve,100));
  assert.equal(notifications.length,1);
  fixture.changePreview();fixture.announcePreview('alpha','mqtt');
  await eventually(()=>notifications.length===2);
  const views=(await incoming({path:'/cameras',headers})).json().cameras;
  assert.equal(views.find(item=>item.name==='Loading dock').previewPush,true);
  const [camera]=await runtime.sql.query('SELECT id FROM cameras WHERE remote_id=$1','alpha');
  const state=(await incoming({path:'/cameras/'+camera.id,headers})).json();
  assert.ok(!state.detections.some(item=>item.type==='preview'));
  bridge.setEventSources(['api']);
  await eventually(()=>bridge.feedReady);
  assert.equal(bridge.previewPush('alpha'),false);
});
