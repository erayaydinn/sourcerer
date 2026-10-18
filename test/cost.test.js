import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addCost, countedTokens, createBudget, overBudget, priceUsage } from '../src/core/cost.js';

const pricing = { m: { input: 2, output: 10, cachedInput: 0.5 } };

test('prices usage per 1M tokens', () => {
  const usage = { inputTokens: 1_000_000, outputTokens: 100_000, cachedTokens: 2_000_000 };
  assert.deepEqual(priceUsage('m', usage, pricing), { costUsd: 2 + 1 + 1, costSource: 'estimated' });
});

test('unknown model or missing usage is unknown', () => {
  const usage = { inputTokens: 1, outputTokens: 1, cachedTokens: 0 };
  assert.deepEqual(priceUsage('other', usage, pricing), { costUsd: null, costSource: 'unknown' });
  assert.equal(priceUsage('m', null, pricing).costSource, 'unknown');
});

test('token budget counts input + output (not cache reads) and is optional', () => {
  const usage = { inputTokens: 1000, outputTokens: 500, cachedTokens: 90000 };
  assert.equal(countedTokens(usage), 1500);
  assert.equal(countedTokens(null), 0);

  const noLimit = createBudget({ maxCostPerRun: 10, maxCostPerAgent: 10 });
  addCost(noLimit, 'coder', 0, { inputTokens: 10_000_000, outputTokens: 0, cachedTokens: 0 });
  assert.equal(overBudget(noLimit, 'coder'), null);

  const budget = createBudget({ maxCostPerRun: 10, maxCostPerAgent: 10, maxTokensPerRun: 3000, maxTokensPerAgent: 2000 });
  addCost(budget, 'coder', null, usage);
  assert.equal(overBudget(budget, 'coder'), null);
  addCost(budget, 'coder', null, usage);
  assert.equal(overBudget(budget, 'coder'), 'coder used 3,000 tokens, over maxTokensPerAgent 2,000');
  addCost(budget, 'reviewer', null, usage);
  assert.equal(overBudget(budget, 'reviewer'), 'run used 4,500 tokens, over maxTokensPerRun 3,000');
});
