import { execFile } from 'node:child_process';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const thisFile = fileURLToPath(import.meta.url);
const readJson = file => JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
const samePath = (a, b) => typeof a === 'string' && isAbsolute(a) && relative(a, b) === '';
const busyMessage = '保存済みモデルで回答やモデル操作が進行中です。完了してからもう一度閉じてください。';

// Older imports already identify their private bridge and its settings source.
// Custom model stop commands continue to use the normal launcher path.
export function savedHostRoot(config) {
  const source = config?.settingsSource;
  if (typeof source !== 'string' || !isAbsolute(source)) return null;
  const root = dirname(dirname(source));
  const stop = config.stopCommand;
  if (!samePath(source, join(root, 'config', 'managed-models.json')) ||
      !samePath(stop?.file, join(root, 'bin', 'reuse-saved-models.ps1')) ||
      stop.args?.length !== 2 || stop.args[0] !== '-Mode' || stop.args[1] !== 'stop') return null;
  return root;
}

// This bridge owns one loopback listener. Pin the process handle before checking its
// executable, script argument, listening PID and creation time. Never stop by port alone.
const inspectOrStop = String.raw`
$ErrorActionPreference='Stop'
$ProgressPreference='SilentlyContinue'
try {
$port=[int]$env:STRATA_HELPER_PORT
$listeners=@(Get-NetTCPConnection -State Listen | Where-Object LocalPort -eq $port)
$rec=$null
if(Test-Path -LiteralPath $env:STRATA_HELPER_RECORD -PathType Leaf) {
    $rec=Get-Content -LiteralPath $env:STRATA_HELPER_RECORD -Raw | ConvertFrom-Json
}
if(!$listeners.Count) {
    if($env:STRATA_HELPER_CREATED) {throw 'The saved model host changed while closing.'}
    if($rec -and $rec.pid -gt 0) {
        $pending=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$rec.pid)
        if($pending -and $pending.ExecutablePath -eq $rec.executable -and $rec.entry -and
            $pending.CommandLine -and $pending.CommandLine.IndexOf($rec.entry, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            throw 'The saved model host is still starting or stopping.'
        }
    }
    'null'; return
}
if(!$rec -or $rec.pid -le 0 -or ![IO.Path]::IsPathRooted($rec.entry) -or
    (@($listeners | Where-Object {$_.OwningProcess -ne $rec.pid -or $_.LocalAddress -ne '127.0.0.1'}).Count)) {
    throw 'The listener does not belong to the saved model host.'
}
$legacy=Join-Path $env:STRATA_HELPER_ROOT 'host-source\apps\host\server\index.mjs'
$slots=[Regex]::Escape((Join-Path $env:STRATA_HELPER_ROOT 'host-versions'))+'\\[^\\]+\\apps\\host\\server\\index\.mjs$'
$entry=[IO.Path]::GetFullPath($rec.entry)
if($entry -ne $legacy -and $entry -notmatch ('^'+$slots)) { throw 'Unexpected saved model host entry.' }
$proc=Get-Process -Id $rec.pid
try {
    $null=$proc.Handle
    $identity=Get-CimInstance Win32_Process -Filter ('ProcessId = '+[int]$rec.pid)
    $argsPattern='^\s*(?:"[^"]+"|\S+)\s+(?:--import\s+(?:"[^"]+"|\S+)\s+)?(?:"([^"]+)"|([^\s"]+))(?=\s|$)'
    if($proc.HasExited -or !$identity -or $rec.executable -ne $env:STRATA_HELPER_NODE -or
        $identity.ExecutablePath -ne $rec.executable -or $identity.CommandLine -notmatch $argsPattern -or
        ($Matches[1] -ne $entry -and $Matches[2] -ne $entry)) { throw 'The saved model host identity does not match.' }
    $creation=$proc.StartTime.ToUniversalTime().Ticks.ToString()
    if($env:STRATA_HELPER_CREATED) {
        if($creation -ne $env:STRATA_HELPER_CREATED -or $proc.Id -ne [int]$env:STRATA_HELPER_PID) {
            throw 'The saved model host changed while closing.'
        }
        if($rec.shutdownToken) {
            $headers=@{'x-strata-client'='strata-managed-launcher'; 'x-strata-shutdown'=$rec.shutdownToken}
            if($env:STRATA_HELPER_LEASE) { $headers['x-strata-updater']=$env:STRATA_HELPER_LEASE }
            $null=Invoke-RestMethod -Uri ('http://127.0.0.1:'+$port+'/api/control/shutdown') -Method Post -TimeoutSec 5 -MaximumRedirection 0 -Headers $headers
        } else {
            # Older launchers have no shutdown token. The helper's own stop action also ends this process.
            $proc.Kill()
        }
        if(!$proc.WaitForExit(20000)) { throw 'The saved model host is still closing.' }
    }
    @{pid=$proc.Id;created=$creation} | ConvertTo-Json -Compress
} finally { $proc.Dispose() }
} catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }
`;

function powershell(args, env = process.env) {
  const exe = join(process.env.SystemRoot, 'System32/WindowsPowerShell/v1.0/powershell.exe');
  return execute(exe, ['-NoProfile', '-NonInteractive', ...args], { env, windowsHide: true });
}

