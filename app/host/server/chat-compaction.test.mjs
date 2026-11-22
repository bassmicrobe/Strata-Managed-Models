import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
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

test('an unavailable cache directory leaves safe in-memory compaction available instead of failing host startup', async t => {
  const directory = folder(t), blocked = join(directory, 'chat-compaction'), reports = [], api = mock();
  writeFileSync(blocked, 'This existing file must remain intact.');
  const compact = factory(api, { dataDir: directory, report: r => reports.push(r) }), payload = history();
  const first = await compact({ model, payload, chatId: 'memory-only' });
  assert.equal(first.compaction.persisted, false);
  assert(first.compaction.afterTokens < first.compaction.beforeTokens);
  const n = api.summaries().length;
  const next = await compact({ model, payload, chatId: 'memory-only' });
  assert.equal(next.compaction.cached, true);
  assert.equal(api.summaries().length, n);
  assert.equal(readFileSync(blocked, 'utf8'), 'This existing file must remain intact.');
  assert(reports.some(r => r.status === 'compaction-cache-unavailable'));
});

test('a cache ACL failure disables disk reads and writes without preventing safe compaction', async t => {
  const directory = folder(t), api = mock(), reports = [];
  const compact = factory(api, { dataDir: directory,
    privateDir: () => { throw new Error('Cannot apply private directory permissions'); }, report: r => reports.push(r) });
  const result = await compact({ model, payload: history(), chatId: 'no-private-cache' });
  assert.equal(result.compaction.persisted, false);
  assert(result.compaction.afterTokens < result.compaction.beforeTokens);
  assert.deepEqual(readdirSync(join(directory, 'chat-compaction')), []);
  assert(reports.some(r => r.status === 'compaction-cache-unavailable'));
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

test('a model that only remembers its current excerpt cannot overwrite earlier requirements', async () => {
  const payload = history();
  payload.messages[1].content = 'The user requires CONDITION_FIRST.\n' + 'old-log '.repeat(1600);
  payload.messages[2].content = 'Recorded CONDITION_MIDDLE.\n' + 'details '.repeat(1600);
  const api = mock({ summary: body => {
    const excerpt = body.messages[1].content.split('Quoted transcript excerpt:\n')[1];
    assert(!body.messages[1].content.includes('Previous summary:'), 'later pieces must not rewrite earlier notes');
    const facts = [...excerpt.matchAll(/CONDITION_(?:FIRST|MIDDLE)/g)].map(m => m[0]);
    return response({ choices: [{ finish_reason: 'stop', message: { content: facts.length ? facts.join('; ') : 'Observed work: completed checks.' } }] });
  } });
  const result = await factory(api)({ model, payload });
  const input = JSON.stringify(result.payload.messages);
  assert.match(input, /CONDITION_FIRST/);
  assert.match(input, /CONDITION_MIDDLE/);
  assert(api.summaries().length > 2);
});

test('incremental compaction appends new sections and keeps saved earlier conditions verbatim after restart', async t => {
  const directory = folder(t), api = mock({ summary: () => response({ choices: [{ finish_reason: 'stop', message: {
    content: JSON.stringify({ requirements: 'Keep KEY-ALPHA.', observations: 'The selected value is KEY-BETA.', unresolved: '' }),
  } }] }) }), payload = history();
  await factory(api, { dataDir: directory })({ model, payload, chatId: 'incremental' });
  const file = join(directory, 'chat-compaction', readdirSync(join(directory, 'chat-compaction'))[0]);
  const first = JSON.parse(readFileSync(file, 'utf8'));
  const next = structuredClone(payload);
  next.messages.push({ role: 'assistant', content: 'Acknowledged.' },
    { role: 'user', content: 'The user additionally requires NEW-CONDITION. ' + 'later '.repeat(5000) },
    { role: 'assistant', content: 'progress '.repeat(400) }, { role: 'user', content: 'Continue with all requirements.' });
  const later = mock({ summary: () => response({ choices: [{ finish_reason: 'stop', message: {
    content: JSON.stringify({ requirements: 'NEW-CONDITION applies.', observations: 'More checks completed.', unresolved: '' }),
  } }] }) });
  const result = await factory(later, { dataDir: directory })({ model, payload: next, chatId: 'incremental' });
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert(saved.end > first.end);
  assert.deepEqual(saved.sections.slice(0, first.sections.length), first.sections);
  assert.match(JSON.stringify(result.payload.messages), /KEY-ALPHA/);
  assert.match(JSON.stringify(result.payload.messages), /NEW-CONDITION/);
  assert(later.summaries().every(call => !call.body.messages[1].content.includes('KEY-ALPHA')),
    'an unrelated new excerpt never gets authority to rewrite old requirements');
});

test('later user corrections stay later than the requirements they replace', async () => {
  const payload = history();
  payload.messages[1].content = 'User decision: release requires 17 passing tests.\n' + 'logs '.repeat(2000);
  payload.messages[2].content = 'The assistant observed 37 completed diagnostics.\n' + 'details '.repeat(1500);
  payload.messages.splice(3, 0, { role: 'user', content: 'Explicit correction: release now requires 19 passing tests.\n' + 'new logs '.repeat(1500) },
    { role: 'assistant', content: 'Acknowledged the correction.' });
  const api = mock({ summary: body => {
    const excerpt = body.messages[1].content.split('Quoted transcript excerpt:\n')[1];
    const facts = [];
    if (excerpt.includes('17 passing tests')) facts.push('User decision: 17 passing tests.');
    if (excerpt.includes('19 passing tests')) facts.push('Later user correction: 19 passing tests.');
    return response({ choices: [{ finish_reason: 'stop', message: { content: facts.join(' ') || 'Observed work: completed diagnostics.' } }] });
  } });
  const result = await factory(api)({ model, payload });
  const input = result.payload.messages.map(m => text(m.content)).join('\n');
  assert(input.indexOf('17 passing tests') >= 0);
  assert(input.indexOf('19 passing tests') > input.indexOf('17 passing tests'));
  assert.match(input, /Newer explicit user corrections supersede earlier user requirements/);
  assert.match(input, /assistant claims and tool observations do not themselves change user requirements/);
});

test('old rolling-summary caches cannot hide facts lost before the new policy', async t => {
  const directory = folder(t), api = mock(), payload = history(), chatId = 'old-cache';
  const compact = factory(api, { dataDir: directory });
  const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
  const scope = digest([2, chatId, model.id, model.baseUrl]);
  const old = { version: 1, end: 2, hash: digest([[payload.messages[0]], payload.messages.slice(1, 3)]),
    summary: 'Only the last batch remains. LOST-EARLIER-FACTS.', at: Date.now() };
  writeFileSync(join(directory, 'chat-compaction', scope + '.json'), JSON.stringify(old));
  const result = await compact({ model, payload, chatId });
  assert(api.summaries().length > 0, 'old checkpoint must be rebuilt from original history');
  assert.match(JSON.stringify(result.payload.messages), /KEY-ALPHA/);
  assert(!JSON.stringify(result.payload.messages).includes('LOST-EARLIER-FACTS'));
  const saved = JSON.parse(readFileSync(join(directory, 'chat-compaction', scope + '.json'), 'utf8'));
  assert.equal(saved.version, 2); assert(saved.sections.length > 0);
});

test('oversized assembled checkpoints shrink individual sections without dropping any source condition', async t => {
  let next = 0, shortened = 0;
  const api = mock({ summary: body => {
    const text = body.messages[1].content;
    if (text.includes('Quoted checkpoint section:\n')) {
      shortened++;
      return response({ choices: [{ finish_reason: 'stop', message: { content: text.match(/KEEP_\d+/)[0] + ' remains a user requirement.' } }] });
    }
    return response({ choices: [{ finish_reason: 'stop', message: { content: `KEEP_${++next} is required. ` + 'Repeated observations. '.repeat(650) } }] });
  } });
  const directory = folder(t), result = await factory(api, { dataDir: directory })({ model, payload: history(), chatId: 'growth' });
  const input = JSON.stringify(result.payload.messages);
  for (let i = 1; i <= next; i++) assert(input.includes(`KEEP_${i} `), `source condition ${i} was lost`);
  assert(shortened > 0);
  assert(result.compaction.afterTokens + 1024 + 256 <= model.contextMax);
  const saved = JSON.parse(readFileSync(join(directory, 'chat-compaction', readdirSync(join(directory, 'chat-compaction'))[0]), 'utf8'));
  assert.equal(saved.sections.length, next);
  assert.equal(new Set(saved.sections.map(s => s.id)).size, next);
  assert(saved.summary.length <= 48000);
});

test('failed or cancelled checkpoint shrinking leaves the earlier valid cache intact', async t => {
  for (const cancel of [false, true]) {
    const directory = folder(t), initial = mock(), payload = history(), chatId = 'growth-transaction';
    await factory(initial, { dataDir: directory })({ model, payload, chatId });
    const file = join(directory, 'chat-compaction', readdirSync(join(directory, 'chat-compaction'))[0]);
    const before = readFileSync(file, 'utf8'), controller = new AbortController();
    const reason = new DOMException('Stopped checkpoint shrinking', 'AbortError');
    const next = structuredClone(payload);
    next.messages.push({ role: 'assistant', content: 'Acknowledged.' }, { role: 'user', content: 'More work. ' + 'later '.repeat(5000) },
      { role: 'assistant', content: 'progress '.repeat(400) }, { role: 'user', content: 'Continue.' });
    const api = mock({ summary: body => {
      if (body.messages[1].content.includes('Quoted checkpoint section:\n')) {
        if (cancel) controller.abort(reason);
        return response({ choices: [{ finish_reason: 'length', message: { content: 'An incomplete checkpoint.' } }] });
      }
      return response({ choices: [{ finish_reason: 'stop', message: { content: 'New requirement. ' + 'Huge observations. '.repeat(800) } }] });
    } });
    await assert.rejects(factory(api, { dataDir: directory })({ model, payload: next, chatId, signal: controller.signal }),
      error => cancel ? error === reason : error.code === 'context-compaction-insufficient-room');
    assert.equal(readFileSync(file, 'utf8'), before, 'never publish a partial or incomplete replacement');
  }
});

test('explicit requirements are retrieved after observations without treating diagnostic numbers as requirements', async () => {
  const api = mock({ summary: body => {
    const excerpt = body.messages[1].content.split('Quoted transcript excerpt:\n')[1];
    const note = { requirements: excerpt.includes('KEY-ALPHA') ? 'User requires KEY-ALPHA.' : '',
      observations: 'The assistant observed 37 diagnostic records.', unresolved: 'Check the remaining work.' };
    return response({ choices: [{ finish_reason: 'stop', message: { content: '```json\n' + JSON.stringify(note) + '\n```' } }] });
  } });
  const payload = history(), result = await factory(api)({ model, payload });
  const input = result.payload.messages[1].content;
  const ledger = input.lastIndexOf('User requirements and decisions, in chronological order.');
  assert(ledger > input.lastIndexOf('37 diagnostic records'));
  assert(input.indexOf('User requires KEY-ALPHA.') > ledger);
  assert.equal(input.match(/User requires KEY-ALPHA\./g).length, 1, 'requirements must not be buried in duplicated observations');
  assert.equal(result.payload.messages.at(-1), payload.messages.at(-1));
});

test('plain or incorrectly typed structured responses remain unclassified history instead of becoming invented requirements', async () => {
  const variants = ['Requirements stay in this plain note.', '{"requirements":["not a string"],"observations":"37 diagnostics","unresolved":""}',
    '{"requirements":"unfinished JSON'];
  for (const content of variants) {
    const api = mock({ summary: () => response({ choices: [{ finish_reason: 'stop', message: { content } }] }) });
    const result = await factory(api)({ model, payload: history() });
    const input = result.payload.messages[1].content;
    assert(input.includes(content));
    assert(input.includes('Unclassified history note:'));
    assert(!input.includes('User requirements and decisions, in chronological order.'));
  }
});

test('shrinking observations preserves exact requirements and source ordering even if the shortening model does not know them', async t => {
  let n = 0, shrunk = 0;
  const requirements = [];
  const api = mock({ summary: body => {
    let note;
    if (body.messages[1].content.includes('Quoted checkpoint section:\n')) {
      const excerpt = JSON.parse(body.messages[1].content.split('Quoted checkpoint section:\n')[1]);
      assert(!Object.hasOwn(excerpt, 'requirements'), 'the shortening model never gets to rewrite requirements');
      shrunk++;
      note = { observations: 'Recorded work completed.', unresolved: 'Run the pending check.' };
    } else {
      const requirement = `条件${++n}: keep exact value 17, path src/check-${n}.mjs, and --no-delete.\nThis remains mandatory.`;
      requirements.push(requirement);
      note = { requirements: requirement, observations: 'Repeated diagnostic observation. '.repeat(450), unresolved: 'Run the pending check.' };
    }
    return response({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(note) } }] });
  } });
  const directory = folder(t), result = await factory(api, { dataDir: directory })({ model, payload: history(), chatId: 'immutable-requirements' });
  const file = join(directory, 'chat-compaction', readdirSync(join(directory, 'chat-compaction'))[0]);
  const saved = JSON.parse(readFileSync(file, 'utf8'));
  assert(shrunk > 0);
  assert.deepEqual(saved.sections.map(section => section.requirements), requirements);
  const input = result.payload.messages[1].content;
  let last = -1;
  for (const requirement of requirements) {
    const position = input.indexOf(requirement);
    assert(position > last); last = position;
  }
  assert(result.compaction.afterTokens + 1024 + 256 <= model.contextMax);
});

