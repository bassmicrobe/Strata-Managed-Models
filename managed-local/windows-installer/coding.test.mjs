import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,readFileSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {configureCoding,codingState,refreshCodingPolicy,mergeCodingPolicy,CODING_TITLE} from './runtime/coding.mjs';

function fixture() {
  const dataRoot=mkdtempSync(join(tmpdir(),'strata-coding-'));
  return {dataRoot,profile:join(dataRoot,'profile')};
}
function server({chats=[],connections=[],workspaces=[]}={}) {
  const sessions=new Map(chats.map(chat=>[chat.id,structuredClone(chat)])),folders=new Map(),calls=[];
  const state={sessions,folders,workspaces:structuredClone(workspaces),connections,calls,fail:null,gate:null,agent:'idle'};
  state.fetch=async (url,options)=>{
    assert.equal(options.headers['x-strata-client'],'strata-managed-coding');
    const {pathname,searchParams}=new URL(url),method=options.method,body=options.body?JSON.parse(options.body):undefined;
    calls.push({path:pathname,method,body});
    if(state.gate)await state.gate;
    if(state.fail===method+' '+pathname){state.fail=null;return Response.json({error:'injected failure'},{status:503});}
    let value;
    if(pathname==='/api/agent/status')value={state:state.agent};
    else if(pathname==='/api/model-providers')value={connections};
    else if(pathname==='/api/chats')value={chats:[...sessions.values()].map(({id,updatedAt})=>({id,updatedAt}))};
    else if(pathname.startsWith('/api/chats/')) {
      const id=decodeURIComponent(pathname.slice('/api/chats/'.length));
      if(method==='PUT'){sessions.set(id,body);value={ok:true};}
      else if(sessions.has(id))value={session:structuredClone(sessions.get(id))};
      else return Response.json({error:'not found'},{status:404});
    } else if(pathname==='/api/chat/folder') {
      if(method==='POST'){folders.set(body.sessionId,{path:body.path,name:'Coding',exists:true});value={ok:true};}
      else value={folder:folders.get(searchParams.get('sessionId'))??null};
    } else if(pathname==='/api/workspaces') {
      if(method==='POST'){
        assert(!state.workspaces.some(w=>w.path===body.path),'workspace must not be registered twice');
        value={id:'ws_'+state.workspaces.length,name:'Coding',path:body.path};state.workspaces.push(value);
      } else value={workspaces:state.workspaces};
    } else if(pathname.startsWith('/api/workspaces/')&&method==='PATCH'){
      const current=state.workspaces.find(w=>w.id===decodeURIComponent(pathname.slice('/api/workspaces/'.length)));
      assert(current);Object.assign(current,body);value=current;
    } else throw Error('Unexpected request '+method+' '+pathname);
    return Response.json(value);
  };
  return state;
}
const record={port:8765};
const setup=(paths,api,options={})=>configureCoding(paths,record,{fetchImpl:api.fetch,...options});
const policyPath=paths=>join(paths.profile,'data/agent/home/AGENTS.md');

test('first use requires explicit consent and an installed Harness before it writes personal setup',async()=>{
  const paths=fixture(),api=server();
  await assert.rejects(()=>setup(paths,api),/confirm automatic execution/);
  assert.equal(api.calls.length,0);assert(!existsSync(join(paths.dataRoot,'coding.json')));assert(!existsSync(policyPath(paths)));
  api.agent='unavailable';await assert.rejects(()=>setup(paths,api,{accepted:true}),/unavailable/);
  assert(!existsSync(join(paths.dataRoot,'coding.json')));assert(!existsSync(policyPath(paths)));
});

test('an empty installation creates one pinned coding chat with a registered workspace and a model picker',async()=>{
  const paths=fixture(),api=server(),result=await setup(paths,api,{accepted:true});
  const saved=api.sessions.get(result.chatId);
  assert.equal(result.target,'#/chat/'+result.chatId);assert.equal(saved.title,CODING_TITLE);assert(saved.pinned);
  assert.deepEqual(saved.preferences,{mode:'bypass',agent:true,thinking:'High',thinkingBudget:0});
  assert.equal(saved.workspace,join(paths.dataRoot,'Workspace/Coding'));assert(existsSync(saved.workspace));
  assert.equal(api.folders.get(saved.id).path,saved.workspace);assert.equal(api.workspaces.length,1);assert.equal(api.workspaces[0].path,saved.workspace);
  assert.equal(api.workspaces[0].name,'コーディング');assert.equal(codingState(paths).consentVersion,1);
  const before=structuredClone(saved),calls=api.calls.length;
  assert.deepEqual(await setup(paths,api),result);assert.deepEqual(api.sessions.get(saved.id),before);
  assert.equal(api.workspaces.length,1);assert(api.calls.slice(calls).every(call=>call.method==='GET'));
});

test('the latest available saved remote selection is reused without changing other chats or models',async()=>{
  const old={id:'old',updatedAt:'2026-01-01',messages:[{text:'keep'}],preferences:{mode:'manual',remoteModel:{connectionId:'provider',modelId:'chosen'}}};
  const removed={id:'new',updatedAt:'2026-02-01',preferences:{remoteModel:{connectionId:'removed',modelId:'removed'}}};
  const paths=fixture(),api=server({chats:[old,removed],connections:[{id:'provider',models:[{id:'chosen'}]}]});
  const result=await setup(paths,api,{accepted:true});
  assert.deepEqual(api.sessions.get(result.chatId).preferences.remoteModel,old.preferences.remoteModel);
  assert.deepEqual(api.sessions.get(old.id),old);assert.deepEqual(api.sessions.get(removed.id),removed);
  assert(api.calls.filter(c=>c.method==='PUT').every(c=>c.path.endsWith(result.chatId)));
});

