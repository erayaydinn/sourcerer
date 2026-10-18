import { runCli } from './cli.js';
import { runLoop } from './agent-loop.js';
import * as openaiCompat from './openai-compat.js';
import * as anthropic from './anthropic.js';

const APIS = { 'openai-compat': openaiCompat, anthropic };

// Runs one agent call and returns { output, usage, costUsd, costSource, durationMs }.
export function runAgent(agent, { prompt, cwd, readDirs = [], sources, config, pricing, onLog }) {
  const opts = {
    prompt,
    system: agent.systemPrompt,
    cwd: cwd ?? agent.cwd ?? process.cwd(),
    readDirs,
    sources,
    model: agent.model,
    allowedTools: agent.tools,
    timeoutSec: agent.timeoutSec,
    maxTurns: agent.maxTurns,
    toolConfig: config.tools,
    pricing,
    onLog,
  };
  if (agent.profile.type === 'cli') return runCli(agent.profile, opts);
  return runLoop(APIS[agent.profile.type], agent.profile, opts);
}
