import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createModelProviders } from '../server/model-providers.mjs';
import { createChatPreparation } from '../server/chat-compaction-bridge.mjs';

const baseUrl = 'http://127.0.0.1:19091/v1';
const json = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const content = value => typeof value === 'string' ? value : Array.isArray(value) ? value.map(b => b.text ?? '').join('\n') : '';
const count = payload => {
  const messages = payload.messages.filter(m => !['system', 'developer'].includes(m.role));
  const system = payload.system ?? payload.messages.filter(m => ['system', 'developer'].includes(m.role)).map(m => content(m.content)).join('\n\n');
  return Math.max(1, Math.ceil((content(system) + messages.map(m => content(m.content)).join('\n') + JSON.stringify(payload.tools ?? [])).length / 4) + messages.length * 8);
};
const sse = rows => new Response(rows.map(row => 'data: ' + (typeof row === 'string' ? row : JSON.stringify(row)) + '\n\n').join(''),
  { headers: { 'content-type': 'text/event-stream' } });
const history = () => [
  { role: 'user', content: 'Preserve KEY-ALPHA. ' + 'old-log '.repeat(1600) },
  { role: 'assistant', content: 'Selected KEY-BETA. ' + 'details '.repeat(1600) },
];
const smallHistory = () => [{ role: 'user', content: 'KEY-ALPHA ' + 'a'.repeat(1000) }, { role: 'assistant', content: 'KEY-BETA ' + 'b'.repeat(1000) }];

