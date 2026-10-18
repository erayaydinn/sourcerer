import { loadConfig } from '../core/config.js';
import { listRuns } from '../core/run-history.js';
import { table, usd } from './project.js';

export function statusCommand({ root, limit }, print) {
  const runs = listRuns(loadConfig(root).paths.runs).slice(0, Number(limit));
  if (!runs.length) {
    print('no runs yet');
    return 0;
  }
  const rows = runs.map(({ id, summary: s }) => s
    ? [id, s.status, s.rounds ?? '', usd(s.totalUsd), s.unknownCostCalls ?? 0]
    : [id, 'running/interrupted', '', '', '']);
  table([['RUN', 'STATUS', 'ROUNDS', 'COST', 'UNKNOWN'], ...rows], print);
  return 0;
}
