import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// Keep the HTTP/store tests independent of a browser or this PC's running models.
const result = await build({
    entryPoints: [fileURLToPath(new URL('../src/lib/managed-models.ts', import.meta.url))],
    bundle: true, write: false, format: 'esm', platform: 'node',
    plugins: [{ name: 'react-hook-stub', setup(builder) {
        builder.onResolve({ filter: /^react$/ }, () => ({ path: 'react', namespace: 'hook-stub' }));
        builder.onLoad({ filter: /.*/, namespace: 'hook-stub' }, () => ({ contents: 'export function useSyncExternalStore(_subscribe, read) { return read(); }', loader: 'js' }));
    } }],
});
const moduleURL = `data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`;
let instance = 0;
const fresh = () => import(`${moduleURL}#${instance++}`);
const snapshot = (extra = {}) => ({ enabled: true, connectionId: 'kept-provider-id', models: [{ id: 'sc117', modelId: 'sc117-api', label: 'SC117 IQ3_S' }], activeId: null, targetId: null, switching: false, phase: 'ready', error: null, activeRequests: 0, queuedRequests: 0, ...extra });
const reply = (value, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

test('concurrent readers share one request and hosts without the endpoint remain disabled', async t => {
    const previous = globalThis.fetch;
    t.after(() => { globalThis.fetch = previous; });
    let calls = 0, release;
    globalThis.fetch = () => { calls++; return new Promise(resolve => { release = resolve; }); };
    const client = await fresh();
    const first = client.refreshManagedModels(), second = client.refreshManagedModels();
    assert.equal(first, second);
    assert.equal(calls, 1);
    release(new Response('Not found', { status: 404 }));
    assert.equal((await first).enabled, false);
});

test('switch POST carries the mutation header and resolves only after the host reports readiness', async t => {
    const previous = globalThis.fetch;
    t.after(() => { globalThis.fetch = previous; });
    const calls = [];
    let ready;
    globalThis.fetch = async (url, options) => {
        calls.push({ url, options });
        if (options.method === 'POST') return reply(snapshot({ targetId: 'sc117', switching: true, phase: 'loading' }), 202);
        return new Promise(resolve => { ready = () => resolve(reply(snapshot({ activeId: 'sc117' }))); });
    };
    const client = await fresh();
    let finished = false;
    const operation = client.switchManagedModel('sc117').then(value => { finished = true; return value; });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls[0].url, '/api/managed-models/switch');
    assert.equal(calls[0].options.headers['x-strata-client'], 'managed-model-picker');
    assert.deepEqual(JSON.parse(calls[0].options.body), { id: 'sc117' });
    assert.equal(finished, false);
    ready();
    assert.equal((await operation).activeId, 'sc117');
    assert.equal(finished, true);
});

test('a host load failure rejects instead of selecting the requested API name', async t => {
    const previous = globalThis.fetch;
    t.after(() => { globalThis.fetch = previous; });
    globalThis.fetch = async (_url, options) => options.method === 'POST'
        ? reply(snapshot({ targetId: 'sc117', switching: true, phase: 'loading' }), 202)
        : reply(snapshot({ error: 'The model process exited.', phase: 'error' }));
    const client = await fresh();
    await assert.rejects(client.switchManagedModel('sc117'), /model process exited/);
});

test('active, queued, loading and maintenance states all block a manual switch', async () => {
    const client = await fresh();
    assert.equal(client.managedModelsBusy(snapshot()), false);
    for (const busy of [{ activeRequests: 1 }, { queuedRequests: 1 }, { switching: true }, { maintenance: true }]) assert.equal(client.managedModelsBusy(snapshot(busy)), true);
    assert.match(client.managedModelPhase('loading'), /読み込/);
});
