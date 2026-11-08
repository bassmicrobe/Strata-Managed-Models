/** Per-user launcher for the Windows package. All mutable files live outside the installation. */
import {spawn,execFile} from 'node:child_process';
import {createServer} from 'node:net';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,unlinkSync,openSync,closeSync,cpSync,realpathSync} from 'node:fs';
import {dirname,join,resolve,relative,isAbsolute,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {fetchForkRelease,stageForkRelease,FORK_REPOSITORY} from './fork-stage.mjs';

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
export function hostEnvironment(paths,active,port,{profile=paths.profile,smoke=false}={}){
  const env={...process.env};
  for(const key of ['PYTHONPATH','PYTHONHOME','PYTHONSTARTUP','STRATA_DATA_DIR','STRATA_MANAGED_MODELS_CONFIG','STRATA_HANDOVER','STRATA_NO_HANDOVER','STRATA_UPDATE_TRUSTED_KEYS','STRATA_DIST','GITHUB_TOKEN','GH_TOKEN'])delete env[key];
  Object.assign(env,{STRATA_HOME:profile,STRATA_DATA_DIR:paths.dataRoot,STRATA_STATE_DIR:join(paths.dataRoot,'state'),STRATA_COMPONENTS_DIR:join(paths.dataRoot,'components'),STRATA_CONTROL_DIR:paths.control,STRATA_INSTALL_DIR:join(paths.dataRoot,'install'),STRATA_PROFILE_DIR:join(paths.dataRoot,'profiles'),STRATA_RUNTIME_DIR:join(paths.dataRoot,'runtime'),STRATA_SETTINGS_FILE:join(paths.dataRoot,'app-settings.json'),STRATA_MODELS_DIR:join(paths.dataRoot,'models'),STRATA_WORKSPACE:join(paths.dataRoot,'Workspace'),STRATA_REAL_ENGINE:'1',STRATA_NO_ACQUIRE:'1',STRATA_APP_VERSION:active.version,STRATA_PORT:String(port),STRATA_BIND:'127.0.0.1',STRATA_UPDATE_MAINTENANCE_FILE:paths.maintenanceFile,STRATA_NO_BUNDLED_ENGINE:'1',STRATA_NO_REPAIR_ACCESS:'1'});
  const managed=join(paths.dataRoot,'managed-models.json');if(existsSync(managed))env.STRATA_MANAGED_MODELS_CONFIG=managed;
  if(smoke)env.STRATA_SETTINGS_FILE=join(dirname(profile),'app-settings.json');
  return env;
}
export function isBusy(native,serving,maintenance){return !!(maintenance?.activeRequests||native?.jobs?.some(job=>job.state==='running')||native?.instances?.some(i=>(i.metrics?.live?.running??0)>0||(i.metrics?.live?.queued??0)>0)||serving?.stats?.running||serving?.stats?.waiting||serving?.requests?.some(r=>['queued','generating'].includes(r.state)));}
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
async function request(record,path,{method='GET',body,token}={}){const response=await fetch(`http://127.0.0.1:${record.port}${path}`,{method,headers:{'x-strata-client':'strata-managed-launcher',...(body?{'content-type':'application/json'}:{}),...(token?{'x-strata-updater':token}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(method==='GET'?5000:360000)});if(!response.ok)throw fail(response.status===409?'回答やモデルの処理が終わってから、もう一度お試しください。':'The Strata host did not accept the operation.');return response;}
async function snapshot(record){const [native,serving,maintenance]=await Promise.all([request(record,'/api/native').then(r=>r.json()),request(record,'/api/serving').then(r=>r.json()),request(record,'/api/update-maintenance').then(r=>r.json())]);return{native,serving,maintenance};}
async function health(record){const [page,native,providers,chats]=await Promise.all([request(record,'/').then(r=>r.text()),request(record,'/api/native').then(r=>r.json()),request(record,'/api/model-providers').then(r=>r.json()),request(record,'/api/chats').then(r=>r.json())]);if(!page.includes('id="root"')||!Array.isArray(native.instances)||!Array.isArray(native.jobs)||!Array.isArray(providers.connections)||!chats)throw fail('The application startup check failed.');return{native,providers,chats};}
async function portFree(preferred=8792){const server=createServer();try{await new Promise((ok,bad)=>{server.once('error',bad);server.listen(preferred,'127.0.0.1',ok);});}catch{await new Promise((ok,bad)=>{server.once('error',bad);server.listen(0,'127.0.0.1',ok);});}const port=server.address().port;await new Promise(ok=>server.close(ok));return port;}
async function startHost(paths,active,{profile=paths.profile,smoke=false}={}){
  const port=await portFree(smoke?0:8792),entry=join(active.hostRoot,'server/index.mjs');
  const logs=join(paths.dataRoot,'logs');mkdirSync(logs,{recursive:true});
  const suffix=smoke?'-smoke-'+randomUUID().slice(0,8):'',out=openSync(join(logs,'host'+suffix+'.stdout.log'),'a',0o600),err=openSync(join(logs,'host'+suffix+'.stderr.log'),'a',0o600);
  const child=spawn(paths.node,[entry,'--dist',join(active.hostRoot,'dist')],{cwd:active.hostRoot,detached:true,windowsHide:true,env:hostEnvironment(paths,active,port,{profile,smoke}),stdio:['ignore',out,err]});closeSync(out);closeSync(err);let failed;child.once('error',error=>{failed=error;});child.unref();
  let actual=null;for(let i=0;i<10&&!actual;i++){if(failed||child.exitCode!==null)throw fail('The Strata host could not start.');actual=await processIdentity(child.pid);if(!actual)await sleep(200);}
  const record={pid:child.pid,port,entry,executable:paths.node,created:actual?.created};
  try{if(!record.created)throw fail('The application process identity could not be checked.');let ready=false;for(let i=0;i<80;i++){if(failed||child.exitCode!==null)throw fail('The Strata host stopped before it was ready.');try{await health(record);ready=true;break;}catch{}await sleep(500);}if(!ready)throw fail('Strata did not become ready.');if(!smoke)atomicJson(paths.pidFile,record);return record;}
  catch(error){if(child.exitCode===null)child.kill();throw error;}
}
async function waitExit(pid){for(let i=0;i<50;i++){if(!await processIdentity(pid))return;await sleep(100);}throw fail('Strata is still closing. Try again in a moment.');}
export async function stopHost(paths,{token,record}={}){
  record??=await ownedRecord(paths);if(!record)return;
  const current=await snapshot(record);if(isBusy(current.native,current.serving,current.maintenance))throw fail('回答やモデルの処理が終わってから、もう一度お試しください。');
  for(const instance of current.native.instances)if(instance.status!=='error')await request(record,`/api/native/instances/${encodeURIComponent(instance.id)}/unload`,{method:'POST',token});
  if(!ownsProcess(paths,record,await processIdentity(record.pid)))throw fail('The Strata process changed while closing.');
  process.kill(record.pid);await waitExit(record.pid);
  try{if(json(paths.pidFile).pid===record.pid)unlinkSync(paths.pidFile);}catch{}
}
async function smokeCandidate(paths,active){const dir=join(paths.dataRoot,'update-smoke',randomUUID());mkdirSync(dir,{recursive:true});const profile=join(dir,'profile');if(existsSync(paths.profile))cpSync(paths.profile,profile,{recursive:true});const record=await startHost(paths,active,{profile,smoke:true});try{await health(record);}finally{if(ownsProcess(paths,record,await processIdentity(record.pid))){process.kill(record.pid);await waitExit(record.pid);}}}
async function restoreModels(record,models,token){for(let index=0;index<models.length;index++){const job=await(await request(record,'/api/native/operations',{method:'POST',token,body:{kind:'load',args:{model:models[index],multiple:index>0}}})).json();let done=false;for(let attempt=0;attempt<900;attempt++){const value=await(await request(record,'/api/native')).json(),current=value.jobs.find(j=>j.id===job.id);if(current?.state==='error')throw fail('The previous model could not be restored.');if(current?.state==='done'){done=true;break;}await sleep(1000);}if(!done)throw fail('The model is still loading. Open Strata to check its progress.');}}
async function updateControl(paths,active,release){
  const env=hostEnvironment(paths,active,8792);delete env.STRATA_NO_ACQUIRE;
  const feed=`https://github.com/Niko1221/Strata/releases/download/${release.manifest.upstreamTag}/strata-feed.json`;
  await new Promise((ok,bad)=>{const child=spawn(join(paths.control,'python/python.exe'),[join(paths.control,'strata.py'),'update','--yes','--no-engine','--output','json','--feed',feed],{cwd:paths.control,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output='',expired=false;const timer=setTimeout(()=>{expired=true;},1200000);child.stdout.on('data',chunk=>{output=(output+chunk.toString('utf8')).slice(-2*1024*1024);});child.stderr.resume();child.once('error',()=>{clearTimeout(timer);bad(fail('The verified Control update could not start.'));});child.once('close',code=>{clearTimeout(timer);let result;try{result=JSON.parse(output.replace(/^\uFEFF/,'').trim());}catch{}code===0&&!expired&&result?.ok===true?ok():bad(fail('The verified Control update did not complete.'));});});
}
async function autoUpdate(paths,active,log){
  let release;try{release=await fetchForkRelease();}catch{log('更新を確認できませんでした。保存済みの版を使います。');return active;}
  if(!releaseIsNew(release,active))return active;
  const prior=await ownedRecord(paths);if(prior){const state=await snapshot(prior);if(isBusy(state.native,state.serving,state.maintenance)){log('回答やモデルの処理中のため、更新を次回に回します。');return active;}}
  const candidate=validateActive(paths,await stageForkRelease({root:paths.dataRoot,release,pythonExe:join(paths.control,'python/python.exe'),log}));
  const id=randomUUID(),renew=()=>atomicJson(paths.maintenanceFile,{pid:process.pid,id,reason:'update',expiresAt:Date.now()+120000});renew();const timer=setInterval(renew,20000);timer.unref();
  let backup,promoted=false,models=[],controlAttempted=false;
  const controlPointer=join(paths.dataRoot,'components/control/active.json'),oldControl=existsSync(controlPointer)?json(controlPointer):null;
  try{
    const running=await ownedRecord(paths);if(running){const state=await snapshot(running);if(!state.maintenance.enabled||!state.maintenance.active||isBusy(state.native,state.serving,state.maintenance))return active;models=state.native.instances.filter(i=>i.status==='ready').map(i=>i.model);}
    // Let the last completed answer's autosave settle; new inference is already blocked.
    await sleep(1500);
    backup=join(paths.dataRoot,'backups',new Date().toISOString().replace(/[:.]/g,'-')+'-'+randomUUID().slice(0,8));mkdirSync(backup,{recursive:true});if(existsSync(paths.profile))cpSync(paths.profile,join(backup,'profile'),{recursive:true});
    if(running)await stopHost(paths,{record:running,token:id});
    if(versionCompare(candidate.version,active.version)>0){controlAttempted=true;await updateControl(paths,active,release);}
    await smokeCandidate(paths,candidate);
    const next={...candidate,releaseTag:release.tag_name,previous:active};atomicJson(paths.activeFile,next);promoted=true;
    const record=await startHost(paths,next);await restoreModels(record,models,id);log('新しいモデル切替版を反映しました。');return next;
  }catch(error){
    log('新しい版の起動を確認できなかったため、以前の版へ戻します。');
    const failed=await ownedRecord(paths);if(failed)await stopHost(paths,{record:failed,token:id});
    atomicJson(paths.activeFile,active);
    if(controlAttempted){if(oldControl)atomicJson(controlPointer,oldControl);else if(existsSync(controlPointer))unlinkSync(controlPointer);}
    if(promoted&&backup&&existsSync(join(backup,'profile'))){if(existsSync(paths.profile)){const quarantine=join(paths.dataRoot,'failed-profile-'+randomUUID());if(!contained(paths.dataRoot,quarantine)||!contained(paths.dataRoot,realpathSync(paths.profile)))throw error;renameSync(paths.profile,quarantine);}cpSync(join(backup,'profile'),paths.profile,{recursive:true});}
    const record=await startHost(paths,active);await restoreModels(record,models,id);return active;
  }finally{clearInterval(timer);try{if(json(paths.maintenanceFile).id===id)unlinkSync(paths.maintenanceFile);}catch{}}
}
async function makePrivate(paths){mkdirSync(paths.dataRoot,{recursive:true,mode:0o700});try{const helpers=await import(pathToFileURL(join(paths.host,'server/private-file.mjs')));helpers.makePrivateDir(paths.dataRoot);}catch{throw fail('Strata could not protect its application data folder.');}}
export async function main(args=process.argv.slice(2),options={}){
  if(args.some(arg=>!['--stop','--wait','--smoke','--no-browser','--models','--api'].includes(arg)))throw fail('Unknown launcher option.');
  const paths=layout(options);if(!existsSync(paths.node)||!existsSync(join(paths.control,'python/python.exe')))throw fail('The bundled runtime is incomplete. Run the installer again.');
  await makePrivate(paths);mkdirSync(join(paths.dataRoot,'logs'),{recursive:true});
  const log=message=>writeFileSync(join(paths.dataRoot,'logs/launcher.log'),new Date().toISOString()+' '+message+'\n',{flag:'a',mode:0o600});
  if(args.includes('--stop')){await stopHost(paths);return{stopped:true};}
  const metadata=json(join(paths.appRoot,'managed-install.json'));
  const bundled=validateActive(paths,{version:metadata.version,commit:metadata.commit,releaseTag:metadata.releaseTag,hostRoot:paths.host});
  let active=bundled;
  if(existsSync(paths.activeFile)){try{const saved=validateActive(paths,json(paths.activeFile));if(!bundledIsNewer(bundled,saved))active=saved;}catch{log('以前のアプリ保存先を確認できなかったため、インストール済みの版を使います。');}}
  if(args.includes('--smoke')){
    const resultFile=join(paths.dataRoot,'smoke-result.json');if(existsSync(resultFile))unlinkSync(resultFile);
    const record=await startHost(paths,active,{smoke:true,profile:join(paths.dataRoot,'smoke/profile')});let result;
    try{const state=await health(record);if(state.providers.connections.length||state.native.instances.length)throw fail('The clean-install smoke profile is not empty.');if(!state.native.capabilities?.componentUpdates)throw fail('The bundled Strata Control could not be found.');result={ok:true,controlAvailable:true,version:active.version,providers:0,models:0,port:record.port};}
    finally{if(ownsProcess(paths,record,await processIdentity(record.pid))){process.kill(record.pid);await waitExit(record.pid);}}
    atomicJson(resultFile,result);return result;
  }
  try{active=await autoUpdate(paths,active,log);}catch{log('更新の検証に失敗しました。保存済みの版で起動します。');}
  let record=await ownedRecord(paths);if(record&&resolve(record.entry)!==resolve(join(active.hostRoot,'server/index.mjs'))){await stopHost(paths,{record});record=null;}
  if(!record)record=await startHost(paths,active);atomicJson(paths.activeFile,active);
  const first=!existsSync(join(paths.dataRoot,'first-run.json')),target=args.includes('--api')?'#/settings?section=Models':args.includes('--models')||first?'#/models':'#/chat';
  if(!args.includes('--no-browser')){await command('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',`Start-Process 'http://127.0.0.1:${record.port}/${target}'`]);atomicJson(join(paths.dataRoot,'first-run.json'),{openedAt:new Date().toISOString()});}
  return {ok:true,version:active.version,url:`http://127.0.0.1:${record.port}/${target}`,pid:record.pid};
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await main()));}catch(error){const message=error instanceof Error?error.message:'Strata could not start.';try{const paths=layout();mkdirSync(join(paths.dataRoot,'logs'),{recursive:true});writeFileSync(join(paths.dataRoot,'logs/launcher.log'),new Date().toISOString()+' '+message+'\n',{flag:'a',mode:0o600});}catch{}console.error(message);process.exitCode=1;}
}
