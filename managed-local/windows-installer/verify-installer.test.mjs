import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createModelProviders} from '../../apps/host/server/model-providers.mjs';
import {createChatStore} from '../../apps/host/server/chat-store.mjs';
import {exerciseInstalledProfile} from './verify-installer.mjs';

async function profileServer(directory,calls){
  const providers=createModelProviders({directory}),chats=createChatStore({dir:directory});
  const server=createServer(async(req,res)=>{
    const path=new URL(req.url,'http://127.0.0.1').pathname;calls.push(req.method+' '+path);
    const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    try{
      assert.equal(req.headers['x-strata-client'],'installer-persistence-test');
      if(path==='/api/native')return send(200,{instances:[],capabilities:{componentUpdates:true}});
      if(path==='/api/model-providers'&&req.method==='GET')return send(200,providers.list());
      const body=async()=>{let text='';for await(const part of req)text+=part;return text;};
      if(path==='/api/model-providers'&&req.method==='POST'){
        const value=JSON.parse(await body());assert(value.models.every(model=>model.vision===false&&model.reasoning===false));
        return send(200,providers.save(value));
      }
      const chat=/^\/api\/chats\/([^/]+)$/.exec(path);
      if(chat&&req.method==='PUT')return send(200,await chats.save(chat[1],await body()));
      if(chat&&req.method==='GET'){const stored=await chats.read(chat[1]);return stored?send(200,JSON.parse(stored)):send(404,{error:'not found'});}
      send(404,{error:'No inference or model-download endpoint is provided by this fixture.'});
    }catch(error){send(500,{error:error.message});}
  });
  await new Promise((done,failed)=>{server.once('error',failed);server.listen(0,'127.0.0.1',done);});
  return{port:server.address().port,providers,stop:()=>new Promise(done=>{server.closeAllConnections();server.close(done);})};
}

test('installer persistence fixture uses real provider/chat stores, survives a recreated host, and never asks for inference or weights',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'strata-installer-profile-')),calls=[];
  let server=await profileServer(directory,calls);
  try{
    const fixture=await exerciseInstalledProfile(server.port);
    assert.equal(fixture.session.messages.length,1);assert.equal(fixture.session.messages[0].role,'user');
    const providerFile=join(directory,'model-providers.json'),chatFile=join(directory,'chats',fixture.session.id+'.json');
    const providerBytes=readFileSync(providerFile),chatBytes=readFileSync(chatFile);
    await server.stop();server=await profileServer(directory,calls);
    await exerciseInstalledProfile(server.port,{expected:fixture});
    assert.deepEqual(readFileSync(providerFile),providerBytes);assert.deepEqual(readFileSync(chatFile),chatBytes);
    assert.deepEqual(calls.filter(call=>!call.startsWith('GET ')),['POST /api/model-providers','PUT /api/chats/installer-persistence-fixture']);
    assert(calls.every(call=>/^GET \/api\/(?:native|model-providers|chats\/installer-persistence-fixture)$/.test(call)||call==='POST /api/model-providers'||call==='PUT /api/chats/installer-persistence-fixture'));
  }finally{await server.stop();}
});

test('a retained marker cannot hide missing user-selected models after restart',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'strata-installer-profile-')),calls=[],server=await profileServer(directory,calls);
  try{
    const fixture=await exerciseInstalledProfile(server.port);server.providers.remove(fixture.providerId);
    await assert.rejects(exerciseInstalledProfile(server.port,{expected:fixture}),/Saved API connection disappeared/);
    assert.deepEqual(JSON.parse(readFileSync(join(directory,'chats',fixture.session.id+'.json'))).session,fixture.session);
  }finally{await server.stop();}
});
