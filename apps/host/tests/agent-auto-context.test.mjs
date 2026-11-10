import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasKnownContext, needsContextRecovery, recoverContext, MAX_CONTEXT_RECOVERIES } from '../server/agent/auto-context.mjs';
import { createAgentBridge } from '../server/agent/agent-bridge.mjs';
import { resolveHarness } from '../server/agent/harness-runtime.mjs';
import { startScriptedWorker } from './helpers/scripted-worker.mjs';

test('automatic recovery uses known capacity, silent pressure, or an actual context overflow', () => {
  assert.equal(hasKnownContext({ kind: 'local', contextWindow: 131072 }), true);
  assert.equal(hasKnownContext({ kind: 'api', contextWindow: 131072 }), false);
  assert.equal(hasKnownContext({ kind: 'api', contextWindow: 131072, contextKnown: true }), true);
  const pressure = { ended: { kind: 'completed' }, wrote: false, tokens: 9300, window: 10000 };
  assert.equal(needsContextRecovery(pressure), true);
  assert.equal(needsContextRecovery({ ...pressure, wrote: true }), false, 'a complete answer does not get continued');
  assert.equal(needsContextRecovery({ ...pressure, window: 0 }), false);
  assert.equal(needsContextRecovery({ ...pressure, ended: { kind: 'cancelled' } }), false);
  assert.equal(needsContextRecovery({ ended: { kind: 'error', error: { message: 'request exceeds the context window' } }, wrote: true }), true);
  assert.equal(needsContextRecovery({ ended: { kind: 'error', error: { message: 'network unavailable' } } }), false);
});

const reduced = () => ({ ok: true, before: { tokens: 12000 }, after: { tokens: 3000 } });
test('recovery resumes only after measurable reduction and is bounded', async () => {
  const state = {}; let resumed = 0, compacted = 0;
  const options = { state, compact: async () => { compacted++; return reduced(); }, resume: async () => { resumed++; } };
  for (let i = 0; i < MAX_CONTEXT_RECOVERIES; i++) assert.equal((await recoverContext(options)).resumed, true);
  assert.equal((await recoverContext(options)).reason, 'limited');
  assert.equal(resumed, MAX_CONTEXT_RECOVERIES); assert.equal(compacted, MAX_CONTEXT_RECOVERIES);
  for (const result of [{ ok: false }, { ok: true }, { ok: true, before: { tokens: 1000 }, after: { tokens: 1000 } }]) {
    const out = await recoverContext({ state: {}, compact: async () => result, resume: async () => assert.fail('must not resume') });
    assert.equal(out.reason, 'no-progress');
  }
});

test('manual stop and simultaneous settlement cannot queue another prompt', async () => {
  let release, stopped = false;
  const state = {};
  const options = { state, stopped: () => stopped, compact: () => new Promise(resolve => { release = resolve; }), resume: async () => assert.fail('must not resume') };
  const first = recoverContext(options);
  assert.equal((await recoverContext(options)).reason, 'limited');
  stopped = true; release(reduced());
  assert.equal((await first).reason, 'stopped');
  assert.equal(state.running, false);
  assert.equal((await recoverContext(options)).reason, 'limited');
});

test('a failed compaction is not a retry loop', async () => {
  const state = {};
  const result = await recoverContext({ state, compact: async () => { throw new Error('offline'); }, resume: async () => assert.fail('must not resume') });
  assert.equal(result.reason, 'failed'); assert.equal(state.running, false); assert.equal(state.attempts, 1);
});

const skip = !process.env.STRATA_HARNESS_DIR || !resolveHarness({ env: process.env }).ok ? 'STRATA_HARNESS_DIR is not set to a built Harness' : false;
async function rig(t, api, chunkDelayMs = 5) {
  const worker = await startScriptedWorker({ chunkDelayMs });
  const dir = mkdtempSync(join(tmpdir(), 'strata-auto-context-'));
  const ws = join(dir, 'ws'); mkdirSync(ws);
  const local = [{ id: 'i', label: 'Scripted', baseUrl: worker.url, modelId: 'scripted-model', context: 32768 }];
  const connections = api ? [{ id: 'managed', name: 'Managed model', baseUrl: worker.url, protocol: 'openai-chat', models: [{ id: 'scripted-model', contextMax: 32768 }] }] : [];
  const bridge = createAgentBridge({ dataDir: dir, localInstances: () => api ? [] : local, connections: () => connections, env: process.env, startTimeoutMs: 90_000 });
  t.after(async () => { await bridge.close(); await worker.close(); try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* Windows sandbox cleanup is best effort */ } });
  return { bridge, worker, options: { chatId: 'recover', workspacePath: ws, mode: 'bypass', choice: api ? { connectionId: 'managed', modelId: 'scripted-model' } : null } };
}

