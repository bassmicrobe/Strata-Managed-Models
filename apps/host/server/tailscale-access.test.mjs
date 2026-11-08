import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createServer } from 'node:net';
import { request as httpRequest } from 'node:http';
import { fileURLToPath } from 'node:url';
import { createTailscaleAccess, parseTailscaleOrigin } from './tailscale-access.mjs';

const origin = 'https://strata.example-tailnet.ts.net';
const request = ({ value = origin, host = '127.0.0.1:8791', remote = '127.0.0.1', headers = {} } = {}) => ({
  headers: { origin: value, host, ...headers }, socket: { remoteAddress: remote },
});

test('configuration accepts one HTTPS Tailscale origin and rejects wildcard, insecure and malformed values', () => {
  assert.equal(parseTailscaleOrigin(undefined), null);
  assert.equal(parseTailscaleOrigin(''), null);
  assert.equal(parseTailscaleOrigin(origin), origin);
  assert.equal(parseTailscaleOrigin(origin + ':8443'), origin + ':8443');
  assert.equal(parseTailscaleOrigin(origin + ':443'), origin);
  for (const bad of ['http://strata.example-tailnet.ts.net', 'https://ts.net', 'https://example.com', origin + '/', origin + '/chat', origin + '?x=1', origin + '#x', 'https://user@strata.example-tailnet.ts.net', 'https://user:pass@strata.example-tailnet.ts.net', 'https://*.example-tailnet.ts.net', 'https://a..ts.net', 'https://a-.ts.net', 'https://a.ts.net.evil.example', origin + ':0', origin + ':65536', origin + ' ', origin + '\\elsewhere', 'null', [origin]]) {
    assert.throws(() => parseTailscaleOrigin(bad), /STRATA_TAILSCALE_ORIGIN/, String(bad));
  }
  assert.throws(() => createTailscaleAccess({ origin, port: 0 }), /port/);
});

test('the opted-in origin accepts only a loopback proxy and an approved public or actual backend Host', () => {
  const access = createTailscaleAccess({ origin, port: 8791 });
  for (const remote of ['127.0.0.1', '127.0.0.2', '::1', '::ffff:127.0.0.1']) {
    for (const host of ['strata.example-tailnet.ts.net', 'strata.example-tailnet.ts.net:443', '127.0.0.1:8791', 'localhost:8791', '[::1]:8791']) {
      assert.equal(access.allows(request({ host, remote })), true, remote + ' ' + host);
    }
  }
  const otherPort = createTailscaleAccess({ origin: origin + ':8443', port: 8791 });
  assert(otherPort.allows(request({ value: origin + ':8443', host: 'strata.example-tailnet.ts.net:8443' })));
  assert.equal(otherPort.allows(request()), false);
});

test('another origin, Host or remote socket cannot borrow the Tailscale exception through forwarded headers', () => {
  const access = createTailscaleAccess({ origin, port: 8791 });
  for (const value of [undefined, null, 'null', origin + '/', origin + ':8443', 'http://strata.example-tailnet.ts.net', 'https://other.example-tailnet.ts.net', origin + '.evil.example', [origin]]) {
    assert.equal(access.allows({ ...request(), headers: { ...request().headers, origin: value } }), false, String(value));
  }
  for (const host of ['elsewhere.ts.net', 'strata.example-tailnet.ts.net:8443', '127.0.0.1:8792', 'localhost', '0.0.0.0:8791', 'strata.example-tailnet.ts.net/anything', 'user@strata.example-tailnet.ts.net', 'strata.example-tailnet.ts.net\\elsewhere', '', ['strata.example-tailnet.ts.net']]) {
    assert.equal(access.allows(request({ host })), false, String(host));
  }
  for (const remote of ['100.64.0.1', '192.168.1.2', '::ffff:192.168.1.2', '2001:db8::1', undefined, '127.0.0.999', 'localhost']) {
    const req = request({ headers: { 'x-forwarded-for': '127.0.0.1', 'x-forwarded-host': '127.0.0.1:8791', 'tailscale-user-login': 'fixture@example.com' } });
    req.socket.remoteAddress = remote;
    assert.equal(access.allows(req), false, String(remote));
  }
});

test('without an explicit origin no request obtains the proxy exception', () => {
  const access = createTailscaleAccess({ port: 8791 });
  assert.equal(access.origin, null);
  assert.equal(access.allows(request()), false);
  assert.equal(access.allows(request({ value: 'http://127.0.0.1:8791' })), false);
  assert.equal(access.allowsBrowser(request({ value: 'http://127.0.0.1:8791' })), false);
});

