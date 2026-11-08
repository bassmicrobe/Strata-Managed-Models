/** Opt-in coding chat setup. All personal state is created on the receiving PC. */
import {randomUUID} from 'node:crypto';
import {existsSync,mkdirSync,readFileSync,writeFileSync,renameSync,unlinkSync,openSync,closeSync} from 'node:fs';
import {dirname,join,resolve} from 'node:path';

export const CODING_CONSENT_VERSION = 1;
export const CODING_TITLE = '自動テストでコーディング';
const START = '<!-- strata-managed-coding:start -->';
const END = '<!-- strata-managed-coding:end -->';
const POLICY = readFileSync(new URL('./coding-policy.md', import.meta.url), 'utf8');
const readJson = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

function atomicWrite(file, text) {
  mkdirSync(dirname(file), {recursive:true});
  const temporary = file + '.' + randomUUID() + '.tmp';
  writeFileSync(temporary, text, {mode:0o600});
  renameSync(temporary, file);
}

export function codingStateFile(paths) { return join(paths.dataRoot, 'coding.json'); }
export function codingState(paths) {
  const file = codingStateFile(paths);
  if (!existsSync(file)) return null;
  const state = readJson(file);
  if (state.consentVersion !== CODING_CONSENT_VERSION || !/^managed-coding-[a-f0-9-]{36}$/.test(state.chatId ?? '')) {
    throw new Error('The saved automatic coding setup is invalid. Restore coding.json from a backup.');
  }
  return state;
}

export function mergeCodingPolicy(text) {
  const start = text.indexOf(START), end = text.indexOf(END);
  const block = START + '\n' + POLICY.trim() + '\n' + END;
  if (start === -1 && end === -1) return text + (text && !text.endsWith('\n') ? '\n' : '') + (text ? '\n' : '') + block + '\n';
  if (start < 0 || end < start || text.indexOf(START, start + START.length) !== -1 || text.indexOf(END, end + END.length) !== -1) {
    throw new Error('The automatic coding instruction markers need repair. Existing instructions were preserved.');
  }
  return text.slice(0, start) + block + text.slice(end + END.length);
}

export function refreshCodingPolicy(paths) {
  if (!codingState(paths)) return false;
  const file = join(paths.profile, 'data', 'agent', 'home', 'AGENTS.md');
  const before = existsSync(file) ? readFileSync(file, 'utf8') : '';
  const after = mergeCodingPolicy(before);
  if (after === before) return false;
  atomicWrite(file, after);
  return true;
}

function acquire(paths) {
  mkdirSync(paths.dataRoot, {recursive:true});
  const file = join(paths.dataRoot, 'coding-setup.lock');
  if (existsSync(file)) {
    const prior = readJson(file);
    let alive = true;
    try { process.kill(prior.pid, 0); } catch (error) { if (error.code === 'ESRCH') alive = false; }
    if (alive) throw new Error('Automatic coding setup is already running. Try again when it finishes.');
    unlinkSync(file);
  }
  const id = randomUUID(), fd = openSync(file, 'wx', 0o600);
  try { writeFileSync(fd, JSON.stringify({pid:process.pid,id})); } finally { closeSync(fd); }
  return () => { if (existsSync(file) && readJson(file).id === id) unlinkSync(file); };
}

async function request(record, path, {method = 'GET', body, missing = false, fetchImpl = fetch} = {}) {
  const response = await fetchImpl(`http://127.0.0.1:${record.port}${path}`, {
    method, headers: {'x-strata-client':'strata-managed-coding', ...(body ? {'content-type':'application/json'} : {})},
    ...(body ? {body:JSON.stringify(body)} : {}), signal:AbortSignal.timeout(15000),
  });
  if (missing && response.status === 404) return null;
  if (!response.ok) throw new Error('The automatic coding setup could not be saved by Strata. Retry after the current task finishes.');
  return response.json();
}

/** Reuse the latest saved remote choice if it still exists; otherwise use a ready native model or the picker. */
export async function codingModel(requestApi) {
  const providers = await requestApi('/api/model-providers');
  const index = await requestApi('/api/chats');
  const recent = [...(index.chats ?? [])].sort((a,b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')));
  for (const row of recent) {
    const saved = await requestApi('/api/chats/' + encodeURIComponent(row.id), {missing:true});
    const choice = saved?.session?.preferences?.remoteModel;
    if (choice && providers.connections?.some(c => c.id === choice.connectionId && c.models?.some(m => m.id === choice.modelId))) return choice;
  }
  return null;
}

export async function configureCoding(paths, record, {accepted = false, fetchImpl = fetch, now = () => new Date().toISOString()} = {}) {
  const release = acquire(paths);
  try {
    let state = codingState(paths);
    if (!state && !accepted) throw new Error('Choose 自動テストでコーディング from the Strata menu and confirm automatic execution first.');
    const api = (path, options = {}) => request(record, path, {...options,fetchImpl});
    const capability = await api('/api/agent/status');
    if (capability.state === 'unavailable') throw new Error('The coding assistant is unavailable. Repair this installation with the latest Windows installer.');
    if (!state) {
      state = {consentVersion:CODING_CONSENT_VERSION,acceptedAt:now(),chatId:'managed-coding-' + randomUUID()};
      atomicWrite(codingStateFile(paths), JSON.stringify(state, null, 2));
    }
    refreshCodingPolicy(paths);
    const chatPath = '/api/chats/' + state.chatId;
    const saved = await api(chatPath, {missing:true});
    const folder = saved?.session?.workspace ?? join(paths.dataRoot, 'Workspace', 'Coding');
    if (!saved) {
      mkdirSync(folder, {recursive:true});
      const remoteModel = await codingModel(api), time = now();
      await api(chatPath, {method:'PUT', body:{
        id:state.chatId,title:CODING_TITLE,defaultTitle:false,createdAt:time,updatedAt:time,
        messages:[],workspace:folder,tokensIn:0,tokensOut:0,pinned:true,
        preferences:{mode:'bypass',agent:true,thinking:'High',thinkingBudget:0,...(remoteModel ? {remoteModel} : {})},
      }});
    }
    // The existing folder and preferences belong to the person after the first save.
    const currentFolder = await api('/api/chat/folder?sessionId=' + state.chatId);
    if (!currentFolder.folder) await api('/api/chat/folder', {method:'POST',body:{sessionId:state.chatId,path:folder}});
    const workspaces = await api('/api/workspaces');
    if (!workspaces.workspaces?.some(w => resolve(w.path).toLowerCase() === resolve(folder).toLowerCase())) {
      const workspace = await api('/api/workspaces', {method:'POST',body:{path:folder}});
      await api('/api/workspaces/' + encodeURIComponent(workspace.id), {method:'PATCH',body:{name:'コーディング'}});
    }
    return {chatId:state.chatId,target:'#/chat/' + state.chatId};
  } finally { release(); }
}
