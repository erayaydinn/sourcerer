import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execa } from 'execa';
import { createBus } from '../src/core/events.js';
import { runTask } from '../src/core/orchestrator.js';

async function makeRepo(root, name) {
  const path = join(root, name);
  await execa('git', ['init', '-q', '-b', 'main', path]);
  writeFileSync(join(path, 'README.md'), name);
  await execa('git', ['add', '.'], { cwd: path });
  await execa('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-q', '-m', 'init'], { cwd: path });
  return path;
}

async function setup(budget = { maxCostPerRun: 10, maxCostPerAgent: 10 }, { maxRounds = 3, test } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sourcerer-orch-'));
  const config = {
    repos: {
      frontend: { path: await makeRepo(root, 'fe'), base: 'main' },
      backend: { path: await makeRepo(root, 'be'), base: 'main', test },
    },
    paths: { runs: join(root, 'runs'), worktrees: join(root, 'worktrees') },
    budget,
    review: { maxRounds, testOutputChars: 50 },
    tools: {},
  };
  const profile = (provider) => ({ type: 'cli', bin: 'x', provider, model: `${provider}-model` });
  const agent = (name, role, repo) => ({
    name, role, repo, llm: `${name}-llm`, model: 'm', profile: profile(name), fallback: null, tools: [],
  });
  const agents = [
    agent('planner', 'planner'),
    agent('coder-frontend', 'coder', 'frontend'),
    agent('coder-backend', 'coder', 'backend'),
    agent('reviewer', 'reviewer'),
  ];
  return { config, agents };
}

const json = (data) => `done\n\`\`\`json\n${JSON.stringify(data)}\n\`\`\``;
const plan = (sides) => json({ sides, contract: 'GET /hello -> { msg: string }', instructions: { frontend: 'show it', backend: 'serve it' } });
const approve = json({ verdict: 'approve', comments: {} });
const changes = (comments) => json({ verdict: 'request-changes', comments });
const result = (output, costUsd = 0.5) => ({ output, usage: null, costUsd, costSource: 'reported', durationMs: 1 });

// Fake runner: planner plans, coders write a file in their cwd, reviewer approves.
function fakeRun(sides, overrides = {}) {
  return async (agent, opts) => {
    if (overrides[agent.name]) return overrides[agent.name](agent, opts);
    if (agent.role === 'planner') return result(plan(sides));
    if (agent.role === 'coder') {
      writeFileSync(join(opts.cwd, `${agent.repo}.js`), 'code');
      return result('coded');
    }
    return result(approve);
  };
}

const deny = async () => false;

test('full flow: plan, both worktrees, coders, diffs, review, summary', async () => {
  const { config, agents } = await setup();
  let reviewPrompt = '';
  const run = fakeRun(['frontend', 'backend'], {
    reviewer: async (agent, opts) => {
      reviewPrompt = opts.prompt;
      return result(approve);
    },
  });
  const out = await runTask('Hello endpoint', { config, agents, pricing: {}, bus: createBus(), confirm: deny, run });

  assert.equal(out.status, 'approved');
  assert.ok(existsSync(join(out.worktrees.frontend, 'frontend.js')));
  assert.match(reviewPrompt, /\+\+\+ b\/backend\.js/);
  assert.match(reviewPrompt, /GET \/hello/);

  const summary = JSON.parse(readFileSync(join(out.runDir, 'summary.json'), 'utf8'));
  assert.equal(summary.totalUsd, 2);
  assert.deepEqual(summary.perAgent, { planner: 0.5, 'coder-frontend': 0.5, 'coder-backend': 0.5, reviewer: 0.5 });
  assert.equal(summary.perLlm['reviewer-llm'], 0.5);
  assert.equal(summary.reviewRounds, 1);
  assert.equal(JSON.parse(readFileSync(join(out.runDir, 'coder-backend.json'), 'utf8')).length, 1);
  assert.match(readFileSync(join(out.runDir, 'orchestrator.log'), 'utf8'), /diff\.ready/);
  assert.equal(readFileSync(join(out.runDir, 'contract.txt'), 'utf8'), 'GET /hello -> { msg: string }');
  assert.equal(await execa('git', ['branch', '--show-current'], { cwd: config.repos.frontend.path }).then((r) => r.stdout), 'main');
});

