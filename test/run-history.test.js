import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findRun, groupCost, listRuns, parseSince, readCalls } from '../src/core/run-history.js';

export function makeRuns() {
  const runsDir = mkdtempSync(join(tmpdir(), 'sourcerer-runs-'));
  const call = (role, llm, costUsd, costSource = 'reported') => ({ role, llm, model: 'm', round: 1, attempt: 1, status: 'ok', costUsd, costSource });
  const write = (id, files) => {
    mkdirSync(join(runsDir, id));
    for (const [name, data] of Object.entries(files)) writeFileSync(join(runsDir, id, name), JSON.stringify(data));
  };
  write('20261001-100000-old-task', {
    'planner.json': [call('planner', 'strong', 1)],
    'summary.json': { status: 'approved', totalUsd: 1, rounds: 1, unknownCostCalls: 0 },
  });
  write('20261017-090000-new-task', {
    'planner.json': [call('planner', 'strong', 0.5)],
    'coder-backend.json': [call('coder', 'strong', 1), call('coder', 'cheap', null, 'unknown')],
    'review.r1.json': { verdict: 'approve', comments: {} },
  });
  writeFileSync(join(runsDir, 'notes.txt'), 'not a run');
  return runsDir;
}

test('listRuns returns runs newest first with summaries', () => {
  const runs = listRuns(makeRuns());
  assert.deepEqual(runs.map((r) => r.id), ['20261017-090000-new-task', '20261001-100000-old-task']);
  assert.equal(runs[0].summary, null);
  assert.equal(runs[1].summary.status, 'approved');
  assert.deepEqual(runs[0].startedAt, new Date(2026, 9, 17, 9, 0, 0));
});

test('findRun: latest by default, unique prefix, clear errors', () => {
  const runs = listRuns(makeRuns());
  assert.equal(findRun(runs).id, '20261017-090000-new-task');
  assert.equal(findRun(runs, '20261001').id, '20261001-100000-old-task');
  assert.throws(() => findRun(runs, '2026'), /matches 2 runs/);
  assert.throws(() => findRun(runs, 'x'), /no run matches/);
  assert.throws(() => findRun([]), /no runs yet/);
});

test('readCalls reads agent call files only and groupCost totals by key', () => {
  const [latest] = listRuns(makeRuns());
  const calls = readCalls(latest);
  assert.equal(calls.length, 3);
  assert.deepEqual(groupCost(calls, 'role'), [
    { key: 'coder', costUsd: 1, calls: 2, unknown: 1 },
    { key: 'planner', costUsd: 0.5, calls: 1, unknown: 0 },
  ]);
  assert.deepEqual(groupCost(calls, 'agent').map((g) => g.key), ['coder-backend', 'planner']);
});

test('parseSince understands m, h and d', () => {
  assert.equal(parseSince('30m'), 30 * 60_000);
  assert.equal(parseSince('24h'), 24 * 3_600_000);
  assert.equal(parseSince('7d'), 7 * 86_400_000);
  assert.throws(() => parseSince('7w'), /30m, 24h or 7d/);
});
