import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { createManagedLocalModels } from './managed-local-models.mjs';

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
async function until(predicate, description = 'condition') {
  const deadline = Date.now() + 3000;
  do { if (await predicate()) return; await delay(5); } while (Date.now() < deadline);
  throw new Error('Timed out waiting for ' + description);
}
const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

// All lifecycle commands and backend fetches are injected. These tests never run
// PowerShell, contact a real inference server, or load any weights.
async function fixture(t, options = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'strata-managed-models-test-'));
  const tokenFile = join(dir, 'gateway.key'), backendKeyFile = join(dir, 'backend.key');
  writeFileSync(tokenFile, 'gateway-private-token-0123456789abcdef');
  writeFileSync(backendKeyFile, 'private-backend-key');
  const cmd = mode => ({ file: join(dir, 'mock-only.ps1'), args: [mode] });
  const config = {
    tokenFile, maintenanceFile: join(dir, 'maintenance.json'), stopCommand: cmd('stop'), probeTimeoutMs: 50, verifyTimeoutMs: 30, pollIntervalMs: 1,
    models: [
      { id: 'original', label: 'Original', modelId: 'original-model', baseUrl: 'http://127.0.0.1:18081/v1', command: cmd('original') },
      { id: 'sc117', label: 'SC117', modelId: 'sc117-model', baseUrl: 'http://127.0.0.1:18081/v1', command: cmd('sc117') },
      { id: 'dense', label: 'Dense 9B', modelId: 'dense-model', baseUrl: 'http://127.0.0.1:18083/v1', apiKeyFile: backendKeyFile, command: cmd('dense') },
    ], ...options.config,
  };
  const configPath = join(dir, 'models.json');
  writeFileSync(configPath, JSON.stringify(config));
  const active = new Set(options.active ?? []), commands = [], requests = [], states = [];
  const gateway = createManagedLocalModels({ configPath, changed: state => states.push(state),
    runCommand: async command => {
      const mode = command.args[0]; commands.push(mode);
      if (await options.onRun?.(mode, { active, commands }) === false) return;
      active.clear(); if (mode !== 'stop') active.add(mode);
    },
    fetchImpl: async (input, init = {}) => {
      const url = new URL(input), record = { url: url.href, init };
      requests.push(record);
      const destination = config.models.filter(m => new URL(m.baseUrl).host === url.host);
      assert.ok(destination.length, 'backend fetch stays inside the trusted catalog');
      const authorization = new Headers(init.headers).get('authorization');
      assert.equal(authorization, destination.some(m => m.apiKeyFile) ? 'Bearer ' + readFileSync(backendKeyFile, 'utf8').trim() : null);
      const ready = destination.filter(m => active.has(m.id));
      if (url.pathname !== '/v1/chat/completions') {
        const override = await options.onProbe?.(url, init, ready);
        if (override) return override;
      }
      if (url.pathname === '/health') return jsonResponse({ status: ready.length ? 'ok' : 'loading' }, ready.length ? 200 : 503);
      if (url.pathname === '/v1/models') return jsonResponse({ data: ready.map(m => ({ id: m.modelId })) });
      assert.equal(url.pathname, '/v1/chat/completions');
      const body = JSON.parse(init.body);
      assert.equal(ready.length, 1, 'one backend model is ready before inference');
      assert.equal(body.model, ready[0].modelId, 'requests cannot reach a different loaded model');
      return options.onChat ? options.onChat(body, init, record) : jsonResponse({ model: body.model, choices: [{ message: { role: 'assistant', content: 'ok' } }] });
    },
  });
  const server = createServer((req, res) => {
    gateway.proxy(req, res, req.url.slice(1)).catch(err => { res.writeHead(err.statusCode ?? 500); res.end('gateway error'); });
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const token = readFileSync(tokenFile, 'utf8');
  const request = (model, extra = {}) => fetch(base + '/chat/completions', {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + token },
    body: JSON.stringify({ model: config.models.find(m => m.id === model)?.modelId ?? model,
      messages: [{ role: 'user', content: 'test' }], ...extra.body }), ...extra,
  });
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    const target = resolve(dir), root = resolve(tmpdir()) + sep;
    assert.ok(target.startsWith(root) && target.includes('strata-managed-models-test-'));
    rmSync(target, { recursive: true, force: true });
  });
  return { gateway, active, commands, requests, states, request, base, token, backendKeyFile, maintenanceFile: config.maintenanceFile };
}