test('planner picking one side creates one worktree and runs one coder', async () => {
  const { config, agents } = await setup();
  const ran = [];
  const base = fakeRun(['backend']);
  const run = (agent, opts) => { ran.push(agent.name); return base(agent, opts); };
  const out = await runTask('Backend only', { config, agents, pricing: {}, bus: createBus(), confirm: deny, run });
  assert.deepEqual(Object.keys(out.worktrees), ['backend']);
  assert.deepEqual(ran, ['planner', 'coder-backend', 'reviewer']);
});

test('failed call is retried once with fallbackLlm', async () => {
  const { config, agents } = await setup();
  const coder = agents.find((a) => a.name === 'coder-backend');
  coder.fallbackLlm = 'backup';
  coder.fallback = { type: 'cli', bin: 'y', provider: 'p', model: 'backup-model' };
  const base = fakeRun(['backend']);
  const run = async (agent, opts) => {
    if (agent.name === 'coder-backend' && agent.model === 'm') throw new Error('rate limited');
    return base(agent, opts);
  };
  const out = await runTask('Retry', { config, agents, pricing: {}, bus: createBus(), confirm: deny, run });
  assert.equal(out.status, 'approved');
  const calls = JSON.parse(readFileSync(join(out.runDir, 'coder-backend.json'), 'utf8'));
  assert.deepEqual(calls.map((c) => [c.attempt, c.status, c.model]), [[1, 'failed', 'm'], [2, 'ok', 'backup-model']]);
});

test('stops when over budget and the user says no', async () => {
  const { config, agents } = await setup({ maxCostPerRun: 1, maxCostPerAgent: 10 });
  const questions = [];
  const confirm = async (message) => { questions.push(message); return false; };
  const out = await runTask('Expensive', { config, agents, pricing: {}, bus: createBus(), confirm, run: fakeRun(['frontend', 'backend']) });
  assert.equal(out.status, 'stopped-budget');
  assert.equal(questions.length, 1);
  assert.match(questions[0], /over maxCostPerRun/);
  const summary = JSON.parse(readFileSync(join(out.runDir, 'summary.json'), 'utf8'));
  assert.equal(summary.status, 'stopped-budget');
  assert.ok(!summary.perAgent.reviewer);
});

test('continues over budget when the user says yes', async () => {
  const { config, agents } = await setup({ maxCostPerRun: 10, maxCostPerAgent: 0.1 });
  let asked = 0;
  const confirm = async () => { asked++; return true; };
  const out = await runTask('Allowed', { config, agents, pricing: {}, bus: createBus(), confirm, run: fakeRun(['backend']) });
  assert.equal(out.status, 'approved');
  assert.equal(asked, 3);
});

test('invalid planner JSON fails the run before any worktree', async () => {
  const { config, agents } = await setup();
  const run = fakeRun([], { planner: async () => result('no json here') });
  const out = await runTask('Broken plan', { config, agents, pricing: {}, bus: createBus(), confirm: deny, run });
  assert.equal(out.status, 'failed');
  assert.match(out.error, /planner: no json block/);
  assert.deepEqual(out.worktrees, {});
});

// Records each call as "name:round" and returns prompts per agent.
function recorder(sides, overrides) {
  const calls = [];
  const prompts = {};
  const base = fakeRun(sides, overrides);
  const run = (agent, opts) => {
    (prompts[agent.name] ??= []).push(opts.prompt);
    // Coder rounds come from the prompt; reviewer rounds are counted.
    const round = agent.role === 'reviewer'
      ? prompts[agent.name].length
      : (opts.prompt.match(/fix round (\d+)/) ?? [null, '1'])[1];
    calls.push(agent.role === 'planner' ? agent.name : `${agent.name}:${round}`);
    return base(agent, opts);
  };
  return { run, calls, prompts };
}

