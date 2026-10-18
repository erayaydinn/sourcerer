import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { loadPricing } from '../core/cost.js';
import { createBus } from '../core/events.js';
import { createAgent } from '../core/factory.js';
import { checkSides, runTask } from '../core/orchestrator.js';
import { taskSlug } from '../git/worktree.js';
import { insideTmux, launch, openLogPanes, openShellWindow, quote } from '../ui/tmux.js';
import { loadProject, reportProblems } from './project.js';

const CLI = fileURLToPath(new URL('./index.js', import.meta.url));

export async function runCommand(task, { root, tmux, interactive, llm, side }, print) {
  const inPanes = process.env.SOURCERER_PANES === '1';
  const sides = side.length ? checkSides(side) : undefined;
  const project = loadProject(root, llm);
  if (!reportProblems(project, print)) return 1;

  // --tmux: re-run this command inside a tmux session/window, which then opens the panes.
  if (tmux && !inPanes) {
    const flags = [
      ...(interactive ? ['--interactive'] : []),
      ...llm.flatMap((pair) => ['--llm', quote(pair)]),
      ...(sides ?? []).flatMap((s) => ['--side', s]),
    ];
    const command = ['node', quote(CLI), '--root', quote(root), 'run', ...flags, quote(task)].join(' ');
    return launch({ name: `sourcerer-${taskSlug(task)}`, command, cwd: root, inside: insideTmux() });
  }

  const { config, defs } = project;
  const bus = createBus();
  printEvents(bus, print);
  if (inPanes) openPanesOn(bus, defs, interactive, print);
  else if (interactive) {
    bus.on('worktrees.ready', (e) => {
      for (const [side, dir] of Object.entries(e.worktrees)) print(`  ${side} worktree: ${dir}`);
    });
  }

  const result = await runTask(task, {
    config,
    agents: defs.map((def) => createAgent(def, config)),
    pricing: loadPricing(config.paths.pricing),
    bus,
    confirm: async (message) => (await ask(`${message} [y/N] `)) === 'y',
    pause: interactive ? pause : undefined,
    sides,
  });

  print(`\n${result.status}${result.error ? `: ${result.error}` : ''}`);
  for (const [where, comments] of Object.entries(result.finalComments ?? {})) {
    for (const comment of comments) print(`- [${where}] ${comment}`);
  }
  for (const [side, notes] of Object.entries(result.coderNotes ?? {})) {
    print(`\n--- ${side} coder notes (end of last answer) ---\n${notes.trim()}`);
  }
  print(`\nrun: ${result.runDir}`);
  for (const [side, dir] of Object.entries(result.worktrees)) print(`${side} worktree: ${dir}`);
  if (inPanes) {
    const session = process.env.SOURCERER_SESSION;
    print(`\nPanes stay open. Close them with: ${session ? `tmux kill-session -t ${session}` : 'tmux kill-window'}`);
  }
  return ['approved', 'changes-requested'].includes(result.status) ? 0 : 1;
}

function printEvents(bus, print) {
  bus.on('agent.started', (e) => print(`> ${e.agent} started (${e.llm}, round ${e.round}, attempt ${e.attempt})`));
  bus.on('agent.finished', (e) => print(`< ${e.agent} ${e.status} $${e.costUsd ?? '?'} (${e.costSource}) ${Math.round(e.durationMs / 1000)}s${e.error ? ` ${e.error}` : ''}`));
  bus.on('tests.finished', (e) => print(`  tests ${e.side} round ${e.round}: ${e.passed ? 'passed' : 'FAILED'} -> ${e.file}`));
  bus.on('diff.ready', (e) => print(`  diff ${e.side}: ${e.filesChanged} files -> ${e.file}`));
  bus.on('review.finished', (e) => print(`  review round ${e.round}: ${e.verdict}`));
  bus.on('cost.updated', (e) => print(`  total $${e.totalUsd.toFixed(4)}`));
}

function openPanesOn(bus, defs, interactive, print) {
  const report = (error) => print(`tmux: ${error instanceof Error ? error.message : error}`);
  const coders = ['frontend', 'backend'].flatMap((side) => defs.filter((def) => def.role === 'coder' && def.repo === side));
  const paneAgents = [...coders, ...defs.filter((def) => def.role === 'reviewer')].map((def) => def.name);
  bus.on('run.started', (e) => openLogPanes(e.runDir, paneAgents).catch(report));
  if (interactive) bus.on('worktrees.ready', (e) => openShellWindow(e.worktrees).catch(report));
}

async function ask(question) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim().toLowerCase();
}

// --interactive pause points. Empty answer means continue.
async function pause(message) {
  const answer = await ask(`${message} [C]ontinue / [s]kip / [a]bort `);
  return answer.startsWith('a') ? 'abort' : answer.startsWith('s') ? 'skip' : 'continue';
}