function mock({ completion, summary } = {}) {
  const calls = [], completions = [], summaries = [];
  const fetchImpl = async (url, init) => {
    init.signal?.throwIfAborted();
    const payload = JSON.parse(init.body), headers = new Headers(init.headers);
    const call = { url, payload, headers }; calls.push(call);
    if (url.endsWith('/messages/count_tokens')) return json({ input_tokens: count(payload) });
    assert(url.endsWith('/chat/completions'));
    if (headers.get('x-strata-compaction') === 'summary') {
      summaries.push(call);
      assert.equal(payload.stream, false);
      if (summary) return summary(call, init);
      return json({ choices: [{ finish_reason: 'stop', message: { content: 'The conversation established KEY-ALPHA and KEY-BETA. Keep both values.' } }] });
    }
    completions.push(call);
    if (completion) return completion(call, completions.length, init);
    return sse([{ choices: [{ index: 0, delta: { content: 'KEY-ALPHA and KEY-BETA.' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: count(payload), completion_tokens: 8 } }, '[DONE]']);
  };
  return { calls, completions, summaries, fetchImpl };
}

function setup(t, api, modelOptions = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'strata-compaction-transport-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const service = createModelProviders({ directory, fetchImpl: api.fetchImpl });
  const saved = service.save({ kind: 'custom', name: 'Test local model', protocol: 'openai-chat', baseUrl,
    apiKey: 'test-only-key', models: [{ id: 'test-model', contextMax: 8192, reasoning: true, ...modelOptions }] }).connections[0];
  const selection = { connectionId: saved.id, modelId: 'test-model' };
  const preparation = () => createChatPreparation({ dataDir: directory, privateDir: () => {}, fetchImpl: api.fetchImpl });
  const frames = [];
  const preparePayload = preparation()({ chatId: 'conversation', model: { counter: 'strata' }, onFrame: f => frames.push(f) });
  return { directory, service, selection, preparation, frames, preparePayload,
    turn: { selection, history: history(), message: 'What are the two keys? Keep this request exact.', systemPrompt: 'Never invent facts.',
      thinking: 'low', onFrame: f => frames.push(f), preparePayload } };
}

test('plain provider transport compacts before streaming, reports exact tokens, and reuses persisted history after restart', async t => {
  const api = mock(), fixture = setup(t, api), original = structuredClone(fixture.turn.history);
  await fixture.service.stream(fixture.turn);
  assert(api.summaries.length > 0);
  assert.equal(api.completions.length, 1);
  const sent = api.completions[0].payload;
  assert.equal(sent.messages[0].content, fixture.turn.systemPrompt);
  assert.equal(sent.messages.at(-1).content, fixture.turn.message);
  assert.equal(sent.reasoning_effort, 'low');
  assert.equal(api.completions[0].headers.get('authorization'), 'Bearer test-only-key');
  assert.match(JSON.stringify(sent.messages), /KEY-ALPHA/);
  assert.deepEqual(fixture.turn.history, original, 'the UI transcript stays intact');
  const compacted = fixture.frames.find(f => f.type === 'compaction');
  assert.equal(compacted.afterTokens, count(sent));
  assert.equal(fixture.frames.find(f => f.type === 'context').contextTokens, count(sent));
  assert.equal(fixture.frames.find(f => f.type === 'done').tokensIn, count(sent));
  assert(fixture.frames.findIndex(f => f.type === 'compaction') < fixture.frames.findIndex(f => f.type === 'start'));
  assert.equal(fixture.frames.filter(f => f.type === 'start').length, 1);
  assert.equal(fixture.frames.filter(f => f.type === 'delta').map(f => f.text).join(''), 'KEY-ALPHA and KEY-BETA.');

  const oldSummaryRequests = api.summaries.length;
  const restart = createModelProviders({ directory: fixture.directory, fetchImpl: api.fetchImpl });
  await restart.stream({ ...fixture.turn, history: [...original, { role: 'user', content: fixture.turn.message }, { role: 'assistant', content: 'KEY-ALPHA and KEY-BETA.' }],
    message: 'Continue.', preparePayload: fixture.preparation()({ chatId: 'conversation', model: { counter: 'strata' } }) });
  assert.equal(api.summaries.length, oldSummaryRequests);
  assert.match(JSON.stringify(api.completions.at(-1).payload), /KEY-ALPHA/);
  assert.equal(api.completions.at(-1).payload.messages.at(-1).content, 'Continue.');
});

test('an upstream context rejection forces one compaction retry before any answer is emitted', async t => {
  const api = mock({ completion: (call, attempt) => attempt === 1 ? json({ error: { message: 'maximum context length exceeded' } }, 400)
    : sse([{ choices: [{ delta: { content: 'A single answer.' }, finish_reason: 'stop' }], usage: { prompt_tokens: count(call.payload), completion_tokens: 4 } }, '[DONE]']) });
  const fixture = setup(t, api);
  await fixture.service.stream({ ...fixture.turn, history: smallHistory() });
  assert.equal(api.completions.length, 2);
  assert(api.summaries.length > 0);
  assert(count(api.completions[1].payload) < count(api.completions[0].payload));
  assert.equal(fixture.frames.filter(f => f.type === 'start').length, 1);
  assert.equal(fixture.frames.filter(f => f.type === 'delta').map(f => f.text).join(''), 'A single answer.');
  assert.equal(fixture.frames.filter(f => f.type === 'done').length, 1);
});

test('a saved model output cap is reserved even when its history is well below the usual 72 percent trigger', async t => {
  const contextMax = 32768, maxOutput = 24576, slack = 1024;
  const api = mock(), fixture = setup(t, api, { contextMax, maxOutput });
  const messages = [{ role: 'user', content: 'Remember KEY-ALPHA. ' + 'a'.repeat(20000) },
    { role: 'assistant', content: 'Selected KEY-BETA. ' + 'b'.repeat(20000) }];
  const originalTokens = count({ messages: [{ role: 'system', content: fixture.turn.systemPrompt }, ...messages, { role: 'user', content: fixture.turn.message }] });
  assert(originalTokens < contextMax * 0.72, 'the percentage trigger alone would not compress this input');
  assert(originalTokens + maxOutput + slack > contextMax, 'the saved output allowance makes this input unsafe');
  await fixture.service.stream({ ...fixture.turn, history: messages });
  assert(api.summaries.length > 0);
  assert.equal(api.completions.length, 1);
  const finalTokens = count(api.completions[0].payload);
  assert(finalTokens + maxOutput + slack <= contextMax);
  assert.equal(fixture.frames.find(f => f.type === 'compaction').beforeTokens, originalTokens);
  assert.equal(fixture.frames.find(f => f.type === 'compaction').afterTokens, finalTokens);
  assert.equal(fixture.frames.find(f => f.type === 'start').contextMax, contextMax);
  assert.equal(fixture.service.resolve(fixture.selection).model.maxOutput, maxOutput);
  assert.equal(api.completions[0].payload.messages.at(-1).content, fixture.turn.message);
});

test('saved output caps also reach preparation on an upstream context retry', async t => {
  const maxOutput = 24576;
  const api = mock({ completion: (call, attempt) => attempt === 1 ? json({ error: { message: 'maximum context length exceeded' } }, 400)
    : sse([{ choices: [{ delta: { content: 'Recovered.' }, finish_reason: 'stop' }], usage: { prompt_tokens: count(call.payload), completion_tokens: 2 } }, '[DONE]']) });
  const fixture = setup(t, api, { contextMax: 32768, maxOutput }), preparationCalls = [];
  await fixture.service.stream({ ...fixture.turn, history: smallHistory(), preparePayload: async (payload, target) => {
    preparationCalls.push(target);
    return fixture.preparePayload(payload, target);
  } });
  assert.equal(preparationCalls.length, 2);
  assert.deepEqual(preparationCalls.map(c => c.maxOutput), [maxOutput, maxOutput]);
  assert.deepEqual(preparationCalls.map(c => c.force === true), [false, true]);
  assert.equal(api.completions.length, 2);
  assert.equal(fixture.frames.filter(f => f.type === 'done').length, 1);
});

for (const protocol of ['anthropic', 'openai-responses']) {
  test(`${protocol} preserves the existing recent-40 bound and flattens history pictures without invoking the OpenAI compactor`, async t => {
    const requests = [];
    const api = { fetchImpl: async (url, init) => {
      requests.push({ url, payload: JSON.parse(init.body) });
      return protocol === 'anthropic' ? sse([{ type: 'message_start', message: { usage: { input_tokens: 300 } } },
        { type: 'content_block_delta', delta: { text: 'Protocol answer.' } }, { type: 'message_delta', usage: { output_tokens: 4 } }, { type: 'message_stop' }])
        : sse([{ type: 'response.output_text.delta', delta: 'Protocol answer.' }, { type: 'response.completed', response: { usage: { input_tokens: 300, output_tokens: 4 } } }]);
    } };
    const fixture = setup(t, api, { contextMax: 32768 });
    const saved = fixture.service.list().connections[0];
    fixture.service.save({ ...saved, protocol });
    const messages = Array.from({ length: 60 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: [
      { type: 'text', text: `history-${i}` }, { type: 'image_url', image_url: { url: 'data:image/png;base64,OLD' } },
    ] }));
    await fixture.service.stream({ ...fixture.turn, history: messages, images: [{ url: 'data:image/png;base64,NEW' }],
      preparePayload: () => { throw new Error('This protocol has no OpenAI compaction adapter.'); } });
    assert.equal(requests.length, 1);
    assert.equal(new URL(requests[0].url).pathname, protocol === 'anthropic' ? '/v1/messages' : '/v1/responses');
    const sent = requests[0].payload.messages ?? requests[0].payload.input;
    assert.equal(sent.length, 41);
    assert.deepEqual(sent.slice(0, 40), messages.slice(-40).map(m => ({ role: m.role, content: m.content[0].text })));
    assert.equal(sent.at(-1).content, fixture.turn.message);
    assert(!JSON.stringify(requests[0].payload).includes('base64'));
    assert.equal(fixture.frames.filter(f => f.type === 'done').length, 1);
  });
}

test('a second context rejection stops after one retry and never emits a false start or answer', async t => {
  const api = mock({ completion: () => json({ error: { message: 'context_length exceeded' } }, 400) });
  const fixture = setup(t, api);
  await assert.rejects(fixture.service.stream({ ...fixture.turn, history: smallHistory() }), e => e.code === 'context-overflow');
  assert.equal(api.completions.length, 2);
  assert(!fixture.frames.some(f => ['start', 'delta', 'done'].includes(f.type)));
});

test('a context failure after partial streamed output is not replayed or duplicated', async t => {
  const api = mock({ completion: () => sse([{ choices: [{ delta: { content: 'Partial answer.' } }] }, { error: { message: 'context_length exceeded' } }]) });
  const fixture = setup(t, api);
  await assert.rejects(fixture.service.stream({ ...fixture.turn, history: [] }), /could not complete/);
  assert.equal(api.completions.length, 1);
  assert.equal(api.summaries.length, 0);
  assert.deepEqual(fixture.frames.filter(f => f.type === 'delta').map(f => f.text), ['Partial answer.']);
  assert(!fixture.frames.some(f => f.type === 'done'));
});

test('stopping during compression aborts the summary and never submits the original oversized history', async t => {
  const controller = new AbortController(), reason = new DOMException('Stopped by user', 'AbortError');
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  const api = mock({ summary: (_call, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }); started();
  }) });
  const fixture = setup(t, api);
  const preparePayload = fixture.preparation()({ chatId: 'cancel', signal: controller.signal, model: { counter: 'strata' }, onFrame: f => fixture.frames.push(f) });
  const turn = fixture.service.stream({ ...fixture.turn, signal: controller.signal, preparePayload });
  await pending;
  controller.abort(reason);
  await assert.rejects(turn, e => e === reason);
  assert.equal(api.completions.length, 0);
  assert(fixture.frames.some(f => f.phase === 'compacting'));
  assert(!fixture.frames.some(f => ['start', 'delta', 'done', 'compaction'].includes(f.type)));
});

