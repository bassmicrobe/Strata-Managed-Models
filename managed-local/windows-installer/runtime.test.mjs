import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync,copyFileSync,linkSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve,dirname} from 'node:path';
import {spawn,execFileSync} from 'node:child_process';
import {createServer} from 'node:net';
import {layout,hostEnvironment,releaseIsNew,bundledIsNewer,validateActive,isBusy,ownsProcess,processIdentity,main,stopHost} from './runtime/runtime.mjs';

const read=file=>JSON.parse(readFileSync(file,'utf8'));
function fixture({unicode=false}={}){
  const root=mkdtempSync(join(tmpdir(),'strata-managed-runtime-')),appRoot=join(root,unicode?'app 日本語':'app'),dataRoot=join(root,unicode?'data 日本語':'data');
  for(const path of ['host/server','host/dist','resources/node','resources/control/python'])mkdirSync(join(appRoot,path),{recursive:true});
  mkdirSync(dataRoot,{recursive:true});
  writeFileSync(join(appRoot,'host/server/index.mjs'),'// fixture');writeFileSync(join(appRoot,'host/dist/index.html'),'<div id="root"></div>');
  writeFileSync(join(appRoot,'managed-install.json'),JSON.stringify({version:'0.2.12',commit:'a'.repeat(40),releaseTag:'managed-v0.2.12-4'}));
  writeFileSync(join(appRoot,'resources/control/python/python.exe'),'fixture marker');
  return {root,appRoot,dataRoot,paths:layout({appRoot,dataRoot}),active:{version:'0.2.12',commit:'a'.repeat(40),releaseTag:'managed-v0.2.12-4',hostRoot:join(appRoot,'host')}};
}
function prepareNode(f){try{linkSync(process.execPath,f.paths.node);}catch{copyFileSync(process.execPath,f.paths.node);}writeFileSync(join(f.paths.host,'server/private-file.mjs'),'export function makePrivateDir(){}');}
function fakeHost(f,{busy=false,instance=false}={}){
  writeFileSync(join(f.paths.host,'server/index.mjs'),`import http from 'node:http';import{writeFileSync}from'node:fs';import{join,dirname}from'node:path';let busy=${busy},instance=${instance};
const native=()=>({available:true,instances:instance?[{id:'fixture-model',status:'ready',model:'user-choice'}]:[],jobs:[],capabilities:{componentUpdates:true}});
const server=http.createServer((req,res)=>{let value;if(req.url==='/') {res.end('<div id="root"></div>');return;}if(req.url==='/api/native')value=native();else if(req.url==='/api/serving')value={stats:{running:0,waiting:0}};else if(req.url==='/api/update-maintenance')value={enabled:true,active:false,activeRequests:busy?1:0};else if(req.url==='/api/model-providers')value={connections:[]};else if(req.url==='/api/chats')value={chats:[]};else if(req.url==='/clear'){busy=false;value={ok:true};}else if(req.url==='/api/native/instances/fixture-model/unload'){instance=false;writeFileSync(join(process.env.STRATA_WORKSPACE,'unload.json'),JSON.stringify({token:req.headers['x-strata-updater']}));value={ok:true};}else{res.writeHead(404);res.end();return;}res.setHeader('content-type','application/json');res.end(JSON.stringify(value));});
writeFileSync(join(dirname(process.env.STRATA_WORKSPACE),'environment.json'),JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([k])=>k.startsWith('STRATA_')))));
server.listen(Number(process.env.STRATA_PORT),'127.0.0.1');`);
  mkdirSync(join(f.dataRoot,'Workspace'),{recursive:true});
}
async function port(){const server=createServer();await new Promise(ok=>server.listen(0,'127.0.0.1',ok));const p=server.address().port;await new Promise(ok=>server.close(ok));return p;}

