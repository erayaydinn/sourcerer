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
  return { limits, totalUsd: 0, perAgent: {}, totalTokens: 0, perAgentTokens: {} };
}

// The tokens a token limit counts: input + output, not cache reads.
export function countedTokens(usage) {
  return usage ? usage.inputTokens + usage.outputTokens : 0;
}

// Unknown cost (null) and unknown usage count as 0.
export function addCost(budget, agent, costUsd, usage = null) {
  budget.totalUsd += costUsd ?? 0;
  budget.perAgent[agent] = (budget.perAgent[agent] ?? 0) + (costUsd ?? 0);
  budget.totalTokens += countedTokens(usage);
  budget.perAgentTokens[agent] = (budget.perAgentTokens[agent] ?? 0) + countedTokens(usage);
}

// Returns a message if a limit is exceeded, otherwise null. Token limits are optional.
export function overBudget(budget, agent) {
  const { maxCostPerRun, maxCostPerAgent, maxTokensPerRun, maxTokensPerAgent } = budget.limits;
  const tokens = (n) => n.toLocaleString('en-US');
  if (budget.totalUsd > maxCostPerRun) return `run cost $${budget.totalUsd.toFixed(2)} is over maxCostPerRun $${maxCostPerRun}`;
  if (budget.perAgent[agent] > maxCostPerAgent) {
    return `${agent} cost $${budget.perAgent[agent].toFixed(2)} is over maxCostPerAgent $${maxCostPerAgent}`;
  }
  if (maxTokensPerRun && budget.totalTokens > maxTokensPerRun) {
    return `run used ${tokens(budget.totalTokens)} tokens, over maxTokensPerRun ${tokens(maxTokensPerRun)}`;
  }
  if (maxTokensPerAgent && budget.perAgentTokens[agent] > maxTokensPerAgent) {
    return `${agent} used ${tokens(budget.perAgentTokens[agent])} tokens, over maxTokensPerAgent ${tokens(maxTokensPerAgent)}`;
  }
  return null;
}
