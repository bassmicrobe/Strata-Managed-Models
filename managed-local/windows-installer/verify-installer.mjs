/** Real install/repair/uninstall smoke gate, using a separate user-data directory and no model downloads. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {basename,dirname,join,resolve,relative,isAbsolute} from 'node:path';
const wait=ms=>new Promise(done=>setTimeout(done,ms));
export function cleanPcEnvironment(source,workRoot){
  const env={...source};
  const systemRoot=source[Object.keys(source).find(key=>key.toLowerCase()==='systemroot')]??'C:/Windows';
  // Node passes only the first case-insensitive environment match. Windows also
  // rebuilds a child's ProgramFiles from ProgramW6432, so isolate every spelling
  // and architecture alias instead of letting CI's PowerShell 7 leak back in.
  const aliases=['path','programfiles','programfiles(x86)','programw6432'];
  for(const key of Object.keys(env))if(aliases.includes(key.toLowerCase()))delete env[key];
  for(const key of ['ProgramFiles','ProgramFiles(x86)','ProgramW6432'])env[key]=join(workRoot,'without-optional-powershell');
  env.PATH=[join(systemRoot,'System32'),join(systemRoot,'System32/WindowsPowerShell/v1.0')].join(';');
  return env;
}
export async function waitForRemovedFiles(paths,{timeoutMs=240000,pollMs=250,exists=existsSync,sleep=wait,now=Date.now}={}){
  const deadline=now()+timeoutMs;
  for(;;){
    const remaining=paths.filter(path=>exists(path));
    if(!remaining.length)return;
    assert(now()<deadline,'Uninstall did not finish removing application files: '+remaining.map(path=>basename(path)).join(', '));
    await sleep(Math.min(pollMs,Math.max(1,deadline-now())));
  }
}
export function runInstallerTest(file,args,{cwd,env,timeoutMs=180000,verbatim=false}={}){
  return new Promise((ok,bad)=>{
    // Normal GUI launches must not leave capture pipes held open by the persistent host.
    // A desktop bridge action has a JSON response that the caller must read.
    const capture=basename(file).toLowerCase()!=='stratamanaged.exe'||args.includes('--desktop-bridge');
    const child=spawn(file,args,{cwd,env,windowsHide:true,windowsVerbatimArguments:verbatim,shell:false,stdio:capture?['ignore','pipe','pipe']:'ignore'});
    let stdout='',stderr='',settled=false,timedOut=false,timer,drainTimer,killTimer;
    child.stdout?.on('data',b=>{stdout=(stdout+b).slice(-16000);});child.stderr?.on('data',b=>{stderr=(stderr+b).slice(-16000);});
    const closePipes=()=>{child.stdout?.destroy();child.stderr?.destroy();};
    const finish=(code,error)=>{
      if(settled)return;settled=true;clearTimeout(timer);clearTimeout(drainTimer);clearTimeout(killTimer);
      if(error){closePipes();bad(Object.assign(Error(`The Windows installer lifecycle test failed: ${basename(file)} could not start (${error.code??'unknown'}).`),{detail:stdout+stderr,code:error.code,cause:error}));}
      else if(code===0&&!timedOut)ok({stdout,stderr});
      else bad(Object.assign(Error(`The Windows installer lifecycle test failed: ${basename(file)} exited with code ${code??'unknown'}${timedOut?' (timed out)':''}.`),{detail:stdout+stderr,code,timedOut}));
    };
    timer=setTimeout(()=>{timedOut=true;child.kill();killTimer=setTimeout(()=>{closePipes();finish(child.exitCode);},2000);},timeoutMs);
    child.once('error',error=>finish(undefined,error));
    child.once('exit',code=>{
      clearTimeout(timer);
      if(!capture){finish(code);return;}
      // Usually close follows exit immediately and preserves all output. A captured helper
      // that spawned a background process still has a bounded pipe-drain period.
      drainTimer=setTimeout(()=>{closePipes();finish(code);},2000);
    });
    child.once('close',code=>finish(code));
  });
}
export async function exerciseInstalledProfile(port,{expected,fetchImpl=fetch}={}){
  assert(Number.isSafeInteger(port)&&port>0&&port<=65535,'The installed host did not save a valid port.');
  const base=`http://127.0.0.1:${port}`;
  const api=async(path,{method='GET',body}={})=>{
    const response=await fetchImpl(base+path,{method,headers:{'x-strata-client':'installer-persistence-test',...(body?{'content-type':'application/json'}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(15000)});
    assert(response.ok,`Installed host ${method} ${path} returned HTTP ${response.status}.`);return response.json();
  };
  const native=await api('/api/native');assert(Array.isArray(native.instances));assert.equal(native.instances.length,0,'Installer verification must not load a model.');
  const agent=await api('/api/agent/status');assert(['idle','ready'].includes(agent.state)&&agent.harness?.version,'The installed coding assistant is unavailable.');
  let providers=await api('/api/model-providers');assert(Array.isArray(providers.connections));
  if(!expected){
    assert.equal(providers.connections.length,0,'A clean normal profile already contained API connections.');
    providers=await api('/api/model-providers',{method:'POST',body:{kind:'custom',name:'Installer fixture',baseUrl:'http://127.0.0.1:9/v1',protocol:'openai-chat',models:[{id:'fixture-a',name:'Fixture A',vision:false,reasoning:false},{id:'fixture-b',name:'Fixture B',vision:false,reasoning:false}]}});
    const connection=providers.connections.find(value=>value.name==='Installer fixture');assert(connection?.id);
    const at=new Date().toISOString(),session={id:'installer-persistence-fixture',title:'Installer persistence fixture',defaultTitle:false,createdAt:at,updatedAt:at,messages:[{id:'installer-fixture-message',role:'user',content:'Controlled installer persistence fixture; no model inference was requested.',at}],workspace:'installer-test',tokensIn:0,tokensOut:0,preferences:{remoteModel:{connectionId:connection.id,modelId:'fixture-b'},agent:false,thinking:'Off'}};
    const saved=await api('/api/chats/'+session.id,{method:'PUT',body:session});assert.equal(saved.id,session.id);
    expected={providerId:connection.id,session};
  }
  const connection=providers.connections.find(value=>value.id===expected.providerId);assert(connection,'Saved API connection disappeared after restart.');
  assert.deepEqual(connection.models.map(model=>[model.id,model.name]),[['fixture-a','Fixture A'],['fixture-b','Fixture B']]);
  assert(connection.models.every(model=>model.vision===false&&model.reasoning===false));
  const chat=await api('/api/chats/'+expected.session.id);assert.equal(chat.v,1);assert.deepEqual(chat.session,expected.session);
  return expected;
}
const installedApi=(port,path,{method='GET',body}={})=>fetch(`http://127.0.0.1:${port}${path}`,{
  method,headers:{'x-strata-client':'installer-persistence-test',...(body?{'content-type':'application/json'}:{})},
  ...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000),
}).then(async response=>{assert(response.ok,`Installed coding API ${method} ${path} returned HTTP ${response.status}.`);return response.json();});

/** The opt-in's saved state must survive repair without replacing user instructions or preferences. */
export async function inspectInstalledCoding(port,{data,expected}={}){
  const state=JSON.parse(readFileSync(join(data,'coding.json'),'utf8'));
  assert.equal(state.consentVersion,1);assert.match(state.chatId,/^managed-coding-[a-f0-9-]{36}$/);assert(state.acceptedAt);
  const chat=(await installedApi(port,'/api/chats/'+state.chatId)).session;
  const folder=(await installedApi(port,'/api/chat/folder?sessionId='+state.chatId)).folder?.path;
  const workspaces=await installedApi(port,'/api/workspaces');
  assert.equal(folder,chat.workspace);assert(existsSync(folder),'The dedicated coding folder is missing.');
  const matching=workspaces.workspaces.filter(workspace=>resolve(workspace.path).toLowerCase()===resolve(folder).toLowerCase());
  assert.equal(matching.length,1,'Coding setup must reuse its registered workspace.');
  if(expected){assert.deepEqual(state,expected.state);assert.deepEqual(chat,expected.chat);assert.deepEqual(matching,expected.workspaces);}
  else{assert.equal(chat.preferences.mode,'bypass');assert.equal(chat.preferences.agent,true);assert.equal(chat.pinned,true);assert.equal(chat.messages.length,0);}
  return{state,chat,workspaces:matching};
}