test('fresh package routes every model, profile and component setting to its own user-data tree',()=>{
  const f=fixture(),old=process.env.STRATA_MANAGED_MODELS_CONFIG;process.env.STRATA_MANAGED_MODELS_CONFIG='C:/unrelated/private/models.json';
  try{const env=hostEnvironment(f.paths,f.active,8792);for(const key of ['STRATA_HOME','STRATA_DATA_DIR','STRATA_STATE_DIR','STRATA_COMPONENTS_DIR','STRATA_INSTALL_DIR','STRATA_PROFILE_DIR','STRATA_RUNTIME_DIR','STRATA_SETTINGS_FILE','STRATA_MODELS_DIR','STRATA_WORKSPACE'])assert(env[key].startsWith(f.dataRoot),key);assert.equal(env.STRATA_MANAGED_MODELS_CONFIG,undefined);assert.equal(env.STRATA_NO_ACQUIRE,'1');assert.equal(env.STRATA_CONTROL_DIR,f.paths.control);assert.equal(env.STRATA_UPDATE_MAINTENANCE_FILE,f.paths.maintenanceFile);
    writeFileSync(join(f.dataRoot,'managed-models.json'),'{}');assert.equal(hostEnvironment(f.paths,f.active,8792).STRATA_MANAGED_MODELS_CONFIG,join(f.dataRoot,'managed-models.json'));
  }finally{if(old===undefined)delete process.env.STRATA_MANAGED_MODELS_CONFIG;else process.env.STRATA_MANAGED_MODELS_CONFIG=old;}
});
test('releases advance by numeric upstream version or fork build and never downgrade an installed setup',()=>{
  const active={version:'0.2.12',releaseTag:'managed-v0.2.12-9'};
  assert(releaseIsNew({version:'0.2.12',tag_name:'managed-v0.2.12-10'},active));assert(!releaseIsNew({version:'0.2.12',tag_name:'managed-v0.2.12-8'},active));
  assert(!releaseIsNew({version:'0.2.11',releaseId:9999,tag_name:'managed-v0.2.11-9999'},active));assert(releaseIsNew({version:'0.3.0',releaseId:1,tag_name:'managed-v0.3.0-1'},active));
  assert(bundledIsNewer({version:'0.2.12',releaseTag:'managed-v0.2.12-10'},{...active,releaseId:200}));assert(!bundledIsNewer({version:'0.2.11',releaseTag:'managed-v0.2.11-100'},active));
});
test('a saved application may only be the bundled host or a verified host slot under this user data',()=>{
  const f=fixture();assert.equal(validateActive(f.paths,f.active).hostRoot,f.paths.host);
  assert.throws(()=>validateActive(f.paths,{...f.active,commit:'g'.repeat(40)}));assert.throws(()=>validateActive(f.paths,{...f.active,hostRoot:join(f.root,'unrelated')}));
  assert.throws(()=>layout({appRoot:f.appRoot,dataRoot:join(f.appRoot,'profile')}));assert.throws(()=>layout({appRoot:f.appRoot,dataRoot:f.root}));
  const outside=join(f.root,'outside'),link=join(f.dataRoot,'host-versions','bad','apps','host');mkdirSync(join(outside,'server'),{recursive:true});mkdirSync(join(outside,'dist'),{recursive:true});writeFileSync(join(outside,'server/index.mjs'),'');writeFileSync(join(outside,'dist/index.html'),'');mkdirSync(dirname(link),{recursive:true});symlinkSync(outside,link,'junction');assert.throws(()=>validateActive(f.paths,{...f.active,hostRoot:link}));
});
test('remote streams, native generation, queued requests and lifecycle jobs all block installer shutdown',()=>{
  assert(isBusy({jobs:[],instances:[]},{stats:{}},{activeRequests:1}));assert(isBusy({jobs:[{state:'running'}],instances:[]},{stats:{}},{}));assert(isBusy({jobs:[],instances:[{metrics:{live:{queued:1}}}]},{stats:{}},{}));assert(isBusy({jobs:[],instances:[]},{stats:{running:1}},{}));assert(!isBusy({jobs:[],instances:[]},{stats:{}},{activeRequests:0}));
});
test('PID reuse, a foreign executable, altered creation time or an outside entry are never owned',()=>{
  const f=fixture(),record={pid:42,port:8792,entry:join(f.paths.host,'server/index.mjs'),executable:f.paths.node,created:'2026-11-08T00:00:00Z'},actual={pid:42,executable:f.paths.node,commandLine:'"'+f.paths.node+'" "'+record.entry+'"',created:record.created};
  assert(ownsProcess(f.paths,record,actual));for(const patch of [{pid:43},{executable:'C:/Windows/System32/notepad.exe'},{created:'another-time'},{commandLine:'other-entry'}])assert(!ownsProcess(f.paths,record,{...actual,...patch}));assert(!ownsProcess(f.paths,{...record,entry:join(f.root,'foreign/server/index.mjs')},actual));
});
test('the CIM query accepts only a numeric process identity and does not expose failed output',async()=>{
  let called=0;assert.equal(await processIdentity('42; malicious',{run:async()=>{called++;}}),null);assert.equal(called,0);
  const value=await processIdentity(42,{run:async(file,args)=>{assert.equal(file,'powershell.exe');assert(args.at(-1).includes('ProcessId = 42'));assert(args.at(-1).startsWith('[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);'));return '{"pid":42,"created":"checked"}';}});assert.equal(value.pid,42);assert.equal(await processIdentity(42,{run:async()=>{throw Error('private details');}}),null);
});
test('the real bundled-Node smoke starts an empty isolated host, records success, and leaves no process', {skip:process.platform!=='win32',timeout:90000},async()=>{
  const f=fixture();prepareNode(f);fakeHost(f);
  const result=await main(['--smoke'],{appRoot:f.appRoot,dataRoot:f.dataRoot});assert.equal(result.ok,true);assert.equal(result.controlAvailable,true);assert.equal(result.models,0);assert.equal(result.providers,0);assert.deepEqual(read(join(f.dataRoot,'smoke-result.json')),result);assert(!existsSync(f.paths.pidFile));
  const env=read(join(f.dataRoot,'environment.json'));assert.equal(env.STRATA_CONTROL_DIR,f.paths.control);assert.equal(env.STRATA_NO_ACQUIRE,'1');assert.equal(env.STRATA_MANAGED_MODELS_CONFIG,undefined);
});
test('desktop launch returns a ready local window URL without starting a browser', {skip:process.platform!=='win32',timeout:90000},async()=>{
  const f=fixture();prepareNode(f);fakeHost(f);let browserCalls=0;
  const options={appRoot:f.appRoot,dataRoot:f.dataRoot,openBrowser:async()=>{browserCalls++;}};
  try{
    const first=await main(['--desktop','--no-update'],options);const url=new URL(first.localUrl);
    assert.equal(url.hostname,'127.0.0.1');assert.equal(url.hash,'#/models');assert.equal(first.tailscaleUrl,null);
    const page=await fetch(url.origin,{signal:AbortSignal.timeout(5000)});assert(page.ok);assert((await page.text()).includes('id="root"'));
    const api=await main(['--desktop','--api','--no-update'],options);assert.equal(api.pid,first.pid);assert.equal(new URL(api.localUrl).hash,'#/settings?section=Models');assert.equal(browserCalls,0);
    const latest={...f.active,releaseId:99,tag_name:'managed-v0.2.12-5',installer:{name:'fixture-setup.exe'}};
    writeFileSync(f.paths.activeFile,JSON.stringify({...f.active,releaseId:99,releaseTag:latest.tag_name}));
    const notice=await main(['--desktop'],{...options,fetchRelease:async()=>latest});
    assert.equal(notice.pid,first.pid);assert.equal(notice.updateStatus,'current');assert.equal(notice.installedReleaseTag,'managed-v0.2.12-4');assert.equal(notice.latestInstallerTag,latest.tag_name);assert.equal(browserCalls,0);
  }finally{await stopHost(f.paths);}
});
test('the real owned-host shutdown refuses a remote stream, then unloads and stops only that host', {skip:process.platform!=='win32',timeout:90000},async()=>{
  const f=fixture();prepareNode(f);fakeHost(f,{busy:true,instance:true});const chosen=await port(),entry=join(f.paths.host,'server/index.mjs');
  const child=spawn(f.paths.node,[entry],{windowsHide:true,stdio:'ignore',env:hostEnvironment(f.paths,f.active,chosen)});
  try{
    let actual;for(let n=0;n<20&&!actual;n++){actual=await processIdentity(child.pid);if(!actual)await new Promise(ok=>setTimeout(ok,100));}
    const record={pid:child.pid,entry,port:chosen,executable:f.paths.node,created:actual.created};
    await assert.rejects(()=>stopHost(f.paths,{record}),/回答/);assert.doesNotThrow(()=>process.kill(child.pid,0));
    await fetch(`http://127.0.0.1:${chosen}/clear`);await stopHost(f.paths,{record,token:'private-updater-token'});
    assert.equal(read(join(f.dataRoot,'Workspace/unload.json')).token,'private-updater-token');assert.equal(await processIdentity(child.pid),null);
  }finally{if(child.exitCode===null)child.kill();}
});
test('Windows PowerShell CIM preserves Japanese and spaced process paths for owned-host shutdown', {skip:process.platform!=='win32',timeout:90000},async()=>{
  const f=fixture({unicode:true});prepareNode(f);fakeHost(f);const chosen=await port(),entry=join(f.paths.host,'server/index.mjs');
  const child=spawn(f.paths.node,[entry],{windowsHide:true,stdio:'ignore',env:hostEnvironment(f.paths,f.active,chosen)});
  try{
    let actual;for(let n=0;n<20&&!actual;n++){actual=await processIdentity(child.pid);if(!actual)await new Promise(ok=>setTimeout(ok,100));}
    assert(actual,'The Unicode process must be visible to CIM.');assert.equal(actual.executable.toLowerCase(),f.paths.node.toLowerCase());assert(actual.commandLine.includes('app 日本語'));
    const record={pid:child.pid,entry,port:chosen,executable:f.paths.node,created:actual.created};assert(ownsProcess(f.paths,record,actual));
    await stopHost(f.paths,{record});assert.equal(await processIdentity(child.pid),null);
  }finally{if(child.exitCode===null)child.kill();}
});
