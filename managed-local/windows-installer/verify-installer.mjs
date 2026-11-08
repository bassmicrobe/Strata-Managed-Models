/** Real install/repair/uninstall smoke gate, using a separate user-data directory and no model downloads. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {basename,join,resolve,relative,isAbsolute} from 'node:path';
const wait=ms=>new Promise(done=>setTimeout(done,ms));
export function runInstallerTest(file,args,{cwd,env,timeoutMs=180000,verbatim=false}={}){
  return new Promise((ok,bad)=>{
    // The GUI launcher exits after starting the persistent host. Its descendants must not
    // inherit capture pipes and hold this test open after the launcher has already exited.
    const capture=basename(file).toLowerCase()!=='stratamanaged.exe';
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
export async function verifyWindowsInstaller({installer,workRoot,run=runInstallerTest}={}){
  if(process.platform!=='win32'||!isAbsolute(installer??'')||!isAbsolute(workRoot??''))throw Error('The Windows installer test needs absolute Windows paths.');
  workRoot=resolve(workRoot);mkdirSync(workRoot,{recursive:true});
  const app=join(workRoot,'app 日本語'),data=join(workRoot,'user-data 日本語');mkdirSync(data,{recursive:true});
  const installLog=join(workRoot,'install.log'),env={...process.env,STRATA_MANAGED_DATA_DIR:data,STRATA_MANAGED_INSTALL_LOG:installLog};
  const phase=name=>console.log('[installer-test] '+name);
  const diagnostics=()=>{if(existsSync(installLog))console.error(readFileSync(installLog,'utf8').slice(-16000));};
  phase('Checking the isolated user registration');
  const registry=await run('powershell.exe',['-NoLogo','-NoProfile','-Command',String.raw`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); $p=Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\StrataManagedModels' -ErrorAction SilentlyContinue; if($p){$p.InstallLocation}; exit 0`],{cwd:workRoot,env});
  const existing=registry.stdout?.trim();if(existing){const target=existsSync(existing)?realpathSync(existing):resolve(existing),rel=relative(realpathSync(workRoot),target);if(rel.startsWith('..')||isAbsolute(rel))throw Error('A real installation is already registered. Use a clean test account.');}
  const invokeSetup=async name=>{phase(name);try{return await run(installer,['/S','/D='+app],{cwd:workRoot,env,timeoutMs:240000,verbatim:true});}catch(error){diagnostics();throw error;}};
  await invokeSetup('Installing into the isolated test folder');
  for(const path of ['StrataManaged.exe','runtime/runtime.mjs','resources/node/node.exe','resources/control/python/python.exe','host/server/index.mjs','host/dist/index.html','README.ja.txt'])assert(existsSync(join(app,path)),'Missing installed file: '+path);
  const launcher=join(app,'StrataManaged.exe');
  const smoke=async name=>{phase(name);
    try{await run(launcher,['--smoke'],{cwd:app,env,timeoutMs:120000});}
    catch(error){for(const p of ['smoke-result.json','logs/runtime.log','logs/launcher.log'])if(existsSync(join(data,p)))console.error(readFileSync(join(data,p),'utf8').slice(-12000));throw error;}
    const result=JSON.parse(readFileSync(join(data,'smoke-result.json'),'utf8'));assert.equal(result.ok,true);assert.equal(result.controlAvailable,true);return result;
  };
  const normalProfile=async(action)=>{
    phase('Starting the normal profile without a browser');
    try{
      await run(launcher,['--no-browser'],{cwd:app,env,timeoutMs:120000});
      const record=JSON.parse(readFileSync(join(data,'host-process.json'),'utf8'));
      const location=relative(realpathSync(workRoot),resolve(record.entry??''));assert(location&&!location.startsWith('..')&&!isAbsolute(location),'The test host is outside the isolated test folder.');
      return await action(record.port);
    }finally{phase('Stopping the isolated normal host');await run(launcher,['--stop','--wait'],{cwd:app,env,timeoutMs:120000});}
  };
  const first=await smoke('Checking a clean first-run profile');
  phase('Saving two user-selected API models and a controlled chat fixture');
  const fixture=await normalProfile(port=>exerciseInstalledProfile(port));
  const providerFile=join(data,'profile/data/model-providers.json'),chatFile=join(data,'profile/data/chats',fixture.session.id+'.json');
  const providerBytes=readFileSync(providerFile),chatBytes=readFileSync(chatFile);
  const userMarker=join(data,'keep-this-user-file.txt'),appMarker=join(app,'user-kept-note.txt');
  writeFileSync(userMarker,'User settings and downloaded models are stored here.');writeFileSync(appMarker,'An unrecognized user file must not be recursively removed.');
  await invokeSetup('Repairing the installed application');const second=await smoke('Rechecking the clean smoke profile after repair');assert(existsSync(userMarker));assert(existsSync(appMarker));
  phase('Verifying selected models and chat after repair and normal restart');
  await normalProfile(port=>exerciseInstalledProfile(port,{expected:fixture}));
  assert.deepEqual(readFileSync(providerFile),providerBytes,'Repair changed the saved API models.');assert.deepEqual(readFileSync(chatFile),chatBytes,'Repair changed the saved chat.');
  phase('Uninstalling only the application');
  try{await run(join(app,'Uninstall.exe'),['/S'],{cwd:workRoot,env,timeoutMs:120000});}catch(error){diagnostics();throw error;}
  for(let i=0;i<100&&existsSync(launcher);i++)await wait(200);
  assert(!existsSync(launcher),'The application launcher was not removed.');assert(!existsSync(join(app,'resources/node/node.exe')),'The bundled runtime was not removed.');
  assert(existsSync(userMarker),'Uninstall removed user data.');assert(existsSync(appMarker),'Uninstall removed an unrecognized file.');
  assert.deepEqual(readFileSync(providerFile),providerBytes,'Uninstall changed or removed the saved API models.');assert.deepEqual(readFileSync(chatFile),chatBytes,'Uninstall changed or removed the saved chat.');
  const result={ok:true,installed:true,repaired:true,uninstalled:true,userDataRetained:true,unknownAppFileRetained:true,apiModelsPersisted:2,chatRetained:true,providerFileRetained:true,chatFileRetained:true,first,second};writeFileSync(join(workRoot,'installer-verification.json'),JSON.stringify(result,null,2));console.log('Windows install, selected API models, chat persistence, repair and uninstall/user-data retention: passed.');return result;
}
