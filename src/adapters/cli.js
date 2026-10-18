import { execa } from 'execa';
import { priceUsage } from '../core/cost.js';
import * as claude from './cli/claude.js';
import * as cursor from './cli/cursor.js';

// Keyed by profile `bin`. codex is added once its output is verified.
const RECIPES = { claude, 'cursor-agent': cursor };

export async function runCli(profile, { prompt, system, cwd, readDirs, model, allowedTools, timeoutSec, pricing, onLog }) {
  const recipe = RECIPES[profile.bin];
  if (!recipe) throw new Error(`no CLI recipe for "${profile.bin}"`);
  const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
  const { args, input } = recipe.command({ prompt: fullPrompt, model, cwd, readDirs, allowedTools });

  const started = Date.now();
  const subprocess = execa(profile.bin, args, { cwd, input, timeout: timeoutSec * 1000 });
  if (onLog && recipe.logLine) streamLines(subprocess.stdout, (line) => {
    const text = safeLogLine(recipe, line);
    if (text) onLog(text);
  });
  const { stdout } = await subprocess;
  const parsed = recipe.parse(stdout);

  const cost = typeof parsed.costUsd === 'number'
    ? { costUsd: parsed.costUsd, costSource: 'reported' }
    : priceUsage(model, parsed.usage, pricing);
  return { output: parsed.output, usage: parsed.usage, ...cost, durationMs: Date.now() - started };
}

function streamLines(stream, onLine) {
  let buffer = '';
  stream.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split('\n');
    buffer = lines.pop();
    for (const line of lines) if (line.trim()) onLine(line);
  });
}

// A log line that fails to parse must never break the run.
function safeLogLine(recipe, line) {
  try {
    return recipe.logLine(line);
  } catch {
    return null;
  }
}
