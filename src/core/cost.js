import { readYaml } from './config.js';
import { pricingFile } from './schemas.js';

export function loadPricing(file) {
  return readYaml(file, pricingFile).models;
}

// inputTokens excludes cachedTokens; cached reads are priced separately.
export function priceUsage(model, usage, pricing) {
  const price = pricing[model];
  if (!price || !usage) return { costUsd: null, costSource: 'unknown' };
  const cachedPrice = price.cachedInput ?? price.input;
  const costUsd = (usage.inputTokens * price.input
    + usage.outputTokens * price.output
    + usage.cachedTokens * cachedPrice) / 1_000_000;
  return { costUsd, costSource: 'estimated' };
}

export function emptyUsage() {
  return { inputTokens: 0, outputTokens: 0, cachedTokens: 0 };
}

export function addUsage(total, usage) {
  total.inputTokens += usage.inputTokens;
  total.outputTokens += usage.outputTokens;
  total.cachedTokens += usage.cachedTokens;
}

export function createBudget(limits) {
  return { limits, totalUsd: 0, perAgent: {} };
}

// Unknown cost (null) counts as 0.
export function addCost(budget, agent, costUsd) {
  budget.totalUsd += costUsd ?? 0;
  budget.perAgent[agent] = (budget.perAgent[agent] ?? 0) + (costUsd ?? 0);
}

// Returns a message if a limit is exceeded, otherwise null.
export function overBudget(budget, agent) {
  const { maxCostPerRun, maxCostPerAgent } = budget.limits;
  if (budget.totalUsd > maxCostPerRun) return `run cost $${budget.totalUsd.toFixed(2)} is over maxCostPerRun $${maxCostPerRun}`;
  if (budget.perAgent[agent] > maxCostPerAgent) {
    return `${agent} cost $${budget.perAgent[agent].toFixed(2)} is over maxCostPerAgent $${maxCostPerAgent}`;
  }
  return null;
}
