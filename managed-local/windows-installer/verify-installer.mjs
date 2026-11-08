/** Real install/repair/uninstall smoke gate, using a separate user-data directory and no model downloads. */
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {existsSync,mkdirSync,readFileSync,writeFileSync,realpathSync} from 'node:fs';
import {join,resolve,relative,isAbsolute} from 'node:path';
const wait=ms=>new Promise(done=>setTimeout(done,ms));
export function runInstallerTest(file,args,{cwd,env,timeoutMs=180000,verbatim=false}={}){
  return new Promise((ok,bad)=>{
    const child=spawn(file,args,{cwd,env,windowsHide:true,windowsVerbatimArguments:verbatim,shell:false,stdio:['ignore','pipe','pipe']});
    let stdout='',stderr='';child.stdout.on('data',b=>{stdout=(stdout+b).slice(-16000);});child.stderr.on('data',b=>{stderr=(stderr+b).slice(-16000);});
    const timer=setTimeout(()=>{child.kill();},timeoutMs);
    child.once('error',error=>{clearTimeout(timer);bad(error);});child.once('close',code=>{clearTimeout(timer);code===0?ok({stdout,stderr}):bad(Object.assign(Error('The Windows installer lifecycle test failed.'),{detail:stdout+stderr,code}));});
  });
}
export async function verifyWindowsInstaller({installer,workRoot,run=runInstallerTest}={}){
  if(process.platform!=='win32'||!isAbsolute(installer??'')||!isAbsolute(workRoot??''))throw Error('The Windows installer test needs absolute Windows paths.');
  workRoot=resolve(workRoot);mkdirSync(workRoot,{recursive:true});
  const app=join(workRoot,'app'),data=join(workRoot,'user-data');mkdirSync(data,{recursive:true});
  const env={...process.env,STRATA_MANAGED_DATA_DIR:data};
  const registry=await run('powershell.exe',['-NoLogo','-NoProfile','-Command',String.raw`$p=Get-ItemProperty -LiteralPath 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\StrataManagedModels' -ErrorAction SilentlyContinue; if($p){$p.InstallLocation}`],{cwd:workRoot,env});
  const existing=registry.stdout?.trim();if(existing){const rel=relative(realpathSync(workRoot),resolve(existing));if(rel.startsWith('..')||isAbsolute(rel))throw Error('A real installation is already registered. Use a clean test account.');}
  const invokeSetup=()=>run(installer,['/S','/D='+app],{cwd:workRoot,env,timeoutMs:240000,verbatim:true});
  await invokeSetup();
  for(const path of ['StrataManaged.exe','runtime/runtime.mjs','resources/node/node.exe','resources/control/python/python.exe','host/server/index.mjs','host/dist/index.html','README.ja.txt'])assert(existsSync(join(app,path)),'Missing installed file: '+path);
  const launcher=join(app,'StrataManaged.exe');
  const smoke=async()=>{
    try{await run(launcher,['--smoke'],{cwd:app,env,timeoutMs:120000});}
    catch(error){for(const p of ['smoke-result.json','logs/runtime.log','logs/launcher.log'])if(existsSync(join(data,p)))console.error(readFileSync(join(data,p),'utf8').slice(-12000));throw error;}
    const result=JSON.parse(readFileSync(join(data,'smoke-result.json'),'utf8'));assert.equal(result.ok,true);assert.equal(result.controlAvailable,true);return result;
  };
  const first=await smoke();
  const userMarker=join(data,'keep-this-user-file.txt'),appMarker=join(app,'user-kept-note.txt');
  writeFileSync(userMarker,'User settings and downloaded models are stored here.');writeFileSync(appMarker,'An unrecognized user file must not be recursively removed.');
  await invokeSetup();const second=await smoke();assert(existsSync(userMarker));assert(existsSync(appMarker));
  await run(join(app,'Uninstall.exe'),['/S'],{cwd:workRoot,env,timeoutMs:120000});
  for(let i=0;i<100&&existsSync(launcher);i++)await wait(200);
  assert(!existsSync(launcher),'The application launcher was not removed.');assert(!existsSync(join(app,'resources/node/node.exe')),'The bundled runtime was not removed.');
  assert(existsSync(userMarker),'Uninstall removed user data.');assert(existsSync(appMarker),'Uninstall removed an unrecognized file.');
  const result={ok:true,installed:true,repaired:true,uninstalled:true,userDataRetained:true,unknownAppFileRetained:true,first,second};writeFileSync(join(workRoot,'installer-verification.json'),JSON.stringify(result,null,2));console.log('Windows install, start, repair and uninstall/user-data retention: passed.');return result;
}
