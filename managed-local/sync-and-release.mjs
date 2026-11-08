/** Merge official stable releases, verify the optional model picker, then publish a host-only bundle. */
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildWindowsInstaller } from './windows-installer/build-installer.mjs';
import { verifyWindowsInstaller } from './windows-installer/verify-installer.mjs';

export const FORK = 'bassmicrobe/Strata-Managed-Models';
export const UPSTREAM = 'Niko1221/Strata';
export const FEATURE = 'strata-managed-models-v1';
export const ARCHIVE = 'managed-host-windows-x64.zip';
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const COMMIT = /^[a-f0-9]{40}$/;
const branch = 'managed-models';
const readJson = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));

export function stableRelease(value) {
  const version = String(value?.tag_name ?? '').replace(/^v/, '');
  if (!VERSION.test(version) || !/^v?\d+\.\d+\.\d+$/.test(value.tag_name ?? '') || value.draft || value.prerelease
    || value.html_url !== `https://github.com/${UPSTREAM}/releases/tag/${value.tag_name}`) throw new Error('The upstream release is not a valid stable release.');
  return { version, tag: value.tag_name };
}
export function compareVersions(a, b) {
  if (!VERSION.test(a) || !VERSION.test(b)) throw new Error('Invalid version number.');
  const aa = a.split('.').map(Number), bb = b.split('.').map(Number);
  return Math.sign(aa[0] - bb[0] || aa[1] - bb[1] || aa[2] - bb[2]);
}
export function bundleManifest({ version, commit, upstreamCommit, upstreamTag }) {
  if (!VERSION.test(version) || !COMMIT.test(commit) || !COMMIT.test(upstreamCommit) || upstreamTag.replace(/^v/, '') !== version) throw new Error('Invalid bundle identity.');
  return { schema_version: 1, feature: FEATURE, version, commit, upstreamCommit, upstreamTag, sourceRepository: FORK };
}
export function bundlePath(path) {
  if (typeof path !== 'string' || path.includes('\\') || path.includes('\0') || isAbsolute(path)
    || path.split('/').some(part => !part || part === '.' || part === '..')) return false;
  if (['LICENSE', 'NOTICE', 'NOTICE.md'].includes(path)) return true;
  return path.startsWith('apps/host/') && !path.split('/').some(part => ['node_modules', '.git', '.env', '.npmrc'].includes(part));
}
function inside(base, file) {
  const full = resolve(file), rel = relative(resolve(base), full);
  if (!rel || rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new Error('A build file is outside the package directory.');
  return full;
}
export function command(file, args, { cwd, timeout = 300000 } = {}) {
  return new Promise((ok, bad) => {
    const child = execFile(file, args, { cwd, timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' } }, (error, stdout, stderr) => {
      if (error) { bad(Object.assign(new Error('A merge, build, or verification command failed.'), { detail: String(stdout).slice(-12000) + String(stderr).slice(-12000) })); }
      else ok(String(stdout));
    });
    child.stdin?.end();
  });
}
async function github(path, { method = 'GET', body, missing = false } = {}) {
  const response = await fetch('https://api.github.com' + path, { method,
    headers: { accept: 'application/vnd.github+json', authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'x-github-api-version': '2022-11-28', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (missing && response.status === 404) return null;
  if (!response.ok) throw new Error(`GitHub operation failed (HTTP ${response.status}).`);
  return response.status === 204 ? null : response.json();
}
export async function previousManifest({ fetchImpl = fetch, token = process.env.GITHUB_TOKEN } = {}) {
  const base = `https://api.github.com/repos/${FORK}`;
  const apiHeaders = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28',
    ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const signal = AbortSignal.timeout(30000);
  const request = async (url, options, step) => {
    try { return await fetchImpl(url, { ...options, signal }); }
    catch { throw new Error(`The previous managed release could not be checked at ${step} (network request failed).`); }
  };
  const metadata = await request(base + '/releases/latest', { headers: apiHeaders, redirect: 'error' }, 'release metadata');
  if (metadata.status === 404) return null; // No published release is the only case in which there is nothing to compare.
  if (!metadata.ok) throw new Error(`The previous managed release metadata failed (HTTP ${metadata.status}).`);
  const latest = await metadata.json();
  const match = /^managed-v(\d+\.\d+\.\d+)-\d+$/.exec(latest.tag_name ?? '');
  const assets = latest.assets?.filter(asset => asset.name === 'managed-host.json');
  const asset = assets?.length === 1 ? assets[0] : null;
  if (!match || latest.draft || latest.prerelease || !asset || !Number.isSafeInteger(asset.id) || asset.id <= 0
    || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 65536) throw new Error('The previous managed release metadata is invalid.');
  // Ask GitHub for asset bytes directly, avoiding the public download URL's edge cache.
  // The workflow token reaches api.github.com only; it is never sent to the signed CDN URL.
  let response = await request(base + `/releases/assets/${asset.id}`, {
    headers: { ...apiHeaders, accept: 'application/octet-stream' }, redirect: 'manual',
  }, 'asset API');
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    let target;
    try {
      target = new URL(response.headers.get('location'));
      if (target.protocol !== 'https:' || target.hostname !== 'release-assets.githubusercontent.com' || target.username || target.password) throw new Error();
    } catch { throw new Error('The previous managed manifest asset redirect is invalid.'); }
    await response.body?.cancel();
    response = await request(target.href, { headers: { accept: 'application/octet-stream' }, redirect: 'error' }, 'asset CDN');
    if (!response.ok) throw new Error(`The previous managed manifest CDN download failed (HTTP ${response.status}).`);
  } else if (!response.ok) throw new Error(`The previous managed manifest asset API failed (HTTP ${response.status}).`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length !== asset.size || bytes.length > 65536) throw new Error('The previous release manifest size does not match its asset.');
  if (asset.digest && asset.digest !== 'sha256:' + createHash('sha256').update(bytes).digest('hex')) throw new Error('The previous release manifest checksum does not match its asset.');
  let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('The previous release manifest is invalid JSON.'); }
  if (value.schema_version !== 1 || value.feature !== FEATURE || value.sourceRepository !== FORK || value.version !== match[1]
    || !COMMIT.test(value.commit ?? '') || !COMMIT.test(value.upstreamCommit ?? '') || value.upstreamTag !== 'v' + match[1]) throw new Error('The previous managed release manifest identity is invalid.');
  return value;
}
export function buildFiles(root, tracked) {
  const paths = new Set(tracked.split('\0').filter(bundlePath));
  function walk(directory) {
    for (const name of readdirSync(directory)) {
      const full = inside(root, join(directory, name)), stat = lstatSync(full);
      if (stat.isSymbolicLink()) throw new Error('Build links are not included in managed host packages.');
      if (stat.isDirectory()) walk(full);
      else if (stat.isFile()) paths.add(relative(root, full).split(sep).join('/'));
      else throw new Error('Unsupported build output.');
    }
  }
  walk(join(root, 'apps/host/dist'));
  return [...paths].filter(bundlePath).sort();
}
export async function packageHost(root, manifest, tracked) {
  const output = join(process.env.RUNNER_TEMP, 'strata-managed-' + randomUUID()); mkdirSync(output, { recursive: true });
  const packageRoot = join(output, 'package'); mkdirSync(packageRoot);
  let bytes = 0;
  for (const path of buildFiles(root, tracked)) {
    const source = inside(root, join(root, ...path.split('/'))), stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024 * 1024) throw new Error('An application file cannot be safely packaged.');
    bytes += stat.size; if (bytes > 512 * 1024 * 1024) throw new Error('The host package is larger than expected.');
    const destination = inside(packageRoot, join(packageRoot, ...path.split('/')));
    mkdirSync(dirname(destination), { recursive: true }); copyFileSync(source, destination);
  }
  writeFileSync(join(packageRoot, 'managed-host.json'), JSON.stringify(manifest, null, 2));
  const archive = join(output, ARCHIVE), packer = join(output, 'pack.ps1');
  writeFileSync(packer, String.raw`param([string]$Source,[string]$Archive)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression
$prefix = [IO.Path]::GetFullPath($Source).TrimEnd([char[]]'\/') + [IO.Path]::DirectorySeparatorChar
$stream = [IO.File]::Open($Archive,[IO.FileMode]::CreateNew,[IO.FileAccess]::ReadWrite,[IO.FileShare]::None)
try {
    $zip = [IO.Compression.ZipArchive]::new($stream,[IO.Compression.ZipArchiveMode]::Create,$true)
    try {
        foreach ($file in (Get-ChildItem -LiteralPath $Source -File -Recurse -Force)) {
            $name = $file.FullName.Substring($prefix.Length).Replace('\','/')
            $entry = $zip.CreateEntry($name,[IO.Compression.CompressionLevel]::Optimal)
            $destination = $entry.Open()
            try {
                $sourceStream = [IO.File]::OpenRead($file.FullName)
                try { $sourceStream.CopyTo($destination) } finally { $sourceStream.Dispose() }
            } finally { $destination.Dispose() }
        }
    } finally { $zip.Dispose() }
} finally { $stream.Dispose() }
`);
  await command('powershell.exe', ['-NoLogo', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', packer, '-Source', packageRoot, '-Archive', archive], { cwd: root });
  const data = readFileSync(archive), external = { ...manifest, archive: { name: ARCHIVE, sha256: createHash('sha256').update(data).digest('hex'), size: data.length } };
  const manifestFile = join(output, 'managed-host.json'); writeFileSync(manifestFile, JSON.stringify(external, null, 2));
  return { output, archive, manifestFile };
}
async function upload(releaseId, file, name, type) {
  if (!Number.isSafeInteger(releaseId) || releaseId <= 0) throw new Error('Invalid release identity.');
  const response = await fetch(`https://uploads.github.com/repos/${FORK}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`, {
    method: 'POST', headers: { authorization: `Bearer ${process.env.GITHUB_TOKEN}`, 'content-type': type },
    body: readFileSync(file), signal: AbortSignal.timeout(120000), redirect: 'error' });
  if (!response.ok) throw new Error(`Release upload failed (HTTP ${response.status}).`);
}
export async function main() {
  if (process.env.GITHUB_REPOSITORY !== FORK || !process.env.GITHUB_TOKEN || !process.env.RUNNER_TEMP
    || !/^[1-9]\d*$/.test(process.env.GITHUB_RUN_NUMBER ?? '')) throw new Error('Run this publisher in the configured fork workflow.');
  const root = resolve(fileURLToPath(new URL('..', import.meta.url))), host = join(root, 'apps/host');
  const git = args => command('git', args, { cwd: root });
  const origin = (await git(['remote', 'get-url', 'origin'])).trim();
  if (![ `https://github.com/${FORK}`, `https://github.com/${FORK}.git` ].includes(origin)) throw new Error('The checkout is not the configured fork.');
  if ((await git(['branch', '--show-current'])).trim() !== branch) throw new Error('The publisher must run on managed-models.');
  if ((await git(['status', '--porcelain'])).trim()) throw new Error('The release checkout must be clean.');
  await git(['config', 'core.longpaths', 'true']);
  await git(['config', 'user.name', 'github-actions[bot]']);
  await git(['config', 'user.email', '41898282+github-actions[bot]@users.noreply.github.com']);
  let upstream; try { upstream = (await git(['remote', 'get-url', 'upstream'])).trim(); } catch { await git(['remote', 'add', 'upstream', `https://github.com/${UPSTREAM}.git`]); upstream = `https://github.com/${UPSTREAM}.git`; }
  if (![ `https://github.com/${UPSTREAM}`, `https://github.com/${UPSTREAM}.git` ].includes(upstream)) throw new Error('The upstream remote is not official Strata.');
  const latest = stableRelease(await github(`/repos/${UPSTREAM}/releases/latest`)), marker = join(root, 'managed-local/UPSTREAM.json'), old = readJson(marker);
  if (!VERSION.test(old.version ?? '') || !COMMIT.test(old.commit ?? '') || compareVersions(latest.version, old.version) < 0) throw new Error('The upstream release would downgrade this fork.');
  await git(['fetch', '--no-tags', 'upstream', 'refs/tags/' + latest.tag]);
  const upstreamCommit = (await git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}'])).trim();
  if (!COMMIT.test(upstreamCommit)) throw new Error('The upstream release commit is invalid.');
  if (latest.version === old.version && upstreamCommit !== old.commit) throw new Error('The published upstream tag changed; review it before merging.');
  if (upstreamCommit !== old.commit) {
    console.log(`Merging official Strata ${latest.version}. A conflict stops publication.`);
    await git(['merge', '--no-edit', '--no-stat', upstreamCommit]);
    writeFileSync(marker, JSON.stringify({ version: latest.version, commit: upstreamCommit }, null, 2) + '\n');
    await git(['add', '--', 'managed-local/UPSTREAM.json']); await git(['commit', '-m', `[GUI] track upstream ${latest.tag}`]);
  }
  const commit = (await git(['rev-parse', 'HEAD'])).trim(), manifest = bundleManifest({ version: latest.version, commit, upstreamCommit, upstreamTag: latest.tag });
  const previous = await previousManifest();
  if (previous?.commit === commit && process.env.INPUT_FORCE !== 'true') { console.log('This verified commit is already published.'); return; }
  if (readJson(join(host, 'package.json')).version !== latest.version) throw new Error('The app and upstream release versions differ.');
  const npm = join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js'); if (!existsSync(npm)) throw new Error('The workflow Node installation has no npm CLI.');
  const runNpm = args => command(process.execPath, [npm, ...args], { cwd: host });
  console.log('Installing dependencies and verifying the model-switch feature.');
  await command(process.execPath, ['--test', 'managed-local/sync-and-release.test.mjs'], { cwd: root });
  await runNpm(['ci', '--ignore-scripts', '--no-audit', '--no-fund']);
  await runNpm(['run', 'typecheck']); await runNpm(['run', 'build']);
  await command(process.execPath, ['--test', 'server/managed-local-models.test.mjs', 'server/update-maintenance.test.mjs', 'server/tailscale-access.test.mjs', 'tests/managed-models-client.test.mjs', 'tests/native-picker.test.mjs', 'tests/model-picker.test.mjs'], { cwd: host });
  const installerTests=readdirSync(join(root,'managed-local/windows-installer')).filter(name=>name.endsWith('.test.mjs')).map(name=>'managed-local/windows-installer/'+name);
  if(installerTests.length)await command(process.execPath,['--test',...installerTests],{cwd:root});
  const files = await git(['ls-files', '-z', '--', 'apps/host', 'LICENSE', 'NOTICE', 'NOTICE.md']);
  const packaged = await packageHost(root, manifest, files);
  const tag = `managed-v${latest.version}-${process.env.GITHUB_RUN_NUMBER}`;
  console.log('Building and testing the standalone Windows installer.');
  const installer=await buildWindowsInstaller({repoRoot:root,hostSourceRoot:root,version:latest.version,commit,releaseTag:tag,outputDir:join(packaged.output,'windows-installer')});
  await verifyWindowsInstaller({installer:installer.installer,workRoot:join(packaged.output,'installer-test')});
  const releaseManifest=readJson(packaged.manifestFile);
  releaseManifest.installer={name:installer.installer.split(/[\\/]/).pop(),sha256:installer.sha256,size:installer.size};
  writeFileSync(packaged.manifestFile,JSON.stringify(releaseManifest,null,2));
  // A normal push refuses concurrent branch changes; the workflow never force-pushes.
  await git(['push', 'origin', `HEAD:refs/heads/${branch}`]);
  const release = await github(`/repos/${FORK}/releases`, { method: 'POST', body: { tag_name: tag, target_commitish: commit,
    name: `Strata ${latest.version} · モデル切替版`, draft: true, prerelease: false,
    body: `Strata ${latest.version} のモデル切替版です。Windowsでは専用ウィンドウで起動します。モデルは画面から自由に追加し、追加済みモデルに応じてチャットの切替一覧が変わります。\n\n新しいWindows版があると、起動時に現在の版と最新版を表示します。「はい」で検証済みのセットアップをダウンロードして開き、「いいえ」で後回しにできます。\n\nコード実行用エージェントを同梱しました。「Strata → 自動テストでコーディング」で自動実行を有効にすると、専用チャットでテスト実行、失敗ログからの修正、再実行を続けられます。初回にBypassモードのファイル編集とコマンド実行について確認します。モデルとプロジェクトの開発環境は利用者が選びます。\n\nTailscaleを別途導入して接続したPCでは、アプリのStrataメニューから同じTailscaleネットワークの端末へHTTPSで共有できます。「共有URLをコピー」で接続先を確認できます。初期状態はPC内限定です。詳しい手順は同梱の日本語READMEをご覧ください。\n\n上流: https://github.com/${UPSTREAM}/releases/tag/${latest.tag}\n上流コミット: ${upstreamCommit}\n切替版コミット: ${commit}\n\n型チェック、画面ビルド、モデル切替・更新・Tailscaleアクセス制御、Windowsへのインストール、専用ウィンドウの表示、再インストールとアンインストール時のデータ保持を検証しました。モデル本体、APIキー、会話履歴は配布物に含みません。\n` } });
  await upload(release.id, packaged.archive, ARCHIVE, 'application/zip');
  await upload(release.id, packaged.manifestFile, 'managed-host.json', 'application/json');
  await upload(release.id,installer.installer,releaseManifest.installer.name,'application/vnd.microsoft.portable-executable');
  await github(`/repos/${FORK}/releases/${release.id}`, { method: 'PATCH', body: { draft: false } });
  console.log(`Published https://github.com/${FORK}/releases/tag/${tag}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(); } catch (error) { console.error(error.message); if (error.detail) console.error(error.detail); process.exitCode = 1; }
}
