import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { createBus } from '../core/events.js';
import { createAgent } from '../core/factory.js';
import { checkSides, runTask } from '../core/orchestrator.js';
import { taskSlug } from '../git/worktree.js';
import { insideTmux, launch, openLogPanes, openShellWindow, quote } from '../ui/tmux.js';
import { buildIndex } from '../rag/index.js';
import { relevantContext } from '../rag/search.js';
import { similarDefinitions } from '../rag/similar.js';
import { printEvents, printResult } from './print.js';
import { loadProject, reportProblems } from './project.js';

const CLI = fileURLToPath(new URL('./index.js', import.meta.url));

// Loads the project (unless given, already checked), wires live printing and runs one task.
// Shared by `sourcerer run` and the session. Returns null if the config has errors (already printed).
export async function executeTask(task, { root, llm = [], project: loaded, sides, confirm, pause, ask, signal, bus = createBus(), run }, print) {
  const project = loaded ?? loadProject(root, llm);
  if (!loaded && !reportProblems(project, print)) return null;
  const { config, defs } = project;
  printEvents(bus, print);
  const result = await runTask(task, {
    config,
    agents: defs.map((def) => createAgent(def, config)),
    pricing: config.pricing,
    bus, confirm, pause, ask, sides, signal, run,
    contextFor: config.rag.enabled ? (input) => repoContext(config, root, input, print) : undefined,
    similarFor: config.rag.enabled ? (input) => similarCode(config, root, input, print) : undefined,
  });
  printResult(result, print);
  return result;
}

export async function runCommand(task, { root, tmux, interactive, llm, side }, print) {
  const inPanes = process.env.SOURCERER_PANES === '1';
  const sides = side.length ? checkSides(side) : undefined;

  // --tmux: re-run this command inside a tmux session/window, which then opens the panes.
  if (tmux && !inPanes) {
    if (!reportProblems(loadProject(root, llm), print)) return 1;
    const flags = [
      ...(interactive ? ['--interactive'] : []),
      ...llm.flatMap((pair) => ['--llm', quote(pair)]),
      ...(sides ?? []).flatMap((s) => ['--side', s]),
    ];
    const command = ['node', quote(CLI), '--root', quote(root), 'run', ...flags, quote(task)].join(' ');
    return launch({ name: `sourcerer-${taskSlug(task)}`, command, cwd: root, inside: insideTmux() });
  }

  // Agents run in their own process group, so Ctrl+C must be handled here:
  // once stops the task cleanly (logs kept), twice exits.
  const controller = new AbortController();
  const onInterrupt = () => {
    if (controller.signal.aborted) process.exit(130);
    print('\nstopping... (Ctrl+C again to exit now)');
    controller.abort();
  };
  process.on('SIGINT', onInterrupt);
  const prompt = async (question) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.on('SIGINT', onInterrupt);
    try {
      return (await rl.question(question, { signal: controller.signal })).trim();
    } catch {
      return '';
    } finally {
      rl.close();
    }
  };

  const bus = createBus();
  if (inPanes) openPanesOn(bus, loadProject(root, llm).defs, interactive, print);
  else if (interactive) {
    bus.on('worktrees.ready', (e) => {
      for (const [s, dir] of Object.entries(e.worktrees)) print(`  ${s} worktree: ${dir}`);
    });
  }

  try {
    const result = await executeTask(task, {
      root, llm, sides, bus, signal: controller.signal,
      confirm: async (message) => (await prompt(`${message} [y/N] `)).toLowerCase() === 'y',
      // --interactive pause points. Empty answer means continue.
      pause: interactive ? async (message) => {
        const answer = (await prompt(`${message} [C]ontinue / [s]kip / [a]bort `)).toLowerCase();
        return answer.startsWith('a') ? 'abort' : answer.startsWith('s') ? 'skip' : 'continue';
      } : undefined,
      // Planner questions, only when someone is at the terminal. Empty answer leaves it to the planner.
      ask: process.stdin.isTTY ? (questions) => askEach(questions, prompt, print) : undefined,
    }, print);
    if (!result) return 1;
    if (inPanes) {
      const session = process.env.SOURCERER_SESSION;
      print(`\nPanes stay open. Close them with: ${session ? `tmux kill-session -t ${session}` : 'tmux kill-window'}`);
    }
    return ['approved', 'changes-requested'].includes(result.status) ? 0 : 1;
  } finally {
    process.off('SIGINT', onInterrupt);
  }
}

async function askEach(questions, prompt, print) {
  print(`\nThe planner has ${questions.length} question(s) (Enter to skip one):`);
  const answers = [];
  for (const [i, question] of questions.entries()) answers.push(await prompt(`${i + 1}. ${question}\n> `));
  return answers;
}

function openPanesOn(bus, defs, interactive, print) {
  const report = (error) => print(`tmux: ${error instanceof Error ? error.message : error}`);
  const coders = ['frontend', 'backend'].flatMap((side) => defs.filter((def) => def.role === 'coder' && def.repo === side));
  const paneAgents = [...coders, ...defs.filter((def) => def.role === 'reviewer')].map((def) => def.name);
  bus.on('run.started', (e) => openLogPanes(e.runDir, paneAgents).catch(report));
  if (interactive) bus.on('worktrees.ready', (e) => openShellWindow(e.worktrees).catch(report));
}

// Existing definitions that resemble what the diff adds, for the reviewer. Never fails the run.
async function similarCode(config, root, { side, diff, worktree }, print) {
  try {
    return await similarDefinitions(config, root, side, { diff, worktree });
  } catch (error) {
    print(`  similar code ${side}: ${error instanceof Error ? error.message : error} (continuing without it)`);
    return '';
  }
}

// Updates the side's index (fast when the base is unchanged) and returns the coder context.
// Search problems never fail the run: they are printed and the coder just gets no context.
async function repoContext(config, root, { side, task, plan, worktree }, print) {
  try {
    const built = await buildIndex(config, root, side);
    if (!built.upToDate) print(`  index ${side}: ${built.files} files (${built.analyzed} analyzed) in ${(built.ms / 1000).toFixed(1)}s`);
    const query = [plan.instructions[side], plan.contract, task].join('\n');
    const { text, files } = await relevantContext(config, root, side, query, worktree);
    if (files.length) print(`  context ${side}: ${files.length} likely relevant files`);
    return text;
  } catch (error) {
    print(`  rag ${side}: ${error instanceof Error ? error.message : error} (continuing without context)`);
    return '';
  }
}
