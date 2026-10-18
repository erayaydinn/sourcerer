import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runAgent } from '../adapters/index.js';
import { loadConfig } from '../core/config.js';
import { loadPricing } from '../core/cost.js';

// Calls each LLM profile once with a tiny prompt. Costs real money.
export async function smokeCommand(profiles, { root }, print) {
  const config = loadConfig(root);
  const pricing = loadPricing(config.paths.pricing);
  const cwd = mkdtempSync(join(tmpdir(), 'sourcerer-smoke-'));
  let failed = false;

  for (const name of profiles.length ? profiles : Object.keys(config.llms)) {
    const profile = config.llms[name];
    if (!profile) { print(`${name}: unknown profile`); failed = true; continue; }
    if (profile.model.startsWith('<')) { print(`${name}: skipped, model not set`); continue; }
    const agent = { profile, model: profile.model, tools: [], timeoutSec: 120, maxTurns: 2, systemPrompt: '' };
    try {
      const result = await runAgent(agent, { prompt: 'Reply with just: hi', cwd, config, pricing });
      print(`${name}: ${JSON.stringify(result.output)} cost=${result.costUsd} (${result.costSource}) ${result.durationMs}ms`);
    } catch (error) {
      failed = true;
      print(`${name}: FAILED ${error instanceof Error ? error.message : error}`);
    }
  }
  return failed ? 1 : 0;
}
