import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdtempSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildProgram } from '../src/cli/index.js';
import { loadConfig } from '../src/core/config.js';
import { makeRuns } from './run-history.test.js';

// A temp project root: the repo's config and agents, plus fake runs.
const root = mkdtempSync(join(tmpdir(), 'sourcerer-cli-'));
cpSync(new URL('../config', import.meta.url), join(root, 'config'), { recursive: true });
cpSync(new URL('../agents', import.meta.url), join(root, 'agents'), { recursive: true });
renameSync(makeRuns(), join(root, 'runs'));
writeFileSync(join(root, '.env'), 'SOURCERER_FRONTEND=/tmp/fe\nSOURCERER_BACKEND=/tmp/be\n');

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

test('role env vars pick the profile and model; empty model means the profile default', async () => {
  process.env.SOURCERER_CODER_MODEL = 'sonnet';
  process.env.SOURCERER_REVIEWER_LLM = 'claude-cheap';
  try {
    const { out } = await cli('validate');
    assert.match(out, /coder-backend \(coder\) -> claude-strong: anthropic\/sonnet/);
    assert.match(out, /reviewer \(reviewer\) -> claude-cheap: anthropic\/sonnet/);
    assert.match(out, /planner \(planner\) -> claude-strong: anthropic\/opus/);
  } finally {
    delete process.env.SOURCERER_CODER_MODEL;
    delete process.env.SOURCERER_REVIEWER_LLM;
  }
});

test('--llm wins over the role env vars and drops the env model', async () => {
  process.env.SOURCERER_REVIEWER_MODEL = 'grok-4.7-high';
  try {
    const { out } = await cli('validate', '--llm', 'reviewer=claude-cheap');
    assert.match(out, /reviewer \(reviewer\) -> claude-cheap: anthropic\/sonnet/);
  } finally {
    delete process.env.SOURCERER_REVIEWER_MODEL;
  }
});

test('budget and round limits come from env as numbers, with YAML defaults', () => {
  assert.deepEqual([loadConfig(root).budget, loadConfig(root).review.maxRounds], [{ maxCostPerRun: 5, maxCostPerAgent: 2, maxTokensPerRun: undefined, maxTokensPerAgent: undefined }, 3]);
  Object.assign(process.env, { SOURCERER_MAX_COST_PER_RUN: '1.5', SOURCERER_MAX_COST_PER_AGENT: '0.5', SOURCERER_MAX_ROUNDS: '1' });
  try {
    const config = loadConfig(root);
    assert.deepEqual(config.budget, { maxCostPerRun: 1.5, maxCostPerAgent: 0.5, maxTokensPerRun: undefined, maxTokensPerAgent: undefined });
    assert.equal(config.review.maxRounds, 1);
    process.env.SOURCERER_MAX_ROUNDS = 'three';
    assert.throws(() => loadConfig(root), /maxRounds/);
    process.env.SOURCERER_MAX_ROUNDS = '0';
    assert.throws(() => loadConfig(root), /maxRounds/);
  } finally {
    for (const name of ['SOURCERER_MAX_COST_PER_RUN', 'SOURCERER_MAX_COST_PER_AGENT', 'SOURCERER_MAX_ROUNDS']) delete process.env[name];
  }
});

test('.env edits are picked up on the next load; shell variables still win', () => {
  const envPath = join(root, '.env');
  const before = readFileSync(envPath, 'utf8');
  try {
    writeFileSync(envPath, `${before}SOURCERER_MAX_ROUNDS=2\n`);
    assert.equal(loadConfig(root).review.maxRounds, 2);
    writeFileSync(envPath, `${before}SOURCERER_MAX_ROUNDS=1\n`);
    assert.equal(loadConfig(root).review.maxRounds, 1, 'changed value is reloaded');
    writeFileSync(envPath, before);
    assert.equal(loadConfig(root).review.maxRounds, 3, 'removed value falls back to the default');
    process.env.SOURCERER_MAX_COST_PER_RUN = '9';
    writeFileSync(envPath, `${before}SOURCERER_MAX_COST_PER_RUN=1\n`);
    assert.equal(loadConfig(root).budget.maxCostPerRun, 9, 'shell wins');
  } finally {
    writeFileSync(envPath, before);
    delete process.env.SOURCERER_MAX_COST_PER_RUN;
    loadConfig(root);
  }
});

test('token limits come from env; empty means no limit; non-integers are rejected', () => {
  process.env.SOURCERER_MAX_TOKENS_PER_RUN = '200000';
  try {
    assert.equal(loadConfig(root).budget.maxTokensPerRun, 200000);
    assert.equal(loadConfig(root).budget.maxTokensPerAgent, undefined);
    process.env.SOURCERER_MAX_TOKENS_PER_RUN = '1.5';
    assert.throws(() => loadConfig(root), /maxTokensPerRun/);
  } finally {
    delete process.env.SOURCERER_MAX_TOKENS_PER_RUN;
  }
});
