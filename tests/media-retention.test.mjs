import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { openDb } from '../dist/server/db.js';
import { MediaRetention } from '../dist/server/media-retention.js';

const id = value => createHash('sha256').update(value).digest('hex');
const file = (key, completedAt) => ({id:id(key),completedAt});
async function fixture(t, respond) {
  const sql = await openDb({config:{driver:'sqlite',path:':memory:'}});
  t.after(() => sql.close());
  await sql.query("INSERT INTO bridges(id) VALUES ('lab')");
  for (const camera of ['a','b','off']) {
    await sql.query("INSERT INTO cameras(id,remote_id,bridge_id) VALUES ($1,$1,'lab')",camera);
  }
  const requests=[];
  const bridge={
    remoteId:stable=>stable, hasMediaFiles:()=>true,
    api:async({path,search,data,stableId})=>{
      const [,,camera,,endpoint]=path.split('/');
      assert.equal(stableId,camera);
      const query=Object.fromEntries(new URLSearchParams(search));
      requests.push({camera,endpoint,query,data});
      const override=await respond({camera,endpoint,query,data,sql});
      if (override!==undefined) return Response.json(override);
      if (endpoint==='capabilities') return Response.json({source:id(camera),video:true,timeLapse:true,cameraTime:'2026-11-20T12:00:00'});
      if (endpoint==='delete') return Response.json({deleted:data.files,absent:[]});
      throw new Error('Unexpected fixture request '+endpoint);
    }
  };
  const runtime={sql,bridges:new Map([['lab',bridge]])};
  const add=(camera,kind,days)=>sql.query('INSERT INTO media_retention(camera,kind,days,source) VALUES($1,$2,$3,$4)',camera,kind,days,id(camera));
  return {sql,requests,runtime,add};
}

test('hourly retention uses each camera and media type independently, even with two WUI workers',async t=>{
  const videos=Array.from({length:1025},(_,n)=>file('old-'+n,'2026-11-18T11:59:59'));
  const boundary=file('keep-boundary','2026-11-18T12:00:00');
  const captures={a:[file('a-old','2026-11-11T12:00:00'),file('a-keep','2026-11-18T11:00:00')],
    b:[file('b-old','2026-11-18T11:00:00'),file('b-keep','2026-11-19T13:00:00')]};
  const {sql,requests,runtime,add}=await fixture(t,({camera,endpoint,query})=>{
    const rows=query.kind==='video' ? [...videos,boundary] : captures[camera];
    const day=f=>f.completedAt.slice(0,10);
    if (endpoint==='days') return {days:[...new Set(rows.map(day))].filter(d=>!query.month || d.slice(0,7)===query.month.slice(0,7))};
    if (endpoint==='files') return {source:id(camera),files:rows.filter(f=>day(f)===query.date),skipped:1};
  });
  await add('a','video',2);
  await add('a','timeLapse',8);
  await add('b','timeLapse',1);
  await Promise.all([new MediaRetention(runtime).checkDue(),new MediaRetention(runtime).checkDue()]);
  const batches=requests.filter(r=>r.endpoint==='delete');
  const videoBatches=batches.filter(r=>r.data.kind==='video');
  assert.deepEqual(videoBatches.map(r=>r.data.files.length),[1024,1]);
  assert.deepEqual(videoBatches.flatMap(r=>r.data.files),videos.map(f=>f.id));
  assert.ok(videoBatches.every(r=>r.camera==='a' && r.data.date==='2026-11-18' && r.data.source===id('a')));
  assert.deepEqual(batches.filter(r=>r.data.kind==='timeLapse').map(r=>[r.camera,r.data.files]).sort(),[['a',[id('a-old')]],['b',[id('b-old')]]]);
  assert.ok(requests.every(r=>r.camera!=='off'));
  const result=await sql.query('SELECT camera,kind,last_deleted,last_error,next_check FROM media_retention ORDER BY camera,kind');
  assert.deepEqual(result.map(r=>[r.camera,r.kind,r.last_deleted]),[['a','timeLapse',1],['a','video',1025],['b','timeLapse',1]]);
  assert.ok(result.every(r=>r.last_error===null && r.next_check>Date.now()+3_590_000));
  const count=requests.length;
  await new MediaRetention(runtime).checkDue();
  assert.equal(requests.length,count,'the database schedule survives restarting the worker');
});

test('a replaced camera, disabled rule, or missing completion data cannot trigger deletion',async t=>{
  const {sql,requests,runtime,add}=await fixture(t,async({camera,endpoint})=>{
    if (endpoint==='days') return {days:['2026-11-10']};
    if (endpoint==='files') {
      if(camera==='b') await sql.query("DELETE FROM media_retention WHERE camera='b'");
      return {source:id(camera==='a'?'replacement':camera),files:camera==='off'?[]:[file('x','2026-11-10T11:00:00')],skipped:1};
    }
  });
  for (const camera of ['a','b','off']) await add(camera,'timeLapse',1);
  await new MediaRetention(runtime).checkDue();
  assert.equal(requests.filter(r=>r.endpoint==='delete').length,0);
  const result=await sql.query('SELECT camera,last_error,last_skipped,last_deleted FROM media_retention ORDER BY camera');
  assert.deepEqual(result.map(r=>[r.camera,r.last_error,r.last_skipped,r.last_deleted]),[['a','CAMERA_UNKNOWN',0,0],['off',null,1,0]]);
});

test('a clip crossing midnight is rechecked as its end expires in the new month',async t=>{
  const video=file('cross-month','2026-11-01T01:15:00');
  const {sql,requests,runtime,add}=await fixture(t,({camera,endpoint,query})=>{
    if(endpoint==='capabilities') return {source:id(camera),video:true,timeLapse:true,cameraTime:'2026-11-03T01:30:00'};
    if(endpoint==='days') return {days:query.month==='2026-10-01'?['2026-10-31']:[]};
    if(endpoint==='files') return {source:id(camera),files:[video],skipped:0};
  });
  await add('a','video',2);
  await sql.query("UPDATE media_retention SET last_cutoff='2026-11-01T00:30:00',history_month='2025-09-01'");
  await new MediaRetention(runtime).checkDue();
  const deletes=requests.filter(r=>r.endpoint==='delete');
  assert.deepEqual(deletes.map(r=>r.data),[{source:id('a'),kind:'video',date:'2026-10-31',files:[video.id]}]);
});
