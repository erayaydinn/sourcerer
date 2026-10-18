import { execa } from 'execa';
import { priceUsage } from '../core/cost.js';
import { gitDirOf, sandboxed } from '../core/sandbox.js';
import * as claude from './cli/claude.js';
import * as cursor from './cli/cursor.js';

// Keyed by profile `bin`. codex is added once its output is verified.
const RECIPES = { claude, 'cursor-agent': cursor };
export const CLI_BINS = Object.keys(RECIPES);

export async function runCli(profile, { prompt, system, cwd, readDirs, model, allowedTools, timeoutSec, pricing, onLog, signal, security }) {
  const recipe = RECIPES[profile.bin];
  if (!recipe) throw new Error(`no CLI recipe for "${profile.bin}"`);
  const fullPrompt = system ? `${system}\n\n${prompt}` : prompt;
  const { args, input } = recipe.command({ prompt: fullPrompt, model, cwd, readDirs, allowedTools, security });

  signal?.throwIfAborted();
  const started = Date.now();
  // Own process group, so stopping it also stops whatever the agent started (tests, servers, ...).
  const [bin, binArgs] = sandboxed(profile.bin, args, {
    security, write: [cwd, gitDirOf(cwd)].filter(Boolean), read: [...readDirs, ...readDirs.map(gitDirOf)].filter(Boolean),
  });
  const subprocess = execa(bin, binArgs, { cwd, input, timeout: timeoutSec * 1000, detached: true });
  const stop = () => killGroup(subprocess.pid);
  signal?.addEventListener('abort', stop, { once: true });
  if (onLog && recipe.logLine) streamLines(subprocess.stdout, (line) => {
    const text = safeLogLine(recipe, line);
    if (text) onLog(text);
  });
  let stdout;
  try {
    ({ stdout } = await subprocess);
  } catch (error) {
    stop();
    signal?.throwIfAborted();
    throw explainFailure(profile.bin, recipe, error, timeoutSec);
  } finally {
    signal?.removeEventListener('abort', stop);
  }
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

// SIGTERM the process group, then SIGKILL whatever is left. Group kill is POSIX-only (Windows needs WSL).
export function killGroup(pid) {
  const send = (sig) => {
    try {
      process.kill(-pid, sig);
    } catch {
      // already gone
    }
  };
  send('SIGTERM');
  setTimeout(() => send('SIGKILL'), 3000).unref();
}

// A short, readable error instead of execa's message (which embeds the whole stdout).
// Uses the recipe's own error when the stream ends in a failed result (rate limit, max turns, ...).
function explainFailure(bin, recipe, error, timeoutSec) {
  if (error.stdout && !error.timedOut) {
    try {
      recipe.parse(error.stdout);
    } catch (parsed) {
      if (parsed.cost || parsed.rateLimited) return parsed;
    }
  }
  const what = error.timedOut ? `timed out after ${timeoutSec}s` : `exited with code ${error.exitCode ?? '?'}`;
  const stderr = String(error.stderr ?? '').trim().split('\n').slice(-3).join(' ').slice(-300);
  return new Error(`${bin} ${what}${stderr ? `: ${stderr}` : ''}`);
}