test('disabled manager does not read credentials, probe, or execute commands', async () => {
  const unexpected = () => { throw new Error('Unexpected external action'); };
  const gateway = createManagedLocalModels({ configPath: '', fetchImpl: unexpected, runCommand: unexpected });
  assert.equal((await gateway.publicState()).enabled, false);
  assert.throws(() => gateway.requestSwitch('original'), { statusCode: 404 });
  assert.throws(() => gateway.providerRegistration('http://localhost'), { statusCode: 404 });
});

test('catalog requires gateway authentication and keeps server-only details private', async t => {
  const h = await fixture(t);
  assert.equal((await fetch(h.base + '/models')).status, 401);
  assert.equal((await fetch(h.base + '/models', { headers: { authorization: 'Bearer wrong' } })).status, 401);
  const response = await fetch(h.base + '/models', { headers: { authorization: 'Bearer ' + h.token } });
  assert.deepEqual((await response.json()).data.map(m => m.id), ['original-model', 'sc117-model', 'dense-model']);
  assert.equal(h.requests.length, 0, 'catalog listing does not load or probe models');
  assert.equal(h.commands.length, 0);
  const state = await h.gateway.publicState({ refresh: false });
  assert.doesNotMatch(JSON.stringify(state), /gateway-private|private-backend|18081|\.ps1|\.key/);
  const registration = h.gateway.providerRegistration(h.base + '/v1');
  assert.equal(registration.apiKey, h.token);
  assert.equal(registration.models.length, 3);
  h.gateway.setConnectionId('preserved-existing-provider');
  assert.equal((await h.gateway.publicState({ refresh: false })).connectionId, 'preserved-existing-provider');
});

test('switching is nonblocking, serialized, and skips an already ready model', async t => {
  const loading = deferred(), started = deferred();
  const h = await fixture(t, { active: ['original'], onRun: async mode => {
    if (mode === 'sc117') { started.resolve(); await loading.promise; }
  } });
  const immediate = h.gateway.requestSwitch('sc117');
  assert.equal(immediate.switching, true);
  assert.equal(immediate.targetId, 'sc117');
  await started.promise;
  assert.deepEqual(h.commands, ['stop', 'sc117']);
  assert.throws(() => h.gateway.requestSwitch('original'), { statusCode: 409 });
  assert.equal(h.gateway.requestSwitch('sc117').targetId, 'sc117', 'same pending selection coalesces');
  assert.equal((await h.gateway.publicState()).phase, 'loading', 'status is readable while a helper is running');
  loading.resolve();
  await until(async () => !(await h.gateway.publicState({ refresh: false })).switching, 'switch completion');
  assert.equal((await h.gateway.publicState({ refresh: false })).activeId, 'sc117');
  h.gateway.requestSwitch('sc117');
  await until(async () => !(await h.gateway.publicState({ refresh: false })).switching);
  assert.deepEqual(h.commands, ['stop', 'sc117'], 'ready model selection never reloads it');
});

