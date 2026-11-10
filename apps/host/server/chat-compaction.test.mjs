import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ChatCompactionError, createChatCompactor } from './chat-compaction.mjs';

const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const text = content => typeof content === 'string' ? content : Array.isArray(content)
  ? content.map(b => b.type === 'tool_result' ? text(b.content) : b.text ?? '').join('\n') : '';
const tokens = p => Math.max(1, Math.ceil((text(p.system) + (p.messages ?? []).map(m => text(m.content)).join('\n')
  + JSON.stringify(p.tools ?? [])).length / 4) + (p.messages?.length ?? 0) * 8);
const model = { id: 'test-model', contextMax: 8192, baseUrl: 'http://127.0.0.1:18081/v1', counter: 'strata' };
const history = () => ({ model: model.id, stream: true, max_tokens: 1024, temperature: 0.7,
  reasoning_budget_tokens: 4096,
  messages: [
    { role: 'system', content: 'Keep user constraints. Preserve important exact identifiers.' },
    { role: 'user', content: 'Remember KEY-ALPHA.\n' + 'old-log '.repeat(1600) },
    { role: 'assistant', content: 'The selected value is KEY-BETA.\n' + 'details '.repeat(1600) },
    { role: 'user', content: 'What are the two remembered keys? Do not change this message.' },
  ] });