test('native inference uses the same preparation and retries a pre-stream context rejection once', async t => {
  // This module reads STRATA_HOME on import. Give it an isolated store before loading it.
  const directory = mkdtempSync(join(tmpdir(), 'strata-compaction-native-'));
  const originalHome = process.env.STRATA_HOME, originalModels = process.env.STRATA_MODELS_DIR;
  process.env.STRATA_HOME = directory; process.env.STRATA_MODELS_DIR = join(directory, 'models');
  let proxyCompletion;
  try { ({ proxyCompletion } = await import('../server/inference.mjs')); }
  finally {
    if (originalHome === undefined) delete process.env.STRATA_HOME; else process.env.STRATA_HOME = originalHome;
    if (originalModels === undefined) delete process.env.STRATA_MODELS_DIR; else process.env.STRATA_MODELS_DIR = originalModels;
  }
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const api = mock({ completion: (call, attempt) => attempt === 1 ? json({ error: { message: 'maximum context length exceeded' } }, 400)
    : sse([{ choices: [{ delta: { content: 'Native answer.' }, finish_reason: 'stop' }], usage: { prompt_tokens: count(call.payload), completion_tokens: 3 } }, '[DONE]']) });
  const frames = [];
  const preparePayload = createChatPreparation({ fetchImpl: api.fetchImpl })({ chatId: 'native', model: { contextMax: 8192, counter: 'strata' }, onFrame: f => frames.push(f) });
  const originalFetch = globalThis.fetch;
  globalThis.fetch = api.fetchImpl;
  try {
    await proxyCompletion({ baseUrl, modelId: 'test-model', message: 'Keep this exact request.', history: smallHistory(),
      systemPrompt: 'Never invent facts.', authorization: 'native-test-key', extra: { max_tokens: 1024, reasoning_budget_tokens: 4096 },
      preparePayload, onFrame: f => frames.push(f) });
  } finally { globalThis.fetch = originalFetch; }
  assert.equal(api.completions.length, 2);
  assert.equal(api.completions.at(-1).payload.reasoning_budget_tokens, 4096);
  assert.equal(api.completions.at(-1).payload.max_tokens, 1024);
  assert.equal(api.completions.at(-1).payload.messages.at(-1).content, 'Keep this exact request.');
  assert.equal(frames.filter(f => f.type === 'start').length, 1);
  assert.deepEqual(frames.filter(f => f.type === 'delta').map(f => f.text), ['Native answer.']);
  assert.equal(frames.find(f => f.type === 'done').tokensIn, frames.find(f => f.type === 'compaction').afterTokens);
});
