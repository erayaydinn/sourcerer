import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const RUN_ID = /^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})(\d{2})-/;

// Runs newest first: { id, dir, startedAt, summary | null }.
export function listRuns(runsDir) {
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir)
    .filter((name) => RUN_ID.test(name))
    .sort()
    .reverse()
    .map((id) => {
      const summaryFile = join(runsDir, id, 'summary.json');
      const summary = existsSync(summaryFile) ? JSON.parse(readFileSync(summaryFile, 'utf8')) : null;
      return { id, dir: join(runsDir, id), startedAt: runTime(id), summary };
    });
}

function runTime(id) {
  const [, year, month, day, hour, minute, second] = id.match(RUN_ID).map(Number);
  return new Date(year, month - 1, day, hour, minute, second);
}

// No prefix means the latest run. A prefix must match exactly one run.
export function findRun(runs, prefix) {
  if (!runs.length) throw new Error('no runs yet');
  if (!prefix) return runs[0];
  const matches = runs.filter((run) => run.id.startsWith(prefix));
  if (matches.length === 1) return matches[0];
  throw new Error(matches.length ? `"${prefix}" matches ${matches.length} runs` : `no run matches "${prefix}"`);
}

// Every call from the run's <agent>.json files (the JSON files that hold arrays).
export function readCalls(run) {
  return readdirSync(run.dir)
    .filter((file) => file.endsWith('.json'))
    .flatMap((file) => {
      const data = JSON.parse(readFileSync(join(run.dir, file), 'utf8'));
      if (!Array.isArray(data)) return [];
      return data.map((call) => ({ runId: run.id, agent: file.slice(0, -'.json'.length), ...call }));
    });
}

// Groups calls by agent, role or llm: [{ key, costUsd, calls, unknown }], most expensive first.
export function groupCost(calls, by) {
  const groups = {};
  for (const call of calls) {
    const group = (groups[call[by]] ??= { key: call[by], costUsd: 0, calls: 0, unknown: 0 });
    group.costUsd += call.costUsd ?? 0;
    group.calls += 1;
    if (call.costSource === 'unknown') group.unknown += 1;
  }
  return Object.values(groups).sort((a, b) => b.costUsd - a.costUsd);
}

// "30m", "24h", "7d" -> milliseconds.
export function parseSince(text) {
  const match = /^(\d+)([mhd])$/.exec(text);
  if (!match) throw new Error(`--since expects something like 30m, 24h or 7d, got "${text}"`);
  return Number(match[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[match[2]];
}