function mock(options = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const path = new URL(url).pathname, body = JSON.parse(init.body);
    calls.push({ url, path, body, headers: new Headers(init.headers) });
    init.signal?.throwIfAborted();
    if (path.endsWith('/messages/count_tokens')) {
      if (options.counter) return options.counter(body, init, calls.at(-1));
      return response({ input_tokens: tokens(body) });
    }
    if (path.endsWith('/apply-template')) return response({ prompt: JSON.stringify(body) });
    if (path.endsWith('/tokenize')) return response({ tokens: Array(Math.max(1, Math.ceil(body.content.length / 4))).fill(1) });
    assert(path.endsWith('/chat/completions'), 'only count and summary endpoints are used');
    assert.equal(body.stream, false);
    assert.equal(body.reasoning_budget_tokens, 0, 'summary has its own bounded budget');
    assert.equal(init.headers['x-strata-compaction'], 'summary');
    assert.match(body.messages[0].content, /untrusted historical data/);
    assert(!body.tools, 'quoted tool data is not an executable tool request');
    if (options.summary) return options.summary(body, init, calls.at(-1));
    return response({ choices: [{ finish_reason: 'stop', message: { content: 'The user needs KEY-ALPHA and KEY-BETA. Preserve these facts and the latest request.' } }] });
  };
  return { calls, fetchImpl, summaries: () => calls.filter(c => c.path.endsWith('/chat/completions')) };
}
function folder(t) {
  const dir = mkdtempSync(join(tmpdir(), 'strata-plain-compaction-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}
const factory = (api, extra = {}) => createChatCompactor({ fetchImpl: api.fetchImpl, privateDir: () => {}, ...extra });

test('small conversations do not call a tokenizer or a summarizer', async () => {
  const api = mock(), compact = factory(api);
  const payload = { model: model.id, messages: [{ role: 'user', content: 'Hello' }] };
  const result = await compact({ model, payload, chatId: 'small' });
  assert.equal(result.payload, payload);
  assert.equal(api.calls.length, 0);
});

test('near-full history is summarized while system, latest request, settings and model context remain intact', async () => {
  const api = mock(), compact = factory(api), payload = history(), original = structuredClone(payload), progress = [];
  const result = await compact({ model, payload, chatId: 'chat', onProgress: p => progress.push(p) });
  assert(result.compaction.afterTokens < result.compaction.beforeTokens);
  assert(result.compaction.afterTokens + payload.max_tokens + 256 <= model.contextMax);
  assert.equal(result.payload.messages[0], payload.messages[0]);
  assert.equal(result.payload.messages.at(-1), payload.messages.at(-1));
  assert.match(JSON.stringify(result.payload.messages), /KEY-ALPHA/);
  assert.equal(result.payload.reasoning_budget_tokens, 4096);
  assert.equal(result.payload.temperature, 0.7);
  assert.deepEqual(payload, original, 'caller history is never mutated');
  assert.deepEqual(progress.map(p => p.phase), ['compacting', 'compacted']);
  assert(api.summaries().length > 1, 'long history is split into bounded summary requests');
});

test('output reservation triggers compaction before an otherwise-small percentage becomes unsafe', async () => {
  const api = mock(), compact = factory(api), payload = history();
  payload.max_tokens = 4096;
  payload.messages[1].content = 'old '.repeat(2100);
  payload.messages[2].content = 'details '.repeat(950);
  const result = await compact({ model, payload, chatId: 'reserved' });
  assert(result.compaction);
  assert(result.compaction.afterTokens + 4096 + 256 <= 8192);
  assert.equal(result.payload.max_tokens, 4096);
});

test('persistent prefix summary is reused after restart, without calling a model for small follow-up turns', async t => {
  const dir = folder(t), first = mock(), payload = history();
  const compact = factory(first, { dataDir: dir });
  assert((await compact({ model, payload, chatId: 'same-chat' })).compaction.persisted);
  const files = readdirSync(join(dir, 'chat-compaction'));
  assert.equal(files.length, 1);
  const savedText = readFileSync(join(dir, 'chat-compaction', files[0]), 'utf8');
  assert(!savedText.includes('old-log'), 'only the summary and prefix digest are persisted');
  const next = structuredClone(payload);
  next.messages.push({ role: 'assistant', content: 'KEY-ALPHA and KEY-BETA.' }, { role: 'user', content: 'Continue.' });
  const second = mock(), restarted = factory(second, { dataDir: dir });
  const result = await restarted({ model, payload: next, chatId: 'same-chat' });
  assert.equal(result.compaction.cached, true);
  assert.equal(result.payload.messages.at(-1).content, 'Continue.');
  assert.equal(second.calls.length, 0);
});

test('summary cache is isolated by chat and model, and changed history invalidates its digest', async t => {
  const api = mock(), compact = factory(api, { dataDir: folder(t) }), payload = history();
  await compact({ model, payload, chatId: 'one' });
  let n = api.summaries().length;
  await compact({ model, payload, chatId: 'two' });
  assert(api.summaries().length > n);
  n = api.summaries().length;
  await compact({ model: { ...model, id: 'other-model' }, payload: { ...payload, model: 'other-model' }, chatId: 'one' });
  assert(api.summaries().length > n);
  n = api.summaries().length;
  const edited = structuredClone(payload); edited.messages[1].content += '\nAn explicit correction.';
  await compact({ model, payload: edited, chatId: 'one' });
  assert(api.summaries().length > n);
});

test('persistent cache has a fixed entry bound', async t => {
  const dir = folder(t), compact = factory(mock(), { dataDir: dir, maxEntries: 2 });
  for (const chatId of ['a', 'b', 'c']) await compact({ model, payload: history(), chatId });
  assert.equal(readdirSync(join(dir, 'chat-compaction')).filter(n => n.endsWith('.json')).length, 2);
});

test('oversized newest message is not truncated or sent as an unsafe original', async () => {
  const api = mock(), compact = factory(api), payload = history(), latest = 'Important newest text '.repeat(2000);
  payload.messages.at(-1).content = latest;
  await assert.rejects(compact({ model, payload, chatId: 'large' }), e => e instanceof ChatCompactionError && e.code === 'context-message-too-large');
  assert.equal(payload.messages.at(-1).content, latest);
  assert.equal(api.summaries().length, 0);
});

test('summary failure is a controlled error instead of forwarding the original oversized history', async () => {
  const api = mock({ summary: () => response({ error: { message: 'internal failure' } }, 500) }), compact = factory(api);
  await assert.rejects(compact({ model, payload: history(), chatId: 'failed' }), e => e.code === 'context-compaction-failed');
  assert.equal(api.summaries().length, 1);
});

test('explicit token-counter failure does not silently guess a safe full request', async () => {
  const api = mock({ counter: () => response({ error: 'missing' }, 404) }), compact = factory(api);
  await assert.rejects(compact({ model, payload: history() }), e => e.code === 'context-count-unavailable');
  assert.equal(api.summaries().length, 0);
});

test('counter endpoint and credentials are independent from the managed gateway summary endpoint', async () => {
  const api = mock(), compact = factory(api);
  await compact({ model: { ...model, baseUrl: 'http://127.0.0.1:18792/api/managed-models/v1',
    authorization: 'gateway-secret', counterBaseUrl: 'http://127.0.0.1:18081/v1' }, payload: history() });
  for (const call of api.calls) {
    if (call.path.endsWith('/messages/count_tokens')) {
      assert.equal(new URL(call.url).port, '18081');
      assert.equal(call.headers.get('authorization'), null);
    } else if (call.path.endsWith('/chat/completions')) {
      assert.equal(new URL(call.url).port, '18792');
      assert.equal(call.headers.get('authorization'), 'Bearer gateway-secret');
    }
  }
});

test('auto counter can use conservative bounds for an unloaded backend without leaking gateway credentials', async () => {
  const api = mock({ counter: () => response({ error: 'not loaded' }, 503) });
  const fetchImpl = async (url, init) => {
    if (url.includes('/apply-template')) throw new TypeError('fetch failed');
    return api.fetchImpl(url, init);
  };
  const compact = createChatCompactor({ fetchImpl });
  const payload = history(); payload.messages[1].content = 'old '.repeat(900); payload.messages[2].content = 'past '.repeat(500);
  const result = await compact({ model: { ...model, counter: 'auto', authorization: 'gateway',
    baseUrl: 'http://127.0.0.1:18792/api/managed-models/v1', counterBaseUrl: model.baseUrl, counterAuthorization: '' }, payload, force: true });
  assert(result.compaction.afterTokens < result.compaction.beforeTokens);
  assert(api.calls.filter(c => c.path.endsWith('/messages/count_tokens')).every(c => !c.headers.has('authorization')));
});

test('summary context-overflow responses split only the quoted data and retry within a fixed bound', async () => {
  let rejected = 0;
  const api = mock({ summary: body => {
    const piece = body.messages[1].content.split('Quoted transcript excerpt:\n')[1];
    if (Buffer.byteLength(piece) > 1200) { rejected++; return response({ error: { message: 'Context length exceeded' } }, 400); }
    return response({ choices: [{ finish_reason: 'stop', message: { content: 'The two keys are KEY-ALPHA and KEY-BETA.' } }] });
  } });
  const payload = history(); payload.messages[1].content = 'a'.repeat(1600); payload.messages[2].content = 'b'.repeat(1600);
  const result = await factory(api)({ model, payload, force: true });
  assert(rejected > 0);
  assert(result.compaction.summaryRequests <= 32);
  assert.equal(result.payload.messages.at(-1), payload.messages.at(-1));
});

test('user cancellation interrupts summary work and does not save a partial summary', async t => {
  const controller = new AbortController(), reason = new DOMException('Stopped by user', 'AbortError'), dir = folder(t);
  const api = mock({ summary: () => { controller.abort(reason); return response({ choices: [{ message: { content: 'partial' } }] }); } });
  await assert.rejects(factory(api, { dataDir: dir })({ model, payload: history(), signal: controller.signal }), e => e === reason);
  assert.equal(readdirSync(join(dir, 'chat-compaction')).length, 0);
  const small = { messages: [{ role: 'user', content: 'small' }] };
  await assert.rejects(factory(mock())({ model, payload: small, signal: controller.signal }), e => e === reason);
});

test('latest tool exchange is retained together; older tool data is quoted for summarization', async () => {
  const api = mock(), payload = history();
  payload.tools = [{ type: 'function', function: { name: 'read_file', parameters: { type: 'object', properties: {} } } }];
  payload.messages.splice(2, 0, { role: 'assistant', content: null, tool_calls: [{ id: 'old-call', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'old-call', content: 'Old tool output.' });
  const tail = [payload.messages.at(-1),
    { role: 'assistant', content: null, tool_calls: [{ id: 'new-call', type: 'function', function: { name: 'read_file', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'new-call', content: 'Current tool output must remain verbatim.' }];
  payload.messages.push(...tail.slice(1));
  const result = await factory(api)({ model, payload });
  assert.deepEqual(result.payload.messages.slice(-3), tail);
  assert.equal(result.payload.tools, payload.tools);
  assert(api.summaries().some(c => c.body.messages[1].content.includes('old-call')));
});

test('older images are explicitly marked unavailable while the latest image is preserved verbatim', async () => {
  const api = mock(), payload = history();
  payload.messages[1].content = [{ type: 'text', text: payload.messages[1].content },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,OLDIMAGE' } }];
  payload.messages.at(-1).content = [{ type: 'text', text: 'Use this newest picture.' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,NEWIMAGE' } }];
  const result = await factory(api)({ model: { ...model, imageTokens: 256 }, payload });
  assert.equal(result.payload.messages.at(-1), payload.messages.at(-1));
  assert(api.summaries().some(c => c.body.messages[1].content.includes('visual contents are unavailable')));
  assert(api.summaries().every(c => !c.body.messages[1].content.includes('OLDIMAGE')));
});

test('summaries from concurrent turns of the same chat are serialized and reused', async () => {
  const api = mock(), compact = factory(api), payload = history();
  const [first, second] = await Promise.all([compact({ model, payload, chatId: 'serial' }), compact({ model, payload, chatId: 'serial' })]);
  assert.equal(first.compaction.cached, false);
  assert.equal(second.compaction.cached, true);
  assert.equal(api.summaries().length, first.compaction.summaryRequests);
});

test('a queued turn can be cancelled immediately without releasing another turn through its predecessor', async () => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  let firstSummary = true;
  const api = mock({ summary: async () => {
    if (firstSummary) { firstSummary = false; entered(); await gate; }
    return response({ choices: [{ finish_reason: 'stop', message: { content: 'KEY-ALPHA and KEY-BETA.' } }] });
  } });
  const compact = factory(api), payload = history(), controller = new AbortController();
  const first = compact({ model, payload, chatId: 'queue' });
  await started;
  const second = compact({ model, payload, chatId: 'queue', signal: controller.signal });
  const reason = new DOMException('Stopped queued turn', 'AbortError');
  controller.abort(reason);
  await assert.rejects(second, e => e === reason);
  let thirdFinished = false;
  const third = compact({ model, payload, chatId: 'queue' }).then(result => { thirdFinished = true; return result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(thirdFinished, false);
  assert.equal(api.summaries().length, 1);
  release();
  const [a, c] = await Promise.all([first, third]);
  assert.equal(c.compaction.cached, true);
  assert.equal(api.summaries().length, a.compaction.summaryRequests);
});
