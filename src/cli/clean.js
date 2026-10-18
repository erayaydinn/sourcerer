import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../core/config.js';
import { listRuns, parseSince } from '../core/run-history.js';

// Deletes run logs (prompts, diffs, agent output) and/or the search index. Worktrees are never touched:
// they may hold work you have not committed (use `sourcerer worktree remove`).
export function cleanCommand({ root, runs, index, olderThan, yes }, print) {
  if (!runs && !index) throw new Error('say what to delete: --runs and/or --index');
  const config = loadConfig(root, { allowMissingRepos: true });
  const targets = [];
  if (runs) {
    const cutoff = olderThan ? Date.now() - parseSince(olderThan) : Infinity;
    for (const run of listRuns(config.paths.runs)) if (run.startedAt.getTime() < cutoff) targets.push(run.dir);
  }
  if (index && existsSync(join(root, 'index'))) targets.push(join(root, 'index'));
  if (!targets.length) {
    print('nothing to delete');
    return 0;
  }
  const size = targets.reduce((sum, path) => sum + du(path), 0);
  print(`${yes ? 'deleting' : 'would delete'} ${targets.length} item(s), ${(size / 1024 / 1024).toFixed(1)} MB:`);
  for (const path of targets.slice(0, 20)) print(`  ${path}`);
  if (targets.length > 20) print(`  ... and ${targets.length - 20} more`);
  if (!yes) {
    print('run again with --yes to delete');
    return 0;
  }
  for (const path of targets) rmSync(path, { recursive: true, force: true });
  print('deleted');
  return 0;
}

function du(path) {
  const stat = statSync(path);
  if (!stat.isDirectory()) return stat.size;
  return readdirSync(path).reduce((sum, name) => sum + du(join(path, name)), 0);
}
