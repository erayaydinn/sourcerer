import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// Live orchestrator events, one line each. Used by `sourcerer run` and the REPL.
export function printEvents(bus, print) {
  bus.on('agent.started', (e) => print(`> ${e.agent} started (${e.llm}, round ${e.round}, attempt ${e.attempt})`));
  bus.on('agent.finished', (e) => print(`< ${e.agent} ${e.status} $${e.costUsd ?? '?'} (${e.costSource}) ${Math.round(e.durationMs / 1000)}s${e.error ? ` ${e.error}` : ''}`));
  bus.on('tests.finished', (e) => print(`  tests ${e.side} round ${e.round}: ${e.passed ? 'passed' : 'FAILED'} -> ${e.file}`));
  bus.on('diff.ready', (e) => print(`  diff ${e.side}: ${e.filesChanged} files -> ${e.file}`));
  bus.on('review.requested', (e) => print(`  review requested (${e.agent}, round ${e.round}, ${e.sides.join(' + ')})`));
  bus.on('review.finished', (e) => print(`  review round ${e.round}: ${e.verdict}`));
  bus.on('cost.updated', (e) => print(`  total $${e.totalUsd.toFixed(4)}, ${e.totalTokens.toLocaleString('en-US')} tokens`));
}

// Final status, review comments, coder notes, worktrees and the total from summary.json.
export function printResult(result, print) {
  print(`\n${result.status}${result.error ? `: ${result.error}` : ''}`);
  for (const [where, comments] of Object.entries(result.finalComments ?? {})) {
    for (const comment of comments) print(`- [${where}] ${comment}`);
  }
  for (const [side, notes] of Object.entries(result.coderNotes ?? {})) {
    print(`\n--- ${side} coder notes (end of last answer) ---\n${notes.trim()}`);
  }
  const summaryFile = join(result.runDir, 'summary.json');
  if (existsSync(summaryFile)) {
    const summary = JSON.parse(readFileSync(summaryFile, 'utf8'));
    const unknown = summary.unknownCostCalls ? ` (${summary.unknownCostCalls} call(s) with unknown cost)` : '';
    const tokens = summary.totalTokens ? `, ${summary.totalTokens.toLocaleString('en-US')} tokens (input + output)` : '';
    print(`\ntotal cost: $${summary.totalUsd.toFixed(4)}${unknown}${tokens}`);
  }
  print(`run: ${result.runDir}`);
  for (const [side, dir] of Object.entries(result.worktrees)) print(`${side} worktree: ${dir}`);
}
