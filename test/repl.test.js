import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import { execa } from 'execa';
import { startRepl } from '../src/cli/repl.js';

const temp = (name) => mkdtempSync(join(tmpdir(), `sourcerer-${name}-`));

async function gitRepo() {
  const dir = temp('repo');
  await execa('git', ['init', '-q', '-b', 'main'], { cwd: dir });
  writeFileSync(join(dir, 'README.md'), 'x');
  await execa('git', ['add', '.'], { cwd: dir });
  await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: dir });
  return dir;
}

async function workspace(budget = '') {
  const root = temp('ws');
  writeFileSync(join(root, 'sourcerer.yaml'), '# test workspace\n');
  writeFileSync(join(root, '.env'), `SOURCERER_FRONTEND=${await gitRepo()}\nSOURCERER_BACKEND=${await gitRepo()}\n${budget}`);
  return root;
}

const block = (data) => `\`\`\`json\n${JSON.stringify(data)}\n\`\`\``;
const result = (output, costUsd = 0.5) => ({ output, usage: null, costUsd, costSource: 'reported', durationMs: 1 });

// Fake agents: planner picks backend, coder can be held open with `gate`, reviewer approves.
function fakeRun({ gate } = {}) {
  return async (agent, opts) => {
    if (agent.role === 'planner') return result(block({ sides: ['backend'], contract: 'c', instructions: { backend: 'b' } }));
    if (agent.role === 'coder') {
      if (gate) await Promise.race([gate, new Promise((_, reject) => opts.signal.addEventListener('abort', () => reject(opts.signal.reason)))]);
      return result('coded');
    }
    return result(block({ verdict: 'approve', comments: {} }));
  };
}

function repl(root, run) {
  const input = new PassThrough();
  const output = new PassThrough();
  let text = '';
  output.on('data', (chunk) => { text += chunk; });
  const closed = startRepl({ rootFlag: root, input, output, run });
  const send = (line) => input.write(`${line}\n`);
  const waitFor = async (pattern, after = 0) => {
    for (let i = 0; i < 200; i++) {
      if (pattern.test(text.slice(after))) return text.length;
      await sleep(25);
    }
    throw new Error(`timed out waiting for ${pattern}\n--- output ---\n${text}`);
  };
  return { send, waitFor, closed, output: () => text };
}

test('plain text runs a task with live events; one task at a time; total cost at the end', async () => {
  const root = await workspace();
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const r = repl(root, fakeRun({ gate }));
  r.send('Add ping');
  await r.waitFor(/> coder-backend started/);
  r.send('Another task');
  await r.waitFor(/a task is already running: "Add ping" \(\/stop to stop it\)/);
  release();
  await r.waitFor(/review requested \(reviewer, round 1, backend\)/);
  await r.waitFor(/approved\n[\s\S]*total cost: \$1\.5000/);
  assert.match(r.output(), /> planner started[\s\S]*< planner ok \$0\.5[\s\S]*diff backend: 0 files[\s\S]*total \$1\.5000/);
  r.send('/exit');
  await r.closed;
});

test('budget pause: /approve continues, /reject stops the run', async () => {
  const root = await workspace('SOURCERER_MAX_COST_PER_RUN=0.1\n');
  const r = repl(root, fakeRun());
  r.send('Approve me');
  await r.waitFor(/over maxCostPerRun \$0\.1\. Continue\? \(y\/n\) {2}\[\/approve, \/reject, \/stop\]/);
  assert.doesNotMatch(r.output(), /Continue\? Continue\?/);
  r.send('/approve');
  const mark = await r.waitFor(/Continue\? \(y\/n\)/, r.output().length);
  r.send('y');
  await r.waitFor(/Continue\? \(y\/n\)/, mark);
  r.send('/approve');
  await r.waitFor(/\napproved\n/);

  const after = r.output().length;
  r.send('Reject me');
  await r.waitFor(/Continue\? \(y\/n\)/, after);
  r.send('/reject');
  await r.waitFor(/stopped-budget: run cost \$0\.50 is over maxCostPerRun/, after);
  r.send('/exit');
  await r.closed;
});

