import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { bundleManifest, bundlePath, compareVersions, stableRelease, packageHost, command, previousManifest, FEATURE, FORK } from './sync-and-release.mjs';

function previousFixture() {
  const value = bundleManifest({ version: '0.2.12', commit: 'a'.repeat(40), upstreamCommit: 'b'.repeat(40), upstreamTag: 'v0.2.12' });
  const bytes = Buffer.from(JSON.stringify(value));
  return { value, bytes, latest: { tag_name: 'managed-v0.2.12-7', draft: false, prerelease: false,
    assets: [{ id: 723399580, name: 'managed-host.json', size: bytes.length, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') }] } };
}
test('previous manifest uses the authenticated asset API and strips authentication before the CDN request', async () => {
  const f = previousFixture(), calls = [], token = 'workflow-token-test';
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) return Response.json(f.latest);
    if (calls.length === 2) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/github-production-release-asset/fixture?signature=public-asset' } });
    return new Response(f.bytes);
  };
  assert.deepEqual(await previousManifest({ fetchImpl, token }), f.value);
  assert.equal(calls.length, 3); assert.equal(calls[1].url, `https://api.github.com/repos/${FORK}/releases/assets/723399580`);
  assert.equal(calls[0].options.headers.authorization, 'Bearer ' + token); assert.equal(calls[1].options.headers.authorization, 'Bearer ' + token);
  assert.equal(calls[1].options.headers.accept, 'application/octet-stream'); assert.equal(calls[1].options.redirect, 'manual');
  assert.equal(calls[2].options.redirect, 'error'); assert(!('authorization' in calls[2].options.headers));
  assert(!JSON.stringify(calls[2]).includes(token));
});
test('a direct asset API response is verified without using the public download URL', async () => {
  const f = previousFixture(); let calls = 0;
  assert.deepEqual(await previousManifest({ token: '', fetchImpl: async (url, options) => {
    calls++; assert(url.startsWith('https://api.github.com/')); assert(!options.headers.authorization);
    return calls === 1 ? Response.json(f.latest) : new Response(f.bytes);
  } }), f.value); assert.equal(calls, 2);
});
test('a non-ok previous-release request stops publication instead of silently skipping the comparison', async () => {
  const f = previousFixture();
  for (const [phase, status, expected] of [['metadata', 403, /metadata failed \(HTTP 403\)/], ['api', 404, /asset API failed \(HTTP 404\)/], ['cdn', 503, /CDN download failed \(HTTP 503\)/]]) {
    let calls = 0;
    await assert.rejects(previousManifest({ token: 'never-log-this', fetchImpl: async () => {
      calls++;
      if (calls === 1) return phase === 'metadata' ? new Response(null, { status }) : Response.json(f.latest);
      if (phase === 'api') return new Response(null, { status });
      if (calls === 2) return new Response(null, { status: 302, headers: { location: 'https://release-assets.githubusercontent.com/fixture' } });
      return new Response(null, { status });
    } }), expected);
  }
  assert.equal(await previousManifest({ fetchImpl: async () => new Response(null, { status: 404 }) }), null);
});
test('previous-manifest redirects to insecure or unrelated hosts are rejected before a second asset request', async () => {
  const f = previousFixture();
  for (const location of ['http://release-assets.githubusercontent.com/fixture', 'https://example.com/fixture', 'https://api.github.com/fixture', 'https://user:password@release-assets.githubusercontent.com/fixture']) {
    let calls = 0;
    await assert.rejects(previousManifest({ token: 'never-leak', fetchImpl: async () => {
      calls++; return calls === 1 ? Response.json(f.latest) : new Response(null, { status: 302, headers: { location } });
    } }), /redirect is invalid/); assert.equal(calls, 2);
  }
});
test('malformed previous-release metadata or manifest bytes cannot bypass the previous-release gate', async () => {
  const f = previousFixture();
  for (const latest of [{ ...f.latest, assets: [] }, { ...f.latest, prerelease: true }, { ...f.latest, assets: [{ ...f.latest.assets[0], id: -1 }] }]) {
    let calls = 0; await assert.rejects(previousManifest({ fetchImpl: async () => { calls++; return Response.json(latest); } }), /metadata is invalid/); assert.equal(calls, 1);
  }
  let calls = 0; await assert.rejects(previousManifest({ fetchImpl: async () => ++calls === 1 ? Response.json(f.latest) : new Response('truncated') }), /size does not match/);
});

const release = (tag_name, extra = {}) => ({ tag_name, html_url: `https://github.com/Niko1221/Strata/releases/tag/${tag_name}`, draft: false, prerelease: false, ...extra });
test('only official stable release metadata is accepted', () => {
  assert.deepEqual(stableRelease(release('v0.2.12')), { version: '0.2.12', tag: 'v0.2.12' });
  for (const value of [release('v0.2.13', { prerelease: true }), release('v0.2.13', { draft: true }), release('v0.2.13-rc1'), release('v0.2.13', { html_url: 'https://example.com/releases/tag/v0.2.13' }), release('v00.2.13')]) assert.throws(() => stableRelease(value));
});
test('version checks avoid lexical ordering and reject malformed numbers', () => {
  assert.equal(compareVersions('0.2.12', '0.2.9'), 1); assert.equal(compareVersions('1.0.0', '1.0.0'), 0); assert.equal(compareVersions('0.2.11', '0.2.12'), -1);
  assert.throws(() => compareVersions('0.2.13-rc1', '0.2.12'));
});
test('host packaging excludes installed dependencies and traversal/private configuration paths', () => {
  for (const file of ['apps/host/server/index.mjs', 'apps/host/dist/assets/app.js', 'apps/host/src/components/ManagedChatModelPicker.tsx', 'apps/host/tests/managed-models-client.test.mjs', 'LICENSE']) assert.equal(bundlePath(file), true, file);
  for (const file of ['../profile.json', 'apps/host/../../profile.json', 'apps\\host\\server\\index.mjs', 'apps/host/node_modules/package/index.js', 'apps/host/.env', 'apps/host/.npmrc', 'host-profile/data/model-providers.json', 'data/models/model.gguf', '/apps/host/server/index.mjs', 'apps/host//server/index.mjs']) assert.equal(bundlePath(file), false, file);
});
test('release manifest binds this fork feature to both exact source commits', () => {
  const manifest = bundleManifest({ version: '0.2.12', commit: 'a'.repeat(40), upstreamCommit: 'b'.repeat(40), upstreamTag: 'v0.2.12' });
  assert.equal(manifest.feature, FEATURE); assert.equal(manifest.sourceRepository, FORK); assert.equal(manifest.schema_version, 1);
  assert(!('archive' in manifest));
  for (const changes of [{ commit: 'not-a-commit' }, { upstreamCommit: 'g'.repeat(40) }, { version: '0.2.13' }, { upstreamTag: 'v0.2.12-rc1' }]) assert.throws(() => bundleManifest({ version: '0.2.12', commit: 'a'.repeat(40), upstreamCommit: 'b'.repeat(40), upstreamTag: 'v0.2.12', ...changes }));
});
test('Windows package contains the built UI, source and embedded identity; external identity hashes its actual bytes', { skip: process.platform !== 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'strata-release-test-'));
  for (const path of ['apps/host/server', 'apps/host/dist/assets', 'apps/host/node_modules/fake']) mkdirSync(join(root, path), { recursive: true });
  writeFileSync(join(root, 'apps/host/server/index.mjs'), '// source');
  writeFileSync(join(root, 'apps/host/dist/index.html'), '<div id="root"></div>');
  writeFileSync(join(root, 'apps/host/dist/assets/app.js'), '// built UI');
  writeFileSync(join(root, 'apps/host/node_modules/fake/private.txt'), 'excluded');
  writeFileSync(join(root, 'LICENSE'), 'fixture licence');
  const previous = process.env.RUNNER_TEMP; process.env.RUNNER_TEMP = root;
  t.after(() => { if (previous === undefined) delete process.env.RUNNER_TEMP; else process.env.RUNNER_TEMP = previous; });
  const identity = bundleManifest({ version: '0.2.12', commit: 'a'.repeat(40), upstreamCommit: 'b'.repeat(40), upstreamTag: 'v0.2.12' });
  const output = await packageHost(root, identity, 'LICENSE\0apps/host/server/index.mjs\0apps/host/node_modules/fake/private.txt\0');
  const external = JSON.parse(readFileSync(output.manifestFile, 'utf8')), zip = readFileSync(output.archive);
  assert.equal(external.archive.sha256, createHash('sha256').update(zip).digest('hex')); assert.equal(external.archive.size, zip.length);
  const inspect = join(root, 'inspect.ps1');
  writeFileSync(inspect, "param([string]$Archive)\nAdd-Type -AssemblyName System.IO.Compression.FileSystem\n$zip = [IO.Compression.ZipFile]::OpenRead($Archive)\ntry { $zip.Entries | ForEach-Object { $_.FullName } } finally { $zip.Dispose() }\n");
  const rawNames = (await command('powershell.exe', ['-NoProfile', '-File', inspect, '-Archive', output.archive], { cwd: root })).trim().split(/\r?\n/);
  assert(!rawNames.some(path => path.includes('\\')), 'ZIP entries must use portable forward slashes.');
  const names = rawNames;
  assert(names.includes('managed-host.json')); assert(names.includes('apps/host/server/index.mjs')); assert(names.includes('apps/host/dist/index.html')); assert(names.includes('apps/host/dist/assets/app.js')); assert(names.includes('LICENSE'));
  assert(!names.some(name => name.includes('node_modules')));
  assert.deepEqual(JSON.parse(readFileSync(join(output.output, 'package/managed-host.json'), 'utf8')), identity);
});
