/** Download and verify CI-published host and Windows setup assets. The caller owns activation. */
import {spawn} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import {existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';

export const FORK_REPOSITORY='bassmicrobe/Strata-Managed-Models';
export const FORK_FEATURE='strata-managed-models-v1';
const ARCHIVE='managed-host-windows-x64.zip',MANIFEST='managed-host.json';
const MAX_ARCHIVE=256*1024*1024,MAX_MANIFEST=64*1024,MAX_FILES=10000;
const tagPattern=/^managed-v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)-([1-9]\d*)$/;
const commitPattern=/^[a-f0-9]{40}$/,digestPattern=/^[a-f0-9]{64}$/;
const hash=bytes=>createHash('sha256').update(bytes).digest('hex');
const failure=()=>new Error('モデル切替版の更新ファイルを検証できませんでした。保存済みの版を使います。');
const repositoryName=value=>typeof value==='string'&&/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(value)&&!value.split('/').some(v=>v==='.'||v==='..')?value:null;
const contained=(base,file,equal=false)=>{const rel=relative(base,file);return equal&&rel===''||!!rel&&rel!=='..'&&!rel.startsWith('..'+sep)&&!isAbsolute(rel);};
function checkedPath(base,file,{equal=false,existing=false}={}){
  const target=resolve(file);if(!contained(base,target,equal))throw failure();
  let cursor=target;
  while(contained(base,cursor,true)){if(existsSync(cursor)&&lstatSync(cursor).isSymbolicLink())throw failure();if(cursor===base)break;cursor=dirname(cursor);}
  if(existing&&!existsSync(target))throw failure();
  if(existsSync(target)&&!contained(realpathSync(base),realpathSync(target),equal))throw failure();
  return target;
}
function assetUrl(repository,tag,name,value){
  try{const url=new URL(value);return url.protocol==='https:'&&url.hostname==='github.com'&&!url.username&&!url.password&&!url.search&&!url.hash
    &&url.pathname===`/${repository}/releases/download/${tag}/${name}`?url.href:null;}catch{return null;}
}
function assetApiUrl(repository,value){
  const prefix=`https://api.github.com/repos/${repository}/releases/assets/`;
  return typeof value==='string'&&value.startsWith(prefix)&&/^[1-9]\d*$/.test(value.slice(prefix.length))?value:null;
}
function assetEndpoint(repository,asset){
  if(asset.id===undefined&&asset.url===undefined)return null;
  const url=assetApiUrl(repository,asset.url);
  if(!Number.isSafeInteger(asset.id)||asset.id<=0||!url||!url.endsWith('/'+asset.id))throw failure();
  return url;
}
function installerIdentity(repository,tag,version,descriptor){
  return descriptor&&descriptor.name===`Strata-Managed-Models-${version}-windows-x64-setup.exe`
    &&Number.isSafeInteger(descriptor.size)&&descriptor.size>0&&descriptor.size<=MAX_ARCHIVE&&digestPattern.test(descriptor.sha256??'')
    &&assetUrl(repository,tag,descriptor.name,descriptor.downloadUrl)
    &&(!descriptor.apiUrl||assetApiUrl(repository,descriptor.apiUrl));
}
function responseUrl(response){
  if(!response.url)return;
  const url=new URL(response.url);
  if(url.protocol!=='https:'||url.username||url.password||!(url.hostname==='github.com'||url.hostname==='api.github.com'||url.hostname.endsWith('.githubusercontent.com')))throw failure();
}
function redirectUrl(value,base){
  const url=new URL(value,base);
  if(url.protocol!=='https:'||url.username||url.password||!(url.hostname==='github.com'||url.hostname.endsWith('.githubusercontent.com')))throw failure();
  return url.href;
}
async function bounded(response,limit){
  if(!response.ok)throw failure();responseUrl(response);
  const claimed=Number(response.headers?.get('content-length'));
  if(Number.isFinite(claimed)&&claimed>limit)throw failure();
  const chunks=[];let total=0;
  if(response.body){for await(const chunk of response.body){const bytes=Buffer.from(chunk);total+=bytes.length;if(total>limit){await response.body.cancel?.().catch(()=>{});throw failure();}chunks.push(bytes);}}
  else{const bytes=Buffer.from(await response.arrayBuffer());if(bytes.length>limit)throw failure();chunks.push(bytes);}
  return Buffer.concat(chunks);
}
async function fetchBytes(fetchImpl,url,limit,timeoutMs,{api=false}={}){
  const signal=AbortSignal.timeout(timeoutMs);let current=url;
  for(let step=0;step<6;step++){
    const response=await fetchImpl(current,{headers:{accept:api?'application/vnd.github+json':'application/octet-stream','user-agent':'Strata-managed-startup-updater'},
      redirect:api?'error':'manual',signal});
    if(!api&&[301,302,303,307,308].includes(response.status)){
      const location=response.headers?.get('location');if(!location)throw failure();
      const next=redirectUrl(location,current);await response.body?.cancel();current=next;continue;
    }
    return bounded(response,limit);
  }
  throw failure();
}
function checkedManifest(value,{repository,version}={}){
  if(!value||value.schema_version!==1||value.feature!==FORK_FEATURE||value.version!==version||value.sourceRepository!==repository
    ||!commitPattern.test(value.commit??'')||!commitPattern.test(value.upstreamCommit??'')
    ||value.upstreamTag!==`v${version}`||value.archive?.name!==ARCHIVE||!digestPattern.test(value.archive?.sha256??'')
    ||!Number.isSafeInteger(value.archive?.size)||value.archive.size<=0||value.archive.size>MAX_ARCHIVE)throw failure();
  return value;
}
export async function fetchForkRelease({repository=FORK_REPOSITORY,fetchImpl=fetch,timeoutMs=10000}={}){
  if(!repositoryName(repository))throw failure();
  let release,manifest;
  try{
    release=JSON.parse((await fetchBytes(fetchImpl,`https://api.github.com/repos/${repository}/releases/latest`,2*1024*1024,timeoutMs,{api:true})).toString('utf8'));
    const match=tagPattern.exec(release.tag_name??''),version=match?.slice(1,4).join('.');
    if(!match||release.draft||release.prerelease||!Number.isSafeInteger(release.id)||release.id<=0
      ||release.html_url!==`https://github.com/${repository}/releases/tag/${release.tag_name}`||!Array.isArray(release.assets))throw failure();
    const external=release.assets.filter(a=>a.name===MANIFEST),archives=release.assets.filter(a=>a.name===ARCHIVE);
    if(external.length!==1||archives.length!==1)throw failure();
    const manifestUrl=assetUrl(repository,release.tag_name,MANIFEST,external[0].browser_download_url);
    const archiveUrl=assetUrl(repository,release.tag_name,ARCHIVE,archives[0].browser_download_url);
    if(!manifestUrl||!archiveUrl||external[0].size>MAX_MANIFEST)throw failure();
    const manifestApiUrl=assetEndpoint(repository,external[0]),archiveApiUrl=assetEndpoint(repository,archives[0]);
    manifest=checkedManifest(JSON.parse((await fetchBytes(fetchImpl,manifestApiUrl??manifestUrl,MAX_MANIFEST,timeoutMs)).toString('utf8')),{repository,version});
    if(archives[0].size!==manifest.archive.size||archives[0].digest&&archives[0].digest!==`sha256:${manifest.archive.sha256}`)throw failure();
    let installer=null;
    if(manifest.installer){
      const matches=release.assets.filter(asset=>asset.name===manifest.installer.name);
      if(matches.length!==1)throw failure();const asset=matches[0];
      installer={...manifest.installer,downloadUrl:asset.browser_download_url,apiUrl:assetEndpoint(repository,asset)};
      if(!installerIdentity(repository,release.tag_name,version,installer)||installer.size!==asset.size||asset.digest&&asset.digest!==`sha256:${installer.sha256}`)throw failure();
    }
    return {tag_name:release.tag_name,version,commit:manifest.commit,upstreamCommit:manifest.upstreamCommit,html_url:release.html_url,releaseId:release.id,
      archiveUrl,archiveApiUrl,archiveSha256:manifest.archive.sha256,archiveSize:manifest.archive.size,sourceRepository:repository,manifest,installer};
  }catch{throw failure();}
}

