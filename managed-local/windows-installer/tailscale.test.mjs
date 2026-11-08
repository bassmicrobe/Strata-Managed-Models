import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,writeFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {planTailscale,applyTailscale,disableTailscale,readTailscaleConfig,tailscaleOrigin,ownedMapping,TailscaleSetupError} from './runtime/tailscale.mjs';
import {hostEnvironment,layout,sharingRestartNeeded} from './runtime/runtime.mjs';

const DNS='test-pc.example-tail.ts.net';
const clone=value=>JSON.parse(JSON.stringify(value));
function fixture(initial={}){
  const dataRoot=mkdtempSync(join(tmpdir(),'strata-managed-tailscale-')),calls=[],c={config:clone(initial),status:{BackendState:'Running',Self:{DNSName:DNS+'.',ID:'node-id'}},failSet:false,funnelAfterSet:false,offLeavesConfig:false};
  const options={dataRoot,find:async()=>'/test/tailscale.exe',run:async(exe,args)=>{
    assert.equal(exe,'/test/tailscale.exe');calls.push([...args]);
    if(args[0]==='status')return{code:0,stdout:JSON.stringify(c.status)};
    if(args[0]==='serve'&&args[1]==='status')return{code:0,stdout:JSON.stringify(c.config)};
    const port=Number(args.find(a=>a.startsWith('--https='))?.split('=')[1]);assert([443,8443,9443].includes(port));
    if(args.at(-1)==='off'){
      if(!c.offLeavesConfig){delete c.config.TCP?.[port];delete c.config.Web?.[DNS+':'+port];delete c.config.AllowFunnel?.[DNS+':'+port];}
      return{code:0,stdout:''};
    }
    assert.deepEqual(args.slice(0,4),['serve','--bg','--https='+port,'--yes']);
    if(c.failSet)return{code:1,timedOut:true,stdout:'Serve is not enabled. To enable, visit https://login.tailscale.com/f/serve?node=node-id\nprivate-error-text'};
    c.config.TCP??={};c.config.TCP[port]={HTTPS:true};c.config.Web??={};c.config.Web[DNS+':'+port]={Handlers:{'/':{Proxy:args.at(-1)}}};
    if(c.funnelAfterSet){c.config.AllowFunnel??={};c.config.AllowFunnel[DNS+':'+port]=true;}
    return{code:0,stdout:'Available within your tailnet'};
  }};
  return{dataRoot,calls,c,options};
}
test('an absent client or signed-out client never changes Serve configuration',async()=>{
  const f=fixture();await assert.rejects(()=>planTailscale({...f.options,find:async()=>null}),/見つかりません/);assert.equal(f.calls.length,0);
  f.c.status={BackendState:'NeedsLogin'};await assert.rejects(()=>planTailscale(f.options),/サインイン/);assert.deepEqual(f.calls,[['status','--json']]);
});
test('sharing selects private HTTPS, verifies exact loopback target, persists opt-in and is idempotent',async()=>{
  const f=fixture(),plan=await planTailscale(f.options);assert.equal(plan.httpsPort,443);assert.equal(plan.url,'https://'+DNS);
  const record=await applyTailscale({...f.options,hostPort:8792,plan});assert.equal(record.target,'http://127.0.0.1:8792');assert(ownedMapping(f.c.config,record));assert.equal(readTailscaleConfig(f.dataRoot).url,plan.url);
  const writes=f.calls.filter(a=>a.includes('--bg')).length;await applyTailscale({...f.options,hostPort:8792,plan:await planTailscale(f.options)});assert.equal(f.calls.filter(a=>a.includes('--bg')).length,writes);
});
test('existing services and public Funnel on another port are left intact while a free private port is used',async()=>{
  const initial={TCP:{443:{HTTPS:true}},Web:{[DNS+':443']:{Handlers:{'/':{Proxy:'http://127.0.0.1:9999'}}}},AllowFunnel:{[DNS+':443']:true}},f=fixture(initial);
  const plan=await planTailscale(f.options);assert.equal(plan.httpsPort,8443);await applyTailscale({...f.options,hostPort:8792,plan});
  assert.deepEqual(f.c.config.TCP[443],initial.TCP[443]);assert.deepEqual(f.c.config.Web[DNS+':443'],initial.Web[DNS+':443']);assert.equal(f.c.config.AllowFunnel[DNS+':443'],true);
  await disableTailscale(f.options);assert.deepEqual(f.c.config.TCP[443],initial.TCP[443]);assert.deepEqual(f.c.config.Web[DNS+':443'],initial.Web[DNS+':443']);assert.equal(f.c.config.AllowFunnel[DNS+':443'],true);assert(!existsSync(join(f.dataRoot,'tailscale.json')));
});
test('foreground listeners reserve ports and a completely occupied candidate set refuses without mutation',async()=>{
  const f=fixture({TCP:{443:{TCPForward:'127.0.0.1:99'}},Foreground:{session:{TCP:{8443:{HTTPS:true}}}}});assert.equal((await planTailscale(f.options)).httpsPort,9443);
  f.c.config.TCP[9443]={HTTPS:true};await assert.rejects(()=>planTailscale(f.options),/使用中/);assert(!f.calls.some(a=>a.includes('--bg')));
});
test('a mapping changed after planning is never overwritten',async()=>{
  const f=fixture(),plan=await planTailscale(f.options);f.c.config.TCP={443:{TCPForward:'127.0.0.1:99'}};
  await assert.rejects(()=>applyTailscale({...f.options,hostPort:8792,plan}),/置き換えません/);assert(!f.calls.some(a=>a.includes('--bg')));assert(!existsSync(join(f.dataRoot,'tailscale.json')));
});
test('ownership on the old port cannot authorize replacing a newly occupied alternate port',async()=>{
  const f=fixture();await applyTailscale({...f.options,hostPort:8792,plan:await planTailscale(f.options)});const original=clone(f.c.config);
  f.c.config.Web[DNS+':443'].Handlers['/'].Proxy='http://127.0.0.1:9999';const plan=await planTailscale(f.options);assert.equal(plan.httpsPort,8443);
  f.c.config=original;f.c.config.TCP[8443]={TCPForward:'127.0.0.1:7777'};const writes=f.calls.filter(a=>a.includes('--bg')).length;
  await assert.rejects(()=>applyTailscale({...f.options,hostPort:8792,plan}),/置き換えません/);assert.equal(f.calls.filter(a=>a.includes('--bg')).length,writes);assert.equal(f.c.config.TCP[8443].TCPForward,'127.0.0.1:7777');
});
test('HTTPS consent failures retain an actionable official URL and never save an unverified opt-in',async()=>{
  const f=fixture(),plan=await planTailscale(f.options);f.c.failSet=true;
  await assert.rejects(()=>applyTailscale({...f.options,hostPort:8792,plan}),err=>err instanceof TailscaleSetupError&&err.actionUrl==='https://login.tailscale.com/f/serve?node=node-id'&&err.message.includes('もう一度')&&!err.message.includes('private-error-text'));
  assert(!existsSync(join(f.dataRoot,'tailscale.json')));
});
test('a result with Funnel enabled is rejected and only its exact new mapping is cleaned up',async()=>{
  const f=fixture(),plan=await planTailscale(f.options);f.c.funnelAfterSet=true;await assert.rejects(()=>applyTailscale({...f.options,hostPort:8792,plan}),/非公開共有/);assert(f.calls.some(a=>a.at(-1)==='off'));assert(!existsSync(join(f.dataRoot,'tailscale.json')));assert(!f.c.config.TCP[443]);
});
test('normal startup reuses the saved URL while updating only the owned proxy backend port',async()=>{
  const f=fixture();await applyTailscale({...f.options,hostPort:8792,plan:await planTailscale(f.options)});
  const plan=await planTailscale(f.options);await applyTailscale({...f.options,hostPort:8811,plan});assert.equal(readTailscaleConfig(f.dataRoot).target,'http://127.0.0.1:8811');assert.equal(plan.url,'https://'+DNS);
});
test('disable is a no-op without opt-in, refuses unrelated changes, and confirms that its port was removed',async()=>{
  const f=fixture();assert.deepEqual(await disableTailscale({...f.options,find:async()=>{throw Error('must not inspect client');}}),{disabled:true,changed:false});assert.equal(f.calls.length,0);
  await applyTailscale({...f.options,hostPort:8792,plan:await planTailscale(f.options)});f.c.config.Web[DNS+':443'].Handlers['/extra']={Text:'unrelated'};
  await assert.rejects(()=>disableTailscale(f.options),/削除しません/);assert(!f.calls.some(a=>a.at(-1)==='off'));
  delete f.c.config.Web[DNS+':443'].Handlers['/extra'];f.c.offLeavesConfig=true;await assert.rejects(()=>disableTailscale(f.options),/停止を確認/);assert(existsSync(join(f.dataRoot,'tailscale.json')));
  f.c.offLeavesConfig=false;assert.deepEqual(await disableTailscale(f.options),{disabled:true,changed:true});
});
test('a saved Funnel endpoint is not silently re-enabled and another node cannot take ownership',async()=>{
  const f=fixture();await applyTailscale({...f.options,hostPort:8792,plan:await planTailscale(f.options)});f.c.config.AllowFunnel={[DNS+':443']:true};await assert.rejects(()=>planTailscale(f.options),/Funnel/);
  await disableTailscale(f.options);await applyTailscale({...f.options,hostPort:8792,plan:await planTailscale(f.options)});f.c.status.Self.ID='another-node';await assert.rejects(()=>planTailscale(f.options),/端末/);
});
test('host origins are exact validated ts.net HTTPS values and smoke never inherits or reads sharing state',()=>{
  for(const url of ['http://'+DNS,'https://example.com','https://'+DNS+'/path','https://'+DNS+'?x=1','https://user:password@'+DNS,'https://'+DNS+':80'])assert.throws(()=>tailscaleOrigin(url));
  const f=fixture(),paths=layout({appRoot:join(f.dataRoot,'..','package-app'),dataRoot:f.dataRoot}),active={version:'0.2.12'};
  const old=process.env.STRATA_TAILSCALE_ORIGIN;process.env.STRATA_TAILSCALE_ORIGIN='https://untrusted.ts.net';
  try{assert.equal(hostEnvironment(paths,active,8792,{smoke:true}).STRATA_TAILSCALE_ORIGIN,undefined);assert.equal(hostEnvironment(paths,active,8792).STRATA_TAILSCALE_ORIGIN,undefined);
    writeFileSync(join(f.dataRoot,'tailscale.json'),JSON.stringify({schema_version:1,owner:'strata-managed-models',enabled:true,hostname:DNS,httpsPort:8443,url:'https://'+DNS+':8443',hostPort:8792,target:'http://127.0.0.1:8792'}));
    assert.equal(hostEnvironment(paths,active,8792).STRATA_TAILSCALE_ORIGIN,'https://'+DNS+':8443');assert.equal(hostEnvironment(paths,active,8792,{smoke:true}).STRATA_TAILSCALE_ORIGIN,undefined);
    assert(sharingRestartNeeded({tailscaleOrigin:''},'https://'+DNS));assert(!sharingRestartNeeded({tailscaleOrigin:'https://'+DNS},'https://'+DNS));assert(sharingRestartNeeded({tailscaleOrigin:'https://'+DNS},''));
  }finally{if(old===undefined)delete process.env.STRATA_TAILSCALE_ORIGIN;else process.env.STRATA_TAILSCALE_ORIGIN=old;}
});
