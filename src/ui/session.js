import { costCommand } from '../cli/cost.js';
import { doctorCommand } from '../cli/doctor.js';
import { logsCommand } from '../cli/logs.js';
import { loadProject, reportProblems } from '../cli/project.js';
import { resolveRoot } from '../cli/root.js';
import { executeTask } from '../cli/run.js';
import { statusCommand } from '../cli/status.js';
import { createBus } from '../core/events.js';

export const HELP = `Type a task to start it. One task runs at a time.
  /status                       recent runs
  /cost [runId] [--by agent|role|llm] [--since 7d]
  /logs [runId] [--agent name]  print a run log
  /llm role=profile             session-only LLM override (/llm shows them, /llm clear removes them)
  /approve /reject              answer a budget question
  /stop                         stop the running task (also: Ctrl+C)
  /doctor                       check the setup
  /help  /exit                  (Ctrl+C twice also exits)`;

export const COMMANDS = ['status', 'cost', 'logs', 'llm', 'approve', 'reject', 'stop', 'doctor', 'help', 'exit'];

// The interactive session behind both the plain REPL and the TUI: a task queue, not a chatbot.
// hooks: change(snapshot) on any state change, task({ task, agents, bus }) when a task starts.
// `run` (fake agent runner) is only passed by tests.
export function createSession({ rootFlag, print, hooks = {}, run }) {
  const state = { task: null, controller: null, question: null, overrides: [], lastInterrupt: 0 };
  const snapshot = () => ({ task: state.task, question: state.question?.message ?? null, overrides: [...state.overrides] });
  const changed = () => hooks.change?.(snapshot());

  const root = () => {
    try {
      return resolveRoot({ flag: rootFlag });
    } catch (error) {
      print(`error: ${error.message}`);
      return null;
    }
  };
  const withRoot = async (fn) => {
    const dir = root();
    if (!dir) return;
    try {
      return await fn(dir);
    } catch (error) {
      print(`error: ${error.message}`);
    }
  };

  // Budget pause: resolved by y/n, /approve, /reject, or false on /stop.
  const confirm = (message) => new Promise((resolve) => {
    state.question = { message, resolve };
    print(`${message} (y/n)  [/approve, /reject, /stop]`); // message already ends with "Continue?"
    changed();
  });
  const answer = (yes) => {
    const { resolve } = state.question;
    state.question = null;
    resolve(yes);
    changed();
  };

  const stop = () => {
    if (!state.task) return print('no task is running');
    print('stopping... (running agents are killed, logs are kept)');
    state.controller.abort();
    if (state.question) answer(false);
  };

  const startTask = (task) => {
    if (state.task) return print(`a task is already running: "${state.task}" (/stop to stop it)`);
    const dir = root();
    if (!dir) return;
    let project;
    try {
      project = loadProject(dir, state.overrides);
    } catch (error) {
      return print(`error: ${error.message}`);
    }
    if (!reportProblems(project, print)) return;
    state.task = task;
    state.controller = new AbortController();
    const bus = createBus();
    hooks.task?.({ task, agents: project.defs.map((def) => def.name), bus });
    changed();
    return executeTask(task, { root: dir, project, confirm, signal: state.controller.signal, bus, run }, print)
      .catch((error) => print(`error: ${error.message}`))
      .finally(() => {
        state.task = null;
        state.controller = null;
        state.question = null;
        changed();
      });
  };

  const commands = {
    help: () => print(HELP),
    status: () => withRoot((dir) => statusCommand({ root: dir, limit: 10 }, print)),
    cost: (args) => withRoot((dir) => {
      const { positional, flags } = parseArgs(args);
      return costCommand(positional[0], { root: dir, by: flags.by ?? 'agent', since: flags.since }, print);
    }),
    logs: (args) => withRoot((dir) => {
      const { positional, flags } = parseArgs(args);
      return logsCommand(positional[0], { root: dir, agent: flags.agent }, print);
    }),
    llm: (args) => {
      if (!args.length) return print(state.overrides.length ? state.overrides.join('\n') : 'no overrides');
      if (args[0] === 'clear') {
        state.overrides = [];
        changed();
        return print('overrides cleared');
      }
      return withRoot((dir) => {
        const next = [...state.overrides.filter((pair) => !args.some((a) => a.split('=')[0] === pair.split('=')[0])), ...args];
        if (!reportProblems(loadProject(dir, next), print)) return;
        state.overrides = next;
        changed();
        print(`overrides for this session: ${next.join(', ')}`);
      });
    },
    approve: () => (state.question ? answer(true) : print('nothing to approve')),
    reject: () => (state.question ? answer(false) : print('nothing to reject')),
    stop,
    doctor: () => doctorCommand({ root: rootFlag }, print),
    exit: () => (state.task ? print('a task is running: /stop it first (or Ctrl+C twice)') : 'exit'),
  };

  // One line of input. Returns 'exit' when the session should end.
  async function handle(line) {
    const text = line.trim();
    if (state.question && /^(y|yes|n|no)$/i.test(text)) return answer(/^y/i.test(text));
    if (text.startsWith('/')) {
      const [name, ...args] = text.slice(1).split(/\s+/);
      if (!commands[name]) return print(`unknown command /${name} (try /help)`);
      try {
        return await commands[name](args);
      } catch (error) {
        return print(`error: ${error.message}`);
      }
    }
    if (text && state.question) return print('answer the budget question first: y/n, /approve, /reject or /stop');
    if (text) startTask(text);
  }

  // Ctrl+C: 'stopping' (task stopped), 'exit' (second press, or twice within 2s when idle), 'hint'.
  function interrupt() {
    if (state.task && !state.controller.signal.aborted) {
      stop();
      return 'stopping';
    }
    if (state.task || Date.now() - state.lastInterrupt < 2000) return 'exit';
    state.lastInterrupt = Date.now();
    return 'hint';
  }

  return { handle, interrupt, snapshot, root: () => root() };
}

// "/cost abc --by llm" -> { positional: ['abc'], flags: { by: 'llm' } }
function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) flags[args[i].slice(2)] = args[++i];
    else positional.push(args[i]);
  }
  return { positional, flags };
}