test('request-changes with no rounds left is reported', async () => {
  const { config, agents } = await setup(undefined, { maxRounds: 1 });
  const run = fakeRun(['frontend'], { reviewer: async () => result(changes({ frontend: ['missing test'] })) });
  const out = await runTask('Needs work', { config, agents, pricing: {}, bus: createBus(), confirm: deny, run });
  assert.equal(out.status, 'changes-requested');
  assert.equal(out.rounds, 1);
  assert.deepEqual(out.finalComments.frontend, ['missing test']);
});

test('feedback goes only to the commented side, then round 2 is approved', async () => {
  const { config, agents } = await setup();
  let reviews = 0;
  const reviewer = async () => result(++reviews === 1 ? changes({ backend: ['validate name'], general: ['add docs'] }) : approve);
  const { run, calls, prompts } = recorder(['frontend', 'backend'], { reviewer });
  const out = await runTask('Two rounds', { config, agents, pricing: {}, bus: createBus(), confirm: deny, run });

  assert.equal(out.status, 'approved');
  assert.equal(out.rounds, 2);
  assert.deepEqual(calls.filter((c) => c.startsWith('coder')).sort(), ['coder-backend:1', 'coder-backend:2', 'coder-frontend:1']);
  assert.match(prompts['coder-backend'][1], /- validate name\n- add docs/);
  assert.match(prompts.reviewer[1], /previous round[\s\S]*validate name/);

  const summary = JSON.parse(readFileSync(join(out.runDir, 'summary.json'), 'utf8'));
  assert.deepEqual([summary.rounds, summary.reviewRounds], [2, 2]);
  assert.ok(existsSync(join(out.runDir, 'review.r1.json')) && existsSync(join(out.runDir, 'backend.r2.diff')));
  const backendCalls = JSON.parse(readFileSync(join(out.runDir, 'coder-backend.json'), 'utf8'));
  assert.deepEqual(backendCalls.map((c) => c.round), [1, 2]);
});

test('only general comments rerun every side', async () => {
  const { config, agents } = await setup(undefined, { maxRounds: 2 });
  let reviews = 0;
  const reviewer = async () => result(++reviews === 1 ? changes({ general: ['rename field'] }) : approve);
  const { run, calls } = recorder(['frontend', 'backend'], { reviewer });
  await runTask('General', { config, agents, pricing: {}, bus: createBus(), confirm: deny, run });
  assert.deepEqual(calls.filter((c) => c.startsWith('coder') && c.endsWith(':2')).sort(), ['coder-backend:2', 'coder-frontend:2']);
});

test('stops after maxRounds of request-changes', async () => {
  const { config, agents } = await setup();
  const { run, calls } = recorder(['backend'], { reviewer: async () => result(changes({ backend: ['still wrong'] })) });
  const out = await runTask('Never good', { config, agents, pricing: {}, bus: createBus(), confirm: deny, run });
  assert.equal(out.status, 'changes-requested');
  assert.equal(out.rounds, 3);
  assert.deepEqual(calls, ['planner', 'coder-backend:1', 'reviewer:1', 'coder-backend:2', 'reviewer:2', 'coder-backend:3', 'reviewer:3']);
});

test('failing tests skip the reviewer and go back to the coder with output', async () => {
  // The test command passes once the coder has written fixed.txt.
  const test = { run: ['node', '-e', "require('fs').existsSync('fixed.txt') || (console.log('expected fixed'), process.exit(1))"], timeoutSec: 10 };
  const { config, agents } = await setup(undefined, { test });
  const base = fakeRun(['backend']);
  const { run, calls, prompts } = recorder(['backend'], {
    'coder-backend': async (agent, opts) => {
      if (/fix round/.test(opts.prompt)) writeFileSync(join(opts.cwd, 'fixed.txt'), 'ok');
      return base({ ...agent, name: 'x' }, opts);
    },
  });
  const out = await runTask('Fix tests', { config, agents, pricing: {}, bus: createBus(), confirm: deny, run });
  assert.equal(out.status, 'approved');
  assert.deepEqual(calls, ['planner', 'coder-backend:1', 'coder-backend:2', 'reviewer:1']);
  assert.match(prompts['coder-backend'][1], /test command failed[\s\S]*expected fixed/);
  assert.match(prompts.reviewer[0], /backend passed/);
  assert.ok(existsSync(join(out.runDir, 'backend.r1.test.txt')));
});

