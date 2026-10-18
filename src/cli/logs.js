import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { execa } from 'execa';
import { loadConfig } from '../core/config.js';
import { findRun, listRuns } from '../core/run-history.js';

export async function logsCommand(runId, { root, agent, follow }, print) {
  const run = findRun(listRuns(loadConfig(root).paths.runs), runId);
  const file = join(run.dir, `${agent ?? 'orchestrator'}.log`);
  if (follow) {
    await execa('tail', ['-n', '+1', '-F', file], { stdio: 'inherit', reject: false });
    return 0;
  }
  if (!existsSync(file)) {
    print(`no log yet: ${file}`);
    return 1;
  }
  print(readFileSync(file, 'utf8').trimEnd());
  return 0;
}
