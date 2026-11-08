import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { harnessDescriptor, HARNESS_INSTALLER_SHA256, validateHarnessListing, validateHarnessTree } from './harness-bundle.mjs';

const save = (file, data) => { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, data); };
const listing = paths => paths.map(path => `Path = ${path}\r\nSize = 1\r\nAttributes = A\r\n`).join('\r\n');
const minimum = ['harness/lib/bin.js', 'harness/package.json', 'harness/BUNDLE.json'];

test('the matching official Windows installer is pinned for the current upstream', async () => {
  const value = await harnessDescriptor('0.2.12', { fetchImpl: () => { throw Error('No lookup needed'); } });
  assert.equal(value.sha256, HARNESS_INSTALLER_SHA256);
  assert.equal(value.archive, 'Strata-0.2.12-windows-x64-setup.exe');
  assert.equal(value.url, 'https://github.com/Niko1221/Strata/releases/download/v0.2.12/' + value.archive);
});

test('future versions require a unique stable official asset with a digest', async () => {
  const version = '0.2.13', name = 'Strata-0.2.13-windows-x64-setup.exe';
  const asset = { name, size: 113000000, digest: 'sha256:' + 'a'.repeat(64), browser_download_url: 'https://github.com/Niko1221/Strata/releases/download/v0.2.13/' + name };
  const release = { tag_name: 'v0.2.13', assets: [asset], draft: false, prerelease: false };
  const fetchImpl = async url => { assert.equal(url, 'https://api.github.com/repos/Niko1221/Strata/releases/tags/v0.2.13'); return Response.json(release); };
  assert.equal((await harnessDescriptor(version, { fetchImpl })).sha256, 'a'.repeat(64));
  for (const bad of [
    { ...release, prerelease: true }, { ...release, tag_name: 'v0.2.14' }, { ...release, assets: [asset, asset] },
    { ...release, assets: [{ ...asset, digest: undefined }] },
    { ...release, assets: [{ ...asset, browser_download_url: 'https://example.com/installer.exe' }] },
  ]) await assert.rejects(harnessDescriptor(version, { fetchImpl: async () => Response.json(bad) }));
});

test('only a bounded complete Harness tree is extracted and Windows aliases cannot escape it', () => {
  assert.deepEqual(validateHarnessListing(listing(minimum)), { files: 3, bytes: 3 });
  for (const path of ['harness/../private', '/harness/private', 'harness/C:/file', 'other/file', 'harness/dir./file', 'harness/dir /file', 'harness/private ']) {
    assert.throws(() => validateHarnessListing(listing([...minimum, path])), /Invalid path/);
  }
  assert.throws(() => validateHarnessListing(listing([...minimum, 'harness/PACKAGE.json'])), /Duplicate/);
  assert.throws(() => validateHarnessListing(listing(minimum).replace('Size = 1', 'Size = 1073741825')), /limit/);
  assert.throws(() => validateHarnessListing(listing(minimum).replace('Attributes = A', 'Symbolic Link = outside')), /Invalid path/);
  assert.throws(() => validateHarnessListing(listing(minimum.slice(1))), /complete/);
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'smm-harness-'));
  save(join(root, 'lib/bin.js'), 'console.log("0.2.1-alpha.3");');
  save(join(root, 'package.json'), JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.2.1-alpha.3' }));
  save(join(root, 'BUNDLE.json'), JSON.stringify({ component: 'deepseek-harness', version: '0.2.1-alpha.3', platform: 'win32' }));
  save(join(root, 'LICENSE'), 'MIT'); save(join(root, 'THIRD_PARTY_NOTICES.md'), 'Third party notices');
  for (const name of ['dsh-agent-instructions', 'dsh-tool-pwsh', 'dsh-tool-fs', 'dsh-compaction-basic']) {
    save(join(root, 'node_modules/@deepseek-ai', name, 'package.json'), '{}');
  }
  return root;
}

test('production Harness validation catches incomplete plugin imports and linked files', () => {
  const root = fixture();
  assert.equal(validateHarnessTree(root).version, '0.2.1-alpha.3');
  save(join(root, 'node_modules/@deepseek-ai/dsh-tool-fs/lib/index.js'), 'import x from "@deepseek-ai/dsh-missing";');
  assert.throws(() => validateHarnessTree(root), /missing production import/);
  save(join(root, 'node_modules/@deepseek-ai/dsh-missing/package.json'), '{}');
  assert.equal(validateHarnessTree(root).version, '0.2.1-alpha.3');
  symlinkSync(join(root, 'lib'), join(root, 'linked'), 'junction');
  assert.throws(() => validateHarnessTree(root), /links/);
});
