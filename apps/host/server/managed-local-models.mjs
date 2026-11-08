/** Opt-in local model lifecycle and OpenAI chat gateway. No model is loaded at startup. */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { makePrivate } from './private-file.mjs';
import { json, readBody, sameSecret } from './util.mjs';

const failure = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const text = value => typeof value === 'string' ? value.trim() : '';
function command(value) {
  if (!value || !isAbsolute(value.file ?? '') || extname(value.file).toLowerCase() !== '.ps1'
    || !Array.isArray(value.args) || value.args.some(a => typeof a !== 'string' || /[\0\r\n]/.test(a))) {
    throw failure('Invalid managed model command.');
  }
  return { file: value.file, args: [...value.args] };
}
function configuration(configPath) {
  if (!configPath) return null;
  const cfg = JSON.parse(readFileSync(configPath, 'utf8').replace(/^\uFEFF/, ''));
  if (!isAbsolute(cfg.tokenFile ?? '') || !Array.isArray(cfg.models) || !cfg.models.length || cfg.models.length > 16) throw failure('Invalid managed model configuration.');
  if (cfg.maintenanceFile != null && !isAbsolute(cfg.maintenanceFile)) throw failure('Invalid managed maintenance lease path.');
  const models = cfg.models.map(m => {
    const url = new URL(m.baseUrl);
    if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash) throw failure('Managed model APIs must be local HTTP addresses.');
    if (!/^[a-z0-9_-]{1,64}$/.test(m.id ?? '') || !text(m.modelId) || !text(m.label)) throw failure('Invalid managed model identity.');
    if (m.apiKeyFile && !isAbsolute(m.apiKeyFile)) throw failure('Invalid managed API key file.');
    return { ...m, id: m.id, label: text(m.label), modelId: text(m.modelId), baseUrl: url.href.replace(/\/+$/, ''), command: command(m.command) };
  });
  if (new Set(models.map(m => m.id)).size !== models.length || new Set(models.map(m => m.modelId)).size !== models.length) throw failure('Managed model IDs must be unique.');
  return { ...cfg, models, stopCommand: cfg.stopCommand ? command(cfg.stopCommand) : null };
}
function tokenAt(path) {
  mkdirSync(dirname(path), { recursive: true });
  if (!existsSync(path)) writeFileSync(path, randomBytes(32).toString('hex'), { mode: 0o600, flag: 'wx' });
  makePrivate(path);
  const token = readFileSync(path, 'utf8').replace(/^\uFEFF/, '').trim();
  if (token.length < 32 || /\s/.test(token)) throw failure('The managed model gateway key is invalid.');
  return token;
}
export function runManagedCommand(cmd, { timeoutMs = 650000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', cmd.file, ...cmd.args], {
      windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    });
    // The scripts keep their own useful logs. Do not echo runtime credentials into HTTP errors.
    child.stdout.resume(); child.stderr.resume();
    // Never release the lifecycle lock while a loader can still spawn a GPU process.
    // The trusted helpers own shutdown/readiness deadlines; a slow helper must settle
    // before another switch is allowed, even after this watchdog deadline.
    let expired = false;
    const timer = setTimeout(() => { expired = true; }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); reject(failure('モデルの起動処理を開始できませんでした。', 503)); });
    child.once('exit', code => {
      clearTimeout(timer);
      if (expired) reject(failure('モデルの切り替えが時間内に完了しませんでした。', 503));
      else code === 0 ? resolve() : reject(failure('モデルの切り替えに失敗しました。起動ログを確認してください。', 503));
    });
  });
}

