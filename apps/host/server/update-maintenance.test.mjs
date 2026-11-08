import test from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createServer} from 'node:http';
import {resolve} from 'node:path';
import {createUpdateMaintenance} from './update-maintenance.mjs';

const id='private-updater-lease-identifier';
const request=(headers={})=>({headers,aborted:false});
class Response extends EventEmitter{
  destroyed=false;
  writeHead(status,headers){this.status=status;this.headers=headers;}
  end(body){this.body=body;this.emit('finish');}
}
function setup(){let value={pid:process.pid,id,expiresAt:2000};const guard=createUpdateMaintenance({file:resolve('lease.json'),read:()=>JSON.stringify(value),now:()=>1000,alive:()=>true});return{guard,set:value2=>{value=value2;}};}

test('disabled maintenance does not read files, block or track existing host operations',()=>{
  const guard=createUpdateMaintenance({file:'',read:()=>{throw Error('No file may be read.');}}),res=new Response();
  assert.equal(guard.handle(request(),res,'/api/chat/stream','POST'),false);
  assert.equal(res.listenerCount('finish'),0);assert.deepEqual(guard.state(),{enabled:false,active:false,activeRequests:0});
  assert.equal(guard.handle(request(),res,'/api/update-maintenance','GET'),true);assert.deepEqual(JSON.parse(res.body),guard.state());
  assert.throws(()=>createUpdateMaintenance({file:'relative.json'}),/absolute/);
});

test('only a live, well-formed, unexpired lease can block mutations and no lease identity is public',()=>{
  const f=setup();assert.deepEqual(f.guard.state(),{enabled:true,active:true,activeRequests:0});
  const res=new Response();assert.equal(f.guard.handle(request(),res,'/api/native/operations','POST'),true);assert.equal(res.status,503);
  const publicResponse=new Response();f.guard.handle(request(),publicResponse,'/api/update-maintenance','GET');assert(!publicResponse.body.includes(id));assert(!publicResponse.body.includes(String(process.pid)));
  for(const value of [null,{}, {pid:0,id,expiresAt:2000},{pid:process.pid,id:'',expiresAt:2000},{pid:process.pid,id,expiresAt:1000},{pid:process.pid,id,expiresAt:'not-a-date'},{pid:'123',id,expiresAt:2000}]){f.set(value);assert.equal(f.guard.state().active,false);}
  const dead=createUpdateMaintenance({file:resolve('lease.json'),read:()=>JSON.stringify({pid:999,id,expiresAt:2000}),now:()=>1000,alive:()=>false});assert.equal(dead.state().active,false);
  const malformed=createUpdateMaintenance({file:resolve('lease.json'),read:()=>'{not json',alive:()=>true});assert.equal(malformed.state().active,false);
  const iso=createUpdateMaintenance({file:resolve('lease.json'),read:()=>JSON.stringify({pid:process.pid,id,expiresAt:'2099-01-01T00:00:00Z'}),alive:()=>true});assert.equal(iso.state().active,true);
});

test('active maintenance permits chat autosaves and reads but only the private updater identity may mutate controls',()=>{
  const {guard}=setup();
  for(const [method,path] of [['GET','/api/native'],['HEAD','/v1/models'],['OPTIONS','/api/native/operations'],['PUT','/api/chats/saved-chat']]){const res=new Response();assert.equal(guard.handle(request(),res,path,method),false);assert.equal(guard.state().activeRequests,0);}
  for(const [method,path] of [['POST','/api/chat/stream'],['POST','/api/internal/agent-llm/chat/completions'],['POST','/v1/chat/completions'],['DELETE','/api/native/instances/a'],['PUT','/api/chats/saved-chat/files'],['PATCH','/api/models']]){const res=new Response();assert.equal(guard.handle(request({'x-strata-updater':'wrong'}),res,path,method),true);assert.equal(res.status,503);}
  const authorized=new Response();assert.equal(guard.handle(request({'x-strata-updater':id}),authorized,'/api/native/operations','POST'),false);assert.equal(guard.state().activeRequests,0);
});

test('accepted mutation ownership ends at finish or disconnect, exactly once, while native 202 jobs remain a separate check',()=>{
  const f=setup();f.set(null);
  for(const path of ['/api/chat/stream','/api/internal/agent-llm/stream','/v1/responses','/api/native/operations','/api/model-providers']){
    const res=new Response();assert.equal(f.guard.handle(request(),res,path,'POST'),false);assert.equal(f.guard.state().activeRequests,1);
    f.set({pid:process.pid,id,expiresAt:2000});assert.equal(f.guard.state().activeRequests,1);assert.equal(f.guard.state().active,true);
    res.emit('close');res.emit('finish');assert.equal(f.guard.state().activeRequests,0);assert.equal(res.listenerCount('finish'),0);assert.equal(res.listenerCount('close'),0);f.set(null);
  }
  const job=new Response();f.guard.handle(request(),job,'/api/native/operations','POST');job.writeHead(202,{});job.end('{"state":"running"}');assert.equal(f.guard.state().activeRequests,0);
  const gone=new Response();gone.destroyed=true;assert.equal(f.guard.handle(request(),gone,'/api/native/operations','POST'),true);assert.equal(f.guard.state().activeRequests,0);
  assert.equal(f.guard.handle({...request(),aborted:true},new Response(),'/api/chat/stream','POST'),true);assert.equal(f.guard.state().activeRequests,0);
});

test('an old HTTP stream finishes during maintenance while new inference is refused and a client disconnect releases ownership',async t=>{
  const f=setup();f.set(null);const held=[];let called=0;
  const server=createServer((req,res)=>{
    const path=new URL(req.url,'http://127.0.0.1').pathname;if(f.guard.handle(req,res,path))return;
    called++;
    if(path==='/api/chat/stream'){res.writeHead(200,{'content-type':'text/plain'});res.write('started');held.push(res);return;}
    req.resume();res.writeHead(200,{'content-type':'application/json'});res.end('{"ok":true}');
  });
  await new Promise((ok,bad)=>{server.once('error',bad);server.listen(0,'127.0.0.1',ok);});
  t.after(()=>{server.closeAllConnections();server.close();});const base=`http://127.0.0.1:${server.address().port}`;
  const streaming=await fetch(base+'/api/chat/stream',{method:'POST'});assert.equal(f.guard.state().activeRequests,1);
  f.set({pid:process.pid,id,expiresAt:2000});
  const publicState=await(await fetch(base+'/api/update-maintenance')).json();assert.deepEqual(publicState,{enabled:true,active:true,activeRequests:1});
  assert.equal((await fetch(base+'/v1/chat/completions',{method:'POST'})).status,503);
  assert.equal((await fetch(base+'/api/chats/existing',{method:'PUT',body:'{}'})).status,200);
  assert.equal((await fetch(base+'/api/native/operations',{method:'POST',headers:{'x-strata-updater':id}})).status,200);
  assert.equal(called,3);assert.equal(f.guard.state().activeRequests,1);
  held[0].end('finished');assert.equal(await streaming.text(),'startedfinished');assert.equal(f.guard.state().activeRequests,0);
  f.set(null);const controller=new AbortController();const abandoned=await fetch(base+'/api/chat/stream',{method:'POST',signal:controller.signal});assert.equal(f.guard.state().activeRequests,1);controller.abort();await abandoned.text().catch(()=>{});
  for(let n=0;n<20&&f.guard.state().activeRequests;n++)await new Promise(ok=>setTimeout(ok,5));
  assert.equal(f.guard.state().activeRequests,0);
});
