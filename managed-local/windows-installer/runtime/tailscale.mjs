/** Optional private Tailscale Serve endpoint. Never installs, signs in, resets, or enables Funnel. */
import {execFile} from 'node:child_process';
import {existsSync,readFileSync,mkdirSync,writeFileSync,renameSync,unlinkSync} from 'node:fs';
import {join,isAbsolute,basename} from 'node:path';
import {randomUUID} from 'node:crypto';

const OWNER='strata-managed-models',PORTS=[443,8443,9443];
const object=value=>value&&typeof value==='object'&&!Array.isArray(value);
const own=(value,key)=>Object.prototype.hasOwnProperty.call(value??{},key);
const validPort=value=>Number.isSafeInteger(value)&&value>=1&&value<=65535;
const configFile=dataRoot=>join(dataRoot,'tailscale.json');
export class TailscaleSetupError extends Error{constructor(message,{actionUrl}={}){super(message);this.name='TailscaleSetupError';this.actionUrl=actionUrl;}}
const error=message=>new TailscaleSetupError(message);
function hostname(value){const result=String(value??'').replace(/\.$/,'').toLowerCase();if(result.length>253||!result.endsWith('.ts.net')||result.split('.').some(part=>! /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(part)))throw error('Tailscaleの端末名を確認できません。Tailscaleへ接続してから、もう一度お試しください。');return result;}
export function tailscaleOrigin(value){try{const url=new URL(value);hostname(url.hostname);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!PORTS.includes(Number(url.port||443)))throw Error();return url.origin;}catch{throw error('Tailscaleの共有URLが正しくありません。');}}
const urlFor=(host,port)=>`https://${host}${port===443?'':':'+port}`;
const targetFor=port=>{if(!validPort(port))throw error('Strataの待受ポートを確認できません。');return new URL(`http://127.0.0.1:${port}`).origin;};
function target(value){try{const url=new URL(value);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'||url.username||url.password||url.search||url.hash||url.pathname!=='/'||!validPort(Number(url.port||80)))return null;return url.origin;}catch{return null;}}
function validRecord(value){if(!object(value)||value.schema_version!==1||value.owner!==OWNER||value.enabled!==true||!PORTS.includes(value.httpsPort)||!validPort(value.hostPort))throw error('Tailscaleの保存設定を確認できません。');const host=hostname(value.hostname),url=tailscaleOrigin(value.url);if(url!==urlFor(host,value.httpsPort)||target(value.target)!==targetFor(value.hostPort))throw error('Tailscaleの保存設定を確認できません。');return{...value,hostname:host,url,target:targetFor(value.hostPort)};}
export function readTailscaleConfig(dataRoot){const file=configFile(dataRoot);if(!existsSync(file))return null;try{return validRecord(JSON.parse(readFileSync(file,'utf8').replace(/^\uFEFF/,'')));}catch{throw error('Tailscaleの保存設定を確認できません。共有設定を確認してください。');}}
function save(dataRoot,value){mkdirSync(dataRoot,{recursive:true});const file=configFile(dataRoot),temp=file+'.'+randomUUID()+'.tmp';writeFileSync(temp,JSON.stringify(value,null,2),{mode:0o600});renameSync(temp,file);}
export function consentUrl(output){const match=String(output??'').match(/https:\/\/login\.tailscale\.com\/f\/serve\?[^\s<>"']{1,2048}/);if(!match)return undefined;try{const url=new URL(match[0]);return url.protocol==='https:'&&url.hostname==='login.tailscale.com'&&url.pathname==='/f/serve'&&!url.username&&!url.password?url.href:undefined;}catch{return undefined;}}
export async function findTailscale(){
  for(const root of [process.env.ProgramW6432,process.env.ProgramFiles,'C:\\Program Files',process.env['ProgramFiles(x86)']].filter(Boolean)){const file=join(root,'Tailscale','tailscale.exe');if(existsSync(file))return file;}
  return new Promise(done=>{execFile('powershell.exe',['-NoLogo','-NoProfile','-NonInteractive','-Command',"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);Get-Command tailscale.exe -CommandType Application -ErrorAction SilentlyContinue|Select-Object -First 1 -ExpandProperty Source"],{windowsHide:true,encoding:'utf8',timeout:10000},(err,out)=>{const file=String(out??'').trim();done(!err&&isAbsolute(file)&&basename(file).toLowerCase()==='tailscale.exe'&&existsSync(file)?file:null);});});
}
export function runTailscale(exe,args){return new Promise(done=>{const child=execFile(exe,args,{windowsHide:true,encoding:'utf8',timeout:15000,maxBuffer:2*1024*1024},(err,stdout,stderr)=>done({code:err?Number.isInteger(err.code)?err.code:1:0,stdout:String(stdout??''),stderr:String(stderr??''),timedOut:!!err?.killed}));child.stdin?.end();});}
function checked(result){if(result?.code!==0){const actionUrl=consentUrl(String(result?.stdout??'')+'\n'+String(result?.stderr??''));if(actionUrl)throw new TailscaleSetupError('TailnetでHTTPS/Serveを有効にしてください。表示されたTailscaleの案内を許可した後、「Tailscaleで共有」をもう一度実行してください。\n'+actionUrl,{actionUrl});throw error('Tailscaleの操作を完了できませんでした。Tailscaleが接続済みか、Serveの利用が許可されているかを確認してください。');}return result.stdout;}
async function readServe(exe,run){try{const value=JSON.parse(checked(await run(exe,['serve','status','--json'])));if(value===null)return{};if(!object(value))throw Error();for(const key of ['TCP','Web','AllowFunnel','Foreground'])if(value[key]!=null&&!object(value[key]))throw Error();for(const foreground of Object.values(value.Foreground??{}))if(!object(foreground))throw Error();return value;}catch(err){if(err instanceof TailscaleSetupError)throw err;throw error('Tailscale Serveの状態を確認できません。Tailscaleを更新して、もう一度お試しください。');}}
function configs(value){return[value,...Object.values(value.Foreground??{}).filter(object)];}
function atPort(key,port){return String(key).endsWith(':'+port);}
function funnelOn(value,port){return configs(value).some(c=>Object.entries(c.AllowFunnel??{}).some(([key,on])=>on===true&&atPort(key,port)));}
export function portOccupied(value,port){return configs(value).some(c=>own(c.TCP,String(port))||Object.keys(c.Web??{}).some(key=>atPort(key,port))||Object.keys(c.AllowFunnel??{}).some(key=>atPort(key,port)));}
export function ownedMapping(value,record,{allowFunnel=false}={}){
  const p=record.httpsPort,key=record.hostname+':'+p,tcp=value.TCP?.[String(p)],web=value.Web?.[key],handler=web?.Handlers?.['/'];
  if(!object(tcp)||tcp.HTTPS!==true||Object.keys(tcp).some(k=>k!=='HTTPS')||!object(web)||Object.keys(web).some(k=>k!=='Handlers')||Object.keys(web.Handlers??{}).length!==1||!object(handler)||Object.keys(handler).some(k=>k!=='Proxy')||!target(record.target)||target(handler.Proxy)!==target(record.target))return false;
  if(Object.keys(value.Web??{}).some(k=>atPort(k,p)&&k!==key)||Object.values(value.Foreground??{}).some(c=>object(c)&&portOccupied(c,p)))return false;
  return allowFunnel||!funnelOn(value,p);
}
async function context({dataRoot,find=findTailscale,run=runTailscale}){
  const exe=await find();if(!exe)throw error('Tailscaleが見つかりません。Tailscaleをインストールしてサインインした後、もう一度「Tailscaleで共有」を実行してください。');
  let state;try{state=JSON.parse(checked(await run(exe,['status','--json'])));}catch(err){if(err instanceof TailscaleSetupError)throw err;throw error('Tailscaleの接続状態を確認できません。');}
  if(state?.BackendState!=='Running'||!state.Self)throw error('Tailscaleへ接続してください。Tailscaleでサインインした後、もう一度お試しください。');
  const host=hostname(state.Self.DNSName),saved=readTailscaleConfig(dataRoot),nodeId=typeof state.Self.ID==='string'?state.Self.ID:null;
  if(saved&&(saved.hostname!==host||saved.nodeId&&nodeId&&saved.nodeId!==nodeId))throw error('保存時とTailscaleの端末が異なります。以前の共有設定を確認してから再設定してください。');
  return{exe,hostname:host,nodeId,saved,config:await readServe(exe,run)};
}
export async function planTailscale({dataRoot,find,run=runTailscale}={}){
  const c=await context({dataRoot,find,run});let port;
  if(c.saved&&ownedMapping(c.config,c.saved,{allowFunnel:true})&&funnelOn(c.config,c.saved.httpsPort))throw error('保存した共有でFunnelが有効です。先に「Tailscale共有を停止」を実行してから、非公開の共有を設定してください。');
  if(c.saved&&(ownedMapping(c.config,c.saved)||!portOccupied(c.config,c.saved.httpsPort)))port=c.saved.httpsPort;
  if(!port)port=PORTS.find(p=>!portOccupied(c.config,p));
  if(!port)throw error('Tailscaleの443・8443・9443番ポートは使用中です。既存の共有設定を確認してください。');
  return{exe:c.exe,hostname:c.hostname,nodeId:c.nodeId,httpsPort:port,url:urlFor(c.hostname,port),saved:c.saved};
}
export async function applyTailscale({dataRoot,hostPort,plan,run=runTailscale}={}){
  if(!plan||hostname(plan.hostname)!==plan.hostname||!PORTS.includes(plan.httpsPort)||tailscaleOrigin(plan.url)!==urlFor(plan.hostname,plan.httpsPort))throw error('Tailscaleの共有設定を確認できません。');
  const record={schema_version:1,owner:OWNER,enabled:true,hostname:plan.hostname,nodeId:plan.nodeId??null,httpsPort:plan.httpsPort,url:plan.url,hostPort,target:targetFor(hostPort)};
  const before=await readServe(plan.exe,run),saved=plan.saved,sameSavedPort=saved?.httpsPort===record.httpsPort;
  if(portOccupied(before,record.httpsPort)&&!(sameSavedPort&&ownedMapping(before,saved))&&!(sameSavedPort&&ownedMapping(before,record)))throw error('Tailscaleの共有設定が変更されました。既存の設定は置き換えません。');
  if(funnelOn(before,record.httpsPort))throw error('このポートではFunnelが有効なため、非公開共有を設定できません。');
  if(sameSavedPort&&ownedMapping(before,record)){save(dataRoot,record);return record;}
  checked(await run(plan.exe,['serve','--bg',`--https=${record.httpsPort}`,'--yes',record.target]));
  const after=await readServe(plan.exe,run);
  if(!ownedMapping(after,record)){
    if(ownedMapping(after,record,{allowFunnel:true}))try{checked(await run(plan.exe,['serve',`--https=${record.httpsPort}`,'off']));}catch{}
    throw error('Tailscaleの非公開共有を確認できませんでした。Serveの設定を確認してください。');
  }
  save(dataRoot,record);return record;
}
export async function disableTailscale({dataRoot,find,run=runTailscale}={}){
  const saved=readTailscaleConfig(dataRoot);if(!saved)return{disabled:true,changed:false};
  const c=await context({dataRoot,find,run});
  if(!portOccupied(c.config,saved.httpsPort)){unlinkSync(configFile(dataRoot));return{disabled:true,changed:false};}
  if(!ownedMapping(c.config,saved,{allowFunnel:true}))throw error('保存した共有とは異なる設定が使われています。既存の共有は削除しません。Tailscale Serveの設定を確認してください。');
  checked(await run(c.exe,['serve',`--https=${saved.httpsPort}`,'off']));
  if(portOccupied(await readServe(c.exe,run),saved.httpsPort))throw error('Tailscale共有の停止を確認できませんでした。');
  unlinkSync(configFile(dataRoot));return{disabled:true,changed:true};
}
