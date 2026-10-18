import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runLoop } from '../src/adapters/agent-loop.js';

const usage = { inputTokens: 1_000_000, outputTokens: 0, cachedTokens: 0 };

// Fake API: asks for a write_file call on the first turn, then answers.
function fakeApi(replies) {
  let turn = 0;
  return {
    createClient: () => null,
    call: async () => replies[Math.min(turn++, replies.length - 1)],
    toolResults: (calls, results) => [{ role: 'user', content: results.join('\n') }],
  };
}

const writeCall = { text: '', assistantMessage: {}, usage, toolCalls: [{ id: '1', name: 'write_file', args: { path: 'x.txt', content: 'done' } }] };
const answer = { text: 'finished', assistantMessage: {}, usage, toolCalls: [] };

function opts(cwd, maxTurns) {
  return {
    prompt: 'go', system: '', cwd, readDirs: [], model: 'm', allowedTools: ['write_file'], timeoutSec: 10, maxTurns,
    toolConfig: { maxOutputChars: 1000, runCommand: { allow: [], timeoutSec: 1 } },
    pricing: { m: { input: 1, output: 1 } },
  };
}

test('runs tool calls until the model answers, summing usage and cost', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sourcerer-loop-'));
  const result = await runLoop(fakeApi([writeCall, answer]), {}, opts(cwd, 5));
  assert.equal(result.output, 'finished');
  assert.equal(readFileSync(join(cwd, 'x.txt'), 'utf8'), 'done');
  assert.equal(result.usage.inputTokens, 2_000_000);
  assert.deepEqual([result.costUsd, result.costSource], [2, 'estimated']);
});

test('stops at maxTurns', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'sourcerer-loop-'));
  await assert.rejects(runLoop(fakeApi([writeCall]), {}, opts(cwd, 2)), /maxTurns \(2\)/);
});