export async function stageForkInstaller({root,release,fetchImpl=fetch}={}){
  const repository=release?.sourceRepository,match=tagPattern.exec(release?.tag_name??''),installer=release?.installer;
  if(!isAbsolute(root??'')||repository!==FORK_REPOSITORY||!match||match.slice(1,4).join('.')!==release.version||!installerIdentity(repository,release.tag_name,release.version,installer))throw failure();
  root=realpathSync(resolve(root));
  const folder=checkedPath(root,join(root,'installer-updates',release.tag_name));mkdirSync(folder,{recursive:true,mode:0o700});
  const file=checkedPath(root,join(folder,installer.name));
  if(existsSync(file)&&lstatSync(file).isFile()&&lstatSync(file).size===installer.size&&hash(readFileSync(file))===installer.sha256)return file;
  const bytes=await fetchBytes(fetchImpl,installer.apiUrl??installer.downloadUrl,installer.size,180000);
  if(bytes.length!==installer.size||bytes[0]!==77||bytes[1]!==90||hash(bytes)!==installer.sha256)throw failure();
  const temp=checkedPath(root,file+'.'+randomUUID()+'.tmp');writeFileSync(temp,bytes,{flag:'wx',mode:0o600});renameSync(temp,file);return file;
}

// All entries are checked before the first file is written. The child uses isolated, bundled Python and no shell.
const EXTRACT=String.raw`
import json, os, pathlib, re, shutil, stat, sys, zipfile
archive, target = map(pathlib.Path, sys.argv[1:3])
target = target.resolve()
reserved = re.compile(r'^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\..*)?$', re.I)
with zipfile.ZipFile(archive) as bundle:
    members = bundle.infolist()
    if len(members) > 10000: raise ValueError('too many archive entries')
    seen, canonical, types, total, checked = set(), {}, {}, 0, []
    for entry in members:
        name = entry.filename
        if entry.orig_filename != name: raise ValueError('noncanonical archive path')
        if not name or '\\' in name or '\x00' in name or name.startswith('/') or ':' in name: raise ValueError('invalid archive path')
        parts = name.rstrip('/').split('/')
        if any(not part or part in ('.', '..') or part.endswith(('.', ' ')) or reserved.fullmatch(part) for part in parts): raise ValueError('invalid archive path')
        if any(part.lower() in ('.git', 'node_modules') or part.lower().startswith('.env') for part in parts): raise ValueError('unexpected archive path')
        if name not in ('managed-host.json', 'LICENSE', 'NOTICE', 'NOTICE.md') and parts != ['apps'] and not (len(parts) >= 2 and parts[:2] == ['apps', 'host']): raise ValueError('unexpected archive root')
        identity = '/'.join(parts).casefold()
        if identity in seen: raise ValueError('duplicate archive path')
        for index in range(1, len(parts) + 1):
            prefix = '/'.join(parts[:index])
            key = prefix.casefold()
            if key in canonical and canonical[key] != prefix: raise ValueError('case-colliding archive path')
            canonical[key] = prefix
            if index < len(parts) and types.get(key) == 'file': raise ValueError('file is an archive parent')
        if not entry.is_dir() and any(key.startswith(identity + '/') for key in seen): raise ValueError('file is an archive parent')
        if parts in (['apps'], ['apps', 'host']) and not entry.is_dir(): raise ValueError('invalid root directory')
        seen.add(identity)
        types[identity] = 'directory' if entry.is_dir() else 'file'
        mode = entry.external_attr >> 16
        kind = stat.S_IFMT(mode)
        if kind not in (0, stat.S_IFREG, stat.S_IFDIR) or entry.external_attr & 0x400: raise ValueError('archive link or special file')
        if kind == stat.S_IFDIR and not entry.is_dir(): raise ValueError('invalid directory entry')
        if entry.flag_bits & 1: raise ValueError('encrypted archive')
        total += entry.file_size
        if total > 256 * 1024 * 1024 or entry.file_size < 0: raise ValueError('archive too large')
        if entry.file_size and not entry.compress_size: raise ValueError('invalid archive size')
        if entry.file_size > 1024 * 1024 and entry.file_size > entry.compress_size * 500: raise ValueError('archive compression ratio')
        destination = target.joinpath(*parts)
        destination.resolve().relative_to(target)
        checked.append((entry, destination))
    for entry, destination in checked:
        if entry.is_dir(): destination.mkdir(parents=True, exist_ok=True); continue
        destination.parent.mkdir(parents=True, exist_ok=True)
        with bundle.open(entry) as incoming, destination.open('xb') as outgoing:
            copied = 0
            while True:
                chunk = incoming.read(1024 * 1024)
                if not chunk: break
                copied += len(chunk)
                if copied > entry.file_size: raise ValueError('invalid expanded size')
                outgoing.write(chunk)
            if copied != entry.file_size: raise ValueError('invalid expanded size')
print(json.dumps({'files': len(checked), 'bytes': total}))
`;
export function runForkStageCommand(file,args,{cwd,timeoutMs=120000}={}){
  return new Promise((ok,bad)=>{
    const env={...process.env};delete env.PYTHONPATH;delete env.PYTHONHOME;
    const child=spawn(file,args,{cwd,windowsHide:true,shell:false,stdio:['ignore','pipe','pipe'],env});
    let stdout='',expired=false;child.stdout.on('data',b=>{stdout=(stdout+b.toString('utf8')).slice(-4096);});child.stderr.resume();
    const timer=setTimeout(()=>{expired=true;if(process.platform==='win32'&&child.pid){const killer=spawn('taskkill.exe',['/PID',String(child.pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});killer.once('error',()=>child.kill());}else child.kill();},timeoutMs);
    child.once('error',()=>{clearTimeout(timer);bad(failure());});
    child.once('close',code=>{clearTimeout(timer);code===0&&!expired?ok({code:0,stdout}):bad(failure());});
  });
}
function fingerprints(base,dir=base,rows=[]){
  for(const name of readdirSync(dir).sort()){
    if(dir===base&&name==='.strata-fork-stage.json')continue;
    const file=checkedPath(base,join(dir,name),{existing:true}),stat=lstatSync(file);
    if(stat.isDirectory())fingerprints(base,file,rows);
    else if(stat.isFile())rows.push({path:relative(base,file).split(sep).join('/'),sha256:hash(readFileSync(file))});
    else throw failure();
    if(rows.length>MAX_FILES)throw failure();
  }
  return rows;
}
function checkInner(sourceRoot,release){
  const value=JSON.parse(readFileSync(checkedPath(sourceRoot,join(sourceRoot,MANIFEST),{existing:true}),'utf8'));
  const fields=['schema_version','feature','version','commit','upstreamCommit','upstreamTag','sourceRepository'];
  if(fields.some(name=>value[name]!==release.manifest[name]))throw failure();
  const required=['server/index.mjs','dist/index.html','server/managed-local-models.mjs','src/lib/managed-models.ts','src/components/ManagedChatModelPicker.tsx'];
  for(const path of required)if(!lstatSync(checkedPath(sourceRoot,join(sourceRoot,'apps/host',path),{existing:true})).isFile())throw failure();
  const pkg=JSON.parse(readFileSync(checkedPath(sourceRoot,join(sourceRoot,'apps/host/package.json'),{existing:true}),'utf8'));
  if(pkg.version!==release.version)throw failure();
}
export async function stageForkRelease({root,release,pythonExe,log=()=>{},fetchImpl=fetch,run=runForkStageCommand}={}){
  if(!isAbsolute(root??'')||!existsSync(root))throw failure();root=realpathSync(root);
  const match=tagPattern.exec(release?.tag_name??''),version=match?.slice(1,4).join('.'),repository=release?.sourceRepository;
  if(!repositoryName(repository)||version!==release.version||!Number.isSafeInteger(release.releaseId)||release.releaseId<=0)throw failure();
  checkedManifest(release.manifest,{repository,version});
  if(release.commit!==release.manifest.commit||release.upstreamCommit!==release.manifest.upstreamCommit||release.archiveSha256!==release.manifest.archive.sha256
    ||release.archiveSize!==release.manifest.archive.size||!assetUrl(repository,release.tag_name,ARCHIVE,release.archiveUrl)
    ||release.archiveApiUrl&&!assetApiUrl(repository,release.archiveApiUrl))throw failure();
  const versions=checkedPath(root,join(root,'host-versions'));mkdirSync(versions,{recursive:true});
  let sourceRoot=checkedPath(versions,join(versions,`${version}-fork-${release.releaseId}`));
  const result=reused=>({sourceRoot,hostRoot:join(sourceRoot,'apps/host'),version,commit:release.commit,releaseId:release.releaseId,
    upstreamCommit:release.upstreamCommit,sourceRepository:repository,reused});
  if(existsSync(sourceRoot)){
    try{
      const marker=JSON.parse(readFileSync(checkedPath(sourceRoot,join(sourceRoot,'.strata-fork-stage.json'),{existing:true}),'utf8'));
      if(marker.commit===release.commit&&marker.releaseId===release.releaseId&&marker.archiveSha256===release.archiveSha256
        &&JSON.stringify(marker.files)===JSON.stringify(fingerprints(sourceRoot))){checkInner(sourceRoot,release);return result(true);}
    }catch{}
    sourceRoot=checkedPath(versions,join(versions,`${version}-fork-${release.releaseId}-${randomUUID().slice(0,8)}`));
  }
  const updates=checkedPath(root,join(root,'updates'));mkdirSync(updates,{recursive:true});
  const downloads=checkedPath(updates,join(updates,'downloads'));mkdirSync(downloads,{recursive:true,mode:0o700});
  let archive=checkedPath(downloads,join(downloads,release.archiveSha256+'.zip'));
  if(!existsSync(archive)||lstatSync(archive).size!==release.archiveSize||hash(readFileSync(archive))!==release.archiveSha256){
    if(existsSync(archive))archive=checkedPath(downloads,join(downloads,release.archiveSha256+'-'+randomUUID().slice(0,8)+'.zip'));
    log(`検証済みのモデル切替版 ${version} をダウンロードしています。`);
    const bytes=await fetchBytes(fetchImpl,release.archiveApiUrl??release.archiveUrl,release.archiveSize,120000);
    if(bytes.length!==release.archiveSize||hash(bytes)!==release.archiveSha256)throw failure();
    writeFileSync(archive,bytes,{flag:'wx',mode:0o600});
  }
  if(!isAbsolute(pythonExe??'')||!existsSync(pythonExe)||!lstatSync(pythonExe).isFile())throw failure();
  const python=realpathSync(pythonExe);
  mkdirSync(sourceRoot);
  try{
    const execution=await run(python,['-I','-c',EXTRACT,archive,sourceRoot],{cwd:root,timeoutMs:120000});
    if(execution?.code!==undefined&&execution.code!==0)throw failure();
    checkInner(sourceRoot,release);
    const files=fingerprints(sourceRoot);
    writeFileSync(join(sourceRoot,'.strata-fork-stage.json'),JSON.stringify({schema_version:1,commit:release.commit,releaseId:release.releaseId,archiveSha256:release.archiveSha256,files},null,2),{flag:'wx'});
    return result(false);
  }catch{
    writeFileSync(join(sourceRoot,'.strata-fork-stage-failed.json'),JSON.stringify({failedAt:new Date().toISOString(),releaseId:release.releaseId}),{flag:'wx'});
    throw failure();
  }
}