test('configured browser access permits the actual HTTP local UI and rejects another local port, protocol, Host or peer', () => {
  const access = createTailscaleAccess({ origin, port: 8791 });
  assert(access.allowsBrowser(request()));
  for (const host of ['127.0.0.1:8791', 'localhost:8791', '[::1]:8791']) {
    assert(access.allowsBrowser(request({ value: 'http://' + host, host })));
  }
  for (const value of ['http://127.0.0.1:8792', 'http://localhost:8792', 'https://127.0.0.1:8791', 'http://127.0.0.1:8791/', 'http://user@127.0.0.1:8791', 'http://127.0.0.1:8791.evil.example', 'null', 'not a URL']) {
    assert.equal(access.allowsBrowser(request({ value })), false, value);
  }
  assert.equal(access.allowsBrowser(request({ value: 'http://127.0.0.1:8791', host: 'strata.example-tailnet.ts.net' })), false);
  assert.equal(access.allowsBrowser(request({ value: 'http://127.0.0.1:8791', remote: '100.64.0.1' })), false);
});

const delay = ms => new Promise(done => setTimeout(done, ms));
function hostRequest(address, { method = 'GET', headers, body } = {}) {
  // Node fetch replaces Host with its URL authority; use HTTP directly to exercise both Serve Host forms.
  return new Promise((done, bad) => {
    const req = httpRequest(address, { method, headers }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', bad);
      res.on('end', () => done({ status: res.statusCode, text: async () => Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', bad);
    req.setTimeout(5000, () => req.destroy(new Error('The isolated host request timed out.')));
    req.end(body);
  });
}
async function freePort() {
  const server = createServer();
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  const port = server.address().port;
  await new Promise(done => server.close(done));
  return port;
}
async function hostFixture(t, configuredOrigin) {
  const home = await mkdtemp(join(tmpdir(), 'strata-tailscale-test-'));
  const port = await freePort(), root = fileURLToPath(new URL('..', import.meta.url));
  const env = {
    ...process.env, STRATA_HOME: home, STRATA_DATA_DIR: home, STRATA_MODELS_DIR: join(home, 'models'), STRATA_WORKSPACE: join(home, 'work'),
    STRATA_SETTINGS_FILE: join(home, 'settings.json'), STRATA_COMPONENTS_DIR: join(home, 'components'), STRATA_CONTROL_DIR: join(home, 'no-control'),
    STRATA_HARNESS_DIR: join(home, 'no-harness'), STRATA_NATIVE_REPO: join(home, 'no-repo'), STRATA_PORT: String(port),
    STRATA_SHARE_PORT: String(await freePort()), STRATA_TUNNEL_PORT: String(await freePort()), STRATA_BIND: '127.0.0.1',
    STRATA_REAL_ENGINE: '0', STRATA_AGENT: 'off', STRATA_NO_ACQUIRE: '1', STRATA_NO_BUNDLED_ENGINE: '1', STRATA_NO_REPAIR_ACCESS: '1',
    STRATA_CLOUDFLARED_SEARCH: 'own', STRATA_MANAGED_MODELS_CONFIG: '', STRATA_UPDATE_MAINTENANCE_FILE: '', STRATA_TAILSCALE_ORIGIN: configuredOrigin ?? '',
    LOCALAPPDATA: join(home, 'Local'), APPDATA: join(home, 'Roaming'), XDG_DATA_HOME: join(home, 'xdg-data'), XDG_STATE_HOME: join(home, 'xdg-state'), XDG_CONFIG_HOME: join(home, 'xdg-config'),
  };
  const child = spawn(process.execPath, ['server/index.mjs'], { cwd: root, env, windowsHide: true, stdio: 'ignore' });
  const exited = once(child, 'exit');
  t.after(async () => {
    if (child.exitCode === null) child.kill();
    await exited;
    // This test owns exactly the random directory made above, never an installed profile.
    assert.equal(dirname(resolve(home)), resolve(tmpdir()));
    assert.match(basename(home), /^strata-tailscale-test-/);
    await rm(home, { recursive: true, force: true });
  });
  const base = 'http://127.0.0.1:' + port;
  for (let n = 0; n < 150; n++) {
    try { if ((await fetch(base + '/api/health')).ok) return { base, port }; } catch {}
    if (child.exitCode !== null) break;
    await delay(100);
  }
  throw new Error('The isolated Tailscale test host did not start.');
}

test('the actual host permits the approved Serve origin for host APIs and the managed-switch guard, preserving local checks', { timeout: 30000 }, async t => {
  const { base, port } = await hostFixture(t, origin);
  const health = headers => hostRequest(base + '/api/health', { headers });
  const switchModel = headers => hostRequest(base + '/api/managed-models/switch', { method: 'POST', headers: { 'content-type': 'application/json', 'x-strata-client': 'tailscale-access-test', ...headers }, body: '{"id":"not-configured"}' });
  const inference = (path, headers, method = 'GET', body) => hostRequest(base + path, { method, headers: { 'content-type': 'application/json', ...headers }, body });
  for (const host of ['strata.example-tailnet.ts.net', '127.0.0.1:' + port]) {
    assert.equal((await health({ origin, host })).status, 200);
    assert.equal((await inference('/v1/models', { origin, host })).status, 200);
    const emptyChat = await inference('/v1/chat/completions', { origin, host }, 'POST', '{}');
    assert.equal(emptyChat.status, 400); // Passed the browser gate, but cannot perform inference without a user message.
    assert.match(await emptyChat.text(), /No user message/);
    const switched = await switchModel({ origin, host });
    assert.equal(switched.status, 404); // Auth passed; model switching remains unconfigured, so no lifecycle operation runs.
    assert.match(await switched.text(), /not configured/);
  }
  assert.equal((await health({ origin: 'https://another.example-tailnet.ts.net' })).status, 403);
  assert.equal((await switchModel({ origin: 'https://another.example-tailnet.ts.net' })).status, 403);
  assert.equal((await health({ origin, host: 'other.example' })).status, 403);
  assert.equal((await fetch(base + '/api/managed-models/switch', { method: 'POST', headers: { origin, 'content-type': 'application/json' }, body: '{}' })).status, 403);
  assert.equal((await health({ origin: 'http://127.0.0.1:' + port })).status, 200);
  assert.equal((await switchModel({ origin: 'http://127.0.0.1:' + port })).status, 404);
  assert.equal((await switchModel({ origin: 'http://127.0.0.1:' + (port + 1) })).status, 403);
  assert.equal((await health({ origin: 'http://127.0.0.1:' + (port + 1) })).status, 403);
  assert.equal((await health({ origin: 'https://localhost' })).status, 403);
  assert.equal((await switchModel({ origin: 'https://localhost' })).status, 403);
  assert.equal((await switchModel({})).status, 404);
  for (const value of ['https://unrelated.example', 'https://another.example-tailnet.ts.net', 'http://127.0.0.1:' + (port + 1), 'https://localhost', 'null']) {
    assert.equal((await inference('/v1/models', { origin: value })).status, 403, value);
    // Refusal happens before body parsing or dispatch, even for an API-key-optional host.
    assert.equal((await inference('/v1/chat/completions', { origin: value }, 'POST', 'not-json')).status, 403, value);
  }
  assert.equal((await inference('/v1/models', { origin: 'http://127.0.0.1:' + port })).status, 200);
  assert.equal((await inference('/v1/chat/completions', { origin: 'http://127.0.0.1:' + port }, 'POST', '{}')).status, 400);
  assert.equal((await inference('/v1/models', {})).status, 200);
  assert.equal((await inference('/v1/chat/completions', {}, 'POST', '{}')).status, 400);
});

test('the actual default host still rejects a Tailscale browser origin and accepts its local browser', { timeout: 30000 }, async t => {
  const { base, port } = await hostFixture(t);
  assert.equal((await fetch(base + '/api/health', { headers: { origin } })).status, 403);
  assert.equal((await fetch(base + '/api/health', { headers: { origin: 'http://127.0.0.1:' + port } })).status, 200);
  assert.equal((await fetch(base + '/api/health', { headers: { origin: 'https://localhost' } })).status, 200);
  assert.equal((await fetch(base + '/v1/models', { headers: { origin: 'https://unrelated.example' } })).status, 200);
  const oldApi = await fetch(base + '/v1/chat/completions', { method: 'POST', headers: { origin: 'https://unrelated.example', 'content-type': 'application/json' }, body: '{}' });
  assert.equal(oldApi.status, 400);
  assert.match(await oldApi.text(), /No user message/);
});
