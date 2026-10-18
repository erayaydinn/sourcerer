import { test } from 'node:test';
import assert from 'node:assert/strict';
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
  for (let i = 0; i < 50 && !existsSync(pidFile); i++) await sleep(50);
  await sleep(100);
  const pids = readFileSync(pidFile, 'utf8').trim().split('\n').map(Number);
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
