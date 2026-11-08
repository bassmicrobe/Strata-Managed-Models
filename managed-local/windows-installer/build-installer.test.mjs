import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,existsSync,symlinkSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {copyHost,hostFileAllowed,collectLicenses,controlDescriptor,download,CONTROL_SHA256,NODE_SHA256} from './build-installer.mjs';

const temp=()=>mkdtempSync(join(tmpdir(),'smm-installer-'));
const save=(path,text)=>{mkdirSync(join(path,'..'),{recursive:true});writeFileSync(path,text);};
function controlFixture(){const bytes=Buffer.from('verified official Control fixture'),sha=createHash('sha256').update(bytes).digest('hex'),url='https://github.com/Niko1221/Strata/releases/download/v0.2.12/strata-control-0.1.58-windows-x86_64.zip';return{bytes,sha,url,metadata:{tag_name:'v0.2.12',draft:false,prerelease:false,assets:[{id:42,name:'strata-control-0.1.58-windows-x86_64.zip',size:bytes.length,digest:'sha256:'+sha,browser_download_url:url}]}};}
test('a Control public download failure falls back through its official asset API without forwarding credentials to the CDN',async()=>{
  const f=controlFixture(),target=join(temp(),'control.zip'),calls=[],token='workflow-token-test';
  await download(f.url,target,f.sha,{token,fetchImpl:async(url,options)=>{calls.push({url,options});if(calls.length===1)return new Response(null,{status:504});if(calls.length===2)return Response.json(f.metadata);if(calls.length===3)return new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/official-control?asset=42'}});return new Response(f.bytes);}});
  assert.deepEqual(readFileSync(target),f.bytes);assert.equal(calls.length,4);assert(!calls[0].options.headers);assert.equal(calls[1].options.headers.authorization,'Bearer '+token);assert.equal(calls[2].url,'https://api.github.com/repos/Niko1221/Strata/releases/assets/42');assert.equal(calls[2].options.redirect,'manual');assert.equal(calls[2].options.headers.accept,'application/octet-stream');assert(!JSON.stringify(calls[3]).includes(token));assert(!('authorization' in calls[3].options.headers));assert.equal(calls[3].options.redirect,'error');
});
test('Control fallback rejects failed HTTP responses and bytes that do not match the pinned checksum',async()=>{
  const f=controlFixture();
  for(const failure of ['metadata','asset','cdn','checksum']){
    const target=join(temp(),'control.zip');let calls=0;
    await assert.rejects(download(f.url,target,f.sha,{fetchImpl:async()=>{calls++;if(calls===1)return new Response(null,{status:504});if(calls===2)return failure==='metadata'?new Response(null,{status:403}):Response.json(f.metadata);if(calls===3)return failure==='asset'?new Response(null,{status:404}):new Response(null,{status:302,headers:{location:'https://release-assets.githubusercontent.com/fixture'}});return failure==='cdn'?new Response(null,{status:503}):new Response(Buffer.alloc(f.bytes.length,0));}}),failure==='checksum'?/checksum does not match/:/HTTP (?:403|404|503)/);
    assert(!existsSync(target));
  }
});
test('the Control fallback rejects an unrelated redirect before sending another request',async()=>{
  const f=controlFixture();let calls=0;await assert.rejects(download(f.url,join(temp(),'control.zip'),f.sha,{fetchImpl:async()=>{calls++;if(calls===1)return new Response(null,{status:504});if(calls===2)return Response.json(f.metadata);return new Response(null,{status:302,headers:{location:'https://example.com/untrusted'}});}}),/redirect is invalid/);assert.equal(calls,3);
});
test('Node.js downloads keep their original direct path and never use GitHub authentication or the Control fallback',async()=>{
  let calls=0;await assert.rejects(download('https://nodejs.org/dist/v24.12.0/node-v24.12.0-win-x64.zip',join(temp(),'node.zip'),'a'.repeat(64),{token:'never-send',fetchImpl:async(url,options)=>{calls++;assert(url.startsWith('https://nodejs.org/'));assert(!options.headers);return new Response(null,{status:504});}}),/nodejs.org \(HTTP 504\)/);assert.equal(calls,1);
});

test('the verified official installer carrying Harness also supports the authenticated asset fallback',async()=>{
  const f=controlFixture(),name='Strata-0.2.12-windows-x64-setup.exe';
  f.url='https://github.com/Niko1221/Strata/releases/download/v0.2.12/'+name;
  Object.assign(f.metadata.assets[0],{name,browser_download_url:f.url});
  const target=join(temp(),name);let calls=0;
  await download(f.url,target,f.sha,{fetchImpl:async()=>{
    calls++;
    if(calls===1)return new Response(null,{status:504});
    if(calls===2)return Response.json(f.metadata);
    return new Response(f.bytes);
  }});
  assert.equal(calls,3);assert.deepEqual(readFileSync(target),f.bytes);
});
test('installer host copy excludes dependency caches and secret environment files while retaining built UI and source',()=>{
  const root=temp(),source=join(root,'source'),target=join(root,'payload/host');
  for(const path of ['server/index.mjs','dist/index.html','src/components/ChatModelPicker.tsx','package.json'])save(join(source,path),'public source');
  for(const path of ['node_modules/pkg/index.js','.git/config','.env','.env.local','.npmrc','.npmrc.local','.cache/cache.db'])save(join(source,path),'never ship');
  const result=copyHost(source,target);assert.equal(result.files,4);
  assert.equal(readFileSync(join(target,'server/index.mjs'),'utf8'),'public source');
  for(const path of ['node_modules','.git','.env','.env.local','.npmrc','.npmrc.local','.cache'])assert.equal(existsSync(join(target,path)),false,path);
  for(const path of ['../escape','/absolute','C:/absolute','a\\b','foo//bar'])assert.equal(hostFileAllowed(path),false,path);
});
test('installer host copy refuses a link before packaging any linked file',()=>{
  const root=temp(),source=join(root,'source');save(join(source,'server/index.mjs'),'server');save(join(source,'dist/index.html'),'ui');
  const outside=join(root,'outside');mkdirSync(outside);save(join(outside,'private.txt'),'never ship');symlinkSync(outside,join(source,'linked'),'junction');
  assert.throws(()=>copyHost(source,join(root,'payload')),/links/);assert(!existsSync(join(root,'payload/linked/private.txt')));
});
test('license collection carries exact frontend license texts and retains only installed production packages',()=>{
  const root=temp(),target=join(root,'licenses');save(join(root,'LICENSE'),'Strata MIT text');
  save(join(root,'apps/host/package-lock.json'),JSON.stringify({packages:{'':{dependencies:{react:'1'}},'node_modules/react':{version:'1'},'node_modules/dev-tool':{version:'2',dev:true},'node_modules/optional-absent':{version:'3'}}}));
  save(join(root,'apps/host/node_modules/react/LICENSE'),'React MIT notice');save(join(root,'apps/host/node_modules/dev-tool/LICENSE'),'dev only');
  const result=collectLicenses(root,target);assert.deepEqual(result,{packages:1,files:1});
  const folder=readdirSync(target).find(name=>name.startsWith('react-'));assert.equal(readFileSync(join(target,folder,'LICENSE'),'utf8'),'React MIT notice');
  assert.equal(readFileSync(join(target,'Strata-LICENSE.txt'),'utf8'),'Strata MIT text');assert(!readdirSync(target).some(name=>name.startsWith('dev-tool')));
});
test('new installer builds resolve only a matching official stable Control package with an asset SHA-256',async()=>{
  const baseline=await controlDescriptor('0.2.12',{fetchImpl:()=>{throw Error('baseline must be pinned');}});assert.equal(baseline.sha256,CONTROL_SHA256);assert.match(NODE_SHA256,/^[a-f0-9]{64}$/);
  const archive='strata-control-0.1.59-windows-x86_64.zip',asset={name:archive,size:73000000,digest:'sha256:'+'a'.repeat(64),browser_download_url:'https://github.com/Niko1221/Strata/releases/download/v0.2.13/'+archive};
  const fetchImpl=async url=>{assert.equal(url,'https://api.github.com/repos/Niko1221/Strata/releases/tags/v0.2.13');return {ok:true,json:async()=>({tag_name:'v0.2.13',draft:false,prerelease:false,assets:[asset]})};};
  const result=await controlDescriptor('0.2.13',{fetchImpl});assert.equal(result.version,'0.1.59');assert.equal(result.sha256,'a'.repeat(64));
  for(const bad of [{...asset,digest:null},{...asset,browser_download_url:'https://example.com/runtime.zip'},{...asset,size:0}])await assert.rejects(controlDescriptor('0.2.13',{fetchImpl:async()=>({ok:true,json:async()=>({tag_name:'v0.2.13',assets:[bad]})})}));
  await assert.rejects(controlDescriptor('0.2.13',{fetchImpl:async()=>({ok:true,json:async()=>({tag_name:'v0.2.13',prerelease:true,assets:[asset]})})}));
});