export function createManagedLocalModels({ configPath = process.env.STRATA_MANAGED_MODELS_CONFIG, fetchImpl = fetch,
  runCommand = runManagedCommand, changed = () => {}, log = () => {} } = {}) {
  const cfg = configuration(configPath), enabled = !!cfg;
  const token = cfg ? tokenAt(cfg.tokenFile) : '';
  const models = cfg?.models ?? [];
  const lookup = new Map(models.map(m => [m.id, m]));
  const modelLookup = new Map(models.map(m => [m.modelId, m]));
  let connectionId = cfg?.connectionId ?? null, activeId = null, activeIds = [];
  let switching = false, targetId = null, phase = 'idle', lastError = null;
  let activeRequests = 0, scheduled = 0, tail = Promise.resolve(), refreshedAt = 0, refreshing = null, probeEpoch = 0;
  const queueLimit = Math.max(1, Math.min(8, cfg?.maxQueuedRequests ?? 4));
  const probeTimeout = cfg?.probeTimeoutMs ?? 1500;
  const verifyTimeout = cfg?.verifyTimeoutMs ?? 15000;
  const publicModel = m => ({ id: m.id, label: m.label, modelId: m.modelId, description: m.description ?? '',
    contextMax: m.contextMax ?? 32768, maxOutput: m.maxOutput ?? 8192, vision: m.vision !== false, reasoning: m.reasoning !== false });
  function maintenance() {
    if (!cfg?.maintenanceFile) return false;
    try {
      const lease = JSON.parse(readFileSync(cfg.maintenanceFile, 'utf8').replace(/^\uFEFF/, ''));
      const expiry = typeof lease.expiresAt === 'number' ? lease.expiresAt : Date.parse(lease.expiresAt);
      if (!Number.isSafeInteger(lease.pid) || lease.pid <= 0 || !Number.isFinite(expiry) || expiry <= Date.now()) return false;
      process.kill(lease.pid, 0);
      return true;
    } catch { return false; }
  }
  function requireAvailable() {
    if (maintenance()) throw failure('Strataを更新しています。完了後にもう一度お試しください。', 503);
  }
  function snapshot() {
    return { enabled, models: models.map(publicModel), activeId, activeIds: [...activeIds], switching, targetId, phase,
      error: lastError, activeRequests, queuedRequests: Math.max(0, scheduled - (activeRequests || switching ? 1 : 0)), connectionId, maintenance: maintenance() };
  }
  function publish() { try { changed(snapshot()); } catch { /* UI observers cannot break lifecycle ownership. */ } }
  function requireEnabled() { if (!enabled) throw failure('Local model switching is not configured.', 404); }
  function backendHeaders(m) {
    let apiKey = '';
    if (m.apiKeyFile) {
      try { apiKey = readFileSync(m.apiKeyFile, 'utf8').replace(/^\uFEFF/, '').trim(); } catch { throw failure('ローカルモデルの接続設定を読み込めません。', 503); }
      if (!apiKey || /\s/.test(apiKey)) throw failure('ローカルモデルの接続設定が無効です。', 503);
    }
    return { 'content-type': 'application/json', ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}) };
  }
  async function detect() {
    const epoch = ++probeEpoch;
    const destinations = [...new Map(models.map(m => [m.baseUrl, m])).values()];
    const seen = await Promise.all(destinations.map(async m => {
      try {
        const options = { headers: backendHeaders(m), redirect: 'error', signal: AbortSignal.timeout(probeTimeout) };
        const health = await fetchImpl(new URL('../health', m.baseUrl + '/'), options);
        if (!health.ok) return [];
        const h = await health.json();
        if (!['ok', 'ready'].includes(h.status)) return [];
        const response = await fetchImpl(m.baseUrl + '/models', { ...options, signal: AbortSignal.timeout(probeTimeout) });
        if (!response.ok) return [];
        const data = await response.json();
        return models.filter(candidate => candidate.baseUrl === m.baseUrl && data.data?.some(row => row.id === candidate.modelId)).map(candidate => candidate.id);
      } catch { return []; }
    }));
    const ids = seen.flat();
    // A status request that started before a switch must not overwrite its newer probe.
    if (epoch === probeEpoch) { activeIds = ids; activeId = ids.length === 1 ? ids[0] : null; refreshedAt = Date.now(); }
    return ids;
  }
  async function publicState({ refresh = true } = {}) {
    if (enabled && refresh && !switching && !activeRequests && Date.now() - refreshedAt > 1000) {
      if (!refreshing) refreshing = detect().finally(() => { refreshing = null; });
      await refreshing;
    }
    return snapshot();
  }
  function enqueue(action) {
    scheduled++; publish();
    const result = tail.then(action);
    tail = result.catch(() => {});
    return result.finally(() => { scheduled--; publish(); });
  }
  async function ensure(m) {
    try {
      const ids = await detect();
      if (ids.length === 1 && ids[0] === m.id) { phase = 'ready'; lastError = null; return; }
      switching = true; targetId = m.id; phase = cfg.stopCommand ? 'stopping' : 'loading'; lastError = null; publish();
      if (cfg.stopCommand) await runCommand(cfg.stopCommand);
      activeId = null; activeIds = []; phase = 'loading'; publish();
      await runCommand(m.command);
      phase = 'checking'; publish();
      const deadline = Date.now() + verifyTimeout;
      do {
        const ready = await detect();
        if (ready.length === 1 && ready[0] === m.id) { phase = 'ready'; return; }
        await sleep(Math.min(500, cfg.pollIntervalMs ?? 500));
      } while (Date.now() < deadline);
      throw failure('選択したモデルの起動を確認できませんでした。', 503);
    } catch (err) {
      lastError = err.statusCode ? err.message : 'モデルの切り替えに失敗しました。'; phase = 'error';
      log('Managed model switch failed: ' + m.id);
      throw failure(lastError, err.statusCode ?? 503);
    } finally { switching = false; targetId = null; publish(); }
  }
  function requestSwitch(id) {
    requireEnabled();
    requireAvailable();
    const m = lookup.get(id);
    if (!m) throw failure('Unknown local model.');
    if (switching && targetId === id) return snapshot();
    if (scheduled || activeRequests || switching) throw failure('回答やモデルの読み込みが完了してから切り替えてください。', 409);
    switching = true; targetId = id; phase = 'checking'; lastError = null;
    void enqueue(() => ensure(m)).catch(() => {});
    return snapshot();
  }
  function providerRegistration(baseUrl) {
    requireEnabled();
    return { kind: 'custom', name: cfg.name ?? 'このPCのモデル', baseUrl, protocol: 'openai-chat', apiKey: token,
      models: models.map(m => ({ id: m.modelId, name: m.label, contextMax: m.contextMax ?? 32768,
        maxOutput: m.maxOutput ?? 8192, vision: m.vision !== false, reasoning: m.reasoning !== false })) };
  }
  async function proxy(req, res, subpath) {
    requireEnabled();
    if (!sameSecret(req.headers.authorization, `Bearer ${token}`)) return json(res, 401, { error: { message: 'Unauthorized local model gateway.', type: 'authentication_error' } });
    if (subpath === 'models' && req.method === 'GET') return json(res, 200, { object: 'list', data: models.map(m => ({
      id: m.modelId, name: m.label, object: 'model', owned_by: 'strata-local', context_length: m.contextMax ?? 32768,
      vision: m.vision !== false, reasoning: m.reasoning !== false,
      architecture: { input_modalities: m.vision === false ? ['text'] : ['text', 'image'], output_modalities: ['text'] },
    })) });
    if (subpath !== 'chat/completions' || req.method !== 'POST') return json(res, 404, { error: { message: 'Unknown managed inference endpoint.' } });
    if (maintenance()) return json(res, 503, { error: { message: 'Strataを更新しています。完了後にもう一度お試しください。' } });
    let body;
    try { body = await readBody(req, 32 * 1024 * 1024); } catch { return json(res, 400, { error: { message: 'The chat request must be valid JSON under 32 MB.' } }); }
    const m = modelLookup.get(body?.model);
    if (!m) return json(res, 400, { error: { message: 'Choose one of the configured local models.' } });
    if (req.aborted || res.destroyed) return;
    if (scheduled >= queueLimit + 1) return json(res, 429, { error: { message: 'The local model queue is full. Try again after the current answer.' } });
    const controller = new AbortController();
    const onClose = () => { if (!res.writableFinished) controller.abort(); };
    const onAborted = () => controller.abort();
    res.on('close', onClose); req.on('aborted', onAborted);
    if (req.aborted || res.destroyed) controller.abort();
    try {
      await enqueue(async () => {
        if (controller.signal.aborted) return;
        requireAvailable();
        activeRequests++; publish();
        try {
          await ensure(m);
          if (controller.signal.aborted) return;
          const upstream = await fetchImpl(m.baseUrl + '/chat/completions', { method: 'POST', headers: backendHeaders(m),
            body: JSON.stringify(body), redirect: 'error', signal: controller.signal });
          if (!upstream.body) throw failure('モデルから空の応答が返りました。', 502);
          res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') ?? 'application/json; charset=utf-8',
            'cache-control': 'no-store', 'x-accel-buffering': 'no' });
          for await (const bytes of upstream.body) {
            if (controller.signal.aborted) break;
            if (!res.write(Buffer.from(bytes))) await once(res, 'drain', { signal: controller.signal });
          }
          if (!res.destroyed) res.end();
        } finally { activeRequests--; publish(); }
      });
    } catch (err) {
      if (!controller.signal.aborted && !res.destroyed) {
        if (!res.headersSent) json(res, err.statusCode ?? 502, { error: { message: err.statusCode ? err.message : 'ローカルモデルとの接続が切れました。もう一度お試しください。' } });
        else res.destroy();
      }
    } finally { res.off('close', onClose); req.off('aborted', onAborted); }
  }
  return { enabled, publicState, requestSwitch, proxy, providerRegistration,
    setConnectionId(id) { connectionId = typeof id === 'string' ? id : null; publish(); } };
}
