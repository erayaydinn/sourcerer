#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { agentsCommand, useCommand } from './agents.js';
import { costCommand } from './cost.js';
import { doctorCommand } from './doctor.js';
import { initCommand } from './init.js';
import { logsCommand } from './logs.js';
import { migrateCommand } from './migrate.js';
import { modelsAddCommand, modelsListCommand, modelsRemoveCommand } from './models.js';
import { startRepl } from './repl.js';
import { resolveRoot } from './root.js';
import { runCommand } from './run.js';
import { setupCommand } from './setup.js';
import { smokeCommand } from './smoke.js';
import { statusCommand } from './status.js';
import { validateCommand } from './validate.js';
import { worktreeCreateCommand, worktreeRemoveCommand } from './worktree.js';

const collect = (value, previous) => [...previous, value];

// Each action stores its exit code in `result.code`; print is injectable for tests.
export function buildProgram({ print = console.log, result = {} } = {}) {
  const program = new Command('sourcerer')
    .description('Orchestrator + subagent factory for a frontend and a backend repo')
    .option('--root <dir>', 'workspace with config/ and agents/ (default: SOURCERER_ROOT, a parent folder, or ~/.config/sourcerer)');
  // Every command except init needs an existing workspace.
  const act = (fn, { needsRoot = true } = {}) => async (...args) => {
    const command = args.at(-1);
    const options = command.optsWithGlobals();
    const root = needsRoot ? resolveRoot({ flag: options.root }) : options.root;
    result.code = await fn(...args.slice(0, -2), { ...options, root }, print);
  };

  program.command('init')
    .description('create a workspace: sourcerer.yaml (your choices) and .env')
    .argument('[dir]', 'folder (default: --root, SOURCERER_ROOT or ~/.config/sourcerer)')
    .action(act(initCommand, { needsRoot: false }));

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

  const models = program.command('models')
    .description('list LLM profiles (package + sourcerer.yaml) and who uses them')
    .action(act(modelsListCommand));
  models.command('add')
    .description('add or replace a profile in sourcerer.yaml (asks for anything not given)')
    .argument('[name]', 'profile name, e.g. cursor-high')
    .option('--cli <bin>', 'agent CLI: claude or cursor-agent')
    .option('--api <type>', 'API: openai-compat or anthropic')
    .option('--provider <vendor>', 'vendor behind the model, e.g. anthropic, openai, xai')
    .option('--model <name>', 'exact model name')
    .option('--base-url <url>', 'openai-compat endpoint')
    .option('--key-env <name>', 'env variable holding the API key')
    .option('--max-output-tokens <n>', 'API output limit (required for anthropic)')
    .option('--force', 'replace an existing profile without asking')
    .action(act(modelsAddCommand));
  models.command('remove')
    .description('remove a profile from sourcerer.yaml (refused while an agent uses it)')
    .argument('<name>', 'profile name')
    .action(act(modelsRemoveCommand));

  program.command('agents')
    .description('which profile and model each agent uses, and where that comes from')
    .action(act(agentsCommand));

  program.command('use')
    .description('save which profile an agent (or every agent of a role) uses, in sourcerer.yaml')
    .argument('<agent|role>', 'e.g. coder-backend, reviewer, coder')
    .argument('<profile>', 'profile name (see `sourcerer models`)')
    .option('--model <name>', 'model for this agent (default: the profile\'s model)')
    .option('--fallback <profile>', 'profile to retry with if a call fails')
    .action(act(useCommand));

  program.command('migrate')
    .description('move an old-layout workspace (config/ and agents/ copies) to sourcerer.yaml')
    .action(act(migrateCommand, { needsRoot: true }));

  program.command('doctor')
    .description('check tools, config, repos, keys (set/missing only) and pricing; exit 1 on any FAIL')
    .option('--smoke', 'also say hi through each profile (costs a few cents)')
    .action(act(doctorCommand, { needsRoot: false }));

  program.command('setup')
    .description('interactive: fill in what is missing (repos, roles, .env, .gitignore, CLI help, pricing rows)')
    .option('--refresh', 'save CLI --help files again even if they exist')
    .action(act(setupCommand, { needsRoot: false }));

  program.command('index')
    .description('build the vector index (not available yet)')
    .action(() => {
      print('Vector index not built yet (Phase 8b). Search uses git grep: search_code, find_symbol, search_docs.');
      result.code = 0;
    });

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
  const args = process.argv.slice(2);
  const result = {};
  try {
    // No subcommand (optionally --root <dir> and/or --plain): the TUI on a terminal, else the plain REPL.
    const plain = args.includes('--plain');
    const rest = args.filter((arg) => arg !== '--plain');
    if (rest.length === 0 || (rest.length === 2 && rest[0] === '--root')) {
      const rootFlag = rest[1];
      if (!plain && process.stdin.isTTY && process.stdout.isTTY) {
        const { startTui } = await import('../ui/tui.js');
        result.code = await startTui({ rootFlag });
      } else await startRepl({ rootFlag });
    } else await buildProgram({ result }).parseAsync();
  } catch (error) {
    console.error(`error: ${error instanceof Error ? error.message : error}`);
    result.code = 1;
  }
  process.exit(result.code ?? 0);
}