test('/stop during a budget pause ends the run as aborted', async () => {
  const root = await workspace('SOURCERER_MAX_COST_PER_RUN=0.1\n');
  const r = repl(root, fakeRun());
  r.send('Stop me');
  await r.waitFor(/Continue\? \(y\/n\)/);
  r.send('/stop');
  await r.waitFor(/stopping\.\.\./);
  await r.waitFor(/\naborted/);
  r.send('/exit');
  await r.closed;
});

test('/stop while an agent runs kills it and ends aborted; /exit is refused while running', async () => {
  const root = await workspace();
  const r = repl(root, fakeRun({ gate: new Promise(() => {}) }));
  r.send('Long task');
  await r.waitFor(/> coder-backend started/);
  r.send('/exit');
  await r.waitFor(/a task is running: \/stop it first/);
  r.send('/stop');
  await r.waitFor(/\naborted/);
  r.send('/exit');
  await r.closed;
});

test('/llm validates and keeps a session override; /status, /cost, /help and unknown commands', async () => {
  const root = await workspace();
  const r = repl(root, fakeRun());
  r.send('/llm coder=gpt-api');
  await r.waitFor(/error: coder-backend: coder llm "gpt-api" has editsFiles: false/);
  r.send('/llm reviewer=claude-cheap');
  await r.waitFor(/overrides for this session: reviewer=claude-cheap/);
  r.send('Task with override');
  await r.waitFor(/> reviewer started \(claude-cheap/);
  await r.waitFor(/\napproved\n/);
  r.send('/status');
  await r.waitFor(/approved\s+1\s+\$1\.5000/);
  r.send('/cost --by llm');
  await r.waitFor(/claude-cheap\s+\$0\.5000/);
  r.send('/nope');
  await r.waitFor(/unknown command \/nope \(try \/help\)/);
  r.send('/help');
  await r.waitFor(/\/approve \/reject/);
  r.send('/exit');
  await r.closed;
});

test('/use saves a per-agent choice, /agents shows it, /models lists profiles', async () => {
  const root = await workspace();
  const r = repl(root, fakeRun());
  r.send('/use coder-backend claude-cheap --model sonnet');
  await r.waitFor(/coder-backend -> claude-cheap \(sonnet\)/);
  r.send('/agents');
  await r.waitFor(/coder-backend\s+coder\s+claude-cheap\s+sourcerer\.yaml\s+sonnet\s+sourcerer\.yaml/);
  r.send('/use coder gpt-api');
  await r.waitFor(/error: not saved: .*editsFiles: false/);
  r.send('/models add mine --cli cursor-agent --provider xai');
  await r.waitFor(/error: missing model/);
  r.send('/models');
  await r.waitFor(/claude-cheap\s+claude\s+anthropic\s+sonnet\s+package\s+\S+\s+coder-backend/);
  r.send('/exit');
  await r.closed;
});

test('REPL: planner questions are answered line by line (empty skips one)', async () => {
  const root = await workspace();
  const prompts = [];
  const base = fakeRun();
  const run = async (agent, opts) => {
    if (agent.role !== 'planner') return base(agent, opts);
    prompts.push(opts.prompt);
    return prompts.length === 1 ? result(block({ questions: ['Which field?', 'Rate limit?'] })) : base(agent, opts);
  };
  const r = repl(root, run);
  r.send('Login');
  await r.waitFor(/1\/2\. Which field\?/);
  r.send('yes, email');
  await r.waitFor(/2\/2\. Rate limit\?/);
  r.send('');
  await r.waitFor(/approved/);
  assert.match(prompts[1], /A: yes, email/);
  assert.match(prompts[1], /Q: Rate limit\?\nA: \(no answer/);
  r.send('/exit');
  await r.closed;
});
