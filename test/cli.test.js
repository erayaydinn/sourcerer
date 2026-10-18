import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../src/cli/index.js';
import { makeRuns } from './run-history.test.js';

// A temp project root: the repo's config and agents, plus fake runs.
const root = mkdtempSync(join(tmpdir(), 'sourcerer-cli-'));
cpSync(new URL('../config', import.meta.url), join(root, 'config'), { recursive: true });
cpSync(new URL('../agents', import.meta.url), join(root, 'agents'), { recursive: true });
renameSync(makeRuns(), join(root, 'runs'));

async function cli(...args) {
  const lines = [];
  const result = {};
  await buildProgram({ print: (line) => lines.push(line), result }).parseAsync(['--root', root, ...args], { from: 'user' });
  return { code: result.code, out: lines.join('\n') };
}

test('status lists runs, incomplete ones marked', async () => {
  const { code, out } = await cli('status');
  assert.equal(code, 0);
  assert.match(out, /20261017-090000-new-task\s+running\/interrupted/);
  assert.match(out, /20261001-100000-old-task\s+approved\s+1\s+\$1\.0000/);
});

test('cost of the latest run by llm shows unknown calls', async () => {
  const { out } = await cli('cost', '--by', 'llm');
  assert.match(out, /run 20261017-090000-new-task/);
  assert.match(out, /strong\s+\$1\.5000\s+2\s+0/);
  assert.match(out, /cheap\s+\$0\.0000\s+1\s+1/);
  assert.match(out, /note: 1 call\(s\) have unknown cost/);
});

test('cost of a run by prefix', async () => {
  const { out } = await cli('cost', '20261001');
  assert.match(out, /total\s+\$1\.0000\s+1/);
});

test('validate applies --llm overrides by role and agent name', async () => {
  const { code, out } = await cli('validate', '--llm', 'reviewer=claude-cheap', '--llm', 'coder-backend=claude-api');
  assert.equal(code, 0);
  assert.match(out, /reviewer \(reviewer\) -> claude-cheap/);
  assert.match(out, /coder-backend \(coder\) -> claude-api/);
  assert.match(out, /coder-frontend \(coder\) -> claude-strong/);
  assert.match(out, /warning: reviewer and coder-frontend both use provider "anthropic"/);
});

test('validate rejects an override that breaks the rules', async () => {
  const { code, out } = await cli('validate', '--llm', 'coder=gpt-api');
  assert.equal(code, 1);
  assert.match(out, /editsFiles: false/);
});

test('run rejects an invalid --side before loading anything', async () => {
  await assert.rejects(cli('run', '--side', 'mobile', 'some task'), /--side expects frontend and\/or backend/);
});