test('requirements that cannot fit produce a controlled failure without rewriting or silently dropping them', async t => {
  const directory = folder(t), api = mock({ summary: body => {
    assert(!body.messages[1].content.includes('Quoted checkpoint section:'), 'immutable requirements cannot be shortened');
    return response({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      requirements: 'Every explicit condition must be preserved. '.repeat(400), observations: '', unresolved: '',
    }) } }] });
  } });
  await assert.rejects(factory(api, { dataDir: directory })({ model, payload: history() }), error => error.code === 'context-compaction-insufficient-room');
  assert.equal(readdirSync(join(directory, 'chat-compaction')).length, 0);
});

test('a late condition in a split user message retains its role separately from following assistant output', async () => {
  const payload = history();
  payload.messages[1].content = 'filler '.repeat(3800) + 'The release requires EXACT-LATE-CONDITION.';
  payload.messages[2].content = 'Assistant observation: 37 diagnostics completed.';
  let found = false;
  const api = mock({ summary: body => {
    const excerpt = body.messages[1].content.split('Quoted transcript excerpt:\n')[1];
    if (excerpt.includes('EXACT-LATE-CONDITION')) {
      found = true;
      assert.match(excerpt, /\[Original message 1; role "user"; continued fragment\]/);
      assert(excerpt.indexOf('role "user"') < excerpt.indexOf('EXACT-LATE-CONDITION'));
      assert(excerpt.indexOf('role "assistant"') > excerpt.indexOf('EXACT-LATE-CONDITION'));
    }
    return response({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({
      requirements: excerpt.includes('EXACT-LATE-CONDITION') ? 'The release requires EXACT-LATE-CONDITION.' : '',
      observations: 'Diagnostics observed.', unresolved: '',
    }) } }] });
  } });
  const result = await factory(api)({ model, payload });
  assert(found);
  assert.match(result.payload.messages[1].content, /The release requires EXACT-LATE-CONDITION/);
});

