import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { hostProcess, savedHostRoot } from './runtime/close-saved-host.mjs';

test('recognizes existing saved model registrations without treating custom stop commands as host shutdowns', () => {
  const root = join(tmpdir(), 'saved models');
  const settingsSource = join(root, 'config/managed-models.json');
  const stopCommand = { file: join(root, 'bin/reuse-saved-models.ps1'), args: ['-Mode', 'stop'] };
  assert.equal(savedHostRoot({ settingsSource, stopCommand }), root);
  for (const cfg of [null, {}, { stopCommand }, { settingsSource }, { settingsSource: 'config/managed-models.json', stopCommand },
    { settingsSource: join(root, 'other/managed-models.json'), stopCommand },
    { settingsSource, stopCommand: { ...stopCommand, file: join(root, 'bin/custom.ps1') } },
    { settingsSource, stopCommand: { ...stopCommand, args: ['-Mode', 'original'] } }]) {
    assert.equal(savedHostRoot(cfg), null);
  }
});

test('only the recorded helper on the owning listener can be closed', { skip: process.platform !== 'win32', timeout: 90000 }, async () => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'saved host fixture ')));
  const entry = join(root, 'host-versions/test/apps/host/server/index.mjs');
  const record = join(root, 'state/deepseek9b/host-process.json');
  mkdirSync(dirname(entry), { recursive: true });
  mkdirSync(dirname(record), { recursive: true });
  writeFileSync(entry, `import http from 'node:http';
    const server=http.createServer((req,res)=>{
      if(req.url === '/api/control/shutdown' && req.headers['x-strata-shutdown'] === 'fixture-token'
        && req.headers['x-strata-updater'] === 'fixture-lease'){
        res.end('{}'); server.close(()=>process.exit(0)); return;
      }
      res.writeHead(403).end();
    }).listen(0,'127.0.0.1',()=>process.send(server.address().port));`);
  const child = spawn(process.execPath, [entry], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  try {
    const [port] = await once(child, 'message');
    // Keep the test on its own ephemeral port, even when a real Strata is running.
    const options = { port, node: process.execPath, leaseId: 'fixture-lease' };
    const valid = { pid: child.pid, executable: process.execPath, entry, shutdownToken: 'fixture-token' };
    await assert.rejects(hostProcess(root, null, options), /listener/);
    writeFileSync(record, JSON.stringify({ ...valid, entry: join(root, 'host-versions/other/apps/host/server/index.mjs') }));
    await assert.rejects(hostProcess(root, null, options), /identity/);
    writeFileSync(record, JSON.stringify(valid));
    const identity = await hostProcess(root, null, options);
    assert.equal(identity.pid, child.pid);
    await assert.rejects(hostProcess(root, { ...identity, created: '0' }, options), /changed/);
    assert.equal(child.exitCode, null);
    const stopped = once(child, 'exit');
    await hostProcess(root, identity, options);
    assert.equal((await stopped)[0], 0);
    assert.equal(await hostProcess(root, null, options), null);
  } finally {
    if (child.exitCode === null && child.signalCode === null) {
      const stopped = once(child, 'exit');
      child.kill();
      await stopped;
    }
    rmSync(root, { recursive: true, force: true });
  }
});
