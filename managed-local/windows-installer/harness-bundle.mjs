/** Stage the Harness shipped in the matching, checksum-verified official Windows installer. */
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const UPSTREAM = 'https://github.com/Niko1221/Strata';
export const HARNESS_INSTALLER_SHA256 = 'b56eb5692aa826e0aa8ae5d4819ddee1745e1522822738748c3b6c5a7643b1ff';
const MAX_INSTALLER = 256 * 1024 * 1024;

export async function harnessDescriptor(version, { fetchImpl = fetch } = {}) {
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) throw Error('Invalid upstream version for the coding assistant.');
  const archive = `Strata-${version}-windows-x64-setup.exe`;
  const url = `${UPSTREAM}/releases/download/v${version}/${archive}`;
  if (version === '0.2.12') return { archive, url, sha256: HARNESS_INSTALLER_SHA256 };
  const response = await fetchImpl(`https://api.github.com/repos/Niko1221/Strata/releases/tags/v${version}`, {
    headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(30000), redirect: 'error',
  });
  if (!response.ok) throw Error('The matching official coding assistant release could not be read.');
  const release = await response.json();
  if (release.tag_name !== `v${version}` || release.draft || release.prerelease || !Array.isArray(release.assets)) {
    throw Error('The official coding assistant release identity is invalid.');
  }
  const matches = release.assets.filter(asset => asset.name === archive && asset.browser_download_url === url
    && /^sha256:[a-f0-9]{64}$/.test(asset.digest ?? '') && Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= MAX_INSTALLER);
  if (matches.length !== 1) throw Error('A unique verified matching Windows coding assistant package was not found.');
  return { archive, url, sha256: matches[0].digest.slice(7) };
}

export function validateHarnessListing(text) {
  const seen = new Set();
  let bytes = 0;
  for (const block of text.trim().split(/\r?\n\s*\r?\n/)) {
    const path = /^Path = ([^\r\n]+)\r?$/m.exec(block)?.[1]?.replaceAll('\\', '/');
    if (!path || !path.startsWith('harness/') || path.includes(':') || path.includes('\0')
      || path.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))
      || /^(?:Symbolic Link|Hard Link) = .+/m.test(block)) throw Error('Invalid path in the official Harness archive.');
    const key = path.toLowerCase();
    if (seen.has(key)) throw Error('Duplicate path in the official Harness archive.');
    seen.add(key);
    const size = Number(/^Size = (\d+)\r?$/m.exec(block)?.[1]);
    if (!Number.isSafeInteger(size) || size < 0) throw Error('Invalid size in the official Harness archive.');
    bytes += size;
    if (seen.size > 60000 || bytes > 1024 * 1024 * 1024) throw Error('The expanded Harness archive exceeds its limit.');
  }
  if (!seen.has('harness/lib/bin.js') || !seen.has('harness/package.json') || !seen.has('harness/bundle.json')) {
    throw Error('The official installer does not contain a complete Harness.');
  }
  return { files: seen.size, bytes };
}

// These are optional development/browser packages intentionally omitted by upstream's production staging.
const OPTIONAL_IMPORTS = new Set([
  '@deepseek-ai/libreoffice-kit', '@deepseek-ai/dsh-client-ui-dockkit', '@deepseek-ai/dsh-client-web',
  '@deepseek-ai/dsh-experimental-webworker-runtime', '@deepseek-ai/dsh-remote-mock', '@deepseek-ai/dsh-client-test-runtime',
]);

export function validateHarnessTree(root) {
  const required = ['lib/bin.js', 'package.json', 'BUNDLE.json', 'LICENSE', 'THIRD_PARTY_NOTICES.md'];
  for (const file of required) if (!existsSync(join(root, file))) throw Error('The bundled coding assistant is missing ' + file + '.');
  const bundle = JSON.parse(readFileSync(join(root, 'BUNDLE.json'), 'utf8'));
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  if (bundle.component !== 'deepseek-harness' || bundle.platform !== 'win32' || pkg.name !== '@deepseek-ai/dsh'
    || typeof pkg.version !== 'string' || pkg.version !== bundle.version) throw Error('The bundled coding assistant identity is invalid.');
  const scope = join(root, 'node_modules/@deepseek-ai');
  for (const name of ['dsh-agent-instructions', 'dsh-tool-pwsh', 'dsh-tool-fs', 'dsh-compaction-basic']) {
    if (!existsSync(join(scope, name, 'package.json'))) throw Error('The bundled coding assistant is missing ' + name + '.');
  }
  let files = 0, bytes = 0;
  function walk(dir) {
    const stat = lstatSync(dir);
    if (stat.isSymbolicLink()) throw Error('The Harness payload may not contain links.');
    if (stat.isDirectory()) {
      for (const entry of readdirSync(dir)) walk(join(dir, entry));
      return;
    }
    if (!stat.isFile()) throw Error('Unsupported Harness payload file.');
    files++; bytes += stat.size;
    if (files > 60000 || bytes > 1024 * 1024 * 1024) throw Error('The Harness payload exceeds its limit.');
    if (!dir.startsWith(scope) || !/\.(?:m?js|cjs)$/.test(dir)) return;
    const text = readFileSync(dir, 'utf8');
    for (const match of text.matchAll(/(?:from|import)\s*\(?\s*["'](@deepseek-ai\/[^"'/]+)(?:\/[^"']*)?["']/g)) {
      const name = match[1];
      if (OPTIONAL_IMPORTS.has(name) || existsSync(join(root, 'node_modules', name))) continue;
      const owner = dir.slice(scope.length + 1).split(/[\\/]/)[0];
      if (!existsSync(join(scope, owner, 'node_modules', name))) throw Error('The Harness has a missing production import: ' + name + '.');
    }
  }
  walk(root);
  return { version: pkg.version, files, bytes };
}

export async function stageHarness({ archive, work, destination, node, run, sevenZip = process.env.STRATA_7ZIP_EXE }) {
  const executable = sevenZip || [
    join(process.env.ProgramFiles || 'C:/Program Files', '7-Zip/7z.exe'),
    join(process.env.LOCALAPPDATA || '', 'Microsoft/WindowsApps/7z.exe'),
  ].find(file => existsSync(file)) || '7z.exe';
  const listing = await run(executable, ['l', '-slt', '-ba', archive, 'harness/*', '-r'], { cwd: work, timeoutMs: 120000 });
  validateHarnessListing(listing.stdout);
  const extracted = join(work, 'official-harness');
  mkdirSync(extracted, { recursive: true });
  await run(executable, ['x', '-y', '-bd', '-bso0', '-bsp0', archive, 'harness/*', '-r', '-o' + extracted], { cwd: work, timeoutMs: 300000 });
  const source = join(extracted, 'harness');
  const result = validateHarnessTree(source);
  const version = await run(node, [join(source, 'lib/bin.js'), '--version'], { cwd: source, timeoutMs: 30000 });
  if (version.stdout.trim() !== result.version) throw Error('The bundled coding assistant could not report its version.');
  if (existsSync(destination)) throw Error('The Harness payload destination already exists.');
  mkdirSync(join(destination, '..'), { recursive: true });
  renameSync(source, destination);
  return result;
}
