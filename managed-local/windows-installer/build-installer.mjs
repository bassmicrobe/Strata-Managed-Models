/** Build a per-user Windows installer without reading an installed user's profile or models. */
import {execFile} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {copyFileSync,cpSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';

export const NODE_VERSION='24.12.0';
export const NODE_ARCHIVE='node-v24.12.0-win-x64.zip';
export const NODE_SHA256='9c125f61ae947b52e779095830f9cac267846a043ef7192183c84016aaad2812';
export const CONTROL_VERSION='0.1.58';
export const CONTROL_ARCHIVE='strata-control-0.1.58-windows-x86_64.zip';
export const CONTROL_SHA256='5a927d2b2ac61a9d6963fb17b46819f0bbd779875d1f9a6ba0e07834b350077b';
const HERE=dirname(fileURLToPath(import.meta.url));
const PRODUCT='strata-managed-models';
const MAX_ARCHIVE=256*1024*1024;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
export function contained(base,file){const r=relative(resolve(base),resolve(file));return !!r&&r!=='..'&&!r.startsWith('..'+sep)&&!isAbsolute(r);}
export function hostFileAllowed(path){return typeof path==='string'&&!isAbsolute(path)&&!path.includes(':')&&!path.includes('\\')&&!path.split('/').some(p=>!p||p==='.'||p==='..'||p.startsWith('.env')||p.startsWith('.npmrc')||['node_modules','.git','.vite','.cache'].includes(p));}
export function runBuildCommand(file,args,{cwd,env,timeoutMs=300000}={}){
  return new Promise((ok,bad)=>{
    const child=execFile(file,args,{cwd,env,timeout:timeoutMs,windowsHide:true,maxBuffer:8*1024*1024},(err,stdout,stderr)=>{
      if(err)bad(Object.assign(new Error('The Windows installer build command failed.'),{detail:String(stdout).slice(-12000)+String(stderr).slice(-12000)}));
      else ok({code:0,stdout:String(stdout),stderr:String(stderr)});
    });child.stdin?.end();
  });
}
async function invoke(run,file,args,options){const answer=await run(file,args,options);if(answer?.code&&answer.code!==0)throw Error('The Windows installer build command failed.');return answer;}
function noLink(file){if(lstatSync(file).isSymbolicLink())throw Error('Installer inputs may not be links.');}
export function copyHost(source,target){
  if(!existsSync(join(source,'server/index.mjs'))||!existsSync(join(source,'dist/index.html')))throw Error('Build the host before packaging the installer.');
  let files=0,bytes=0;
  function walk(dir,rel=''){
    noLink(dir);
    for(const name of readdirSync(dir)){
      const part=rel?rel+'/'+name:name;if(!hostFileAllowed(part))continue;
      const from=join(dir,name),to=join(target,...part.split('/'));noLink(from);const stat=lstatSync(from);
      if(stat.isDirectory()){mkdirSync(to,{recursive:true});walk(from,part);}
      else if(stat.isFile()){
        files++;bytes+=stat.size;if(files>20000||bytes>512*1024*1024)throw Error('Unexpectedly large host input.');
        mkdirSync(dirname(to),{recursive:true});copyFileSync(from,to);
      }else throw Error('Unsupported installer input.');
    }
  }
  mkdirSync(target,{recursive:true});walk(source);return {files,bytes};
}
export function collectLicenses(repoRoot,destination){
  mkdirSync(destination,{recursive:true});
  const license=join(repoRoot,'LICENSE');if(!existsSync(license))throw Error('Strata LICENSE is missing.');
  copyFileSync(license,join(destination,'Strata-LICENSE.txt'));
  const host=join(repoRoot,'apps/host'),lock=JSON.parse(readFileSync(join(host,'package-lock.json'),'utf8'));
  const notices=['# Third-party notices','','Strata: MIT. See Strata-LICENSE.txt.','Node.js: see resources/node/LICENSE.','Strata Control and its bundled Python packages: see resources/control and the included package metadata.',''];
  let packages=0,files=0;
  for(const [path,entry] of Object.entries(lock.packages??{})){
    if(!path||entry.dev||!path.startsWith('node_modules/')||path.split('/').some(p=>p==='.'||p==='..'))continue;
    const directory=join(host,...path.split('/'));if(!existsSync(directory))continue;noLink(directory);
    const names=readdirSync(directory).filter(n=>/^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(n)&&lstatSync(join(directory,n)).isFile());
    if(!names.length)continue;
    const id=path.replace(/^node_modules\//,'').replace(/[^A-Za-z0-9_.-]/g,'_')+'-'+sha(Buffer.from(path)).slice(0,8),out=join(destination,id);mkdirSync(out,{recursive:true});
    for(const name of names){noLink(join(directory,name));copyFileSync(join(directory,name),join(out,name));files++;}
    packages++;notices.push(`- ${path.replace(/^node_modules\//,'')} ${entry.version??''}: ${names.map(n=>id+'/'+n).join(', ')}`);
  }
  for(const direct of Object.keys(lock.packages?.['']?.dependencies??{})){
    const dir=join(host,'node_modules',direct);if(!existsSync(dir))throw Error('Install production dependencies before collecting their licenses.');
    if(!readdirSync(dir).some(n=>/^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/i.test(n)))throw Error('A bundled frontend dependency has no license notice: '+direct);
  }
  writeFileSync(join(destination,'THIRD-PARTY-NOTICES.md'),notices.join('\n')+'\n');return {packages,files};
}
async function controlAssetFallback(match,expected,{fetchImpl,token,initialFailure}){
  const [url,tag,name]=match,base='https://api.github.com/repos/Niko1221/Strata',signal=AbortSignal.timeout(180000);
  const headers={accept:'application/vnd.github+json','x-github-api-version':'2022-11-28',...(token?{authorization:'Bearer '+token}:{})};
  const request=async(address,options,phase)=>{try{return await fetchImpl(address,{...options,signal});}catch{throw Error(`${initialFailure}; official Control fallback failed at ${phase} (network request failed).`);}};
  const metadata=await request(base+'/releases/tags/'+tag,{headers,redirect:'error'},'api.github.com release metadata');
  if(!metadata.ok)throw Error(`${initialFailure}; official Control fallback metadata failed at api.github.com (HTTP ${metadata.status}).`);
  const release=await metadata.json(),assets=release.assets?.filter(a=>a.name===name);
  const asset=assets?.length===1?assets[0]:null;
  if(release.tag_name!==tag||release.draft||release.prerelease||!asset||!Number.isSafeInteger(asset.id)||asset.id<=0
    ||!Number.isSafeInteger(asset.size)||asset.size<=0||asset.size>MAX_ARCHIVE||asset.browser_download_url!==url
    ||asset.digest&&asset.digest!=='sha256:'+expected)throw Error('The official Control fallback asset metadata is invalid.');
  let response=await request(base+'/releases/assets/'+asset.id,{headers:{...headers,accept:'application/octet-stream'},redirect:'manual'},'api.github.com asset API');
  if([301,302,303,307,308].includes(response.status)){
    let target;try{target=new URL(response.headers.get('location'));if(target.protocol!=='https:'||target.hostname!=='release-assets.githubusercontent.com'||target.username||target.password)throw Error();}catch{throw Error('The official Control fallback asset redirect is invalid.');}
    await response.body?.cancel();
    response=await request(target.href,{headers:{accept:'application/octet-stream'},redirect:'error'},'release-assets.githubusercontent.com asset CDN');
    if(!response.ok)throw Error(`${initialFailure}; official Control fallback failed at release-assets.githubusercontent.com (HTTP ${response.status}).`);
  }else if(!response.ok)throw Error(`${initialFailure}; official Control fallback failed at api.github.com asset API (HTTP ${response.status}).`);
  return{response,size:asset.size};
}
export async function download(url,target,expected,{fetchImpl=fetch,token=process.env.GITHUB_TOKEN}={}){
  if(existsSync(target)&&sha(readFileSync(target))===expected)return;
  const control=/^https:\/\/github\.com\/Niko1221\/Strata\/releases\/download\/(v\d+\.\d+\.\d+)\/(strata-control-\d+\.\d+\.\d+-windows-x86_64\.zip)$/.exec(url);
  let response,size,initialFailure;
  try{response=await fetchImpl(url,{signal:AbortSignal.timeout(control?30000:180000)});}catch{initialFailure=`Official runtime download failed at ${new URL(url).hostname} (network request failed)`;}
  if(response&&!response.ok)initialFailure=`Official runtime download failed at ${new URL(url).hostname} (HTTP ${response.status})`;
  if(initialFailure){
    if(!control)throw Error(initialFailure+'.');
    await response?.body?.cancel();
    console.log(initialFailure+'; using the official GitHub asset API.');
    ({response,size}=await controlAssetFallback(control,expected,{fetchImpl,token,initialFailure}));
  }
  const chunks=[];let total=0;for await(const chunk of response.body){total+=chunk.length;if(total>MAX_ARCHIVE)throw Error('The official runtime archive is larger than expected.');chunks.push(chunk);}
  const bytes=Buffer.concat(chunks);if(size!==undefined&&bytes.length!==size)throw Error('The official Control archive size does not match its asset.');if(sha(bytes)!==expected)throw Error('The official runtime archive checksum does not match.');
  writeFileSync(target,bytes,{flag:'w'});
}
export async function controlDescriptor(version,{fetchImpl=fetch}={}){
  if(version==='0.2.12')return {version:CONTROL_VERSION,archive:CONTROL_ARCHIVE,sha256:CONTROL_SHA256,url:`https://github.com/Niko1221/Strata/releases/download/v0.2.12/${CONTROL_ARCHIVE}`};
  if(!/^\d+\.\d+\.\d+$/.test(version??''))throw Error('Invalid upstream version for Control.');
  const response=await fetchImpl(`https://api.github.com/repos/Niko1221/Strata/releases/tags/v${version}`,{headers:{accept:'application/vnd.github+json'},signal:AbortSignal.timeout(30000),redirect:'error'});
  if(!response.ok)throw Error('The official matching Control release could not be read.');
  const release=await response.json();if(release.draft||release.prerelease||release.tag_name!==`v${version}`||!Array.isArray(release.assets))throw Error('The official matching Control release is invalid.');
  const candidates=release.assets.filter(a=>/^strata-control-(\d+\.\d+\.\d+)-windows-x86_64\.zip$/.test(a.name??'')&&/^sha256:[a-f0-9]{64}$/.test(a.digest??'')&&a.size>0&&a.size<=MAX_ARCHIVE&&a.browser_download_url===`https://github.com/Niko1221/Strata/releases/download/v${version}/${a.name}`);
  if(candidates.length!==1)throw Error('A unique verified matching Control package was not found.');
  const a=candidates[0];return {version:/^strata-control-(\d+\.\d+\.\d+)-/.exec(a.name)[1],archive:a.name,sha256:a.digest.slice(7),url:a.browser_download_url};
}
const EXTRACT=String.raw`param([string]$Archive,[string]$Target)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$base = [IO.Path]::GetFullPath($Target).TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
$zip = [IO.Compression.ZipFile]::OpenRead($Archive)
try {
    $seen = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    $checked = [Collections.Generic.List[object]]::new()
    [long]$total = 0
    if ($zip.Entries.Count -gt 60000) { throw 'Too many archive entries.' }
    foreach ($entry in $zip.Entries) {
        $name = $entry.FullName.Replace('\','/')
        if (-not $name -or $name.StartsWith('/') -or $name.Contains(':') -or $name.IndexOf([char]0) -ge 0) { throw 'Invalid archive path.' }
        $parts = $name.TrimEnd('/').Split('/')
        foreach ($part in $parts) { if (-not $part -or $part -eq '.' -or $part -eq '..' -or $part.EndsWith('.') -or $part.EndsWith(' ')) { throw 'Invalid archive path.' } }
        if (-not $seen.Add($name.TrimEnd('/'))) { throw 'Duplicate archive entry.' }
        $kind = ($entry.ExternalAttributes -shr 16) -band 0xF000
        if (($kind -ne 0 -and $kind -ne 0x8000 -and $kind -ne 0x4000) -or ($entry.ExternalAttributes -band 0x400)) { throw 'Archive links are not allowed.' }
        $total += $entry.Length
        if ($total -gt 2147483648) { throw 'Archive exceeds the expanded size limit.' }
        $destination = [IO.Path]::GetFullPath([IO.Path]::Combine($base,$name.Replace('/','\')))
        if (-not $destination.StartsWith($base,[StringComparison]::OrdinalIgnoreCase)) { throw 'Archive path escapes target.' }
        $checked.Add(@{Entry=$entry;Path=$destination;Directory=$name.EndsWith('/')})
    }
    foreach ($item in $checked) {
        if ($item.Directory) { [IO.Directory]::CreateDirectory($item.Path) | Out-Null; continue }
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($item.Path)) | Out-Null
        $stream = [IO.File]::Open($item.Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
        try { $incoming = $item.Entry.Open(); try { $incoming.CopyTo($stream) } finally { $incoming.Dispose() } } finally { $stream.Dispose() }
    }
} finally { $zip.Dispose() }
`;
async function extract(archive,target,stage,run){
  mkdirSync(target,{recursive:true});const script=join(stage,'extract-runtime.ps1');if(!existsSync(script))writeFileSync(script,EXTRACT);
  await invoke(run,'powershell.exe',['-NoLogo','-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Archive',archive,'-Target',target],{cwd:stage,timeoutMs:180000});
}
function payloadSize(folder){let n=0;for(const f of readdirSync(folder)){const p=join(folder,f);const s=lstatSync(p);if(s.isDirectory())n+=payloadSize(p);else if(s.isFile())n+=s.size;else throw Error('Installer payload contains an unexpected file.');}return n;}
function findControl(unpacked){if(existsSync(join(unpacked,'strata.py')))return unpacked;const children=readdirSync(unpacked).filter(n=>lstatSync(join(unpacked,n)).isDirectory());if(children.length===1&&existsSync(join(unpacked,children[0],'strata.py')))return join(unpacked,children[0]);throw Error('The official Control archive layout was not recognized.');}
function makensis(){const candidates=[process.env.STRATA_MAKENSIS,join(process.env['ProgramFiles(x86)']||'C:/Program Files (x86)','NSIS/makensis.exe'),join(process.env.ProgramFiles||'C:/Program Files','NSIS/makensis.exe')];const value=candidates.find(p=>p&&existsSync(p));if(!value)throw Error('NSIS is not installed. Set STRATA_MAKENSIS to an official makensis.exe.');return value;}

const DESKTOP_TARGET='x86_64-pc-windows-msvc';
const WEBVIEW2_URL='https://go.microsoft.com/fwlink/p/?LinkId=2124703';
async function webviewBootstrapper(cache,work,run,fetchImpl){
  const file=join(cache,'MicrosoftEdgeWebview2Setup.exe');
  if(!existsSync(file)){
    const response=await fetchImpl(WEBVIEW2_URL,{signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw Error(`Microsoft WebView2 bootstrapper download failed (HTTP ${response.status}).`);
    const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length<1024||bytes.length>8*1024*1024||bytes[0]!==77||bytes[1]!==90)throw Error('The WebView2 bootstrapper is not a Windows executable.');
    writeFileSync(file,bytes);
  }
  const script=join(work,'verify-webview2.ps1');
  writeFileSync(script,String.raw`param([string]$File)
$ErrorActionPreference = 'Stop'
$signature = Get-AuthenticodeSignature -LiteralPath $File
if ($signature.Status -ne 'Valid' -or $signature.SignerCertificate.GetNameInfo([Security.Cryptography.X509Certificates.X509NameType]::SimpleName,$false) -ne 'Microsoft Corporation') { throw 'The WebView2 bootstrapper is not signed by Microsoft.' }
`);
  await invoke(run,'pwsh.exe',['-NoLogo','-NoProfile','-NonInteractive','-File',script,file],{cwd:work,timeoutMs:60000});
  return file;
}

async function buildDesktopWindow(repoRoot,stageBase,payload,run){
  const root=join(repoRoot,'managed-local/windows-installer/desktop'),manifest=join(root,'Cargo.toml');
  const cargo=process.env.STRATA_CARGO_EXE??'cargo.exe',target=resolve(process.env.CARGO_TARGET_DIR??join(stageBase,'smm-desktop-target'));
  const registry=process.env.CARGO_HOME??join(process.env.USERPROFILE??stageBase,'.cargo');
  const env={...process.env,CARGO_TARGET_DIR:target,CARGO_BUILD_JOBS:process.env.CARGO_BUILD_JOBS??'8',CARGO_ENCODED_RUSTFLAGS:[`--remap-path-prefix=${repoRoot}=/strata`,`--remap-path-prefix=${registry}=/cargo`].join('\x1f')};
  delete env.RUSTFLAGS;
  const options={cwd:root,env,timeoutMs:1200000},base=['--locked','--release','--target',DESKTOP_TARGET,'--manifest-path',manifest];
  console.log('Building and testing the Rust desktop window.');
  await invoke(run,cargo,['test',...base],options);
  await invoke(run,cargo,['build',...base],options);
  const native=join(payload,'resources/desktop');mkdirSync(native,{recursive:true});
  copyFileSync(join(target,DESKTOP_TARGET,'release/StrataWindow.exe'),join(native,'StrataWindow.exe'));
  const metadata=JSON.parse((await invoke(run,cargo,['metadata','--locked','--format-version','1','--filter-platform',DESKTOP_TARGET,'--manifest-path',manifest],options)).stdout);
  const included=new Set(metadata.resolve.nodes.map(n=>n.id)),licenses=join(payload,'licenses/desktop');mkdirSync(licenses,{recursive:true});
  const notices=['# Rust desktop window dependencies',''];
  for(const pkg of metadata.packages.filter(p=>included.has(p.id)&&p.source)){
    const source=dirname(pkg.manifest_path),label=(pkg.name+'-'+pkg.version).replace(/[^A-Za-z0-9_.-]/g,'_');
    const names=readdirSync(source).filter(name=>/^(?:licen[cs]e|copying|notice|copyright)(?:[._-].*)?$/i.test(name)&&lstatSync(join(source,name)).isFile());
    for(const name of names){const out=join(licenses,label);mkdirSync(out,{recursive:true});copyFileSync(join(source,name),join(out,name));}
    notices.push(`- ${pkg.name} ${pkg.version}: ${pkg.license??'see included license'}${names.length?' ('+names.map(n=>label+'/'+n).join(', ')+')':''}`);
  }
  writeFileSync(join(licenses,'THIRD-PARTY-NOTICES.md'),notices.join('\n')+'\n');
}

export async function buildWindowsInstaller({repoRoot,hostSourceRoot=repoRoot,version,commit,releaseTag,outputDir,run=runBuildCommand,fetchImpl=fetch,control}={}){
  if(process.platform!=='win32')throw Error('Build this installer on Windows.');
  if(!/^\d+\.\d+\.\d+$/.test(version??'')||!/^[a-f0-9]{40}$/.test(commit??'')||!/^managed-v\d+\.\d+\.\d+-\d+$/.test(releaseTag??'')||!isAbsolute(repoRoot??'')||!isAbsolute(outputDir??''))throw Error('Invalid Windows installer build identity.');
  repoRoot=resolve(repoRoot);hostSourceRoot=resolve(hostSourceRoot);outputDir=resolve(outputDir);mkdirSync(outputDir,{recursive:true});
  const compiler=makensis(),stageBase=process.env.RUNNER_TEMP||join(process.env.TEMP||outputDir,'smm-build'),work=join(stageBase,'s-'+randomUUID().slice(0,8)),payload=join(work,'payload'),cache=join(outputDir,'dependencies');mkdirSync(payload,{recursive:true});mkdirSync(cache,{recursive:true});
  control??=await controlDescriptor(version,{fetchImpl});
  if(!/^\d+\.\d+\.\d+$/.test(control.version??'')||!/^strata-control-\d+\.\d+\.\d+-windows-x86_64\.zip$/.test(control.archive??'')||! /^[a-f0-9]{64}$/.test(control.sha256??'')||control.url!==`https://github.com/Niko1221/Strata/releases/download/v${version}/${control.archive}`)throw Error('The matching Control descriptor is invalid.');
  const nodeZip=join(cache,NODE_ARCHIVE),controlZip=join(cache,control.archive);
  await download(`https://nodejs.org/dist/v${NODE_VERSION}/${NODE_ARCHIVE}`,nodeZip,NODE_SHA256,{fetchImpl});
  await download(control.url,controlZip,control.sha256,{fetchImpl});
  const nodeUnpacked=join(work,'node'),controlUnpacked=join(work,'control');await extract(nodeZip,nodeUnpacked,work,run);await extract(controlZip,controlUnpacked,work,run);
  const nodeSource=join(nodeUnpacked,`node-v${NODE_VERSION}-win-x64`),nodeTarget=join(payload,'resources/node');mkdirSync(nodeTarget,{recursive:true});
  for(const name of ['node.exe','LICENSE'])copyFileSync(join(nodeSource,name),join(nodeTarget,name));
  const controlSource=findControl(controlUnpacked);if(!existsSync(join(controlSource,'python/python.exe'))||!existsSync(join(controlSource,'strata_control')))throw Error('The official Control runtime is incomplete.');
  cpSync(controlSource,join(payload,'resources/control'),{recursive:true});
  const host=copyHost(join(hostSourceRoot,'apps/host'),join(payload,'host'));
  const runtimeSource=join(repoRoot,'managed-local/windows-installer/runtime');if(!existsSync(join(runtimeSource,'Launcher.cs'))||!existsSync(join(runtimeSource,'runtime.mjs')))throw Error('Portable launcher runtime sources are missing.');
  cpSync(runtimeSource,join(payload,'runtime'),{recursive:true,filter:file=>!file.endsWith('Launcher.cs')});
  const licenses=collectLicenses(repoRoot,join(payload,'licenses'));
  await buildDesktopWindow(repoRoot,stageBase,payload,run);
  const webview2=await webviewBootstrapper(cache,work,run,fetchImpl);
  const readme=join(repoRoot,'managed-local/windows-installer/README.ja.md');if(!existsSync(readme))throw Error('The Japanese installer README is missing.');
  copyFileSync(readme,join(payload,'README.ja.md'));writeFileSync(join(payload,'README.ja.txt'),'\uFEFF'+readFileSync(readme,'utf8').replace(/^\uFEFF/,''));
  const icon=join(repoRoot,'apps/desktop/src-tauri/icons/icon.ico');
  const csc=join(process.env.WINDIR||'C:/Windows','Microsoft.NET/Framework64/v4.0.30319/csc.exe');if(!existsSync(csc))throw Error('The Windows .NET Framework C# compiler is unavailable.');
  await invoke(run,csc,['/nologo','/codepage:65001','/target:winexe','/optimize+','/platform:x64','/reference:System.Windows.Forms.dll','/reference:System.Drawing.dll','/reference:System.Web.Extensions.dll',...(existsSync(icon)?['/win32icon:'+icon]:[]),'/out:'+join(payload,'StrataManaged.exe'),join(runtimeSource,'Launcher.cs')],{cwd:work});
  const metadata={schema_version:1,product:PRODUCT,version,commit,releaseTag,nodeVersion:NODE_VERSION,controlVersion:control.version};writeFileSync(join(payload,'managed-install.json'),JSON.stringify(metadata,null,2));
  writeFileSync(join(payload,'.strata-managed-install'),'StrataManagedModels:5B157B33-47AD-43CC-8E0F-42F5F91D8290');
  const installer=join(outputDir,`Strata-Managed-Models-${version}-windows-x64-setup.exe`),template=join(HERE,'installer.nsi');
  await invoke(run,compiler,['/INPUTCHARSET','UTF8','/V3','/DVERSION='+version,'/DOUTFILE='+installer,'/DPAYLOAD='+payload,'/DWEBVIEW2_SETUP='+webview2,'/DESTIMATED_SIZE='+Math.ceil(payloadSize(payload)/1024),...(existsSync(icon)?['/DPRODUCT_ICON='+icon]:[]),template],{cwd:work,timeoutMs:600000});
  if(!existsSync(installer))throw Error('NSIS did not produce the installer.');
  const bytes=readFileSync(installer),result={installer,sha256:sha(bytes),size:bytes.length,version,commit,releaseTag,payload,host,licenses,node:{version:NODE_VERSION,archiveSha256:NODE_SHA256},control:{version:control.version,archiveSha256:control.sha256}};
  writeFileSync(join(outputDir,'installer-build.json'),JSON.stringify(result,null,2));return result;
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const [repoRoot,hostSourceRoot,version,commit,releaseTag,outputDir]=process.argv.slice(2);
  try{const result=await buildWindowsInstaller({repoRoot,hostSourceRoot,version,commit,releaseTag,outputDir});console.log(JSON.stringify({installer:result.installer,sha256:result.sha256,size:result.size}));}catch(error){console.error(error.message);if(error.detail)console.error(error.detail);process.exitCode=1;}
}