test('chat autoloads the selected historical model and forwards images with backend credentials', async t => {
  const imageBody = { messages: [{ role: 'user', content: [{ type: 'text', text: 'describe' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAA' } }] }], temperature: 0.2 };
  let received;
  const h = await fixture(t, { active: ['original'], onChat: body => { received = body; return jsonResponse({ model: body.model }); } });
  assert.equal((await h.request('unknown-model')).status, 400);
  assert.deepEqual(h.commands, []);
  const response = await h.request('dense', { body: JSON.stringify({ model: 'dense-model', ...imageBody }) });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { model: 'dense-model' });
  assert.deepEqual(received.messages, imageBody.messages);
  assert.equal(received.temperature, 0.2);
  assert.deepEqual(h.commands, ['stop', 'dense']);
  const inference = h.requests.find(r => r.url.endsWith('/chat/completions'));
  assert.equal(new Headers(inference.init.headers).get('authorization'), 'Bearer private-backend-key');
  assert.ok(!JSON.stringify(inference.init).includes(h.token));
  writeFileSync(h.backendKeyFile, 'rotated-backend-key');
  assert.equal((await h.request('dense')).status, 200, 'backend key is reread for rotation');
});

test('whole streamed response owns the mutex; a queued other-model chat loads only after it ends', async t => {
  let streamController;
  const stream = new ReadableStream({ start(controller) { streamController = controller; controller.enqueue(new TextEncoder().encode('data: first\n\n')); } });
  let chats = 0;
  const h = await fixture(t, { active: ['original'], onChat: body => ++chats === 1
    ? new Response(stream, { headers: { 'content-type': 'text/event-stream' } }) : jsonResponse({ model: body.model }) });
  const first = await h.request('original', { body: JSON.stringify({ model: 'original-model', messages: [], stream: true }) });
  assert.equal(first.headers.get('content-type'), 'text/event-stream');
  assert.equal((await h.gateway.publicState({ refresh: false })).activeRequests, 1);
  const second = h.request('sc117');
  await until(async () => (await h.gateway.publicState({ refresh: false })).queuedRequests === 1, 'queued chat');
  assert.throws(() => h.gateway.requestSwitch('dense'), { statusCode: 409 });
  assert.deepEqual(h.commands, [], 'no loader runs while response stream remains open');
  streamController.enqueue(new TextEncoder().encode('data: [DONE]\n\n')); streamController.close();
  assert.equal(await first.text(), 'data: first\n\ndata: [DONE]\n\n');
  assert.equal((await (await second).json()).model, 'sc117-model');
  assert.deepEqual(h.commands, ['stop', 'sc117']);
  assert.equal((await h.gateway.publicState({ refresh: false })).activeRequests, 0);
});

test('inference queue is bounded to four waiting requests', async t => {
  let streamController, chats = 0;
  const stream = new ReadableStream({ start(controller) { streamController = controller; controller.enqueue(new Uint8Array([65])); } });
  const h = await fixture(t, { active: ['original'], onChat: () => ++chats === 1 ? new Response(stream) : jsonResponse({ ok: true }) });
  const current = await h.request('original');
  const waiting = Array.from({ length: 4 }, () => h.request('original'));
  await until(async () => (await h.gateway.publicState({ refresh: false })).queuedRequests === 4, 'four queued requests');
  assert.equal((await h.request('original')).status, 429);
  streamController.close(); await current.text();
  for (const response of await Promise.all(waiting)) assert.equal(response.status, 200);
});

test('client abort during load keeps the lifecycle locked until helper settles and skips inference', async t => {
  const loading = deferred(), started = deferred();
  const h = await fixture(t, { onRun: async mode => { if (mode === 'dense') { started.resolve(); await loading.promise; } } });
  const abort = new AbortController();
  const pending = h.request('dense', { signal: abort.signal }).catch(err => err);
  await started.promise; abort.abort(); await pending; await delay(20);
  assert.throws(() => h.gateway.requestSwitch('original'), { statusCode: 409 });
  assert.equal((await h.gateway.publicState({ refresh: false })).activeRequests, 1);
  loading.resolve();
  await until(async () => (await h.gateway.publicState({ refresh: false })).activeRequests === 0, 'aborted loader settlement');
  assert.ok(!h.requests.some(r => r.url.endsWith('/chat/completions')), 'aborted caller does not generate after loading');
  assert.equal((await h.gateway.publicState({ refresh: false })).activeId, 'dense');
});

test('client disconnect aborts the upstream stream before releasing lifecycle ownership', async t => {
  let upstreamAborted = false;
  const h = await fixture(t, { active: ['original'], onChat: (body, init) => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('data: started\n\n'));
      init.signal.addEventListener('abort', () => { upstreamAborted = true; controller.error(new DOMException('Aborted', 'AbortError')); }, { once: true });
    },
  })) });
  const abort = new AbortController();
  const response = await h.request('original', { signal: abort.signal });
  const reader = response.body.getReader(); await reader.read(); abort.abort();
  await until(async () => upstreamAborted && (await h.gateway.publicState({ refresh: false })).activeRequests === 0, 'upstream abort and lock release');
  assert.equal(upstreamAborted, true);
  assert.equal(h.gateway.requestSwitch('original').switching, true);
  await until(async () => !(await h.gateway.publicState({ refresh: false })).switching);
});

test('wrong backend model after a loader finishes never receives an inference request', async t => {
  const h = await fixture(t, { onRun: (mode, { active }) => {
    if (mode === 'sc117') { active.add('original'); return false; }
  } });
  const response = await h.request('sc117');
  assert.equal(response.status, 503);
  assert.match((await response.json()).error.message, /起動を確認/);
  assert.ok(!h.requests.some(r => r.url.endsWith('/chat/completions')));
  const state = await h.gateway.publicState({ refresh: false });
  assert.equal(state.switching, false);
  assert.equal(state.phase, 'error');
});

