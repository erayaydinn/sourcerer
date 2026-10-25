import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../src/adapters/cli.js';

// A fake `claude` on PATH that replays the recorded stream slowly.
const bin = mkdtempSync(join(tmpdir(), 'sourcerer-bin-'));
function fakeCli(name, fixtureName) {
  const fixture = fileURLToPath(new URL(`./fixtures/${fixtureName}`, import.meta.url));
  writeFileSync(join(bin, name), `#!/bin/sh\ncat > /dev/null\nwhile IFS= read -r line; do echo "$line"; sleep 0.05; done < '${fixture}'\n`);
  chmodSync(join(bin, name), 0o755);
}
fakeCli('claude', 'claude-stream.jsonl');
fakeCli('cursor-agent', 'cursor-stream.jsonl');

test('runCli streams readable lines before the process ends', async () => {
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const seen = [];
  const started = Date.now();
  const result = await runCli({ bin: 'claude' }, {
    prompt: 'x', cwd: bin, readDirs: [], model: 'm', allowedTools: [], timeoutSec: 10, pricing: {},
    onLog: (line) => seen.push({ line, at: Date.now() - started }),
  });
  assert.deepEqual(seen.map((s) => s.line), ['→ Read {"file_path":"/work/note.txt"}', 'hello']);
  assert.ok(seen[0].at < result.durationMs - 100, 'first line arrived well before the end');
  assert.deepEqual([result.output, result.costSource], ['hello', 'reported']);
});

test('runCli streams cursor-agent lines and estimates cost from pricing', async () => {
  process.env.PATH = `${bin}:${process.env.PATH}`;
  const seen = [];
  const result = await runCli({ bin: 'cursor-agent' }, {
    prompt: 'x', cwd: bin, readDirs: [], model: 'grok-4.7-medium', allowedTools: ['read_file'], timeoutSec: 10,
    pricing: { 'grok-4.7-medium': { input: 1, output: 10, cachedInput: 0.1 } },
    onLog: (line) => seen.push(line),
  });
  assert.equal(seen.length, 4);
  assert.equal(result.costSource, 'estimated');
  assert.ok(Math.abs(result.costUsd - (31543 * 1 + 153 * 10 + 19200 * 0.1) / 1e6) < 1e-12);
});

test('a CLI that exits non-zero gives a short error (not its stdout) with the reported cost', async () => {
  const fixture = join(bin, 'limited.jsonl');
  writeFileSync(fixture, [
    JSON.stringify({ type: 'system', subtype: 'init', tools: Array(200).fill('Tool') }),
    JSON.stringify({ type: 'result', is_error: true, api_error_status: 429, api_error: 'usage_limit_reached', result: 'limit hit', total_cost_usd: 0.21, usage: {} }),
  ].join('\n'));
  const limitedBin = mkdtempSync(join(tmpdir(), 'sourcerer-limited-'));
  writeFileSync(join(limitedBin, 'claude'), `#!/bin/sh\ncat > /dev/null\ncat '${fixture}'\necho 'some stderr' >&2\nexit 1\n`);
  chmodSync(join(limitedBin, 'claude'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${limitedBin}:${saved}`;
  try {
    await assert.rejects(runCli({ bin: 'claude' }, { prompt: 'x', cwd: limitedBin, readDirs: [], model: 'm', allowedTools: [], timeoutSec: 10, pricing: {} }), (error) => {
      assert.equal(error.message, 'claude failed (usage_limit_reached): limit hit');
      assert.equal(error.cost.costUsd, 0.21);
      assert.equal(error.rateLimited, true);
      return true;
    });

    writeFileSync(join(limitedBin, 'claude'), '#!/bin/sh\ncat > /dev/null\necho \'{"type":"system"}\'\necho "boom: auth expired" >&2\nexit 2\n');
    await assert.rejects(runCli({ bin: 'claude' }, { prompt: 'x', cwd: limitedBin, readDirs: [], model: 'm', allowedTools: [], timeoutSec: 10, pricing: {} }),
      { message: 'claude exited with code 2: boom: auth expired' });
  } finally {
    process.env.PATH = saved;
  }
});

test('runCli returns when the CLI exits, even if it left a background process holding stdout', async () => {
  const leftBin = mkdtempSync(join(tmpdir(), 'sourcerer-left-'));
  const result = JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'done', total_cost_usd: 0.01, usage: {} });
  writeFileSync(join(leftBin, 'claude'), `#!/bin/sh\ncat > /dev/null\necho '${result}'\nsleep 30 &\nexit 0\n`);
  chmodSync(join(leftBin, 'claude'), 0o755);
  const saved = process.env.PATH;
  process.env.PATH = `${leftBin}:${saved}`;
  try {
    const started = Date.now();
    const out = await runCli({ bin: 'claude' }, { prompt: 'x', cwd: leftBin, readDirs: [], model: 'm', allowedTools: [], timeoutSec: 20, pricing: {} });
    assert.equal(out.output, 'done');
    assert.ok(Date.now() - started < 5000, 'did not wait for the background process');
  } finally {
    process.env.PATH = saved;
  }
});
