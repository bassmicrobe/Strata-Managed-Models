/** Per-user launcher for the Windows package. All mutable files live outside the installation. */
import {spawn,execFile} from 'node:child_process';
import {createServer} from 'node:net';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,unlinkSync,openSync,closeSync,cpSync,realpathSync} from 'node:fs';
import {dirname,join,resolve,relative,isAbsolute,sep,delimiter} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {fetchForkRelease,stageForkRelease,stageForkInstaller,FORK_REPOSITORY} from './fork-stage.mjs';
import {readTailscaleConfig,planTailscale,applyTailscale,disableTailscale,tailscaleOrigin} from './tailscale.mjs';
import {configureCoding,refreshCodingPolicy} from './coding.mjs';

const sleep=ms=>new Promise(done=>setTimeout(done,ms));
const json=file=>JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const VERSION=/^\d+\.\d+\.\d+$/;
const COMMIT=/^[a-f0-9]{40}$/;
const fail=message=>new Error(message);
export function contained(base,file,equal=false){const rel=relative(resolve(base),resolve(file));return equal&&rel===''||!!rel&&rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel);}
export function atomicJson(file,value){mkdirSync(dirname(file),{recursive:true});const tmp=file+'.'+randomUUID()+'.tmp';writeFileSync(tmp,JSON.stringify(value,null,2),{mode:0o600});renameSync(tmp,file);}
export function versionCompare(a,b){if(!VERSION.test(a)||!VERSION.test(b))throw fail('Invalid application version.');const x=a.split('.').map(Number),y=b.split('.').map(Number);return Math.sign(x[0]-y[0]||x[1]-y[1]||x[2]-y[2]);}
export function releaseIsNew(release,active){const order=versionCompare(release.version,active.version);if(order!==0)return order>0;if(active.releaseId)return release.releaseId>active.releaseId;const build=value=>Number(/^managed-v\d+\.\d+\.\d+-(\d+)$/.exec(value??'')?.[1]??0);return build(release.tag_name)>build(active.releaseTag);}
export function bundledIsNewer(bundled,active){const order=versionCompare(bundled.version,active.version);if(order!==0)return order>0;const build=value=>Number(/^managed-v\d+\.\d+\.\d+-(\d+)$/.exec(value??'')?.[1]??0);return build(bundled.releaseTag)>build(active.releaseTag);}
export function layout({appRoot=resolve(dirname(fileURLToPath(import.meta.url)),'..'),dataRoot=process.env.STRATA_MANAGED_DATA_DIR??join(process.env.LOCALAPPDATA??'', 'StrataManaged')}={}){
  if(!isAbsolute(appRoot)||!isAbsolute(dataRoot)||resolve(dataRoot)===resolve(dirname(dataRoot)))throw fail('The application data folder is invalid.');
  appRoot=resolve(appRoot);dataRoot=resolve(dataRoot);
  if(contained(appRoot,dataRoot,true)||contained(dataRoot,appRoot,true))throw fail('Application files and personal data must use separate folders.');
  return {appRoot,dataRoot,node:join(appRoot,'resources/node/node.exe'),control:join(appRoot,'resources/control'),host:join(appRoot,'host'),pidFile:join(dataRoot,'host-process.json'),activeFile:join(dataRoot,'active-host.json'),maintenanceFile:join(dataRoot,'update-maintenance.json'),profile:join(dataRoot,'profile')};
}
export function validateActive(paths,active){
  if(!active||!VERSION.test(active.version)||!COMMIT.test(active.commit??''))throw fail('The saved application version is invalid.');
  const hostRoot=resolve(active.hostRoot??''),bundled=resolve(paths.host),versions=join(paths.dataRoot,'host-versions');
  if(hostRoot!==bundled&&(!contained(versions,hostRoot)||!/[\\/]apps[\\/]host$/.test(hostRoot)))throw fail('The saved application folder is invalid.');
  if(!existsSync(join(hostRoot,'server/index.mjs'))||!existsSync(join(hostRoot,'dist/index.html')))throw fail('The application files are incomplete.');
  const real=realpathSync(hostRoot);if(real!==realpathSync(bundled)&&!contained(realpathSync(paths.dataRoot),real))throw fail('The application folder points outside this installation.');
  return {...active,hostRoot};
}
export function hostEnvironment(paths,active,port,{profile=paths.profile,smoke=false,managedModels=!smoke}={}){
  const env={...process.env};
  // Windows environment names are case-insensitive; do not pass both PATH and Path to spawn.
  const pathKey=Object.keys(env).find(key=>key.toLowerCase()==='path'),systemPath=pathKey?env[pathKey]:'';
  for(const key of Object.keys(env))if(key.toLowerCase()==='path')delete env[key];
  env.PATH=dirname(paths.node)+(systemPath?delimiter+systemPath:'');
  for(const key of ['PYTHONPATH','PYTHONHOME','PYTHONSTARTUP','STRATA_DATA_DIR','STRATA_MANAGED_MODELS_CONFIG','STRATA_HANDOVER','STRATA_NO_HANDOVER','STRATA_UPDATE_TRUSTED_KEYS','STRATA_DIST','STRATA_TAILSCALE_ORIGIN','STRATA_SHUTDOWN_TOKEN','GITHUB_TOKEN','GH_TOKEN'])delete env[key];
  Object.assign(env,{STRATA_HOME:profile,STRATA_DATA_DIR:paths.dataRoot,STRATA_STATE_DIR:join(paths.dataRoot,'state'),STRATA_COMPONENTS_DIR:join(paths.dataRoot,'components'),STRATA_CONTROL_DIR:paths.control,STRATA_INSTALL_DIR:join(paths.dataRoot,'install'),STRATA_PROFILE_DIR:join(paths.dataRoot,'profiles'),STRATA_RUNTIME_DIR:join(paths.dataRoot,'runtime'),STRATA_SETTINGS_FILE:join(paths.dataRoot,'app-settings.json'),STRATA_MODELS_DIR:join(paths.dataRoot,'models'),STRATA_WORKSPACE:join(paths.dataRoot,'Workspace'),STRATA_REAL_ENGINE:'1',STRATA_NO_ACQUIRE:'1',STRATA_APP_VERSION:active.version,STRATA_PORT:String(port),STRATA_BIND:'127.0.0.1',STRATA_UPDATE_MAINTENANCE_FILE:paths.maintenanceFile,STRATA_NO_BUNDLED_ENGINE:'1',STRATA_NO_REPAIR_ACCESS:'1'});
  env.STRATA_HARNESS_DIR=join(paths.appRoot,'resources/harness');
  const managed=join(paths.dataRoot,'managed-models.json');if(managedModels&&existsSync(managed))env.STRATA_MANAGED_MODELS_CONFIG=managed;
  if(env.STRATA_MANAGED_MODELS_CONFIG){
    const preload=json(env.STRATA_MANAGED_MODELS_CONFIG).compactionPreload;
    if(typeof preload==='string'&&isAbsolute(preload)&&existsSync(preload)){
      const option='--import='+pathToFileURL(preload).href;
      // New hosts compact chats themselves. Keep the saved adapter for a rollback,
      // but do not import it on top of the bundled implementation.
      if(existsSync(join(active.hostRoot,'server/chat-compaction.mjs'))){if(env.NODE_OPTIONS===option)delete env.NODE_OPTIONS;}
      else env.NODE_OPTIONS=option;
    }
  }
  if(!smoke){const origin=paths.tailscaleOrigin??readTailscaleConfig(paths.dataRoot)?.url;if(origin)env.STRATA_TAILSCALE_ORIGIN=tailscaleOrigin(origin);}
  if(smoke)env.STRATA_SETTINGS_FILE=join(dirname(profile),'app-settings.json');
  return env;
}
export function isBusy(native,serving,maintenance,agent,managed){return !!(managed?.switching||managed?.activeRequests||managed?.queuedRequests||agent?.activeTurns||maintenance?.activeRequests||native?.jobs?.some(job=>job.state==='running')||native?.instances?.some(i=>(i.metrics?.live?.running??0)>0||(i.metrics?.live?.queued??0)>0)||serving?.stats?.running||serving?.stats?.waiting||serving?.requests?.some(r=>['queued','generating'].includes(r.state)));}
function command(file,args,timeout=15000){return new Promise((ok,bad)=>{execFile(file,args,{encoding:'utf8',windowsHide:true,timeout,maxBuffer:1024*1024},(err,stdout)=>err?bad(fail('Windows could not complete the application operation.')):ok(stdout));});}
export async function processIdentity(pid,{run=command}={}){
  if(!Number.isSafeInteger(pid)||pid<=0)return null;
  const script=`[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);$p=Get-CimInstance Win32_Process -Filter 'ProcessId = ${pid}' -ErrorAction Stop;if($p){[pscustomobject]@{pid=$p.ProcessId;executable=$p.ExecutablePath;commandLine=$p.CommandLine;created=$p.CreationDate.ToUniversalTime().ToString('o')}|ConvertTo-Json -Compress}`;
  try{const value=(await run('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-Command',script])).trim();return value?JSON.parse(value):null;}catch{return null;}
}
export function ownsProcess(paths,record,actual){
  if(!record||!actual||record.pid!==actual.pid||!Number.isSafeInteger(record.port)||record.port<1||record.port>65535||!record.entry||!record.created||record.created!==actual.created)return false;
  const same=(a,b)=>resolve(a).toLowerCase()===resolve(b).toLowerCase();
  const allowed=record.entry===join(paths.host,'server/index.mjs')||contained(join(paths.dataRoot,'host-versions'),record.entry)&&/[\\/]apps[\\/]host[\\/]server[\\/]index\.mjs$/.test(record.entry);
  const firstArgument=/^\s*(?:"[^"]+"|\S+)\s+(?:"([^"]+)"|(\S+))(?:\s|$)/.exec(String(actual.commandLine??''));
  const script=firstArgument?.[1]??firstArgument?.[2];
  return allowed&&same(actual.executable??'',paths.node)&&same(record.executable??'',paths.node)&&!!script&&same(script,record.entry);
}
async function ownedRecord(paths){if(!existsSync(paths.pidFile))return null;let record;try{record=json(paths.pidFile);}catch{return null;}return ownsProcess(paths,record,await processIdentity(record.pid))?record:null;}
async function request(record,path,{method='GET',body,token,optional=false}={}){const response=await fetch(`http://127.0.0.1:${record.port}${path}`,{method,headers:{'x-strata-client':'strata-managed-launcher',...(body?{'content-type':'application/json'}:{}),...(token?{'x-strata-updater':token}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(method==='GET'?5000:360000)});if(optional&&response.status===404)return null;if(!response.ok)throw fail(response.status===409?'回答やモデルの処理が終わってから、もう一度お試しください。':'The Strata host did not accept the operation.');return response;}
async function snapshot(record){
  const [native,serving,maintenance,agent,managed]=await Promise.all(['/api/native','/api/serving','/api/update-maintenance','/api/agent/status','/api/managed-models'].map(path=>request(record,path,{optional:path==='/api/managed-models'}).then(r=>r?.json())));
  return {native,serving,maintenance,agent,managed};
}
async function health(record){const [page,native,providers,chats]=await Promise.all([request(record,'/').then(r=>r.text()),request(record,'/api/native').then(r=>r.json()),request(record,'/api/model-providers').then(r=>r.json()),request(record,'/api/chats').then(r=>r.json())]);if(!page.includes('id="root"')||!Array.isArray(native.instances)||!Array.isArray(native.jobs)||!Array.isArray(providers.connections)||!chats)throw fail('The application startup check failed.');return{native,providers,chats};}
async function portFree(preferred=8792){const server=createServer();try{await new Promise((ok,bad)=>{server.once('error',bad);server.listen(preferred,'127.0.0.1',ok);});}catch{await new Promise((ok,bad)=>{server.once('error',bad);server.listen(0,'127.0.0.1',ok);});}const port=server.address().port;await new Promise(ok=>server.close(ok));return port;}
async function startHost(paths,active,{profile=paths.profile,smoke=false,managedModels=!smoke}={}){
  const port=await portFree(smoke?0:8792),entry=join(active.hostRoot,'server/index.mjs');
  const logs=join(paths.dataRoot,'logs');mkdirSync(logs,{recursive:true});
  const suffix=smoke?'-smoke-'+randomUUID().slice(0,8):'',out=openSync(join(logs,'host'+suffix+'.stdout.log'),'a',0o600),err=openSync(join(logs,'host'+suffix+'.stderr.log'),'a',0o600);
  const env=hostEnvironment(paths,active,port,{profile,smoke,managedModels});
  env.STRATA_SHUTDOWN_TOKEN=randomUUID()+randomUUID();
  const child=spawn(paths.node,[entry,'--dist',join(active.hostRoot,'dist')],{cwd:active.hostRoot,detached:true,windowsHide:true,env,stdio:['ignore',out,err]});closeSync(out);closeSync(err);let failed;child.once('error',error=>{failed=error;});child.unref();
  let actual=null;for(let i=0;i<10&&!actual;i++){if(failed||child.exitCode!==null)throw fail('The Strata host could not start.');actual=await processIdentity(child.pid);if(!actual)await sleep(200);}
  const record={pid:child.pid,port,entry,executable:paths.node,created:actual?.created,tailscaleOrigin:env.STRATA_TAILSCALE_ORIGIN??'',shutdownToken:env.STRATA_SHUTDOWN_TOKEN};
  try{if(!record.created)throw fail('The application process identity could not be checked.');let ready=false;for(let i=0;i<80;i++){if(failed||child.exitCode!==null)throw fail('The Strata host stopped before it was ready.');try{await health(record);ready=true;break;}catch{}await sleep(500);}if(!ready)throw fail('Strata did not become ready.');if(!smoke)atomicJson(paths.pidFile,record);return record;}
  catch(error){if(child.exitCode===null)child.kill();throw error;}
}
async function waitExit(pid){for(let i=0;i<150;i++){if(!await processIdentity(pid))return;await sleep(100);}throw fail('Strata is still closing. Try again in a moment.');}
export async function stopHost(paths,{token,record,modelsOnly=false}={}){
  record??=await ownedRecord(paths);
  if(!record){if(modelsOnly)throw fail('Strataの実行状態を確認できません。画面を開き直してください。');return;}
  if(!token){
    const before=await snapshot(record);
    if(isBusy(before.native,before.serving,before.maintenance,before.agent,before.managed))throw fail('回答やモデルの処理が終わってから、もう一度お試しください。');
    if(before.maintenance.active)throw fail('Strataの更新処理が終わってから、もう一度お試しください。');
    const id=randomUUID(),renew=()=>atomicJson(paths.maintenanceFile,{pid:process.pid,id,reason:'stop',expiresAt:Date.now()+120000});renew();
    const timer=setInterval(renew,20000);timer.unref();
    try{return await stopHost(paths,{record,token:id,modelsOnly});}
    finally{clearInterval(timer);try{if(json(paths.maintenanceFile).id===id)unlinkSync(paths.maintenanceFile);}catch{}}
  }
  const current=await snapshot(record);
  if(!current.maintenance.enabled||!current.maintenance.active)throw fail('Strata could not guard the shutdown. Try again after updating the app.');
  if(isBusy(current.native,current.serving,current.maintenance,current.agent,current.managed))throw fail('回答やモデルの処理が終わってから、もう一度お試しください。');
  for(const instance of current.native.instances)if(modelsOnly||instance.status!=='error')await request(record,`/api/native/instances/${encodeURIComponent(instance.id)}/unload`,{method:'POST',token});
  if(modelsOnly){
    if(current.managed?.enabled&&current.managed.activeIds?.length){
      const stop=json(join(paths.dataRoot,'managed-models.json')).stopCommand;
      if(!stop)throw fail('保存済みモデルの停止設定が見つかりません。');
      const {runManagedCommand}=await import(pathToFileURL(join(dirname(record.entry),'managed-local-models.mjs')));
      await runManagedCommand(stop);
    }
    return;
  }
  if(!ownsProcess(paths,record,await processIdentity(record.pid)))throw fail('The Strata process changed while closing.');
  if(record.shutdownToken){
    const response=await fetch(`http://127.0.0.1:${record.port}/api/control/shutdown`,{method:'POST',headers:{'x-strata-client':'strata-managed-launcher','x-strata-shutdown':record.shutdownToken,...(token?{'x-strata-updater':token}:{})},signal:AbortSignal.timeout(5000)});
    if(!response.ok)throw fail('Strata could not stop its coding assistant cleanly. Try closing the app again.');
  }else process.kill(record.pid);
  await waitExit(record.pid);
  try{if(json(paths.pidFile).pid===record.pid)unlinkSync(paths.pidFile);}catch{}
}
async function smokeCandidate(paths,active,previousManaged){
  const dir=join(paths.dataRoot,'update-smoke',randomUUID());mkdirSync(dir,{recursive:true});
  const profile=join(dir,'profile');if(existsSync(paths.profile))cpSync(paths.profile,profile,{recursive:true});
  const record=await startHost(paths,active,{profile,smoke:true,managedModels:true});
  try{
    await health(record);
    if(previousManaged?.enabled){
      const candidate=await (await request(record,'/api/managed-models')).json();
      if(!candidate.enabled||candidate.connectionId!==previousManaged.connectionId||candidate.models.length!==previousManaged.models.length||
        previousManaged.models.some(old=>!candidate.models.some(model=>model.id===old.id&&model.modelId===old.modelId&&
          model.contextMax===old.contextMax&&(old.thinkingBudget===undefined||model.thinkingBudget===old.thinkingBudget)))){
        throw fail('The update did not retain the saved model registration and settings.');
      }
    }
  }finally{if(ownsProcess(paths,record,await processIdentity(record.pid))){process.kill(record.pid);await waitExit(record.pid);}}
}
async function restoreModels(record,models,token){for(let index=0;index<models.length;index++){const job=await(await request(record,'/api/native/operations',{method:'POST',token,body:{kind:'load',args:{model:models[index],multiple:index>0}}})).json();let done=false;for(let attempt=0;attempt<900;attempt++){const value=await(await request(record,'/api/native')).json(),current=value.jobs.find(j=>j.id===job.id);if(current?.state==='error')throw fail('The previous model could not be restored.');if(current?.state==='done'){done=true;break;}await sleep(1000);}if(!done)throw fail('The model is still loading. Open Strata to check its progress.');}}
async function updateControl(paths,active,release){
  const env=hostEnvironment(paths,active,8792);delete env.STRATA_NO_ACQUIRE;
  const feed=`https://github.com/Niko1221/Strata/releases/download/${release.manifest.upstreamTag}/strata-feed.json`;
  await new Promise((ok,bad)=>{const child=spawn(join(paths.control,'python/python.exe'),[join(paths.control,'strata.py'),'update','--yes','--no-engine','--output','json','--feed',feed],{cwd:paths.control,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',expired=false;const timer=setTimeout(()=>{expired=true;},1200000);child.stdout.on('data',chunk=>{output=(output+chunk.toString('utf8')).slice(-2*1024*1024);});child.stderr.resume();child.once('error',()=>{clearTimeout(timer);bad(fail('The verified Control update could not start.'));});child.once('close',code=>{clearTimeout(timer);let result;try{result=JSON.parse(output.replace(/^\uFEFF/,'').trim());}catch{}code===0&&!expired&&result?.ok===true?ok():bad(fail('The verified Control update did not complete.'));});});
}
async function autoUpdate(paths,active,log,release){
  if(!releaseIsNew(release,active))return {active,status:'current'};
  // The native Harness is delivered by the Windows installer, not the host-only archive.
  const installed=json(join(paths.appRoot,'managed-install.json'));
  if(release.version!==(installed.harnessSourceVersion??installed.version)){
    log('新しい本家バージョンはコーディング機能と一緒に更新するため、Windows版の更新通知からインストールしてください。');
    return {active,status:'deferred-installer'};
  }
  const prior=await ownedRecord(paths);if(prior){const state=await snapshot(prior);if(isBusy(state.native,state.serving,state.maintenance,state.agent,state.managed)){log('回答やモデルの処理中のため、更新を次回に回します。');return {active,status:'deferred'};}}
  const candidate=validateActive(paths,await stageForkRelease({root:paths.dataRoot,release,pythonExe:join(paths.control,'python/python.exe'),log}));
  const id=randomUUID(),renew=()=>atomicJson(paths.maintenanceFile,{pid:process.pid,id,reason:'update',expiresAt:Date.now()+120000});renew();const timer=setInterval(renew,20000);timer.unref();
  let backup,previousManaged,promoted=false,models=[],controlAttempted=false;
  const controlPointer=join(paths.dataRoot,'components/control/active.json'),oldControl=existsSync(controlPointer)?json(controlPointer):null;
  try{
    const running=await ownedRecord(paths);if(running){const state=await snapshot(running);if(!state.maintenance.enabled||!state.maintenance.active||isBusy(state.native,state.serving,state.maintenance,state.agent,state.managed))return {active,status:'deferred'};previousManaged=state.managed;models=state.native.instances.filter(i=>i.status==='ready').map(i=>i.model);}
    // Let the last completed answer's autosave settle; new inference is already blocked.
    await sleep(1500);
    backup=join(paths.dataRoot,'backups',new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));mkdirSync(backup,{recursive:true});if(existsSync(paths.profile))cpSync(paths.profile,join(backup,'profile'),{recursive:true});
    if(running)await stopHost(paths,{record:running,token:id});
    if(versionCompare(candidate.version,active.version)>0){controlAttempted=true;await updateControl(paths,active,release);}
    await smokeCandidate(paths,candidate,previousManaged);
    const next={...candidate,releaseTag:release.tag_name,previous:active};atomicJson(paths.activeFile,next);promoted=true;
    const record=await startHost(paths,next);await restoreModels(record,models,id);log('新しいモデル切替版を反映しました。');return {active:next,status:'applied'};
  }catch(error){
    log('新しい版の起動を確認できなかったため、以前の版へ戻します。');
    const failed=await ownedRecord(paths);if(failed)await stopHost(paths,{record:failed,token:id});
    atomicJson(paths.activeFile,active);
    if(controlAttempted){if(oldControl)atomicJson(controlPointer,oldControl);else if(existsSync(controlPointer))unlinkSync(controlPointer);}
    if(promoted&&backup&&existsSync(join(backup,'profile'))){if(existsSync(paths.profile)){const quarantine=join(paths.dataRoot,'failed-profile-'+randomUUID());if(!contained(paths.dataRoot,quarantine)||!contained(paths.dataRoot,realpathSync(paths.profile)))throw error;renameSync(paths.profile,quarantine);}cpSync(join(backup,'profile'),paths.profile,{recursive:true});}
    const record=await startHost(paths,active);await restoreModels(record,models,id);return {active,status:'rollback'};
  }finally{clearInterval(timer);try{if(json(paths.maintenanceFile).id===id)unlinkSync(paths.maintenanceFile);}catch{}}
}
async function makePrivate(paths){mkdirSync(paths.dataRoot,{recursive:true,mode:0o700});try{const helpers=await import(pathToFileURL(join(paths.host,'server/private-file.mjs')));helpers.makePrivateDir(paths.dataRoot);}catch{throw fail('Strata could not protect its application data folder.');}}
export function sharingRestartNeeded(record,origin){return (record?.tailscaleOrigin??'')!==(origin??'');}
async function restartForSharing(paths,active,record){
  const id=randomUUID(),renew=()=>atomicJson(paths.maintenanceFile,{pid:process.pid,id,reason:'update',expiresAt:Date.now()+120000});renew();const timer=setInterval(renew,20000);timer.unref();
  let models=[],stopped=false;
  try{const state=await snapshot(record);if(!state.maintenance.enabled||!state.maintenance.active||isBusy(state.native,state.serving,state.maintenance,state.agent,state.managed))throw fail('回答やモデルの処理が終わってから、もう一度共有設定を実行してください。');models=state.native.instances.filter(i=>i.status==='ready').map(i=>i.model);await sleep(1500);await stopHost(paths,{record,token:id});stopped=true;const next=await startHost(paths,active);await restoreModels(next,models,id);return next;}
  catch(error){if(stopped){const failed=await ownedRecord(paths);if(failed)await stopHost(paths,{record:failed,token:id});paths.tailscaleOrigin=record.tailscaleOrigin??'';const restored=await startHost(paths,active);await restoreModels(restored,models,id);}throw error;}
  finally{clearInterval(timer);try{if(json(paths.maintenanceFile).id===id)unlinkSync(paths.maintenanceFile);}catch{}}
}
async function openBrowser(url){await command('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',`Start-Process '${url.replace(/'/g,"''")}'`]);}
export async function main(args=process.argv.slice(2),options={}){
  if(args.includes('--stop-models')&&args.some(arg=>!['--stop-models','--desktop','--no-browser'].includes(arg)))throw fail('Choose one launcher action.');
  if(args.includes('--coding-accept')&&!args.includes('--coding'))throw fail('Automatic coding consent requires --coding.');
  if(args.includes('--coding')&&args.some(arg=>['--stop','--smoke','--models','--api','--tailscale','--tailscale-off','--download-update'].includes(arg)))throw fail('Choose one launcher action.');
  if(args.some(arg=>!['--stop','--stop-models','--wait','--smoke','--no-browser','--no-update','--desktop','--models','--api','--tailscale','--tailscale-off','--download-update','--coding','--coding-accept'].includes(arg))||args.includes('--tailscale')&&args.includes('--tailscale-off')||args.includes('--smoke')&&(args.includes('--tailscale')||args.includes('--tailscale-off'))||args.includes('--download-update')&&args.some(arg=>!['--download-update','--desktop','--no-browser'].includes(arg)))throw fail('Unknown launcher option.');
  const paths=layout(options);if(!existsSync(paths.node)||!existsSync(join(paths.control,'python/python.exe')))throw fail('The bundled runtime is incomplete. Run the installer again.');
  const showBrowser=options.openBrowser??openBrowser,checkRelease=options.fetchRelease??fetchForkRelease;
  await makePrivate(paths);mkdirSync(join(paths.dataRoot,'logs'),{recursive:true});
  const log=message=>writeFileSync(join(paths.dataRoot,'logs/launcher.log'),new Date().toISOString()+' '+message+'\n',{flag:'a',mode:0o600});
  if(args.includes('--stop')){await stopHost(paths);return{stopped:true};}
  if(args.includes('--stop-models')){await stopHost(paths,{modelsOnly:true});return{modelsStopped:true};}
  if(!args.includes('--smoke'))try{refreshCodingPolicy(paths);}catch(error){if(args.includes('--coding'))throw error;log('自動テストの指示を更新できませんでした。保存済みの指示を確認してください。');}
  const metadata=json(join(paths.appRoot,'managed-install.json'));
  const bundled=validateActive(paths,{version:metadata.version,commit:metadata.commit,releaseTag:metadata.releaseTag,hostRoot:paths.host});
  if(args.includes('--download-update')){
    const release=await checkRelease();
    if(!release.installer||!releaseIsNew(release,bundled))throw fail('この Windows 版はすでに最新です。');
    const installer=await stageForkInstaller({root:paths.dataRoot,release});
    const setup=spawn(installer,['/D='+paths.appRoot],{cwd:paths.dataRoot,detached:true,stdio:'ignore',windowsVerbatimArguments:true,windowsHide:false,shell:false});
    await new Promise((ok,bad)=>{setup.once('spawn',ok);setup.once('error',bad);});setup.unref();
    return {ok:true,installerOpened:true,releaseTag:release.tag_name};
  }
  let active=bundled;
  if(existsSync(paths.activeFile)){try{const saved=validateActive(paths,json(paths.activeFile));if(!bundledIsNewer(bundled,saved))active=saved;}catch{log('以前のアプリ保存先を確認できなかったため、インストール済みの版を使います。');}}
  if(args.includes('--smoke')){
    const resultFile=join(paths.dataRoot,'smoke-result.json');if(existsSync(resultFile))unlinkSync(resultFile);
    const record=await startHost(paths,active,{smoke:true,profile:join(paths.dataRoot,'smoke/profile')});let result;
    try{const state=await health(record);if(state.providers.connections.length||state.native.instances.length)throw fail('The clean-install smoke profile is not empty.');if(!state.native.capabilities?.componentUpdates)throw fail('The bundled Strata Control could not be found.');result={ok:true,controlAvailable:true,version:active.version,providers:0,models:0,port:record.port};}
    finally{if(ownsProcess(paths,record,await processIdentity(record.pid))){process.kill(record.pid);await waitExit(record.pid);}}
    atomicJson(resultFile,result);return result;
  }
  if(args.includes('--tailscale-off')){
    const saved=readTailscaleConfig(paths.dataRoot);if(!saved)return{disabled:true,changed:false};
    let record=await ownedRecord(paths);if(record){const state=await snapshot(record);if(isBusy(state.native,state.serving,state.maintenance,state.agent,state.managed))throw fail('回答やモデルの処理が終わってから、共有を停止してください。');}
    const result=await disableTailscale({dataRoot:paths.dataRoot});paths.tailscaleOrigin='';
    if(record&&sharingRestartNeeded(record,''))record=await restartForSharing(paths,active,record);
    log('Tailscale共有を停止しました。');return {...result,localUrl:record?`http://127.0.0.1:${record.port}/#/chat`:null,tailscaleUrl:null};
  }
  let sharingPlan=null,savedSharing=null;
  try{savedSharing=readTailscaleConfig(paths.dataRoot);if(args.includes('--tailscale')||savedSharing)sharingPlan=await planTailscale({dataRoot:paths.dataRoot});}
  catch(error){if(args.includes('--tailscale'))throw error;log('Tailscale共有を再開できませんでした。ローカル画面を開きます。');}
  paths.tailscaleOrigin=sharingPlan?.url??savedSharing?.url??'';
  let updateStatus='unchanged',latest=null;
  if(!args.includes('--no-update'))try{latest=await checkRelease();const update=await autoUpdate(paths,active,log,latest);active=update.active;updateStatus=update.status;}catch{updateStatus='unavailable';log('更新の検証に失敗しました。保存済みの版で起動します。');}
  let record=await ownedRecord(paths);if(record&&resolve(record.entry)!==resolve(join(active.hostRoot,'server/index.mjs'))){await stopHost(paths,{record});record=null;}
  if(record&&sharingRestartNeeded(record,paths.tailscaleOrigin))record=await restartForSharing(paths,active,record);
  if(!record)record=await startHost(paths,active);atomicJson(paths.activeFile,active);
  let shared=null;
  if(sharingPlan){try{shared=await applyTailscale({dataRoot:paths.dataRoot,hostPort:record.port,plan:sharingPlan});log('Tailscale共有: '+shared.url);}catch(error){if(args.includes('--tailscale')){if(error.actionUrl&&!args.includes('--no-browser'))await showBrowser(error.actionUrl);throw error;}log('Tailscale共有を再開できませんでした。ローカル画面を開きます。');}}
  const coding=args.includes('--coding')?await configureCoding(paths,record,{accepted:args.includes('--coding-accept')}):null;
  const first=!existsSync(join(paths.dataRoot,'first-run.json')),target=coding?.target??(args.includes('--api')?'#/settings?section=Models':args.includes('--models')||first&&!existsSync(join(paths.dataRoot,'managed-models.json'))?'#/models':'#/chat');
  const localUrl=`http://127.0.0.1:${record.port}/${target}`,url=shared?`${shared.url}/${target}`:localUrl;
  if(!args.includes('--no-browser')){if(!args.includes('--desktop'))await showBrowser(url);atomicJson(join(paths.dataRoot,'first-run.json'),{openedAt:new Date().toISOString()});}
  return {ok:true,version:active.version,releaseTag:active.releaseTag,updateStatus,installedReleaseTag:bundled.releaseTag,latestInstallerTag:latest?.installer&&releaseIsNew(latest,bundled)?latest.tag_name:null,url,localUrl,tailscaleUrl:shared?.url??null,pid:record.pid,tailscale:!!shared};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await main()));}catch(error){const message=error instanceof Error?error.message:'Strata could not start.';try{const paths=layout();mkdirSync(join(paths.dataRoot,'logs'),{recursive:true});writeFileSync(join(paths.dataRoot,'logs/launcher.log'),new Date().toISOString()+' '+message+'\n',{flag:'a',mode:0o600});}catch{}console.error(message);process.exitCode=1;}
}