test('two concurrently ready backends are normalized before serving the selected model', async t => {
  const h = await fixture(t, { active: ['original', 'dense'] });
  const state = await h.gateway.publicState();
  assert.equal(state.activeId, null);
  assert.deepEqual(state.activeIds, ['original', 'dense']);
  assert.equal((await h.request('original')).status, 200);
  assert.deepEqual(h.commands, ['stop', 'original']);
});

test('an older status probe cannot overwrite the active model after a later switch completes', async t => {
  const probing = deferred(), resume = deferred();
  let first = true;
  const h = await fixture(t, { active: ['original'], onProbe: async (url, init, ready) => {
    if (first && url.pathname === '/v1/models' && url.port === '18081') {
      first = false; probing.resolve();
      const staleResponse = jsonResponse({ data: ready.map(m => ({ id: m.modelId })) });
      await resume.promise; return staleResponse;
    }
  } });
  const oldStatus = h.gateway.publicState();
  await probing.promise;
  h.gateway.requestSwitch('sc117');
  await until(async () => !(await h.gateway.publicState({ refresh: false })).switching, 'newer switch completion');
  assert.equal((await h.gateway.publicState({ refresh: false })).activeId, 'sc117');
  resume.resolve();
  assert.equal((await oldStatus).activeId, 'sc117');
});

test('a live maintenance lease blocks switches and new inference but keeps status and catalog available', async t => {
  const h = await fixture(t, { active: ['original'] });
  writeFileSync(h.maintenanceFile, JSON.stringify({ pid: process.pid, expiresAt: new Date(Date.now() + 60000).toISOString(), reason: 'update' }));
  assert.equal((await h.gateway.publicState({ refresh: false })).maintenance, true);
  assert.throws(() => h.gateway.requestSwitch('original'), { statusCode: 503 });
  const blocked = await h.request('dense');
  assert.equal(blocked.status, 503);
  assert.match((await blocked.json()).error.message, /更新/);
  assert.equal((await fetch(h.base + '/models', { headers: { authorization: 'Bearer ' + h.token } })).status, 200);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(h.commands, []);
});

test('missing, expired, malformed and dead-process maintenance leases do not strand the chat', async t => {
  const h = await fixture(t, { active: ['original'] });
  assert.equal((await h.gateway.publicState({ refresh: false })).maintenance, false);
  for (const lease of [
    { pid: process.pid, expiresAt: Date.now() - 1 },
    { pid: 2147483647, expiresAt: Date.now() + 60000 },
    { pid: process.pid, expiresAt: 'not-a-date' },
    { pid: 0, expiresAt: Date.now() + 60000 },
  ]) {
    writeFileSync(h.maintenanceFile, JSON.stringify(lease));
    assert.equal((await h.gateway.publicState({ refresh: false })).maintenance, false);
  }
  writeFileSync(h.maintenanceFile, '{unfinished');
  assert.equal((await h.gateway.publicState({ refresh: false })).maintenance, false);
  assert.equal((await h.request('original')).status, 200);
  assert.deepEqual(h.commands, []);
});

test('maintenance lets an existing response finish and prevents an already queued model from loading', async t => {
  let streamController;
  const stream = new ReadableStream({ start(controller) { streamController = controller; controller.enqueue(new TextEncoder().encode('first')); } });
  const h = await fixture(t, { active: ['original'], onChat: () => new Response(stream) });
  const first = await h.request('original');
  const queued = h.request('sc117');
  await until(async () => (await h.gateway.publicState({ refresh: false })).queuedRequests === 1, 'queued request before maintenance');
  writeFileSync(h.maintenanceFile, JSON.stringify({ pid: process.pid, expiresAt: Date.now() + 60000 }));
  assert.equal((await h.gateway.publicState({ refresh: false })).activeRequests, 1);
  assert.equal((await h.request('dense')).status, 503);
  streamController.enqueue(new TextEncoder().encode('-complete')); streamController.close();
  assert.equal(await first.text(), 'first-complete');
  const refused = await queued;
  assert.equal(refused.status, 503);
  assert.match((await refused.json()).error.message, /更新/);
  assert.deepEqual(h.commands, [], 'an update lease prevents queued work from loading a different model');
  assert.equal((await h.gateway.publicState({ refresh: false })).activeRequests, 0);
});
