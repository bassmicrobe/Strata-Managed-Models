import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtempSync,readFileSync,existsSync,realpathSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fetchForkRelease,stageForkInstaller,FORK_REPOSITORY,FORK_FEATURE} from './runtime/fork-stage.mjs';

const repo=FORK_REPOSITORY,tag='managed-v0.2.12-42',version='0.2.12',base=`https://api.github.com/repos/${repo}`;
const sha=bytes=>createHash('sha256').update(bytes).digest('hex');
const archive='managed-host-windows-x64.zip',name=`Strata-Managed-Models-${version}-windows-x64-setup.exe`;
const bytes=Buffer.from('MZ verified installer fixture');
const metadata=(id,name,size,digest)=>({id,name,size,digest:`sha256:${digest}`,url:`${base}/releases/assets/${id}`,browser_download_url:`https://github.com/${repo}/releases/download/${tag}/${name}`});
function fixture(){
  const manifest={schema_version:1,feature:FORK_FEATURE,version,sourceRepository:repo,commit:'a'.repeat(40),upstreamCommit:'b'.repeat(40),upstreamTag:'v'+version,archive:{name:archive,size:12,sha256:'c'.repeat(64)},installer:{name,size:bytes.length,sha256:sha(bytes)}};
  const manifestBytes=Buffer.from(JSON.stringify(manifest));
  const release={id:123,tag_name:tag,html_url:`https://github.com/${repo}/releases/tag/${tag}`,assets:[metadata(1,'managed-host.json',manifestBytes.length,sha(manifestBytes)),metadata(2,archive,12,manifest.archive.sha256),metadata(3,name,bytes.length,sha(bytes))]};
  return {manifestBytes,release};
}

test('the updater binds the Windows installer to the verified release and uses asset API downloads',async()=>{
  const {manifestBytes,release}=fixture();const calls=[];
  const fetchImpl=async(url,options)=>{calls.push(url);assert.equal(options.headers.authorization,undefined);
    if(url===base+'/releases/latest')return new Response(JSON.stringify(release));
    if(url===base+'/releases/assets/1'){assert.equal(options.headers.accept,'application/octet-stream');return Response.redirect('https://release-assets.githubusercontent.com/fixture/manifest',302);}
    if(url==='https://release-assets.githubusercontent.com/fixture/manifest')return new Response(manifestBytes);
    if(url===base+'/releases/assets/3')return new Response(bytes);
    throw Error('Unexpected download');
  };
  const checked=await fetchForkRelease({fetchImpl});assert.equal(checked.archiveApiUrl,base+'/releases/assets/2');assert.equal(checked.installer.apiUrl,base+'/releases/assets/3');
  const root=mkdtempSync(join(tmpdir(),'strata-update-installer-')),file=await stageForkInstaller({root,release:checked,fetchImpl});
  assert.deepEqual(readFileSync(file),bytes);assert.equal(file,join(realpathSync(root),'installer-updates',tag,name));
  assert.equal(await stageForkInstaller({root,release:checked,fetchImpl:()=>{throw Error('Verified cache should be reused');}}),file);
  assert.equal(calls.length,4);
});

test('the updater never stages a mismatched installer or follows an unrelated URL',async()=>{
  const {release,manifestBytes}=fixture();
  const checked=await fetchForkRelease({fetchImpl:async(url)=>new Response(url===base+'/releases/latest'?JSON.stringify(release):manifestBytes)});
  const root=mkdtempSync(join(tmpdir(),'strata-update-installer-'));
  const corrupt=Buffer.from(bytes);corrupt[corrupt.length-1]^=1;
  await assert.rejects(()=>stageForkInstaller({root,release:checked,fetchImpl:async()=>new Response(corrupt)}));
  assert(!existsSync(join(root,'installer-updates',tag,name)));
  await assert.rejects(()=>stageForkInstaller({root,release:{...checked,installer:{...checked.installer,apiUrl:'https://unrelated.example/setup.exe'}},fetchImpl:()=>{throw Error('Must not request unrelated URLs');}}));
  release.assets[2].size++;
  await assert.rejects(()=>fetchForkRelease({fetchImpl:async(url)=>new Response(url===base+'/releases/latest'?JSON.stringify(release):manifestBytes)}));
});
