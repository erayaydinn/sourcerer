import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceUsage } from '../src/core/cost.js';

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
