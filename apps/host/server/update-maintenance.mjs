/** Optional installer/update lease. Existing requests finish; no new mutation may race a host restart. */
import {readFileSync} from 'node:fs';
import {isAbsolute} from 'node:path';
import {json,sameSecret} from './util.mjs';

const READ_ONLY=new Set(['GET','HEAD','OPTIONS']);
function processAlive(pid){try{process.kill(pid,0);return true;}catch(error){return error?.code==='EPERM';}}

export function createUpdateMaintenance({file=process.env.STRATA_UPDATE_MAINTENANCE_FILE,read=path=>readFileSync(path,'utf8'),now=()=>Date.now(),alive=processAlive}={}){
  const enabled=typeof file==='string'&&file.length>0;
  if(file!=null&&file!==''&&(!enabled||!isAbsolute(file)))throw new Error('The update maintenance file must be an absolute path.');
  let activeRequests=0;
  function lease(){
    if(!enabled)return null;
    try{
      const value=JSON.parse(read(file).replace(/^\uFEFF/,''));
      const expiry=typeof value.expiresAt==='number'?value.expiresAt:typeof value.expiresAt==='string'?Date.parse(value.expiresAt):NaN;
      if(!Number.isSafeInteger(value.pid)||value.pid<=0||typeof value.id!=='string'||!/^[A-Za-z0-9_-]{16,128}$/.test(value.id)||!Number.isFinite(expiry)||expiry<=now()||!alive(value.pid))return null;
      return value;
    }catch{return null;}
  }
  const state=()=>({enabled,active:!!lease(),activeRequests});
  function track(res){
    activeRequests++;
    let finished=false;
    const release=()=>{if(finished)return;finished=true;activeRequests--;res.off('finish',release);res.off('close',release);};
    res.once('finish',release);res.once('close',release);
  }
  /** Return true when this hook answered the request. Call before dispatch and before any await. */
  function handle(req,res,path,method=req.method??'GET'){
    if(path==='/api/update-maintenance'&&method==='GET'){json(res,200,state());return true;}
    if(!enabled)return false;
    const guarded=path.startsWith('/api/')||path.startsWith('/v1/');
    if(!guarded||READ_ONLY.has(method))return false;
    if(req.aborted||res.destroyed)return true;
    const autosave=method==='PUT'&&/^\/api\/chats\/[^/]+$/.test(path);
    const current=lease(),updater=!!current&&sameSecret(req.headers['x-strata-updater'],current.id);
    if(current&&!updater&&!autosave){json(res,503,{error:'Strataを更新しています。完了後にもう一度お試しください。',code:'update-maintenance'});return true;}
    if(!autosave&&!updater)track(res);
    return false;
  }
  return {enabled,state,handle};
}
