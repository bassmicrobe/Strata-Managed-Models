import test from 'node:test';
import assert from 'node:assert/strict';
import {copyFileSync,existsSync,mkdtempSync,readFileSync,writeFileSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createServer} from 'node:http';
import {createModelProviders} from '../../apps/host/server/model-providers.mjs';
import {createChatStore} from '../../apps/host/server/chat-store.mjs';
import {cleanPcEnvironment,exerciseInstalledProfile,runInstallerTest,waitForRemovedFiles} from './verify-installer.mjs';

test('the clean-PC fixture removes every inherited ProgramFiles alias and PATH casing without changing its source',()=>{
  const source={SYSTEMROOT:'C:/Windows',PROGRAMFILES:'optional-upper',ProgramFiles:'optional-title',programfiles:'optional-lower',PROGRAMW6432:'optional-64',ProgramW6432:'optional-64-title','PROGRAMFILES(X86)':'optional-32',PATH:'developer-upper',Path:'developer-title',path:'developer-lower',KEEP:'retained'};
  const saved={...source},root=join(tmpdir(),'strata-clean-pc'),env=cleanPcEnvironment(source,root);
  assert.deepEqual(source,saved);assert.equal(env.KEEP,'retained');
  for(const name of ['ProgramFiles','ProgramFiles(x86)','ProgramW6432']){
    assert.deepEqual(Object.keys(env).filter(key=>key.toLowerCase()===name.toLowerCase()),[name]);
    assert.equal(env[name],join(root,'without-optional-powershell'));
  }
  assert.deepEqual(Object.keys(env).filter(key=>key.toLowerCase()==='path'),['PATH']);
  assert.equal(env.ProgramFiles,join(root,'without-optional-powershell'));
  assert.equal(env.PATH,[join(source.SYSTEMROOT,'System32'),join(source.SYSTEMROOT,'System32/WindowsPowerShell/v1.0')].join(';'));
});

test('a real Windows child cannot reconstruct optional PowerShell paths from CI casing or ProgramW6432',{skip:process.platform!=='win32'},()=>{
  const root=mkdtempSync(join(tmpdir(),'strata-clean-pc-'));
  const inherited={...process.env,PROGRAMFILES:'ci-optional-powershell',ProgramFiles:'local-optional-powershell',programfiles:'other-optional-powershell',PROGRAMW6432:'ci-optional-64',ProgramW6432:'optional-64','PROGRAMFILES(X86)':'ci-optional-32',PATH:'ci-developer-path',Path:'other-developer-path'};
  const env=cleanPcEnvironment(inherited,root);
  const child=JSON.parse(execFileSync(process.execPath,['-e',"process.stdout.write(JSON.stringify({programFiles:process.env.ProgramFiles,programW6432:process.env.ProgramW6432,programFilesX86:process.env['ProgramFiles(x86)'],path:process.env.PATH}))"],{env,windowsHide:true,encoding:'utf8'}));
  for(const key of ['programFiles','programW6432','programFilesX86'])assert.equal(child[key],join(root,'without-optional-powershell'));
  assert.equal(child.path,env.PATH);
});

test('uninstall waits for every owned application tree after its temporary process takes over',async()=>{
  const remaining=new Set(['launcher','resources','uninstaller']);let elapsed=0,polls=0;
  await waitForRemovedFiles([...remaining],{timeoutMs:100,pollMs:10,exists:file=>remaining.has(file),now:()=>elapsed,sleep:async ms=>{
    elapsed+=ms;polls++;remaining.delete(polls===1?'launcher':polls===2?'resources':'uninstaller');
  }});
  assert.equal(polls,3);assert.equal(elapsed,30);
});

test('uninstall waiting is bounded and reports the remaining application files',async()=>{
  let elapsed=0;
  await assert.rejects(waitForRemovedFiles(['resources'],{timeoutMs:20,pollMs:10,exists:()=>true,now:()=>elapsed,sleep:async ms=>{elapsed+=ms;}}),/did not finish.*resources/);
  assert.equal(elapsed,20);
});

