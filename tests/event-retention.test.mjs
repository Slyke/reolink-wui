import {test} from 'node:test';
import assert from 'node:assert/strict';
import {setTimeout as wait} from 'node:timers/promises';
import {Redis} from 'ioredis';
import {createServer} from 'node:tls';
import {connect} from 'node:net';
import {once} from 'node:events';
import {execFileSync} from 'node:child_process';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {launch,fixtureBridge,eventually,uuid} from './support.mjs';

test('Valkey supports independent per-camera count and age limits and migrates list history', {skip:!process.env.WUI_TEST_VALKEY}, async t=>{
  const fixture=await fixtureBridge();t.after(()=>fixture.close());
  const {app,runtime,incoming,seed,signIn}=await launch({bridges:[fixture.config],eventHistory:{backend:'memory',retention:2}});
  t.after(()=>app.close());
  await seed({username:'retention-admin',admin:true});const headers=await signIn('retention-admin');
  const prefix='retention-'+uuid();
  const valkey={url:process.env.WUI_TEST_VALKEY,keyPrefix:prefix};
  const redis=new Redis(valkey.url);t.after(()=>redis.disconnect());
  const event=(type,observedAt=Date.now())=>({id:uuid(),observedAt,event:{type,active:true}});
  const old=event('legacy');
  await redis.sadd(prefix+':events:cameras',prefix+':events:camera:lab/alpha');
  await redis.lpush(prefix+':events:camera:lab/alpha',JSON.stringify(old));
  const configure=async options=>{
    const response=await incoming({method:'PUT',path:'/admin/event-history',headers,payload:{
      operationId:uuid(),limit:2,storage:{mode:'valkey',valkey:{...valkey,...options}}
    }});
    assert.equal(response.statusCode,200,response.body);assert.equal(response.json().outcome,'confirmed',response.body);
    return response.json().data;
  };
  await configure({maxEvents:3,ttlSeconds:null});
  assert.equal(await redis.type(prefix+':events:camera:lab/alpha'),'zset');
  assert.equal((await runtime.history.read({camera:'lab/alpha'})).events[0].id,old.id);
  for(let i=0;i<5;i++) for(const camera of ['alpha','beta']) runtime.history.add({camera:'lab/'+camera,entry:event(camera+'-'+i)});
  for(const camera of ['alpha','beta']) await eventually(async()=>{
    const result=await runtime.history.read({camera:'lab/'+camera});
    if(result.events.length!==3 || result.events.at(-1).event.type!==camera+'-4') return false;
    assert.deepEqual(result.events.map(item=>item.event.type),[camera+'-2',camera+'-3',camera+'-4']);
    return true;
  });
  const memoryLimit=(await incoming({path:'/admin/event-history',headers})).json().limit;
  assert.equal(memoryLimit,2);
  await configure({maxEvents:null,ttlSeconds:1});
  for(let i=0;i<5;i++) runtime.history.add({camera:'lab/alpha',entry:event('time-only-'+i)});
  runtime.history.add({camera:'lab/alpha',entry:event('expired-in-past',Date.now()-2000)});
  await eventually(async()=>{
    const result=await runtime.history.read({camera:'lab/alpha'});
    return result.events.filter(item=>item.event.type.startsWith('time-only')).length===5
      && !result.events.some(item=>item.event.type==='expired-in-past');
  });
  await wait(1100);
  assert.equal((await runtime.history.read({camera:'lab/alpha'})).events.length,0);
  await configure({maxEvents:2,ttlSeconds:1});
  for(let i=0;i<4;i++) runtime.history.add({camera:'lab/beta',entry:event('both-'+i)});
  await eventually(async()=>(await runtime.history.read({camera:'lab/beta'})).events.length===2);
  await wait(1100);
  assert.equal((await runtime.history.read({camera:'lab/beta'})).events.length,0);
  const invalid=await incoming({method:'PUT',path:'/admin/event-history',headers,payload:{operationId:uuid(),limit:2,
    storage:{mode:'valkey',valkey:{...valkey,maxEvents:null,ttlSeconds:null}}}});
  assert.equal(invalid.statusCode,400);
  await incoming({method:'PUT',path:'/admin/event-history',headers,payload:{operationId:uuid(),limit:2,storage:{mode:'memory'}}});
  for(let i=0;i<4;i++) runtime.history.add({camera:'lab/alpha',entry:event('memory-'+i)});
  assert.deepEqual((await runtime.history.read({camera:'lab/alpha'})).events.map(item=>item.event.type),['memory-2','memory-3']);
});

test('Valkey TLS supports verification, a self-signed trust anchor and disabled verification', {skip:!process.env.WUI_TEST_VALKEY},async t=>{
  const directory=await mkdtemp(join(tmpdir(),'wui-valkey-tls-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const key=join(directory,'key.pem'),cert=join(directory,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=Valkey fixture','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  const upstream=new URL(process.env.WUI_TEST_VALKEY),connections=new Set();
  const server=createServer({key:await readFile(key),cert:await readFile(cert)},socket=>{
    const peer=connect({host:upstream.hostname,port:Number(upstream.port)});
    connections.add(socket);connections.add(peer);
    socket.on('error',()=>peer.destroy());peer.on('error',()=>socket.destroy());
    socket.once('close',()=>{connections.delete(socket);peer.destroy();});
    peer.once('close',()=>{connections.delete(peer);socket.destroy();});
    socket.pipe(peer).pipe(socket);
  });
  server.on('tlsClientError',()=>{});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{for(const socket of connections)socket.destroy();await new Promise(resolve=>server.close(resolve));});
  upstream.protocol='rediss:';upstream.hostname='127.0.0.1';upstream.port=String(server.address().port);
  const {app,runtime,incoming,seed,signIn}=await launch();t.after(()=>app.close());
  await seed({username:'valkey-tls-admin',admin:true});const headers=await signIn('valkey-tls-admin');
  const configure=async options=>{
    const response=await incoming({method:'PUT',path:'/admin/event-history',headers,payload:{operationId:uuid(),limit:3,
      storage:{mode:'valkey',valkey:{url:upstream.href,keyPrefix:'tls-'+uuid(),...options}}}});
    assert.equal(response.json().outcome,'confirmed',response.body);return response.json().data;
  };
  assert.equal((await configure({})).connected,false);
  assert.equal((await configure({rejectUnauthorized:false})).connected,true);
  assert.equal((await configure({ca:await readFile(cert,'utf8')})).connected,true);
  assert.equal((await runtime.history.settings()).limit,3);
});