test('a later plain-text correction remains after earlier structured requirements in the final ledger', async () => {
  const payload = history();
  payload.messages[1].content = 'Release requires 17 passing tests.\n' + 'old logs '.repeat(1500);
  payload.messages[2].content = 'Observed diagnostics.\n' + 'details '.repeat(1500);
  payload.messages.splice(3, 0, { role: 'user', content: 'Explicit correction: release now requires 19 passing tests.\n' + 'later logs '.repeat(1800) },
    { role: 'assistant', content: 'Acknowledged.' });
  const api = mock({ summary: body => {
    const excerpt = body.messages[1].content.split('Quoted transcript excerpt:\n')[1];
    const content = excerpt.includes('19 passing tests') ? 'Explicit user correction: release now requires 19 passing tests.'
      : JSON.stringify({ requirements: excerpt.includes('17 passing tests') ? 'Release requires 17 passing tests.' : '',
        observations: 'Diagnostics observed.', unresolved: '' });
    return response({ choices: [{ finish_reason: 'stop', message: { content } }] });
  } });
  const result = await factory(api)({ model, payload });
  const summary = result.payload.messages[1].content;
  assert(summary.includes('17 passing tests'));
  assert(summary.indexOf('19 passing tests') > summary.indexOf('17 passing tests'));
  assert(summary.indexOf('Unclassified history note:') > summary.indexOf('17 passing tests'));
});
