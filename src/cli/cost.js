import { loadConfig } from '../core/config.js';
import { findRun, groupCost, listRuns, parseSince, readCalls } from '../core/run-history.js';
import { table, usd } from './project.js';

const GROUPS = ['agent', 'role', 'llm'];

// One run (default: latest), or every run started within --since.
export function costCommand(runId, { root, since, by }, print) {
  if (!GROUPS.includes(by)) throw new Error(`--by expects ${GROUPS.join(', ')}, got "${by}"`);
  const runs = listRuns(loadConfig(root).paths.runs);
  const picked = since
    ? runs.filter((run) => run.startedAt.getTime() >= Date.now() - parseSince(since))
    : [findRun(runs, runId)];

  const calls = picked.flatMap(readCalls);
  print(since ? `${picked.length} runs in the last ${since}` : `run ${picked[0].id}`);
  if (!calls.length) {
    print('no calls');
    return 0;
  }
  const groups = groupCost(calls, by);
  const total = groups.reduce((sum, group) => sum + group.costUsd, 0);
  const unknown = groups.reduce((sum, group) => sum + group.unknown, 0);
  table([
    [by.toUpperCase(), 'COST', 'CALLS', 'UNKNOWN'],
    ...groups.map((group) => [group.key, usd(group.costUsd), group.calls, group.unknown]),
    ['total', usd(total), calls.length, unknown],
  ], print);
  if (unknown) print(`note: ${unknown} call(s) have unknown cost and count as $0`);
  return 0;
}