test('reopening preserves edited messages, title, permission mode, budget, model, and project folder',async()=>{
  const paths=fixture(),api=server(),result=await setup(paths,api,{accepted:true});
  const saved=api.sessions.get(result.chatId),folder=join(paths.dataRoot,'My project');mkdirSync(folder);
  Object.assign(saved,{title:'My edited title',pinned:false,messages:[{id:'real-message',content:'retain'}],workspace:folder});
  saved.preferences={mode:'manual',agent:false,thinkingBudget:6144,remoteModel:{connectionId:'user',modelId:'changed'}};
  api.folders.set(saved.id,{path:folder,exists:true});api.workspaces.push({id:'custom',path:folder,name:'My project name'});
  const before=structuredClone(saved),workspaces=structuredClone(api.workspaces),calls=api.calls.length;
  await setup(paths,api);assert.deepEqual(api.sessions.get(saved.id),before);assert.deepEqual(api.workspaces,workspaces);
  assert(api.calls.slice(calls).every(call=>call.method==='GET'));assert.equal(api.folders.get(saved.id).path,folder);
});

test('partial setup retries reuse the committed chat id and never replace saved user preferences',async()=>{
  const paths=fixture(),api=server();api.fail='POST /api/chat/folder';
  await assert.rejects(()=>setup(paths,api,{accepted:true}),/could not be saved/);
  const state=codingState(paths),saved=api.sessions.get(state.chatId);assert(saved);
  saved.preferences.mode='manual';saved.messages=[{id:'after-failure',content:'keep'}];
  const result=await setup(paths,api);assert.equal(result.chatId,state.chatId);assert.equal(api.sessions.size,1);
  assert.equal(api.sessions.get(state.chatId).preferences.mode,'manual');assert.equal(saved.messages[0].content,'keep');
  assert.equal(api.calls.filter(c=>c.method==='PUT').length,1);assert.equal(api.workspaces.length,1);
});

test('registered workspace survives a failed naming request without duplicate registration',async()=>{
  const paths=fixture(),api=server();api.fail='PATCH /api/workspaces/ws_0';
  await assert.rejects(()=>setup(paths,api,{accepted:true}),/could not be saved/);
  api.workspaces[0].name='User renamed it';
  await setup(paths,api);assert.equal(api.workspaces.length,1);assert.equal(api.workspaces[0].name,'User renamed it');
  assert.equal(api.calls.filter(c=>c.method==='POST'&&c.path==='/api/workspaces').length,1);
});

test('concurrent starts fail safely and the successful start remains the only creator',async()=>{
  const paths=fixture(),api=server();let resume;api.gate=new Promise(done=>{resume=done;});
  const first=setup(paths,api,{accepted:true});
  await assert.rejects(()=>setup(paths,api,{accepted:true}),/already running/);
  resume();await first;assert.equal(api.sessions.size,1);assert.equal(api.workspaces.length,1);
  assert(!existsSync(join(paths.dataRoot,'coding-setup.lock')));
});

test('managed instructions preserve surrounding user content and update idempotently',async()=>{
  const paths=fixture(),api=server();mkdirSync(join(paths.profile,'data/agent/home'),{recursive:true});
  const original='# Personal instructions\r\nKeep this exact sentence.\r\n';writeFileSync(policyPath(paths),original);
  await setup(paths,api,{accepted:true});const first=readFileSync(policyPath(paths),'utf8');assert(first.startsWith(original));
  assert(first.includes('command tool'));assert(first.includes('three correction-and-test attempts'));
  const withSuffix=first+'\r\nMy own appended rule.\r\n';writeFileSync(policyPath(paths),withSuffix);
  assert.equal(refreshCodingPolicy(paths),false);assert.equal(readFileSync(policyPath(paths),'utf8'),withSuffix);
  const outdated=withSuffix.replace('command tool','OLD POLICY TEXT');writeFileSync(policyPath(paths),outdated);
  assert(refreshCodingPolicy(paths));assert.equal(readFileSync(policyPath(paths),'utf8'),withSuffix);
});

test('unaccepted installs do not add policy and damaged managed markers are never overwritten',()=>{
  const paths=fixture();assert.equal(refreshCodingPolicy(paths),false);assert(!existsSync(policyPath(paths)));
  for(const text of ['personal\n<!-- strata-managed-coding:start -->','<!-- strata-managed-coding:end -->','<!-- strata-managed-coding:start --><!-- strata-managed-coding:start --><!-- strata-managed-coding:end -->'])assert.throws(()=>mergeCodingPolicy(text),/preserved/);
  writeFileSync(join(paths.dataRoot,'coding.json'),JSON.stringify({consentVersion:1,chatId:'other-persons-chat'}));
  assert.throws(()=>refreshCodingPolicy(paths),/invalid/);assert(!existsSync(policyPath(paths)));
});
