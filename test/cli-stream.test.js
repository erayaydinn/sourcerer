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