test('tests still failing after maxRounds ends as tests-failed', async () => {
  const { config, agents } = await setup(undefined, { maxRounds: 2, test: { run: ['false'], timeoutSec: 10 } });
  const { run, calls } = recorder(['backend']);
  const out = await runTask('Always red', { config, agents, pricing: {}, bus: createBus(), confirm: deny, run });
  assert.equal(out.status, 'tests-failed');
  assert.deepEqual(calls, ['planner', 'coder-backend:1', 'coder-backend:2']);
});

test('budget stop in the middle of the loop', async () => {
  const { config, agents } = await setup({ maxCostPerRun: 10, maxCostPerAgent: 0.9 });
  const { run } = recorder(['backend'], { reviewer: async () => result(changes({ backend: ['again'] })) });
  const out = await runTask('Budget loop', { config, agents, pricing: {}, bus: createBus(), confirm: deny, run });
  assert.equal(out.status, 'stopped-budget');
  assert.equal(out.rounds, 2);
  assert.match(out.error, /coder-backend cost \$1\.00/);
  assert.deepEqual(out.finalComments.backend, ['again']);
});

test('agent output is logged live while the agent runs', async () => {
  const { config, agents } = await setup();
  let seenDuringRun = '';
  const run = fakeRun(['backend'], {
    'coder-backend': async (agent, opts) => {
      opts.onLog('writing server.js');
      seenDuringRun = readFileSync(join(config.paths.runs, readdirSync(config.paths.runs)[0], 'coder-backend.log'), 'utf8');
      return result('done');
    },
  });
  const out = await runTask('Live', { config, agents, pricing: {}, bus: createBus(), confirm: deny, run });
  assert.match(seenDuringRun, /--- round 1, attempt 1 \(coder-backend-llm\) ---\nwriting server\.js/);
  const log = readFileSync(join(out.runDir, 'coder-backend.log'), 'utf8');
  assert.doesNotMatch(log, /\ndone\n/, 'streamed output is not repeated');
  assert.match(log, /--- ok, \$0\.5 \(reported\)/);
  assert.doesNotMatch(readFileSync(join(out.runDir, 'orchestrator.log'), 'utf8'), /agent\.log/);
});

test('interactive pause: skip before review ends unreviewed', async () => {
  const { config, agents } = await setup();
  const questions = [];
  const pause = async (message) => { questions.push(message); return 'skip'; };
  const { run, calls } = recorder(['backend']);
  const out = await runTask('Pause', { config, agents, pricing: {}, bus: createBus(), confirm: deny, pause, run });
  assert.equal(out.status, 'unreviewed');
  assert.match(questions[0], /run the reviewer\?/);
  assert.ok(!calls.some((c) => c.startsWith('reviewer')));
});

test('interactive pause: skip before a fix round ends changes-requested, abort ends aborted', async () => {
  const { config, agents } = await setup();
  const reviewer = async () => result(changes({ backend: ['fix'] }));
  const skipFix = async (message) => (/fix round/.test(message) ? 'skip' : 'continue');
  const one = recorder(['backend'], { reviewer });
  const out = await runTask('Skip fix', { config, agents, pricing: {}, bus: createBus(), confirm: deny, pause: skipFix, run: one.run });
  assert.equal(out.status, 'changes-requested');
  assert.equal(out.rounds, 1);

  const two = await setup();
  const aborted = await runTask('Abort', { ...two, pricing: {}, bus: createBus(), confirm: deny, pause: async () => 'abort', run: recorder(['backend']).run });
  assert.equal(aborted.status, 'aborted');
});