/** No model weights: the installed Harness and command executor use a scripted loopback model. */
export async function exerciseInstalledHarness(port,{app,coding}={}){
  const {startScriptedWorker}=await import('../../apps/host/tests/helpers/scripted-worker.mjs');
  const worker=await startScriptedWorker({model:'installer-tool-model',chunkDelayMs:1});
  let connectionId;
  try{
    const saved=await installedApi(port,'/api/model-providers',{method:'POST',body:{kind:'custom',name:'Installer tool fixture',baseUrl:worker.url,protocol:'openai-chat',models:[{id:'installer-tool-model',name:'Scripted tool fixture',vision:false,reasoning:false}]}});
    connectionId=saved.connections.find(connection=>connection.name==='Installer tool fixture')?.id;assert(connectionId);
    const remoteModel={connectionId,modelId:'installer-tool-model'},folder=coding.chat.workspace;
    writeFileSync(join(folder,'installer-portability.test.cjs'),"const test = require('node:test');\nconst assert = require('node:assert/strict');\nconst fs = require('node:fs');\ntest('bundled Node executes a project test', () => { assert.equal(2 + 2, 4); fs.writeFileSync('installer-node-result.json', JSON.stringify({ executable: process.execPath, passed: true })); });\n");
    const stream=async(body,onFrame=()=>{})=>{
      const response=await fetch(`http://127.0.0.1:${port}/api/chat/stream`,{method:'POST',headers:{'x-strata-client':'installer-persistence-test','content-type':'application/json'},body:JSON.stringify({...body,remoteModel,history:[]}),signal:AbortSignal.timeout(150000)});
      assert.equal(response.status,200,'The installed Harness turn did not start.');
      const frames=[],decoder=new TextDecoder();let buffer='';
      for await(const chunk of response.body){buffer+=decoder.decode(chunk,{stream:true});let end;while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end).trim();buffer=buffer.slice(end+1);if(line){const frame=JSON.parse(line);frames.push(frame);await onFrame(frame);}}}
      assert(!frames.some(frame=>frame.type==='error'),JSON.stringify(frames.filter(frame=>frame.type==='error')));
      assert.equal(frames.at(-1)?.type,'done');return frames;
    };
    const command="Set-Content -LiteralPath 'installer-shell-version.txt' -Value $PSVersionTable.PSVersion.Major; node --test installer-portability.test.cjs; exit $LASTEXITCODE";
    const frames=await stream({sessionId:coding.state.chatId,mode:coding.chat.preferences.mode,message:'SCRIPT:call pwsh '+JSON.stringify({command,description:'Run the installer portability test',timeout_ms:30000})});
    assert.equal(frames.find(frame=>frame.type==='start')?.mode,'bypass');
    assert(!frames.some(frame=>frame.type==='agent-tool'&&frame.tool.state==='proposed'),'The opted-in coding chat unexpectedly requested approval.');
    const tool=frames.filter(frame=>frame.type==='agent-tool'&&frame.tool.state==='done').at(-1);assert(tool,'The bundled Harness did not execute its command tool.');
    assert.match(String(tool.tool.result),/bundled Node executes a project test/);
    const nodeResult=JSON.parse(readFileSync(join(folder,'installer-node-result.json'),'utf8'));
    assert.equal(resolve(nodeResult.executable).toLowerCase(),resolve(app,'resources/node/node.exe').toLowerCase(),'Project tests did not use the bundled Node runtime.');assert.equal(nodeResult.passed,true);
    assert.equal(readFileSync(join(folder,'installer-shell-version.txt'),'utf8').trim(),'5','The clean-PC probe must exercise built-in Windows PowerShell.');
    const status=await installedApi(port,'/api/agent/status');assert.equal(status.state,'ready');assert(Number.isSafeInteger(status.runtime?.pid));assert(status.harness?.version);
    const probe='installer-manual-permission-probe';
    await installedApi(port,'/api/chat/folder',{method:'POST',body:{sessionId:probe,path:folder}});
    let asked=false;
    const manual=await stream({sessionId:probe,message:'SCRIPT:retrywrite installer-denied.txt must-not-be-written'},async frame=>{
      if(frame.type==='agent-tool'&&frame.tool.state==='proposed'){
        asked=true;await installedApi(port,'/api/chat/approval',{method:'POST',body:{sessionId:probe,toolId:frame.tool.id,decision:'deny'}});
      }
    });
    assert(asked,'Coding opt-in must not enable Bypass for an ordinary chat.');assert.equal(manual.find(frame=>frame.type==='start')?.mode,'manual');assert(!existsSync(join(folder,'installer-denied.txt')),'An ordinary chat wrote a file after denial.');
    return{started:true,version:status.harness.version,commandExecuted:true,bundledNode:true,powerShellMajor:5,ordinaryChatApprovalRequired:true};
  }finally{
    try{if(connectionId)await installedApi(port,'/api/model-providers/'+connectionId,{method:'DELETE'});}
    finally{await worker.close();}
  }
}
export async function verifyWindowsInstaller({installer,workRoot,run=runInstallerTest}={}){
  if(process.platform!=='win32'||!isAbsolute(installer??'')||!isAbsolute(workRoot??''))throw Error('The Windows installer test needs absolute Windows paths.');
  workRoot=resolve(workRoot);mkdirSync(workRoot,{recursive:true});
  const app=join(workRoot,'app 日本語'),data=join(workRoot,'user-data 日本語');mkdirSync(data,{recursive:true});
  const installLog=join(workRoot,'install.log'),env={...process.env,STRATA_MANAGED_DATA_DIR:data,STRATA_MANAGED_INSTALL_LOG:installLog};
  // Model a receiving PC with neither a system Node install nor optional PowerShell 7.
  const hostEnv=cleanPcEnvironment(env,workRoot);
  const phase=name=>console.log('[installer-test] '+name);
  const diagnostics=()=>{if(existsSync(installLog))console.error(readFileSync(installLog,'utf8').slice(-16000));};
  phase('Checking the isolated user registration');
  const registry=await run('powershell.exe',['-NoLogo','-NoProfile','-Command',String.raw`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $p=Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\StrataManagedModels' -ErrorAction SilentlyContinue; if($p){$p.InstallLocation}; exit 0`],{cwd:workRoot,env});
  const existing=registry.stdout?.trim();if(existing){const target=existsSync(existing)?realpathSync(existing):resolve(existing),rel=relative(realpathSync(workRoot),target);if(rel.startsWith('..')||isAbsolute(rel))throw Error('A real installation is already registered. Use a clean test account.');}
  const invokeSetup=async name=>{phase(name);try{return await run(installer,['/S','/D='+app],{cwd:workRoot,env,timeoutMs:240000,verbatim:true});}catch(error){diagnostics();throw error;}};
  await invokeSetup('Installing into the isolated test folder');
  for(const path of ['StrataManaged.exe','runtime/runtime.mjs','resources/desktop/StrataWindow.exe','resources/node/node.exe','resources/control/python/python.exe','resources/harness/lib/bin.js','resources/harness/BUNDLE.json','resources/harness/LICENSE','resources/harness/THIRD_PARTY_NOTICES.md','host/server/index.mjs','host/dist/index.html','README.ja.txt'])assert(existsSync(join(app,path)),'Missing installed file: '+path);
  const programs=await run('powershell.exe',['-NoLogo','-NoProfile','-Command',"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); [Environment]::GetFolderPath('Programs')"],{cwd:workRoot,env});
  const startMenu=join(programs.stdout.trim(),'Strata Managed Models');
  for(const name of ['Tailscaleで共有','Tailscale共有を停止','Strataを停止','自動テストでコーディング'])assert(existsSync(join(startMenu,name+'.lnk')),'Missing Japanese Start Menu shortcut: '+name);
  const launcher=join(app,'StrataManaged.exe');
  const smoke=async name=>{phase(name);
    try{await run(launcher,['--smoke'],{cwd:app,env,timeoutMs:120000});}
    catch(error){for(const p of ['smoke-result.json','logs/runtime.log','logs/launcher.log'])if(existsSync(join(data,p)))console.error(readFileSync(join(data,p),'utf8').slice(-12000));throw error;}
    const result=JSON.parse(readFileSync(join(data,'smoke-result.json'),'utf8'));assert.equal(result.ok,true);assert.equal(result.controlAvailable,true);return result;
  };
  const normalProfile=async(action)=>{
    phase('Starting the normal profile without a browser');
    try{
      await run(join(app,'resources/node/node.exe'),[join(app,'runtime/runtime.mjs'),'--no-browser','--no-update'],{cwd:app,env:hostEnv,timeoutMs:120000});
      const record=JSON.parse(readFileSync(join(data,'host-process.json'),'utf8'));
      const location=relative(realpathSync(workRoot),resolve(record.entry??''));assert(location&&!location.startsWith('..')&&!isAbsolute(location),'The test host is outside the isolated test folder.');
      return await action(record.port);
    }finally{phase('Stopping the isolated normal host');await run(launcher,['--stop','--wait'],{cwd:app,env,timeoutMs:120000});}
  };
  const first=await smoke('Checking a clean first-run profile');
  phase('Saving two user-selected API models and a controlled chat fixture');
  const instructionsFile=join(data,'profile/data/agent/home/AGENTS.md'),instructions='# Existing project guidance\nPreserve this user-authored instruction.\n';
  mkdirSync(dirname(instructionsFile),{recursive:true});writeFileSync(instructionsFile,instructions);
  const configureCoding=async accepted=>run(join(app,'resources/node/node.exe'),[join(app,'runtime/runtime.mjs'),'--coding',...(accepted?['--coding-accept']:[]),'--no-browser','--no-update'],{cwd:app,env:hostEnv,timeoutMs:120000});
  let desktop,coding,harness;
  const fixture=await normalProfile(async port=>{
    const fixture=await exerciseInstalledProfile(port);
    assert(!existsSync(join(data,'coding.json')),'Normal startup opted into automatic coding without consent.');
    await assert.rejects(configureCoding(false),error=>/confirm automatic execution first/.test(error.detail??''));
    assert(!existsSync(join(data,'coding.json')));assert.equal(readFileSync(instructionsFile,'utf8'),instructions);
    phase('Opting into coding and exercising the installed Harness with a scripted model');
    await configureCoding(true);coding=await inspectInstalledCoding(port,{data});
    assert.deepEqual(coding.chat.preferences.remoteModel,fixture.session.preferences.remoteModel,'Coding setup did not keep the user-selected API model.');
    const policy=readFileSync(instructionsFile,'utf8');assert(policy.startsWith(instructions));assert.equal(policy.split('<!-- strata-managed-coding:start -->').length,2);assert.match(policy,/three correction-and-test attempts/);
    harness=await exerciseInstalledHarness(port,{app,coding});
    // Save an edited chat to prove repeated launches preserve the person's history and mode.
    coding.chat.preferences.mode='manual';coding.chat.messages=[{id:'installer-coding-message',role:'user',content:'Keep my coding history after repair.',at:new Date().toISOString()}];
    await installedApi(port,'/api/chats/'+coding.state.chatId,{method:'PUT',body:coding.chat});
    await configureCoding(false);await inspectInstalledCoding(port,{data,expected:coding});
    await exerciseInstalledProfile(port,{expected:fixture});
    phase('Stopping models through the installed desktop launcher while keeping its host');
    const beforeStop=JSON.parse(readFileSync(join(data,'host-process.json'),'utf8'));
    const modelStop=await run(launcher,['--stop-models','--desktop-bridge'],{cwd:app,env:hostEnv,timeoutMs:120000});
    assert.deepEqual(JSON.parse(modelStop.stdout),{modelsStopped:true});
    assert.equal(JSON.parse(readFileSync(join(data,'host-process.json'),'utf8')).pid,beforeStop.pid);
    await exerciseInstalledProfile(port,{expected:fixture});
    phase('Opening the installed WebView2 window without an external browser');
    try{await run(launcher,['--desktop-smoke'],{cwd:app,env,timeoutMs:150000});}
    catch(error){for(const file of ['logs/desktop-window.log','logs/desktop-launcher.log','logs/launcher.log'])if(existsSync(join(data,file)))console.error(readFileSync(join(data,file),'utf8').slice(-12000));throw error;}
    desktop=JSON.parse(readFileSync(join(data,'desktop-smoke.json'),'utf8'));
    assert.deepEqual(desktop,{ok:true,windowCreated:true,pageLoaded:true,renderer:'WebView2',loopback:true});
    return fixture;
  });
  const providerFile=join(data,'profile/data/model-providers.json'),chatFile=join(data,'profile/data/chats',fixture.session.id+'.json');
  const providerBytes=readFileSync(providerFile),chatBytes=readFileSync(chatFile);
  const codingFiles=[join(data,'coding.json'),instructionsFile,join(data,'profile/data/chats',coding.state.chatId+'.json'),join(coding.chat.workspace,'installer-portability.test.cjs'),join(coding.chat.workspace,'installer-node-result.json')];
  const codingBytes=codingFiles.map(file=>readFileSync(file));
  const assertCodingRetained=()=>codingFiles.forEach((file,index)=>assert.deepEqual(readFileSync(file),codingBytes[index],'Coding setup, instructions, conversation or project files changed.'));
  const userMarker=join(data,'keep-this-user-file.txt'),appMarker=join(app,'user-kept-note.txt');
  writeFileSync(userMarker,'User settings and downloaded models are stored here.');writeFileSync(appMarker,'An unrecognized user file must not be recursively removed.');
  await invokeSetup('Repairing the installed application');const second=await smoke('Rechecking the clean smoke profile after repair');assert(existsSync(userMarker));assert(existsSync(appMarker));
  phase('Verifying selected models and chat after repair and normal restart');
  await normalProfile(async port=>{await configureCoding(false);await inspectInstalledCoding(port,{data,expected:coding});return exerciseInstalledProfile(port,{expected:fixture});});
  assertCodingRetained();
  assert.deepEqual(readFileSync(providerFile),providerBytes,'Repair changed the saved API models.');assert.deepEqual(readFileSync(chatFile),chatBytes,'Repair changed the saved chat.');
  phase('Uninstalling only the application');
  try{await run(join(app,'Uninstall.exe'),['/S'],{cwd:workRoot,env,timeoutMs:120000});}catch(error){diagnostics();throw error;}
  // NSIS returns from its original executable after handing off to a temporary copy.
  // Its 20,000+ Harness dependency files can still be disappearing after that return.
  await waitForRemovedFiles(['StrataManaged.exe','Uninstall.exe','host','runtime','resources','licenses'].map(path=>join(app,path)));
  assert(!existsSync(launcher),'The application launcher was not removed.');assert(!existsSync(join(app,'resources/node/node.exe')),'The bundled runtime was not removed.');assert(!existsSync(join(app,'resources/desktop/StrataWindow.exe')),'The desktop executable was not removed.');
  assert(!existsSync(join(app,'resources/harness/lib/bin.js')),'The bundled coding assistant was not removed.');
  assert(existsSync(userMarker),'Uninstall removed user data.');assert(existsSync(appMarker),'Uninstall removed an unrecognized file.');
  assert.deepEqual(readFileSync(providerFile),providerBytes,'Uninstall changed or removed the saved API models.');assert.deepEqual(readFileSync(chatFile),chatBytes,'Uninstall changed or removed the saved chat.');
  assertCodingRetained();
  const result={ok:true,installed:true,repaired:true,uninstalled:true,userDataRetained:true,unknownAppFileRetained:true,apiModelsPersisted:2,chatRetained:true,providerFileRetained:true,chatFileRetained:true,codingOptInVerified:true,codingHistoryRetained:true,userInstructionsRetained:true,codingWorkspaceRetained:true,harness,desktop,first,second};writeFileSync(join(workRoot,'installer-verification.json'),JSON.stringify(result,null,2));console.log('Windows install, desktop, portable coding tools, opt-in, selected models, chats, instructions, project files, repair and uninstall/user-data retention: passed.');return result;
}