async function profileServer(directory,calls){
  const providers=createModelProviders({directory}),chats=createChatStore({dir:directory});
  const server=createServer(async(req,res)=>{
    const path=new URL(req.url,'http://127.0.0.1').pathname;calls.push(req.method+' '+path);
    const send=(status,value)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(value));};
    try{
      assert.equal(req.headers['x-strata-client'],'installer-persistence-test');
      if(path==='/api/native')return send(200,{instances:[],capabilities:{componentUpdates:true}});
      if(path==='/api/agent/status')return send(200,{state:'idle',harness:{version:'0.2.1-alpha.3'}});
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
    assert(calls.every(call=>/^GET \/api\/(?:native|agent\/status|model-providers|chats\/installer-persistence-fixture)$/.test(call)||call==='POST /api/model-providers'||call==='PUT /api/chats/installer-persistence-fixture'));
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

test('a Windows GUI launcher returns while its background Node remains alive, and inherited capture pipes have a bounded drain',{
  skip:process.platform!=='win32'||!existsSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe'),timeout:20000,
},async t=>{
  const root=mkdtempSync(join(tmpdir(),'strata-installer-pipes-')),source=join(root,'Fixture.cs'),launcher=join(root,'StrataManaged.exe'),captured=join(root,'CapturedFixture.exe'),script=join(root,'keep-background-alive.js');
  const pidFiles=[];
  t.after(()=>{for(const path of pidFiles){if(!existsSync(path))continue;const pid=Number(readFileSync(path,'utf8'));if(Number.isSafeInteger(pid)&&pid>0){try{process.kill(pid);}catch{}}}});
  writeFileSync(script,'setInterval(() => {}, 1000);');
  writeFileSync(source,`using System; using System.Diagnostics; using System.IO;
internal static class Fixture {
  [STAThread] private static int Main(string[] args) {
    var start = new ProcessStartInfo(args[0], "\\\"" + args[1] + "\\\"");
    start.UseShellExecute = false; start.CreateNoWindow = true; start.WindowStyle = ProcessWindowStyle.Hidden;
    using (var child = Process.Start(start)) { File.WriteAllText(args[2], child.Id.ToString()); }
    Console.Out.Write("fixture-wrapper-exited"); return 0;
  }
}`);
  execFileSync('C:/Windows/Microsoft.NET/Framework64/v4.0.30319/csc.exe',['/nologo','/target:winexe','/out:'+launcher,source],{windowsHide:true,stdio:'pipe'});
  copyFileSync(launcher,captured);
  for(const [file,name,capture] of [[launcher,'ignored',false],[captured,'captured',true]]){
    const pidFile=join(root,name+'.pid');pidFiles.push(pidFile);const start=Date.now();
    const result=await runInstallerTest(file,[process.execPath,script,pidFile],{cwd:root,timeoutMs:5000});
    assert(Date.now()-start<5000,'The launcher test waited for a persistent descendant to close its handles.');
    assert(existsSync(pidFile));const pid=Number(readFileSync(pidFile,'utf8'));assert.doesNotThrow(()=>process.kill(pid,0),'The background fixture must still be alive when its launcher returns.');
    if(capture)assert.equal(result.stdout,'fixture-wrapper-exited');else assert.deepEqual(result,{stdout:'',stderr:''});
  }
});

test('captured registry helpers preserve their output and failed helpers report the executable and exit code',{skip:process.platform!=='win32'},async()=>{
  assert.equal((await runInstallerTest('powershell.exe',['-NoLogo','-NoProfile','-Command','[Console]::Out.Write("registry-path-marker")'],{timeoutMs:10000})).stdout,'registry-path-marker');
  await assert.rejects(runInstallerTest('powershell.exe',['-NoLogo','-NoProfile','-Command','exit 7'],{timeoutMs:10000}),error=>error.code===7&&/powershell\.exe exited with code 7/.test(error.message));
});