test('worktrees.ready is emitted with the worktree paths', async () => {
  const { config, agents } = await setup();
  const bus = createBus();
  let ready = null;
  bus.on('worktrees.ready', (e) => { ready = e.worktrees; });
  const out = await runTask('Ready', { config, agents, pricing: {}, bus, confirm: deny, run: fakeRun(['frontend']) });
  assert.deepEqual(ready, out.worktrees);
});

test('each agent gets search sources from its rag.scope', async () => {
  const { config, agents } = await setup();
  config.repos.backend.docs = ['docs'];
  const scopes = { planner: ['frontend', 'backend', 'docs'], 'coder-frontend': ['frontend', 'contract'], reviewer: ['frontend', 'backend'] };
  for (const agent of agents) agent.rag = { scope: scopes[agent.name] ?? [] };
  const seen = {};
  const base = fakeRun(['frontend', 'backend']);
  const run = (agent, opts) => { seen[agent.name] = opts.sources; return base(agent, opts); };
  const out = await runTask('Scopes', { config, agents, pricing: {}, bus: createBus(), confirm: deny, run });

  assert.deepEqual(seen.planner.code, [
    { name: 'frontend', dir: config.repos.frontend.path },
    { name: 'backend', dir: config.repos.backend.path },
  ]);
  assert.deepEqual(seen.planner.docs.map((d) => [d.name, d.paths]), [['frontend', []], ['backend', ['docs']]]);
  assert.equal(seen.planner.contract, null);
  assert.deepEqual(seen['coder-frontend'].code, [{ name: 'frontend', dir: out.worktrees.frontend }]);
  assert.equal(seen['coder-frontend'].contract, join(out.runDir, 'contract.txt'));
  assert.deepEqual(seen.reviewer.code.map((c) => c.dir), [out.worktrees.frontend, out.worktrees.backend]);
  assert.equal(seen['coder-backend'], undefined, 'no scope falls back to the workspace');
});

test('--side backend: only backend runs even if the planner picks both', async () => {
  const { config, agents } = await setup();
  const { run, calls, prompts } = recorder(['frontend', 'backend']);
  const out = await runTask('Backend only', { config, agents, pricing: {}, bus: createBus(), confirm: deny, run, sides: ['backend'] });
  assert.equal(out.status, 'approved');
  assert.deepEqual(Object.keys(out.worktrees), ['backend']);
  assert.deepEqual(calls, ['planner', 'coder-backend:1', 'reviewer:1']);
  assert.match(prompts.planner[0], /limited to: backend\. Set "sides" to exactly \["backend"\]/);
  assert.doesNotMatch(prompts.reviewer[0], /### frontend/);
  assert.match(readFileSync(join(out.runDir, 'orchestrator.log'), 'utf8'), /run\.started.*"sides":\["backend"\]/);
});

test('--side fails if the planner wrote no instructions for that side', async () => {
  const { config, agents } = await setup();
  const planner = async () => result(json({ sides: ['frontend'], contract: 'c', instructions: { frontend: 'x' } }));
  const out = await runTask('Mismatch', { config, agents, pricing: {}, bus: createBus(), confirm: deny, sides: ['backend'], run: fakeRun([], { planner }) });
  assert.equal(out.status, 'failed');
  assert.match(out.error, /no instructions for backend \(required by --side\)/);
  assert.deepEqual(out.worktrees, {});
});

test('invalid --side fails before the planner is called', async () => {
  const { config, agents } = await setup();
  const { run, calls } = recorder(['backend']);
  const out = await runTask('Bad side', { config, agents, pricing: {}, bus: createBus(), confirm: deny, sides: ['mobile'], run });
  assert.equal(out.status, 'failed');
  assert.match(out.error, /--side expects frontend and\/or backend, got "mobile"/);
  assert.deepEqual(calls, []);
});