export async function hostProcess(root, identity, { port = 8791, node = join(process.env.ProgramFiles, 'nodejs/node.exe'), leaseId = '' } = {}) {
  const env = { ...process.env, STRATA_HELPER_ROOT: root, STRATA_HELPER_NODE: node, STRATA_HELPER_PORT: String(port),
    STRATA_HELPER_RECORD: join(root, 'state/deepseek9b/host-process.json'), STRATA_HELPER_PID: String(identity?.pid ?? ''),
    STRATA_HELPER_CREATED: identity?.created ?? '', STRATA_HELPER_LEASE: leaseId };
  try {
    const { stdout } = await powershell(['-EncodedCommand', Buffer.from(inspectOrStop, 'utf16le').toString('base64')], env);
    return JSON.parse(stdout);
  } catch (error) { throw Error(error.stderr?.trim() || 'Could not verify the saved model host.', { cause: error }); }
}

async function status(port, path) {
  const response = await fetch('http://127.0.0.1:' + port + path, { headers: { 'x-strata-client': 'saved-model-shutdown' },
    signal: AbortSignal.timeout(10000), redirect: 'error' });
  if (!response.ok) throw Error('Could not check the saved model host: ' + response.status);
  return response.json();
}

async function checkInstalledPeer(root, data) {
  const file = join(data, 'host-process.json');
  const config = join(data, 'managed-models.json');
  if (!existsSync(file) || !existsSync(config) || !samePath(savedHostRoot(readJson(config)), root)) return;
  const { port } = readJson(file);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) throw Error('Unexpected installed host port.');
  let states;
  try { states = await Promise.all(['/api/managed-models', '/api/agent/status', '/api/serving'].map(path => status(port, path))); }
  catch (error) { if (error.cause?.code === 'ECONNREFUSED') return; throw error; }
  const [managed, agent, serving] = states;
  if (!managed.enabled || managed.switching || managed.activeRequests !== 0 || managed.queuedRequests !== 0 ||
      agent.activeTurns !== 0 || serving.stats?.running !== 0 || serving.stats?.waiting !== 0) {
    throw Object.assign(Error(busyMessage), { code: 10 });
  }
}

async function closeLocal(root, modelsLoaded, peerData) {
  if (!isAbsolute(root)) throw Error('Invalid saved model location.');
  root = realpathSync(root);
  const settings = join(root, 'config/managed-models.json');
  const cfg = readJson(settings);
  if (!samePath(cfg.maintenanceFile, join(root, 'state/auto-update/maintenance.json')) ||
      !samePath(cfg.stopCommand?.file, join(root, 'bin/switch-strata.ps1'))) throw Error('Unexpected saved model configuration.');

  let owner = await hostProcess(root);
  if (!owner) {
    if (!modelsLoaded) return;
    // The engine can outlive its helper. Restore the adapter solely to use its request/engine lease.
    await powershell(['-ExecutionPolicy', 'Bypass', '-File', join(root, 'bin/start-strata-host.ps1'), '-NoBrowser']);
    owner = await hostProcess(root);
    if (!owner) throw Error('The saved model host could not be verified.');
  }
  const stopModule = join(root, 'bin/stop-strata-models.mjs');
  if (!samePath(realpathSync(stopModule), stopModule)) throw Error('Unexpected saved model helper location.');
  const { withIdleModelLease, stopModels } = await import(pathToFileURL(stopModule));
  const exit = await withIdleModelLease(async () => {
    const current = await hostProcess(root);
    if (current?.pid !== owner.pid || current?.created !== owner.created) throw Error('The saved model host changed while closing.');
    await checkInstalledPeer(root, peerData);
    const state = await status(8791, '/api/managed-models');
    if (!state.maintenance || !Array.isArray(state.activeIds)) throw Error('Could not verify the saved model maintenance lease.');
    if (modelsLoaded || state.activeIds.length) await stopModels();
    const lease = readJson(cfg.maintenanceFile);
    if (lease.pid !== process.pid || !lease.id) throw Error('The saved model maintenance lease changed.');
    await hostProcess(root, owner, { leaseId: lease.id });
  });
  if (exit !== 0) throw Object.assign(Error(busyMessage), { code: exit });
}

// Private model commands expect the environment of the saved installation, not the installer.
export async function closeSavedHost(root, { modelsLoaded = false } = {}) {
  const args = [thisFile, '--local', root];
  if (modelsLoaded) args.push('--models-loaded');
  try { await execute(process.execPath, args, { windowsHide: true }); }
  catch (error) { throw Object.assign(Error(error.stderr?.trim() || error.message), { code: error.code }); }
}

if (process.argv[1] && samePath(resolve(process.argv[1]), thisFile)) {
  try {
    const [mode, location, loaded, ...extra] = process.argv.slice(2);
    if (mode !== '--local' || extra.length || (loaded && loaded !== '--models-loaded') ||
        (!location && basename(dirname(thisFile)).toLowerCase() !== 'bin')) throw Error('Invalid saved model shutdown arguments.');
    const peerData = process.env.STRATA_MANAGED_DATA_DIR ?? join(process.env.LOCALAPPDATA, 'StrataManaged');
    for (const key of Object.keys(process.env)) if (/^STRATA_/i.test(key)) delete process.env[key];
    process.env.Path = join(process.env.ProgramFiles, 'nodejs') + ';' + (process.env.Path ?? '');
    await closeLocal(location ?? dirname(dirname(thisFile)), loaded === '--models-loaded', peerData);
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.code === 10 ? 10 : 1;
  }
}
