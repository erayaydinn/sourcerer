#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { costCommand } from './cost.js';
import { logsCommand } from './logs.js';
import { runCommand } from './run.js';
import { smokeCommand } from './smoke.js';
import { statusCommand } from './status.js';
import { validateCommand } from './validate.js';
import { worktreeCreateCommand, worktreeRemoveCommand } from './worktree.js';

// Sourcerer's own folder: config/, agents/ and runs/ live there.
const DEFAULT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const collect = (value, previous) => [...previous, value];

// Each action stores its exit code in `result.code`; print is injectable for tests.
export function buildProgram({ print = console.log, result = {} } = {}) {
  const program = new Command('sourcerer')
    .description('Orchestrator + subagent factory for a frontend and a backend repo')
    .option('--root <dir>', 'project folder with config/ and agents/', DEFAULT_ROOT);
  const globals = (command) => ({ ...command.optsWithGlobals(), root: resolve(command.optsWithGlobals().root) });
  const act = (fn) => async (...args) => {
    const command = args.at(-1);
    result.code = await fn(...args.slice(0, -2), { ...globals(command), ...args.at(-2) }, print);
  };

  program.command('run')
    .description('plan, code and review a task')
    .argument('<task...>', 'the task, quotes optional')
    .option('--tmux', 'one pane per agent')
    .option('--interactive', 'pause before each review and fix round')
    .option('--llm <role|agent=profile>', 'use another LLM profile (repeatable)', collect, [])
    .option('--side <side>', 'only work on frontend or backend (repeatable; default: planner decides)', collect, [])
    .action(act((task, options, print) => runCommand(task.join(' '), options, print)));

  program.command('status')
    .description('list recent runs')
    .option('-n, --limit <n>', 'how many runs', '10')
    .action(act(statusCommand));

  program.command('logs')
    .description('show a run log (default: latest run, orchestrator log)')
    .argument('[runId]', 'run id or unique prefix')
    .option('--agent <name>', 'show this agent\'s log')
    .option('-f, --follow', 'keep following the log')
    .action(act(logsCommand));

  program.command('cost')
    .description('cost of a run (default: latest), or of all runs with --since')
    .argument('[runId]', 'run id or unique prefix')
    .option('--since <window>', 'all runs started within e.g. 30m, 24h, 7d')
    .option('--by <group>', 'agent, role or llm', 'agent')
    .action(act(costCommand));

  program.command('validate')
    .description('check config and agents')
    .option('--llm <role|agent=profile>', 'check with an LLM override (repeatable)', collect, [])
    .action(act(validateCommand));

  program.command('smoke')
    .description('say hi to each LLM profile (costs money)')
    .argument('[profiles...]', 'profiles to test (default: all)')
    .action(act(smokeCommand));

  const worktree = program.command('worktree').description('create or remove task worktrees by hand');
  worktree.command('create')
    .argument('<task>', 'task text')
    .argument('[sides...]', 'frontend and/or backend (default: both)')
    .action(act(worktreeCreateCommand));
  worktree.command('remove')
    .argument('<slug>', 'task slug')
    .option('--force', 'discard uncommitted changes')
    .action(act(worktreeRemoveCommand));

  return program;
}

// Run only when executed directly (also through the `npm link` symlink), not when imported by tests.
if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = {};
  try {
    await buildProgram({ result }).parseAsync();
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : error}`);
    result.code = 1;
  }
  process.exit(result.code ?? 0);
}
