import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:https';
import {createServer as tcp} from 'node:net';
import {once} from 'node:events';
import {execFileSync,spawn} from 'node:child_process';
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {WebSocketServer} from 'ws';
import {bridgeSchema} from '../dist/server/config.js';
import {testBridge} from '../dist/server/bridge-test.js';
import {launch,fixtureBridge,eventually,serviceToken,uuid} from './support.mjs';

const port = async () => {
  const listener=tcp().listen(0,'127.0.0.1');await once(listener,'listening');
  const value=listener.address().port;await new Promise(resolve=>listener.close(resolve));return value;
};
test('bridge tests check draft endpoints independently without saving or sending camera commands',async t=>{
  const fixture=await fixtureBridge({websocket:true});t.after(()=>fixture.close());
  const {app,runtime,incoming,seed,signIn}=await launch({bridges:[{...fixture.config,cameraIds:[]}]});t.after(()=>app.close());
  await seed({username:'connection-test-admin',admin:true});await seed({username:'connection-test-viewer'});
  const headers=await signIn('connection-test-admin'),viewer=await signIn('connection-test-viewer');
  await eventually(()=>runtime.bridges.get('lab').feedReady);
  const bridge=runtime.bridges.get('lab');
  const draft={...fixture.config,http:{url:fixture.config.http.url},id:'lab'};
  const run=(configuration,auth=headers)=>incoming({method:'POST',path:'/admin/bridges/test',headers:auth,payload:{configuration}});
  assert.equal((await run(draft,viewer)).statusCode,403);
  const result=await run({...draft,cameraIds:[]});
  assert.equal(result.statusCode,200,result.body);
  assert.deepEqual(result.json().results.map(item=>item.status),['passed','passed','passed']);
  assert.equal(result.json().cameraCount,2);
  assert.equal(runtime.bridges.size,1);assert.equal(runtime.bridges.get('lab'),bridge);assert.equal(bridge.feedReady,true);
  assert.equal(fixture.counts().writes,0);
  assert.ok(!result.body.includes(serviceToken));
  const bad=await run({...draft,http:{url:fixture.config.http.url,token:'intentionally-incorrect-fixture-token'}});
  assert.equal(bad.json().results[0].failure,'authorization');
  assert.equal(bad.json().results[2].status,'passed');
  const refused=await port();
  const mqttBad=await run({...draft,mqtt:{url:'mqtt://127.0.0.1:'+refused,baseTopic:'fixture'}});
  assert.equal(mqttBad.json().results[0].status,'passed');
  assert.equal(mqttBad.json().results[1].status,'passed');
  assert.equal(mqttBad.json().results[2].status,'failed');
  assert.equal(fixture.counts().writes,0);
});

test('HTTP, WS and MQTT accept optional trust anchors or per-connection disabled verification',async t=>{
  const directory=await mkdtemp(join(tmpdir(),'wui-connection-tls-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const key=join(directory,'key.pem'),cert=join(directory,'cert.pem');
  execFileSync('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',key,'-out',cert,'-days','1','-subj','/CN=Connection fixture','-addext','subjectAltName=IP:127.0.0.1'],{stdio:'ignore'});
  const ca=await readFile(cert,'utf8');
  const server=createServer({key:await readFile(key),cert:ca},(req,res)=>{
    if(req.headers.authorization!=='Bearer '+serviceToken){res.statusCode=401;return res.end('{}');}
    res.end(JSON.stringify(req.url==='/api/contract'?{version:1,inventory:true}:{cameras:[{id:'alpha',active:true}]}));
  });
  const sockets=new WebSocketServer({server,path:'/ws'});
  sockets.on('connection',socket=>socket.on('message',data=>{
    const message=JSON.parse(data);socket.send(JSON.stringify({id:message.id,ok:true,snapshots:[]}));
  }));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  t.after(async()=>{for(const socket of sockets.clients)socket.terminate();sockets.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));});
  const http={url:'https://127.0.0.1:'+server.address().port,token:serviceToken};
  const evaluate=options=>testBridge({config:bridgeSchema.parse({id:'tls',label:'TLS fixture',http:{...http,...options}})});
  const defaults=await evaluate({});
  assert.deepEqual(defaults.results.slice(0,2).map(item=>item.failure),['tls','tls']);
  for(const options of [{rejectUnauthorized:false},{ca}]) {
    const result=await evaluate(options);
    assert.deepEqual(result.results.map(item=>item.status),['passed','passed','disabled']);
  }
  const independent=await testBridge({config:bridgeSchema.parse({
    id:'tls',label:'Independent TLS',http:{...http,rejectUnauthorized:false},
    ws:{url:http.url.replace('https:','wss:')+'/ws',token:serviceToken}
  })});
  assert.equal(independent.results[0].status,'passed');assert.equal(independent.results[1].failure,'tls');

  const mqttPort=await port(),file=join(directory,'mosquitto.conf');
  await writeFile(file,'listener '+mqttPort+' 127.0.0.1\nallow_anonymous true\ncertfile '+cert+'\nkeyfile '+key+'\n');
  const broker=spawn('mosquitto',['-c',file],{stdio:'ignore'});
  t.after(async()=>{if(broker.exitCode===null){broker.kill();await once(broker,'exit');}});
  await eventually(async()=>new Promise(resolve=>{
    const connection=tcpConnection(mqttPort);connection.once('connect',()=>{connection.destroy();resolve(true);});connection.once('error',()=>resolve(false));
  }));
  const mqtt={url:'mqtts://127.0.0.1:'+mqttPort,baseTopic:'fixture'};
  for(const [options,expected] of [[{},'failed'],[{rejectUnauthorized:false},'passed'],[{ca},'passed']]) {
    const result=await testBridge({config:bridgeSchema.parse({id:'mqtt-tls',label:'MQTT TLS',cameraIds:['alpha'],mqtt:{...mqtt,...options}})});
    assert.equal(result.results[2].status,expected,JSON.stringify(result));
  }
});
// The fixture TCP connection tests listener readiness without issuing broker commands.
import {connect as tcpConnectionRaw} from 'node:net';
const tcpConnection=port=>tcpConnectionRaw({host:'127.0.0.1',port});