for (const api of [false, true]) test(`a silent full ${api ? 'managed API' : 'local'} turn compresses and answers in the same UI turn`, { skip, timeout: 120_000 }, async t => {
  const r = await rig(t, api), frames = [];
  await r.bridge.runTurn({ ...r.options, message: `SCRIPT:contextrecover 32000\n${'alpha '.repeat(8000)}`, onFrame: frame => frames.push(frame) });
  assert.ok(r.worker.requests.some(q => q.summary), 'the history was summarized');
  assert.equal(r.worker.requests.filter(q => q.contextContinued).length, 1, 'one continuation, with no original message replay');
  assert.match(frames.filter(f => f.type === 'delta').map(f => f.text).join(''), /Continued after automatic context compression/);
  assert.equal(frames.filter(f => f.type === 'done').length, 1, 'one UI turn');
  assert.equal(frames.at(-1).type, 'done');
  assert.equal(frames.filter(f => f.type === 'error').length, 0);
});

test('Stop during automatic compression never queues the continuation', { skip, timeout: 120_000 }, async t => {
  const r = await rig(t, false, 400), frames = []; let stopped = false;
  await r.bridge.runTurn({ ...r.options, message: `SCRIPT:contextrecover 32000\n${'alpha '.repeat(8000)}`, onFrame: frame => {
    frames.push(frame);
    if (!stopped && frame.type === 'status' && frame.phase === 'compacting') { stopped = true; void r.bridge.stop('recover'); }
  } });
  assert.equal(stopped, true);
  assert.equal(r.worker.requests.filter(q => q.contextContinued).length, 0);
  assert.equal(frames.at(-1).type, 'done');
  assert.equal(frames.at(-1).cancelled, true);
});

test('automatic continuation does not repeat a completed command', { skip, timeout: 120_000 }, async t => {
  const r = await rig(t, false), frames = [];
  await r.bridge.runTurn({ ...r.options, message: `SCRIPT:contextrecovertool\n${'alpha '.repeat(8000)}`, onFrame: frame => frames.push(frame) });
  assert.equal(readFileSync(join(r.options.workspacePath, 'once.txt'), 'utf8').trim(), 'completed');
  assert.equal(r.worker.requests.filter(q => q.contextContinued).length, 1);
  assert.equal(frames.filter(f => f.type === 'agent-tool' && f.tool.state === 'done').length, 1);
  assert.match(frames.filter(f => f.type === 'delta').map(f => f.text).join(''), /Continued after automatic context compression/);
  assert.equal(frames.at(-1).type, 'done');
});

test('Stop during preflight compression cancels before the new message is submitted', { skip, timeout: 120_000 }, async t => {
  const r = await rig(t, false, 400);
  // Fill a durable session without making the first answer itself need recovery.
  for (let i = 0; i < 2; i++) await r.bridge.runTurn({ ...r.options, message: `SCRIPT:echo part${i} ${'alpha '.repeat(2000)}`, onFrame: () => {} });
  const frames = []; let stopped = false;
  await r.bridge.runTurn({ ...r.options, message: `SCRIPT:echo NEVER_SUBMITTED ${'beta '.repeat(8000)}`, onFrame: frame => {
    frames.push(frame);
    if (!stopped && frame.type === 'status' && frame.phase === 'compacting') { stopped = true; void r.bridge.stop('recover'); }
  } });
  assert.equal(stopped, true);
  assert.equal(frames.at(-1).cancelled, true);
  assert.ok(r.worker.requests.every(q => !q.raw.includes('NEVER_SUBMITTED')));
});
