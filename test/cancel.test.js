import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { runCli } from '../src/adapters/cli.js';

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

test('aborting runCli kills the agent CLI and the processes it started', async () => {
  const bin = mkdtempSync(join(tmpdir(), 'sourcerer-cancel-'));
  const pidFile = join(bin, 'pids');
  // Fake claude: starts a background child (like an agent running `npm test`), then waits.
  writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat > /dev/null\nsleep 30 &\necho $! > '${pidFile}'\necho $$ >> '${pidFile}'\nwait\n`);
  chmodSync(join(bin, 'claude'), 0o755);
  process.env.PATH = `${bin}:${process.env.PATH}`;

  const controller = new AbortController();
  const running = runCli({ bin: 'claude' }, {
    prompt: 'x', cwd: bin, readDirs: [], model: 'm', allowedTools: [], timeoutSec: 60, pricing: {}, signal: controller.signal,
  });
  // Wait for both lines: the fake CLI writes them one after the other, so the file can exist with only one.
  const written = () => (existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean) : []);
  for (let i = 0; i < 100 && written().length < 2; i++) await sleep(50);
  const pids = written().map(Number);
  assert.equal(pids.length, 2);
  assert.ok(pids.every(alive));

  controller.abort();
  await assert.rejects(running, (error) => error.name === 'AbortError');
  for (let i = 0; i < 40 && pids.some(alive); i++) await sleep(100);
  assert.deepEqual(pids.map(alive), [false, false], 'CLI and its child are both gone');
});

test('runCli refuses to start when already aborted', async () => {
  await assert.rejects(runCli({ bin: 'claude' }, { prompt: 'x', cwd: tmpdir(), readDirs: [], model: 'm', allowedTools: [], timeoutSec: 1, pricing: {}, signal: AbortSignal.abort() }),
    (error) => error.name === 'AbortError');
});

// Sourcerer stopped by `kill` (SIGTERM) or a closed terminal (SIGHUP), not Ctrl+C: its agent CLIs run
// detached, so they must be stopped explicitly.
for (const [name, code] of [['SIGTERM', 143], ['SIGHUP', 129]]) {
  test(`${name} to Sourcerer stops running agent CLIs and the processes they started`, async () => {
    const bin = mkdtempSync(join(tmpdir(), 'sourcerer-signal-'));
    const pidFile = join(bin, 'pids');
    writeFileSync(join(bin, 'claude'), `#!/bin/sh\ncat > /dev/null\nsleep 30 &\necho $! > '${pidFile}'\necho $$ >> '${pidFile}'\nwait\n`);
    chmodSync(join(bin, 'claude'), 0o755);
    const cli = new URL('../src/adapters/cli.js', import.meta.url).href;
    const script = `import { runCli } from '${cli}';
await runCli({ bin: 'claude' }, { prompt: 'x', cwd: '${bin}', readDirs: [], model: 'm', allowedTools: [], timeoutSec: 60, pricing: {} });`;
    const sourcerer = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env, PATH: `${bin}:${process.env.PATH}` }, stdio: 'ignore' });
    const exited = new Promise((resolve) => sourcerer.once('exit', (exitCode) => resolve(exitCode)));

    const written = () => (existsSync(pidFile) ? readFileSync(pidFile, 'utf8').trim().split('\n').filter(Boolean) : []);
    for (let i = 0; i < 100 && written().length < 2; i++) await sleep(50);
    const pids = written().map(Number);
    assert.equal(pids.length, 2);
    assert.ok(pids.every(alive));

    sourcerer.kill(name);
    assert.equal(await exited, code);
    for (let i = 0; i < 40 && pids.some(alive); i++) await sleep(100);
    assert.deepEqual(pids.map(alive), [false, false], 'the agent CLI and its child are both gone');
  });
}
